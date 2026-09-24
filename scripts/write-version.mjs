// Writes public/version.json so a tab left open across a deploy can notice
// the new build and reload itself (see src/client/version.ts).
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

let sha = 'nogit';
try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch {}
const id = `${sha}-${Date.now().toString(36)}`;
mkdirSync('public', { recursive: true });
writeFileSync('public/version.json', JSON.stringify({ id }) + '\n');
writeFileSync('.build-id', id);
console.log(`build id ${id}`);

