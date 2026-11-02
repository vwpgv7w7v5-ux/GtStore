import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const main=await readFile(new URL('../../apps/admin-v6/src/main.js',import.meta.url),'utf8');
const css=await readFile(new URL('../../apps/admin-v6/src/styles/vision.css',import.meta.url),'utf8');
for(const marker of ['Мои рассылки','loadCampaigns','marketingPage','openCampaignEditor','/campaigns/${c.id}/send','data-campaign'])assert.ok(main.includes(marker),`missing ${marker}`);
for(const marker of ['.campaign-head','.campaign-row','.campaign-detail','.delivery-list'])assert.ok(css.includes(marker),`missing ${marker}`);
console.log('V6.10 campaign studio UI tests passed');
