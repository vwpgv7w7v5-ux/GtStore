import assert from 'node:assert/strict';
import fs from 'node:fs';
const js=fs.readFileSync('apps/admin-v6/src/main.js','utf8');
const css=fs.readFileSync('apps/admin-v6/src/styles/vision.css','utf8');
for(const token of ['automationsPage','automationEditor','automationDetails','bindAutomations','/automations','{{order.number}}','data-automation-toggle']) assert.ok(js.includes(token),`Missing UI token: ${token}`);
for(const token of ['automation-grid','automation-card','run-row','switch']) assert.ok(css.includes(token),`Missing style: ${token}`);
console.log('V6.12 automation studio UI tests passed');
