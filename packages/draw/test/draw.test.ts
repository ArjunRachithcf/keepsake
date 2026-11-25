import { describe, expect, it } from 'vitest';
import { DRAW_RULES_VERSION } from '../src/index';

// Placeholder until M3 (ADR 0004): the package builds, imports and runs under the unit project.
describe('@keepsake/draw', () => {
  it('has no rules yet (M3)', () => {
    expect(DRAW_RULES_VERSION).toBe(0);
  });
});
