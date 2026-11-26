// Words and numbers as the household reads them (UI round 4's click-through fixes): dates day first (never the US
// order), the passkey's sensible name, the draw's "Kids draw too" line, plurals, page titles, how screens move, and a
// group gift that never says more than "enough" or "not enough yet" and your own share.
import { describe, expect, it } from 'vitest';
import { dateTime, day, dayMonth, money, numericDate, setTimeZone, since, weekdayDate } from '../src/format';
import { kidsDrawWords } from '../src/draw';
import { groupWords } from '../src/gift';
import { count, rowsLeftOut } from '../src/import';
import { move } from '../src/router';
import { tabTitle } from '../src/ui';
import { deviceWord, passkeyName } from '../src/pages/SignIn';

describe('dates, day first', () => {
  const now = new Date('2026-11-26T12:00:00Z');
  it('writes a calendar day as 25.12.2026, with its weekday, or without its year', () => {
    expect(numericDate('2026-12-25')).toBe('25.12.2026');
    expect(weekdayDate('2026-12-25')).toBe('Fri 25.12.2026');
    expect(weekdayDate('2027-01-09')).toBe('Sat 09.01.2027');
    expect(dayMonth('2026-05-02')).toBe('02.05.');
  });
  it('writes when something happened as 26 Nov, its year only when it is not this year', () => {
    expect(day('2026-11-26', now)).toBe('26 Nov');
    expect(day('2025-12-24', now)).toBe('24 Dec 2025');
    // an instant is the day it is on this device
    expect(day(new Date(2026, 10, 26, 23, 30).toISOString(), now)).toBe('26 Nov');
  });
  it('is never the US order, whatever the browser is set to', () => {
    expect(numericDate('2026-03-04')).toBe('04.03.2026');
    expect(weekdayDate('2026-03-04')).not.toMatch(/3\/4|March 4/);
  });
  it('writes a time on the 24-hour clock', () => {
    expect(dateTime(new Date(2026, 11, 24, 18, 5).toISOString())).toBe('Thu 24.12.2026, 18:05');
  });
  it('dates a profile part by its month', () => {
    expect(since('2026-10-03T10:00:00.000Z')).toBe('from October 2026');
    expect(since(null)).toBe('');
  });
  it('writes a price with its cents', () => {
    expect(money(8900, 'CHF')).toMatch(/89\.00/);
    expect(money(4550, 'CHF')).toMatch(/45\.50/);
  });
});

describe('times in the household\'s time zone, not the device\'s', () => {
  it('writes the household\'s day and time even where the device is elsewhere and the day would flip', () => {
    const was = process.env.TZ;
    process.env.TZ = 'America/New_York';
    try {
      const drawn = '2026-11-26T23:30:00.000Z'; // 18:30 on the 26th in New York, 00:30 on the 27th in Zurich
      const now = new Date('2026-11-27T08:00:00Z');
      setTimeZone(null);
      expect(day(drawn, now)).toBe('26 Nov');
      setTimeZone('Europe/Zurich');
      expect(day(drawn, now)).toBe('27 Nov');
      expect(dateTime(drawn)).toBe('Fri 27.11.2026, 00:30');
      expect(weekdayDate(drawn)).toBe('Fri 27.11.2026');
      // the year turns there too
      expect(day('2026-12-31T23:30:00.000Z', new Date('2026-12-31T12:00:00Z'))).toBe('1 Jan 2027');
      // a calendar day stays the day it is, wherever
      expect(weekdayDate('2026-12-25')).toBe('Fri 25.12.2026');
    } finally { setTimeZone(null); if (was === undefined) delete process.env.TZ; else process.env.TZ = was; }
  });
});

describe('a new passkey\'s name', () => {
  it('is the person\'s and the device\'s', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    expect(passkeyName('Inês', iphone)).toBe('Inês’s iPhone');
    expect(passkeyName(' Leo ', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36')).toBe('Leo’s Mac');
    expect(passkeyName('', iphone)).toBe('This iPhone');
    expect(passkeyName('', 'curl/8')).toBe('This device');
  });
  it('knows the usual devices', () => {
    expect(deviceWord('Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile Safari')).toBe('Android phone');
    expect(deviceWord('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC');
    expect(deviceWord('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux PC');
  });
});

describe('the words that follow a state', () => {
  it('"Kids draw too" says what it is now', () => {
    expect(kidsDrawWords(true, ['Mia'])).toBe('On: Mia draws a name as well.');
    expect(kidsDrawWords(true, ['Mia', 'Leo'])).toBe('On: Mia and Leo draw a name as well.');
    expect(kidsDrawWords(false, ['Mia'])).toBe('Off: only grown-ups draw names.');
  });
  it('counts rows, wishes and claims in the singular and the plural', () => {
    expect(rowsLeftOut(1)).toBe('1 row left out');
    expect(rowsLeftOut(2)).toBe('2 rows left out');
    expect(rowsLeftOut(0)).toBe('0 rows left out');
    expect(count(1, 'wish', 'wishes')).toBe('1 wish');
    expect(count(6, 'wish', 'wishes')).toBe('6 wishes');
  });
  it('titles a page once: never "Keepsake · Keepsake"', () => {
    expect(tabTitle('Keepsake')).toBe('Keepsake');
    expect(tabTitle('My wishes')).toBe('My wishes · Keepsake');
  });
});

describe('how a screen moves', () => {
  it('pushes into a detail, pops back, fades between tabs', () => {
    expect(move('/family', '/family/p_leo')).toBe('push');
    expect(move('/family/p_leo', '/family')).toBe('pop');
    expect(move('/family', '/household')).toBe('push');
    expect(move('/celebrations', '/celebrations/c_xmas')).toBe('push');
    expect(move('/', '/family')).toBe('fade');
    expect(move('/family/p_leo', '/celebrations/c_xmas')).toBe('fade');
  });
});

describe('a group gift says only enough or not, and your own share (ADR 0003)', () => {
  const g = (over: object) => ({ organizer: null, targetMinor: 12000, enough: false, state: 'open' as const, givers: [{ giver: null, mine: true }, { giver: { id: 'p_t', name: 'Tomás' }, mine: false }], myShareMinor: 4000, canManage: false, ...over });
  it('never a total, never what the others gave', () => {
    const w = groupWords(g({}), 'CHF');
    expect(w.state).toBe('Not enough yet');
    expect(w.mine).toMatch(/^Your share CHF.?40\.00$/);
    expect(JSON.stringify(w)).not.toMatch(/80|120/);
    expect(groupWords(g({ enough: true }), 'CHF').state).toBe('Enough');
    expect(groupWords(g({ myShareMinor: null }), 'CHF').mine).toBeNull();
  });
});
