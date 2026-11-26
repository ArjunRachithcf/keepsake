// scripts/smoke.sh runs under `set -o pipefail`: a pipe into `grep -q` can fail when grep stops at its first match and
// the writer dies of SIGPIPE (PR #14 review, a flaky "failed for another reason"). The script reads output whole first.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = readFileSync(fileURLToPath(new URL('../../../scripts/smoke.sh', import.meta.url)), 'utf8');

describe('scripts/smoke.sh', () => {
  it('runs with pipefail and never pipes into grep -q', () => {
    expect(script).toMatch(/set -euo pipefail/);
    const lines = script.split('\n').filter((l) => !l.trimStart().startsWith('#'));
    expect(lines.filter((l) => /\|\s*grep\s+-q/.test(l))).toEqual([]);
  });
});
