import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-help-'));
const { server } = createApp({
  databaseFile: path.join(dir, 'db.json'),
  mediaDirectory: path.join(dir, 'media'),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;
const req = async (p, o = {}) => {
  const r = await fetch(base + p, {
    ...o,
    headers: {
      'content-type': 'application/json',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const b = r.status === 204 ? null : await r.json();
  if (!r.ok)
    throw Object.assign(new Error(b?.error?.message || String(b)), {
      status: r.status,
      body: b,
    });
  return b;
};

try {
  const boot = await req('/bootstrap', {
    method: 'POST',
    body: {
      email: 'help@test.local',
      password: 'Password123!',
      name: 'Helper',
    },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'help@test.local', password: 'Password123!' },
  });
  const token = login.token;
  const root = `/workspaces/${boot.workspace.id}/shops/${boot.shop.id}`;

  const sections = await req('/help/sections');
  assert.ok(sections.includes('Старт'));
  assert.ok(sections.includes('Платежи'));

  const all = await req('/help/articles');
  assert.ok(all.length >= 10);

  const found = await req('/help/articles?q=' + encodeURIComponent('ApiShip'));
  assert.ok(found.some((a) => a.id === 'kb_delivery'));

  const article = await req('/help/articles/kb_telegram');
  assert.equal(article.id, 'kb_telegram');

  const thread = await req(root + '/support/thread', { token });
  assert.ok(thread.messages?.length >= 1);

  const sent = await req(root + '/support/messages', {
    method: 'POST',
    token,
    body: { text: 'Как подключить ЮKassa и чеки?' },
  });
  assert.ok(sent.thread.messages.length >= 2);
  assert.ok(sent.thread.messages.some((m) => m.role === 'support'));
  assert.ok(sent.suggestedArticle);
  assert.match(sent.suggestedArticle.id, /^kb_/);

  const operator = await req(root + '/support/messages', {
    method: 'POST',
    token,
    body: { text: 'Нужен оператор по срочному вопросу' },
  });
  assert.ok(operator.ticket);
  assert.equal(operator.ticket.status, 'open');

  const tickets = await req(root + '/support/tickets', { token });
  assert.ok(tickets.length >= 1);

  console.log('V6.22 help & support tests passed');
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
