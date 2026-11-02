#!/usr/bin/env python3
"""Update the confirmed /opt/gtstore systemd installation without moving state.

Run as root from the Timeweb console. Only source files and node_modules change;
the existing units, database, uploads, environment and nginx configuration stay.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

DEFAULT_COMMIT = "e85daa017553c962919606c97bbb0bb315b200f9"
SITE = "72-56-28-133.sslip.io"
UNITS = {4000: "gtstore-api.service", 4173: "gtstore-admin.service", 4174: "gtstore-storefront.service"}
SCOPES = ("apps/api-v6/src", "apps/admin-v6", "apps/storefront-v6")
ROOT_FILES = ("package.json", "package-lock.json", "scripts/serve-static.js")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def source_files(source):
    result = []
    for scope in SCOPES:
        require((source / scope).is_dir() and not (source / scope).is_symlink(), "Incomplete source: " + scope)
        result.extend(p.relative_to(source) for p in (source / scope).rglob("*") if p.is_file())
    for name in ROOT_FILES:
        require((source / name).is_file(), "Incomplete source: " + name)
        result.append(Path(name))
    require((source / "apps/api-v6/src/imports/jobs.js").is_file(), "Source does not contain background imports")
    for relative in result:
        require(not (source / relative).is_symlink(), "Source symlinks are not permitted")
        require(not any(p == ".env" or p.startswith(".env.") for p in relative.parts),
                "Source must not replace existing environment files")
    return sorted(set(result))


def unpack(archive, destination, commit):
    """Accept only GitHub's single-root, regular-file source tarball."""
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        require(len(members) < 20000 and sum(m.size for m in members) < 200 * 1024**2,
                "Source archive is too large")
        seen = set()
        for item in members:
            p = PurePosixPath(item.name)
            require(not p.is_absolute() and ".." not in p.parts and p.parts
                    and p.parts[0] == "GtStore-" + commit and (item.isfile() or item.isdir()),
                    "Unsafe or unexpected source archive")
            require(p.as_posix() not in seen, "Duplicate source archive member")
            seen.add(p.as_posix())
        bundle.extractall(destination, members=members,
                          **({"filter": "data"} if hasattr(tarfile, "data_filter") else {}))
    source = destination / ("GtStore-" + commit)
    source_files(source)
    return source


class System:
    def run(self, args, *, cwd=None, capture=True, env=None, timeout=45):
        return subprocess.run(args, cwd=cwd, env=env, check=True, timeout=timeout,
                              stdout=subprocess.PIPE if capture else None,
                              stderr=subprocess.PIPE if capture else None).stdout

    def service(self, action):
        self.run(["systemctl", action, *UNITS.values()], timeout=120)

    def request(self, route, *, public=False):
        if public:
            # Reach this server's nginx with the real HTTPS hostname, SNI and
            # certificate validation; do not depend on public-IP hairpin routing.
            return self.run(["curl", "--fail", "--silent", "--show-error", "--max-time", "5", "--noproxy", SITE,
                             "--resolve", SITE + ":443:127.0.0.1", "https://" + SITE + route], timeout=8)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:4000" + route, timeout=3) as response:
            return response.read()

    def inspect(self, project):
        listing = self.run(["ss", "-lntp"]).decode()
        api_pid = None
        for port, unit in UNITS.items():
            self.run(["systemctl", "is-active", "--quiet", unit])
            found = set()
            for line in listing.splitlines():
                fields = line.split()
                if len(fields) >= 4 and fields[3].rsplit(":", 1)[-1] == str(port):
                    found.update(int(p) for p in re.findall(r"pid=(\d+)", line))
            require(len(found) == 1, "Expected one node process on port " + str(port))
            pid = found.pop()
            require(Path(f"/proc/{pid}/cwd").resolve() == project, "Process has a different project directory")
            groups = Path(f"/proc/{pid}/cgroup").read_text()
            require(any(unit in line.split(":", 2)[-1].split("/")
                        for line in groups.splitlines()), "Port is not owned by " + unit)
            if port == 4000:
                api_pid = pid
        # Select only operational paths, never log or persist process secrets.
        selected = {}
        for field in Path(f"/proc/{api_pid}/environ").read_bytes().split(b"\0"):
            key, _, value = field.partition(b"=")
            if key in (b"V6_DATABASE_FILE", b"V6_MEDIA_DIRECTORY"):
                selected[key.decode()] = value.decode()
        database = Path(selected.get("V6_DATABASE_FILE") or "data/v6.json")
        media = Path(selected.get("V6_MEDIA_DIRECTORY") or "uploads/v6")
        database = (project / database).resolve()
        media = (project / media).resolve()
        if selected.get("V6_MEDIA_DIRECTORY") and "V6_MEDIA_DIRECTORY" not in (project / "apps/api-v6/src/app.js").read_text():
            require(media == (project / "uploads/v6").resolve(),
                    "Existing API ignores a different V6_MEDIA_DIRECTORY; inspect media settings first")
        node = Path(f"/proc/{api_pid}/exe").resolve()
        require(database.is_file(), "Existing database is missing; refusing to create an empty store")
        require(not (project / "node_modules").is_symlink(), "Inspect the existing node_modules symlink first")
        require((project / "node_modules").is_dir(), "Existing dependencies are missing")
        return database, media, node


