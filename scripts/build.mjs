import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve(import.meta.dirname, '..');
const source = readFileSync(resolve(root, 'vendor/agentid-sniper/watch.mjs'), 'utf8');
const expected = '34293ab59758484ff6a48b85f07864073a525b75cc2014cdb0411a3b2ed74bf7';
if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error('Pinned upstream source hash mismatch; review an upstream update explicitly');
let code = source;
const patches = JSON.parse(readFileSync(resolve(root, 'personal/patches.json'), 'utf8'));
for (const patch of patches) {
  if (code.split(patch.before).length - 1 !== patch.count) throw new Error('Patch no longer applies: ' + patch.name);
  code = code.split(patch.before).join(patch.after);
}
if (process.argv.includes('--check')) {
  if (readFileSync(resolve(root, 'watch.mjs'), 'utf8') !== code) throw new Error('watch.mjs differs from the pinned source + reviewed patches');
} else writeFileSync(resolve(root, 'watch.mjs'), code);
console.log('Pinned upstream + ' + patches.length + ' personal patches verified');
