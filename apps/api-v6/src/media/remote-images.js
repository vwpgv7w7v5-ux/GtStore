import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import net from 'node:net';
import { AppError, assert } from '../core/errors.js';

// Downloaded catalogue URLs are untrusted. Never let them address the host's
// loopback, private network, metadata service, or IPv4 transition mechanisms.
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const [first, second] = address.toLowerCase().split(':').map(x => parseInt(x || '0', 16));
    // Only global unicast; exclude Teredo, 6to4, documentation and special-use.
    return first >= 0x2000 && first < 0x4000 && first !== 0x2002 &&
      first !== 0x3ffe && first !== 0x3fff &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

function remoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('MEDIA_URL_INVALID', 'Некорректный адрес фотографии'); }
  assert(url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443'),
    'MEDIA_URL_INVALID', 'Для импорта фотографии нужен публичный HTTPS-адрес без логина и пароля');
  url.hash = '';
  return url;
}

async function publicAddresses(url, lookup) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const records = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  assert(records.length && records.every(record => isPublicAddress(record.address)),
    'MEDIA_URL_PRIVATE', 'Адрес фотографии ведёт в закрытую или служебную сеть');
  return records;
}

function proxyFor(url) {
  const excluded = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (excluded.some(entry => entry === '*' || url.hostname === entry ||
    (entry.startsWith('.') && (url.hostname === entry.slice(1) || url.hostname.endsWith(entry))))) return null;
  return process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
}

function responseFrom(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => request.destroy(new AppError('MEDIA_DOWNLOAD_TIMEOUT', 'Время загрузки фотографии истекло', 504)), timeoutMs);
    request.once('error', error => { clearTimeout(timeout); reject(error); });
    request.once('response', response => {
      response.once('close', () => clearTimeout(timeout));
      resolve(response);
    });
    request.end();
  });
}

async function requestImage(url, { addresses, timeoutMs, proxy }) {
  const deadline = Date.now() + timeoutMs;
  if (!proxy) {
    let index = 0;
    const lookup = (_hostname, options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      if (options.all) return callback(null, addresses);
      const record = addresses[index++ % addresses.length];
      callback(null, record.address, record.family);
    };
    return responseFrom(https.request(url, { lookup, agent: false, headers: { accept: 'image/jpeg,image/png,image/webp,image/gif' } }), timeoutMs);
  }

  // Keep the configured egress proxy and its TLS trust. CONNECT uses the source
  // hostname so destination policy remains enforceable by the proxy.
  const destination = new URL(proxy);
  assert(['http:', 'https:'].includes(destination.protocol), 'MEDIA_PROXY_INVALID', 'Неподдерживаемый HTTPS-прокси');
  const headers = { host: url.host };
  if (destination.username || destination.password) {
    headers['proxy-authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(destination.username)}:${decodeURIComponent(destination.password)}`).toString('base64');
  }
  const socket = await new Promise((resolve, reject) => {
    const connector = destination.protocol === 'https:' ? https : http;
    const request = connector.request({ protocol: destination.protocol, hostname: destination.hostname, port: destination.port || (destination.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: `${url.hostname}:443`, headers });
    const timeout = setTimeout(() => request.destroy(new AppError('MEDIA_DOWNLOAD_TIMEOUT', 'Время подключения к фотографиям истекло', 504)), timeoutMs);
    request.once('error', error => { clearTimeout(timeout); reject(error); });
    request.once('connect', (response, connection, head) => {
      clearTimeout(timeout);
      if (response.statusCode !== 200) {
        connection.destroy();
        reject(new AppError('MEDIA_PROXY_DENIED', `Прокси отклонил загрузку фотографии (HTTP ${response.statusCode})`, 502));
        return;
      }
      if (head.length) connection.unshift(head);
      resolve(connection);
    });
    request.end();
  });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const secure = tls.connect({ socket, host: hostname, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true });
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = () => secure;
  secure.once('error', () => {}); // The HTTP request also receives TLS errors.
  const request = https.request(url, { agent, headers: { accept: 'image/jpeg,image/png,image/webp,image/gif' } });
  try {
    const response = await responseFrom(request, Math.max(1, deadline - Date.now()));
    response.once('close', () => { agent.destroy(); socket.destroy(); });
    return response;
  } catch (error) { agent.destroy(); socket.destroy(); throw error; }
}

export function imageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function withinDeadline(promise, deadline) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new AppError('MEDIA_DOWNLOAD_TIMEOUT', 'Время загрузки фотографии истекло', 504)), Math.max(1, deadline - Date.now()));
    })]);
  } finally { clearTimeout(timer); }
}

async function download(value, options) {
  let url = remoteUrl(value);
  const lookup = options.lookup || dns.lookup;
  const request = options.request || requestImage;
  const maxBytes = options.maxBytes || 8 * 1024 * 1024;
  const deadline = Date.now() + (options.timeoutMs || 20_000);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const timeoutMs = deadline - Date.now();
    assert(timeoutMs > 0, 'MEDIA_DOWNLOAD_TIMEOUT', 'Время загрузки фотографии истекло', 504);
    const addresses = await withinDeadline(publicAddresses(url, lookup), deadline);
    const remaining = deadline - Date.now();
    assert(remaining > 0, 'MEDIA_DOWNLOAD_TIMEOUT', 'Время загрузки фотографии истекло', 504);
    const response = await request(url, { addresses, timeoutMs: remaining, proxy: options.proxy === undefined ? proxyFor(url) : options.proxy });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      assert(redirect < 3 && response.headers.location, 'MEDIA_REDIRECT_INVALID', 'Слишком много перенаправлений фотографии');
      url = remoteUrl(new URL(response.headers.location, url));
      continue;
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new AppError('MEDIA_DOWNLOAD_FAILED', `Не удалось загрузить фотографию (HTTP ${response.statusCode})`, 502);
    }
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(contentType)) {
      response.destroy();
      throw new AppError('MEDIA_TYPE_NOT_ALLOWED', 'По ссылке получена страница или неподдерживаемое изображение', 415);
    }
    if (Number(response.headers['content-length'] || 0) > maxBytes) {
      response.destroy();
      throw new AppError('MEDIA_TOO_LARGE', 'Фотография превышает допустимый размер', 413);
    }
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => response.destroy(new AppError('MEDIA_DOWNLOAD_TIMEOUT', 'Время загрузки фотографии истекло', 504)), Math.max(1, deadline - Date.now()));
    try {
      for await (const chunk of response) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        assert(size <= maxBytes, 'MEDIA_TOO_LARGE', 'Фотография превышает допустимый размер', 413);
        chunks.push(bytes);
      }
    } finally { clearTimeout(timer); response.destroy(); }
    const buffer = Buffer.concat(chunks);
    assert(buffer.length && imageMime(buffer) === contentType, 'MEDIA_CONTENT_INVALID', 'Содержимое фотографии не соответствует формату изображения', 415);
    return { buffer, mime: contentType };
  }
}

export async function downloadRemoteImage(value, options = {}) {
  try { return await download(value, options); }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('MEDIA_DOWNLOAD_FAILED', 'Не удалось скачать фотографию: проверьте доступ к HTTPS-адресу и настройку сети', 502);
  }
}
