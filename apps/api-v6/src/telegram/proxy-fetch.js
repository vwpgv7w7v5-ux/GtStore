import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

function envProxy() {
  return String(
    process.env.TELEGRAM_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      '',
  ).trim();
}

function curlFetch(url, options = {}, proxy) {
  return new Promise((resolve, reject) => {
    const method = String(options.method || 'GET').toUpperCase();
    // Never auto-retry POST: Telegram may already have applied sendMessage.
    const allowRetry = method === 'GET' || method === 'HEAD';
    const args = [
      '-4',
      '-sS',
      '--http1.1',
      '-X',
      method,
      '--connect-timeout',
      String(process.env.TELEGRAM_API_CONNECT_TIMEOUT || 15),
      '--max-time',
      String(Math.ceil(Number(process.env.TELEGRAM_API_TIMEOUT_MS || 30000) / 1000)),
      '-H',
      'content-type: application/json',
    ];
    if (allowRetry) {
      args.push('--retry', '3', '--retry-delay', '2', '--retry-connrefused');
    }
    if (proxy) args.push('--proxy', proxy);
    if (options.body) args.push('--data-binary', String(options.body));
    args.push('-w', '\n__HTTP__:%{http_code}');
    args.push(url);
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        const compact = stderr
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line, idx, arr) => arr.indexOf(line) === idx)
          .slice(-1)[0];
        reject(new Error(compact || `curl exit ${code}`));
        return;
      }
      const marker = stdout.lastIndexOf('\n__HTTP__:');
      const body = marker >= 0 ? stdout.slice(0, marker) : stdout;
      const status = marker >= 0 ? Number(stdout.slice(marker + 10)) || 0 : 200;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return JSON.parse(body || '{}');
        },
        async text() {
          return body;
        },
      });
    });
  });
}

function httpProxyFetch(url, options = {}, proxyUrl) {
  const target = new URL(url);
  const proxy = new URL(proxyUrl);
  const payload = options.body ? Buffer.from(String(options.body)) : null;
  const isHttpsProxy = proxy.protocol === 'https:';
  const request = isHttpsProxy ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      {
        protocol: proxy.protocol,
        hostname: proxy.hostname,
        port: proxy.port || (isHttpsProxy ? 443 : 80),
        method: 'CONNECT',
        path: `${target.hostname}:${target.port || 443}`,
        headers: {
          Host: `${target.hostname}:${target.port || 443}`,
        },
        timeout: Number(process.env.TELEGRAM_API_CONNECT_TIMEOUT || 12) * 1000,
      },
      (res) => {
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
      },
    );
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`Proxy CONNECT status ${res.statusCode}`));
        return;
      }
      const tlsReq = httpsRequest(
        {
          host: target.hostname,
          path: `${target.pathname}${target.search}`,
          method: options.method || 'GET',
          headers: {
            'content-type': 'application/json',
            'content-length': payload ? payload.length : 0,
            host: target.hostname,
          },
          socket,
          servername: target.hostname,
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => {
            body += chunk;
          });
          response.on('end', () => {
            resolve({
              ok: response.statusCode >= 200 && response.statusCode < 300,
              status: response.statusCode || 0,
              async json() {
                return JSON.parse(body || '{}');
              },
              async text() {
                return body;
              },
            });
          });
        },
      );
      tlsReq.on('error', reject);
      if (payload) tlsReq.write(payload);
      tlsReq.end();
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Proxy CONNECT timeout'));
    });
    req.end();
  });
}

/** Fetch that can route Telegram calls through TELEGRAM_PROXY / HTTPS_PROXY. */
export function createTelegramFetch(baseFetch = globalThis.fetch) {
  return async function telegramFetch(url, options = {}) {
    const proxy = envProxy();
    if (!proxy) return baseFetch(url, options);
    if (/^socks/i.test(proxy)) return curlFetch(url, options, proxy);
    if (/^https?:/i.test(proxy)) {
      try {
        return await httpProxyFetch(url, options, proxy);
      } catch {
        return curlFetch(url, options, proxy);
      }
    }
    return curlFetch(url, options, proxy);
  };
}

/** Binary download via curl (proxy-safe). Avoids corrupting images through string buffers. */
export function downloadViaCurl(url, destPath, proxy = envProxy()) {
  return new Promise((resolve, reject) => {
    const args = [
      '-4',
      '-sS',
      '-L',
      '--http1.1',
      '--retry',
      '3',
      '--retry-delay',
      '1',
      '--connect-timeout',
      String(process.env.TELEGRAM_API_CONNECT_TIMEOUT || 15),
      '--max-time',
      String(Math.ceil(Number(process.env.TELEGRAM_API_TIMEOUT_MS || 30000) / 1000)),
      '-o',
      destPath,
    ];
    if (proxy) args.push('--proxy', proxy);
    args.push(url);
    const child = spawn('curl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim().split(/\n+/).filter(Boolean).slice(-1)[0] || `curl exit ${code}`));
        return;
      }
      resolve(destPath);
    });
  });
}
