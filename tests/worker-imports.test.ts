// pinyin-pro runs a `setTimeout` at module scope (scheduleAcBuild) building its
// segmentation automaton. That is fine in a browser (src/client/*), and fatal
// in the Workers runtime: "Disallowed operation called within global scope"
// the moment src/worker/extract.ts pulls it in transitively through
// src/shared/extract.ts (commit 5099137). Reproduced live 2026-09-08 with
// `wrangler dev`: the Worker refused to start.
//
// This is a static guard, not a runtime one: it reads every file the Worker
// depends on (src/shared/*.ts and src/worker/*.ts) and fails if any of them
// imports 'pinyin-pro'. src/shared/* must stay import-clean of it because the
// Worker imports src/shared/*; only src/client/* may use it.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function tsFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f));
}

describe('the Worker never pulls in pinyin-pro', () => {
  const files = [...tsFilesIn('src/shared'), ...tsFilesIn('src/worker')];

  it('checked at least the shared and worker modules', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    it(`${file} does not import 'pinyin-pro'`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/from\s+['"]pinyin-pro['"]/);
    });
  }
});

