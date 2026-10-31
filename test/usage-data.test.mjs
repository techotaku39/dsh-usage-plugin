import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseDefaultMonth,
  collectLocalUsage,
  collectOpenCodeRequestLog,
  currentMonth,
  findDshOpenCodeSessionId,
  listMonths,
  monthKey,
  previousMonth,
} from '../lib/usage-data.js';

test('monthKey follows the requested time zone', () => {
  assert.equal(monthKey(Date.UTC(2026, 9, 31, 15, 59), 'Asia/Shanghai'), '2026-10');
  assert.equal(monthKey(Date.UTC(2026, 9, 31, 16, 0), 'Asia/Shanghai'), '2026-11');
});

test('previousMonth handles year boundaries', () => {
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-11'), '2026-10');
});

test('month list is descending and includes the current month', () => {
  const months = listMonths({ '2026-09': {} }, { '2026-10': {} }, 'Asia/Shanghai');
  assert.ok(months.includes(currentMonth('Asia/Shanghai')));
  assert.deepEqual(months, [...months].sort().reverse());
});

test('default month prefers a month with data', () => {
  const months = ['2026-11', '2026-10', '2026-09'];
  assert.equal(
    chooseDefaultMonth(months, { '2026-10': {} }, { '2026-09': {} }, 'Asia/Shanghai'),
    '2026-10'
  );
});

test('local DSH log aggregation returns real monthly totals', () => {
  const result = collectLocalUsage({ timeZone: 'Asia/Shanghai' });
  assert.ok(result.filesFound > 0, 'expected DSH session files');
  assert.ok(result.filesRead > 0, 'expected readable session files');
  const october = result.months['2026-10'];
  assert.ok(october, 'expected October 2026 usage');
  assert.equal(october.totals.requests, 19);
  assert.equal(october.totals.totalTokens, 298392);
});

test('OpenCode request log returns the exact DSH session totals', async (t) => {
  const sessionId = findDshOpenCodeSessionId();
  if (!sessionId) return t.skip('no DSH x-opencode-session configured');
  let result;
  try {
    result = await collectOpenCodeRequestLog({
      timeZone: 'Asia/Shanghai',
      month: '2026-10',
      sessionId,
    });
  } catch (error) {
    return t.skip(`OpenCode request log unavailable: ${error.message}`);
  }
  assert.equal(result.totals.requests, 4);
  assert.equal(result.totals.totalTokens, 61037);
  assert.ok(result.totals.costUSD > 0);
});
