// The vendored design kit (src/vendor/homerslab) is Homeward's, unchanged: every file matches vendor.json, and nothing
// else is in the folder. A change comes only from scripts/sync-design.sh, which rewrites vendor.json from the source.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(import.meta.dirname, '../src/vendor/homerslab');
const manifest = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8')) as { commit: string; source: string; license: string; files: Record<string, string> };
const sha = (f: string) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex');
const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dir, join(d, n))]));

describe('the vendored HomersLab design kit', () => {
  it('names its source, commit and licence', () => {
    expect(manifest.source).toBe('https://github.com/ArjunRachithcf/homeward');
    expect(manifest.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(manifest.license).toMatch(/^Apache-2\.0/);
  });

  it.each(Object.keys(manifest.files))('%s is unchanged (re-sync with scripts/sync-design.sh, never edit it)', (f) => {
    expect(sha(f)).toBe(manifest.files[f]);
  });

  it('holds nothing but the kit, its manifest and its note', () => {
    expect(walk(dir).sort()).toEqual([...Object.keys(manifest.files), 'README.md', 'vendor.json'].sort());
  });
});
