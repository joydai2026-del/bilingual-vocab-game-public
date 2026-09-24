// Builds public/cedict.json from the CC-CEDICT dump.
//
// CC-CEDICT (https://www.mdbg.net/chinese/dictionary?page=cc-cedict) is
// CC BY-SA 4.0. The generated asset is a derivative and carries the same
// licence; the attribution lives in README.md and in the page footer.
//
// Input:  data/cedict.txt.gz  (falls back to scratch/cedict.txt.gz)
// Output: public/cedict.json  (Vite copies public/ into dist/client, which is
//         the `assets.directory` in wrangler.jsonc, so the Worker reads it
//         through env.ASSETS)
//
// All the parsing and selection rules live in src/shared/cedict.ts so the tests
// can pin them. This file is only IO. Deterministic: same input, same bytes.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildDict } from '../src/shared/cedict.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [join(root, 'data', 'cedict.txt.gz'), join(root, 'scratch', 'cedict.txt.gz')];
const source = sources.find((p) => existsSync(p));
if (!source) {
  console.error(
    `build:dict: no CC-CEDICT dump found. Looked for:\n  ${sources.join('\n  ')}\n` +
      'Download cedict_1_0_ts_utf-8_mdbg.txt.gz from https://www.mdbg.net/chinese/dictionary?page=cc-cedict'
  );
  process.exit(1);
}

const started = Date.now();
const raw = source.endsWith('.gz')
  ? gunzipSync(readFileSync(source)).toString('utf8')
  : readFileSync(source, 'utf8');

const asset = buildDict(raw.split('\n'));
const json = JSON.stringify(asset);

const outDir = join(root, 'public');
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'cedict.json');
writeFileSync(outPath, json, 'utf8');

const bytes = Buffer.byteLength(json, 'utf8');
console.log(
  `build:dict: ${Object.keys(asset.e).length} headwords -> public/cedict.json ` +
    `(${(bytes / 1024 / 1024).toFixed(2)} MB, ${Date.now() - started} ms) from ${source.slice(root.length + 1)}`
);