class Update:
    def __init__(self, project, source, commit, system=None, backup_parent=None):
        self.project = Path(project)
        self.source = Path(source)
        self.commit = commit
        self.system = system or System()
        self.backup_parent = Path(backup_parent or "/opt/gtstore-backups")
        self.files = source_files(self.source)
        self.backup = None
        self.old_files = {}
        self.stopped = False
        self.applying = False
        self.old_modules = False
        self.attempts = 30
        self.delay = 1

    def validate(self):
        require(self.project.is_dir() and not self.project.is_symlink(), "Project must be a real directory")
        require(self.project.resolve() == self.project, "Project parents must not be symlinks")
        package = json.loads((self.project / "package.json").read_text())
        require(str(package.get("name", "")).startswith("gtstore"), "This is not a GtStore project")
        database, media, node = self.system.inspect(self.project)
        state = json.loads(database.read_text())
        require(isinstance(state.get("users"), list) and state["users"], "Existing database has no users")
        self.database, self.media, self.node = database, media, node
        self.revision = int(state.get("revision", 0))
        self.products = len(state.get("products", []))
        protected = (database, media, database.parent / "import-jobs")
        for relative in self.files:
            target = self.project / relative
            for parent in (target, *target.parents):
                require(not parent.is_symlink(), "Refusing source path containing a symlink: " + str(relative))
                if parent == self.project:
                    break
            require(not target.exists() or target.is_file(), "Source destination is not a regular file")
            require(not any(target == p or p in target.parents for p in protected), "Source overlaps persistent state")
        before = json.loads(self.system.request("/api/v6/health", public=True))
        require(before.get("ok") is True and before.get("revision", -1) >= self.revision,
                "The HTTPS site is not serving the expected existing database")

    def install_dependencies(self):
        print("Installing and checking dependencies before stopping the site...", flush=True)
        env = {**os.environ, "PATH": str(self.node.parent) + os.pathsep + os.environ.get("PATH", "")}
        self.system.run(["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
                        cwd=self.source, capture=False, env=env, timeout=600)
        self.system.run([str(self.node), "--input-type=module", "-e",
                         'await import("./apps/api-v6/src/app.js"); '
                         'const {default:sharp}=await import("sharp"); '
                         'await sharp({create:{width:2,height:2,channels:3,background:"#fff"}}).webp().toBuffer();'],
                        cwd=self.source, env=env, timeout=30)
        require((self.source / "node_modules").is_dir(), "Staged dependencies are missing")

    def snapshot(self):
        require(not self.backup_parent.is_symlink(), "Backup directory must not be a symlink")
        self.backup_parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.backup_parent, 0o700)
        self.backup = Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S-") + self.commit[:8] + "-",
                                            dir=self.backup_parent))
        # Capture the whole stopped installation, including its state and local
        # configuration. Dependencies move separately; git metadata stays put.
        def include(item):
            parts = PurePosixPath(item.name).parts
            if len(parts) >= 2 and parts[1] in ("node_modules", ".git"):
                return None
            return item
        with tarfile.open(self.backup / "installation.tar.gz", "w:gz") as archive:
            archive.add(self.project, arcname="project", filter=include)
            if self.project not in self.database.parents:
                archive.add(self.database, arcname="external/database.json")
            if self.media.exists() and self.project not in self.media.parents:
                archive.add(self.media, arcname="external/media")
        for relative in self.files:
            target = self.project / relative
            self.old_files[str(relative)] = target.exists()
            if target.exists():
                saved = self.backup / "code" / relative
                saved.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, saved)
                s = target.stat()
                os.chown(saved, s.st_uid, s.st_gid)
        (self.backup / "manifest.json").write_text(json.dumps({"commit": self.commit, "project": str(self.project),
            "database": str(self.database), "media": str(self.media), "files": self.old_files}, indent=2))
        print("Backup saved: " + str(self.backup), flush=True)

    @staticmethod
    def replace(source, target, *, restore=False):
        missing = []
        parent = target.parent
        while not parent.exists():
            missing.append(parent)
            parent = parent.parent
        for directory in reversed(missing):
            owner = directory.parent.stat()
            directory.mkdir(mode=0o755)
            os.chmod(directory, 0o755)
            os.chown(directory, owner.st_uid, owner.st_gid)
        metadata = source.stat() if restore else (target.stat() if target.exists() else target.parent.stat())
        fd, name = tempfile.mkstemp(prefix=".gtstore-update-", dir=target.parent)
        try:
            with os.fdopen(fd, "wb") as output, source.open("rb") as input_file:
                shutil.copyfileobj(input_file, output)
                os.fchmod(output.fileno(), stat.S_IMODE(metadata.st_mode) if restore or target.exists() else 0o644)
                os.fchown(output.fileno(), metadata.st_uid, metadata.st_gid)
            os.replace(name, target)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def apply(self):
        self.applying = True
        for relative in self.files:
            self.replace(self.source / relative, self.project / relative)
        os.rename(self.project / "node_modules", self.backup / "node_modules")
        self.old_modules = True
        os.rename(self.source / "node_modules", self.project / "node_modules")
        # The staging parent is private, but runtime dependency files need to be
        # readable/executable by the existing systemd service users.
        for directory, dirs, files in os.walk(self.project / "node_modules", followlinks=False):
            os.chmod(directory, 0o755)
            for name in files:
                p = Path(directory) / name
                if not p.is_symlink():
                    mode = stat.S_IMODE(p.stat().st_mode)
                    os.chmod(p, mode | (0o555 if mode & 0o111 else 0o444))

    def healthy(self):
        try:
            for public in (False, True):
                self.health_reason = "API health check failed" + (" through HTTPS" if public else " on port 4000")
                h = json.loads(self.system.request("/api/v6/health", public=public))
                if h.get("ok") is not True or h.get("backgroundImport") is not True or h.get("revision", -1) < self.revision:
                    return False
            for route, source in (("/admin/", "apps/admin-v6/index.html"),
                                  ("/admin/src/main.js", "apps/admin-v6/src/main.js"),
                                  ("/storefront.js", "apps/storefront-v6/storefront.js")):
                self.health_reason = "HTTPS source does not match GitHub: " + route
                if hashlib.sha256(self.system.request(route, public=True)).digest() != hashlib.sha256((self.source / source).read_bytes()).digest():
                    return False
            for unit in UNITS.values():
                self.health_reason = "Service is not active: " + unit
                self.system.run(["systemctl", "is-active", "--quiet", unit])
            return True
        except Exception:
            return False

    def rollback(self):
        print("Update failed; restoring previous code. Database and photos are preserved.", flush=True)
        try:
            if self.applying:
                try:
                    self.system.service("stop")
                except Exception:
                    pass  # Still restore code and attempt a restart after a partial stop.
                for relative, existed in self.old_files.items():
                    target = self.project / relative
                    if existed:
                        self.replace(self.backup / "code" / relative, target, restore=True)
                    elif target.is_file():
                        target.unlink()
                if self.old_modules:
                    modules = self.project / "node_modules"
                    if modules.exists():
                        shutil.rmtree(modules)
                    os.rename(self.backup / "node_modules", modules)
        finally:
            self.system.service("restart")

    def run(self):
        self.validate()
        self.install_dependencies()
        try:
            self.stopped = True
            self.system.service("stop")
            self.snapshot()
            self.apply()
            self.system.service("start")
            for attempt in range(self.attempts):
                if self.healthy():
                    (self.project / ".gtstore-source-commit").write_text(self.commit + "\n")
                    os.chmod(self.project / ".gtstore-source-commit", 0o644)
                    self.stopped = False
                    print("UPDATED: " + self.commit, flush=True)
                    print("HTTPS API, admin and storefront verified; backgroundImport=true.", flush=True)
                    print(f"Existing database preserved ({self.products} products before update). No Excel import was run.", flush=True)
                    return
                if attempt % 5 == 0:
                    print("Waiting: " + self.health_reason, flush=True)
                time.sleep(self.delay)
            raise RuntimeError("New HTTPS site did not pass readiness checks")
        except BaseException:
            if self.stopped:
                previous = {sig: signal.signal(sig, signal.SIG_IGN)
                            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)}
                try:
                    self.rollback()
                finally:
                    for sig, handler in previous.items():
                        signal.signal(sig, handler)
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", default=DEFAULT_COMMIT)
    args = parser.parse_args()
    require(os.geteuid() == 0, "Run this installer as root from the Timeweb console")
    require(re.fullmatch("[0-9a-f]{40}", args.commit), "Expected a full GitHub commit SHA")
    os.umask(0o077)
    for command in ("node", "npm", "curl", "systemctl", "ss"):
        require(shutil.which(command), "Missing required command: " + command)
    project = Path("/opt/gtstore")
    fd = os.open("/opt/.gtstore-update.lock", os.O_CREAT | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for sig in (signal.SIGTERM, signal.SIGHUP):
            signal.signal(sig, lambda number, frame: sys.exit(128 + number))
        with tempfile.TemporaryDirectory(prefix=".gtstore-update-", dir="/opt") as directory:
            work = Path(directory)
            archive = work / "source.tar.gz"
            print("Downloading verified source from GitHub: " + args.commit, flush=True)
            url = "https://codeload.github.com/vwpgv7w7v5-ux/GtStore/tar.gz/" + args.commit
            with urllib.request.urlopen(url, timeout=60) as response, archive.open("wb") as output:
                count = 0
                while chunk := response.read(128 * 1024):
                    count += len(chunk)
                    require(count <= 50 * 1024**2, "Source download is too large")
                    output.write(chunk)
            source = unpack(archive, work, args.commit)
            Update(project, source, args.commit).run()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("Interrupted; see the update/rollback output above.", file=sys.stderr)
        sys.exit(130)
    except Exception as error:
        # Do not echo subprocess environments, request headers or npm diagnostics
        # that could include credentials from an existing server configuration.
        print("UPDATE FAILED: " + (str(error) if not isinstance(error, subprocess.CalledProcessError)
                                  else "Command failed: " + str(error.cmd[0])), file=sys.stderr)
        sys.exit(1)
