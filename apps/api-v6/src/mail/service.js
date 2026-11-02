import net from 'node:net';
import tls from 'node:tls';
import { id } from '../core/ids.js';

function encodeAddress(value) {
  return String(value || '').trim();
}

export class MailService {
  constructor(options = {}) {
    this.host = String(options.host || process.env.SMTP_HOST || '').trim();
    this.port = Number(options.port || process.env.SMTP_PORT || 587);
    this.secure = String(options.secure || process.env.SMTP_SECURE || '') === '1';
    this.user = String(options.user || process.env.SMTP_USER || '').trim();
    this.pass = String(options.pass || process.env.SMTP_PASS || '');
    this.from =
      String(options.from || process.env.SMTP_FROM || '').trim() ||
      'GStore <noreply@gtstore.local>';
    this.store = options.store || null;
  }

  configured() {
    return Boolean(this.host);
  }

  async send({ to, subject, text, html }) {
    const entry = {
      id: id('mail'),
      to: encodeAddress(to),
      subject: String(subject || ''),
      text: String(text || ''),
      html: String(html || ''),
      from: this.from,
      status: 'queued',
      createdAt: new Date().toISOString(),
      error: '',
    };
    if (!entry.to || !entry.to.includes('@')) {
      entry.status = 'failed';
      entry.error = 'INVALID_EMAIL';
      await this.persist(entry);
      return entry;
    }
    if (!this.configured()) {
      entry.status = 'logged';
      console.log(`[mail:outbox] to=${entry.to} subject=${entry.subject}`);
      await this.persist(entry);
      return entry;
    }
    try {
      await this.smtpSend(entry);
      entry.status = 'sent';
      entry.sentAt = new Date().toISOString();
    } catch (error) {
      entry.status = 'failed';
      entry.error = error.message || 'SMTP_ERROR';
    }
    await this.persist(entry);
    return entry;
  }

  async persist(entry) {
    if (!this.store) return;
    await this.store.transaction('mail', (db) => {
      db.mailOutbox ||= [];
      db.mailOutbox.push(entry);
      if (db.mailOutbox.length > 500) {
        db.mailOutbox = db.mailOutbox.slice(-500);
      }
    });
  }

  async smtpSend(entry) {
    const transcript = [];
    const socket = await this.connect();
    const read = () =>
      new Promise((resolve, reject) => {
        let buffer = '';
        const onData = (chunk) => {
          buffer += chunk.toString('utf8');
          if (/\r?\n/.test(buffer) && /^[0-9]{3} /.test(buffer.split(/\r?\n/).filter(Boolean).at(-1) || '')) {
            socket.off('data', onData);
            transcript.push(buffer);
            resolve(buffer);
          }
        };
        socket.on('data', onData);
        socket.on('error', reject);
        setTimeout(() => reject(new Error('SMTP_TIMEOUT')), 15000);
      });
    const write = async (line) => {
      socket.write(line + '\r\n');
    };
    const expect = async (code) => {
      const response = await read();
      if (!response.startsWith(String(code))) {
        throw new Error(`SMTP unexpected: ${response.trim()}`);
      }
      return response;
    };
    await expect(220);
    await write(`EHLO gtstore.local`);
    await expect(250);
    if (this.user) {
      await write('AUTH LOGIN');
      await expect(334);
      await write(Buffer.from(this.user).toString('base64'));
      await expect(334);
      await write(Buffer.from(this.pass).toString('base64'));
      await expect(235);
    }
    const fromEmail =
      (this.from.match(/<([^>]+)>/) || [])[1] ||
      this.from ||
      'noreply@gtstore.local';
    await write(`MAIL FROM:<${fromEmail}>`);
    await expect(250);
    await write(`RCPT TO:<${entry.to}>`);
    await expect(250);
    await write('DATA');
    await expect(354);
    const body = [
      `From: ${this.from}`,
      `To: ${entry.to}`,
      `Subject: ${entry.subject}`,
      'MIME-Version: 1.0',
      entry.html
        ? 'Content-Type: text/html; charset=utf-8'
        : 'Content-Type: text/plain; charset=utf-8',
      '',
      entry.html || entry.text,
      '.',
    ].join('\r\n');
    await write(body);
    await expect(250);
    await write('QUIT');
    socket.end();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const connector = this.secure || this.port === 465 ? tls : net;
      const socket = connector.connect(
        { host: this.host, port: this.port, servername: this.host },
        () => resolve(socket),
      );
      socket.setEncoding('utf8');
      socket.on('error', reject);
    });
  }
}
