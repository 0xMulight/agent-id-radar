import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config } from '../src/config.mjs';
const root = resolve(import.meta.dirname, '..');
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(x => x.isDirectory() ? walk(join(dir, x.name)) : [join(dir, x.name)]); }
for (const f of [...walk(join(root, 'src')), ...walk(join(root, 'test'))].filter(x => x.endsWith('.mjs'))) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
config(JSON.parse(readFileSync(join(root, 'config.example.json'), 'utf8')));
console.log('Syntax and example configuration checks passed');
