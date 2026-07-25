import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const main=await readFile(new URL('../../apps/admin-v6/src/main.js',import.meta.url),'utf8');
for(const marker of ['Warehouse Core v6.17','loadWarehouse','warehousePage','warehouse/adjust','warehouse/movements','data-route="${r}"'])assert.ok(main.includes(marker),`missing ${marker}`);
console.log('V6.17 warehouse UI tests passed');
