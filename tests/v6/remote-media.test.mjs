import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { MediaService } from '../../apps/api-v6/src/media/service.js';
import { downloadRemoteImage, isPublicAddress } from '../../apps/api-v6/src/media/remote-images.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
function response(bytes = pixel, statusCode = 200, headers = { 'content-type': 'image/png' }) {
  return Object.assign(Readable.from([bytes]), { statusCode, headers });
}
const options = request => ({ lookup, proxy: null, request });

test('rejects private, reserved and IPv4 transition addresses', () => {
  for (const value of ['127.0.0.1', '10.0.0.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.1.1.1', '192.0.2.1', '198.18.0.1', '203.0.113.5', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fc00::1', '2002:7f00:1::', '2001:db8::1', '64:ff9b::7f00:1', '3fff::1']) {
    assert.equal(isPublicAddress(value), false, value);
  }
  for (const value of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicAddress(value), true, value);
});

test('requires public HTTPS without userinfo or alternate ports', async () => {
  let requests = 0;
  const config = options(async () => { requests++; return response(); });
  for (const url of ['http://example.com/a.png', 'file:///a.png', 'https://user:password@example.com/a.png', 'https://example.com:8443/a.png', 'https://2130706433/a.png', 'https://[::ffff:127.0.0.1]/a.png']) {
    await assert.rejects(downloadRemoteImage(url, config), error => ['MEDIA_URL_INVALID', 'MEDIA_URL_PRIVATE'].includes(error.code));
  }
  assert.equal(requests, 0);
});

test('passes only validated DNS addresses to the transport', async () => {
  const result = await downloadRemoteImage('https://images.example/a.png', options(async (url, config) => {
    assert.equal(url.hostname, 'images.example');
    assert.deepEqual(config.addresses, [{ address: '93.184.216.34', family: 4 }]);
    assert.equal(config.proxy, null);
    return response();
  }));
  assert.deepEqual(result.buffer, pixel);
  assert.equal(result.mime, 'image/png');
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', { ...options(async () => response()), lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }] }), { code: 'MEDIA_URL_PRIVATE' });
});

test('validates every redirect destination before requesting it', async () => {
  let requests = 0;
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', options(async () => {
    requests++;
    return response('', 302, { location: 'https://169.254.169.254/latest/meta-data/' });
  })), { code: 'MEDIA_URL_PRIVATE' });
  assert.equal(requests, 1);
  requests = 0;
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', options(async () => {
    requests++;
    return response('', 302, { location: '/another.png' });
  })), { code: 'MEDIA_REDIRECT_INVALID' });
  assert.equal(requests, 4);
});

test('rejects HTML, spoofed image content and oversized streams', async () => {
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', options(async () => response('<html>blocked</html>', 200, { 'content-type': 'text/html' }))), { code: 'MEDIA_TYPE_NOT_ALLOWED' });
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', options(async () => response('<html>not a PNG</html>'))), { code: 'MEDIA_CONTENT_INVALID' });
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', { ...options(async () => response()), maxBytes: 16 }), { code: 'MEDIA_TOO_LARGE' });
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', options(async () => response('', 200, { 'content-type': 'image/png', 'content-length': '999999999' }))), { code: 'MEDIA_TOO_LARGE' });
});

test('times out DNS and stalled image bodies', async () => {
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', { ...options(async () => response()), timeoutMs: 20, lookup: async () => new Promise(() => {}) }), { code: 'MEDIA_DOWNLOAD_TIMEOUT' });
  await assert.rejects(downloadRemoteImage('https://images.example/a.png', { ...options(async () => Object.assign(new Readable({ read() {} }), { statusCode: 200, headers: { 'content-type': 'image/png' } })), timeoutMs: 20 }), { code: 'MEDIA_DOWNLOAD_TIMEOUT' });
});

test('deduplicates concurrent downloads and reuses persisted files after restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gtstore-remote-media-'));
  try {
    let downloads = 0;
    const first = new MediaService({ directory, remoteOptions: options(async () => { downloads++; return response(); }) });
    const sources = await Promise.all(Array.from({ length: 12 }, () => first.importRemote('https://images.example/a.png')));
    assert.equal(downloads, 1);
    assert.equal(new Set(sources.map(item => item.url)).size, 1);
    assert.ok(sources[0].url.startsWith('/api/v6/media/import-'));
    assert.deepEqual(await fs.readFile(path.join(directory, sources[0].filename)), pixel);
    const restarted = new MediaService({ directory, remoteOptions: options(async () => { throw new Error('External host is offline'); }) });
    assert.equal((await restarted.importRemote('https://images.example/a.png')).url, sources[0].url);
    assert.deepEqual(await fs.readFile(restarted.resolve(sources[0].filename)), pixel);
    assert.equal(downloads, 1);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('does not cache failed responses and recovers missing files', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gtstore-remote-media-'));
  try {
    let downloads = 0;
    const service = new MediaService({ directory, remoteOptions: options(async () => ++downloads === 1 ? response('', 404) : response()) });
    await assert.rejects(service.importRemote('https://images.example/a.png'), { code: 'MEDIA_DOWNLOAD_FAILED' });
    const media = await service.importRemote('https://images.example/a.png');
    assert.equal(downloads, 2);
    await fs.unlink(service.resolve(media.filename));
    assert.equal((await service.importRemote('https://images.example/a.png')).url, media.url);
    assert.equal(downloads, 3);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('repairs truncated or corrupted content-addressed files atomically', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gtstore-remote-media-'));
  try {
    let downloads = 0;
    const service = new MediaService({ directory, remoteOptions: options(async () => { downloads++; return response(); }) });
    const media = await service.importRemote('https://images.example/a.png');
    await fs.writeFile(service.resolve(media.filename), pixel.subarray(0, 15));
    await service.importRemote('https://images.example/a.png');
    assert.deepEqual(await fs.readFile(service.resolve(media.filename)), pixel);
    assert.equal(downloads, 2);
    const damaged = Buffer.from(pixel); damaged[damaged.length - 1] ^= 1;
    await fs.writeFile(service.resolve(media.filename), damaged);
    await service.importRemote('https://images.example/a.png');
    assert.deepEqual(await fs.readFile(service.resolve(media.filename)), pixel);
    assert.equal(downloads, 3);
    assert.equal((await fs.readdir(directory)).filter(name => name.endsWith('.tmp')).length, 0);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('media routes reject directories, hidden metadata, traversal and symlinks', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gtstore-remote-media-'));
  try {
    const service = new MediaService({ directory });
    await fs.mkdir(path.join(directory, 'folder.png'));
    await fs.writeFile(path.join(directory, 'actual.png'), pixel);
    await fs.symlink(path.join(directory, 'actual.png'), path.join(directory, 'link.png'));
    for (const filename of ['.', '..', '.import-cache', '../actual.png', 'metadata.json', '.hidden.png']) {
      assert.throws(() => service.resolve(filename), { code: 'MEDIA_PATH_INVALID' });
    }
    for (const filename of ['folder.png', 'link.png', 'missing.png']) assert.throws(() => service.resolve(filename), { code: 'MEDIA_NOT_FOUND' });
    assert.equal(service.resolve('actual.png'), path.join(directory, 'actual.png'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
