// The morning batch's timer (PR #12 review, L8): a batch that failed is tried again 15 minutes later, while it is
// still due, instead of waiting for tomorrow's 08:00.
import { afterEach, expect, it, vi } from 'vitest';
import * as t from '../src/db/schema';
import { RETRY_MS, scheduleMorning } from '../src/jobs/morning';
import { household } from './helpers';

afterEach(() => { vi.useRealTimers(); });

it('a failed batch is tried again 15 minutes later, until one succeeds; then not before the next morning', () => {
  vi.useFakeTimers({ now: new Date('2026-12-01T09:00:00Z') });
  const db = household();
  const runs: string[] = [];
  const failures: unknown[] = [];
  let fail = 2;
  const stop = scheduleMorning(db, { timezone: 'UTC' }, (now) => {
    runs.push(now.toISOString());
    if (fail-- > 0) throw new Error('the disk was busy');
    db.insert(t.jobRun).values({ name: 'morning', day: '2026-12-01', at: now.toISOString() }).run();
  }, (e) => failures.push(e));
  vi.advanceTimersByTime(RETRY_MS);
  vi.advanceTimersByTime(RETRY_MS);
  vi.advanceTimersByTime(6 * 3_600_000);
  stop();
  expect(runs).toEqual(['2026-12-01T09:00:00.000Z', '2026-12-01T09:15:00.000Z', '2026-12-01T09:30:00.000Z']);
  expect(failures).toHaveLength(2);
});
