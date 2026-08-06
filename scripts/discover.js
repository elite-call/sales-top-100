// Prints the API name of every field in a module, so scripts/config.json can be filled in.
// Usage: npm run discover           (defaults to Deals)
//        node scripts/discover.js Leads
import { accessToken, fieldNames } from './zoho.js';

const module = process.argv[2] || 'Deals';
const token = await accessToken();
const fields = await fieldNames(token, module);

console.log(`\n${module} — ${fields.length} fields\n`);
console.log('LABEL'.padEnd(38) + 'API NAME'.padEnd(38) + 'TYPE');
console.log('-'.repeat(96));
for (const f of fields.sort((a, b) => a.label.localeCompare(b.label))) {
  console.log(f.label.slice(0, 36).padEnd(38) + f.api.slice(0, 36).padEnd(38) + f.type);
}
console.log('\nCopy the API names you need into the "fields" block of scripts/config.json.\n');
