import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { evidenceBridge, inventory, sha256, loadFixture } from '../adapter.mjs';
import { queryPlan, validWeekly } from '../queries.mjs';

const weekly = { metric: 'weekly_order_count' };
const week = { ...weekly, start_week: '2026-01-05', end_week: '2026-01-12' };
const rows = [{ week_start: '2025-12-29', order_count: 3 }, { week_start: '2026-01-05', order_count: 4 }, { week_start: '2026-01-12', order_count: 5 }];
const result = (plan, data = rows) => ({ columns: ['week_start', 'order_count'], rows: structuredClone(data),
  definition: { sql: plan.sql, source_tables: ['orders'], filters: plan.filters } });

test('dates are real UTC Mondays, paired, ordered and bounded; no SQL or arbitrary keys', () => {
  const bridge = evidenceBridge(() => assert.fail('invalid input must never query'));
  for (const args of [null, [], {}, { metric: 'unknown' }, { ...weekly, start_week: '2026-01-05' },
    { ...week, end_week: '2026-01-05' }, { ...week, start_week: '2026-01-12' },
    { ...week, start_week: '2026-02-30' }, { ...week, start_week: '2026-01-06' },
    { ...week, start_week: "2026-01-05' OR 1=1--" }, { ...week, end_week: '2028-01-03' },
    { ...week, start_week: '2026-01-05T00:00:00Z' }, { ...week, timezone: 'local' },
    { ...weekly, sql: 'SELECT secret' }, { ...week, metric: 'order_count' }]) {
    assert.equal(bridge.tool.validate(args), false, JSON.stringify(args));
    assert.throws(() => queryPlan(args), /unavailable/);
  }
  assert.equal(bridge.tool.validate(weekly), true); assert.equal(bridge.tool.validate(week), true);
  assert.equal(queryPlan(weekly).limit, 54, 'detect overflow instead of silently truncating to 53');
});

test('weekly evidence preserves host rows and private definition, consumes token, and rejects prose', async () => {
  const bridge = evidenceBridge(async (_signal, plan) => result(plan));
  const signal = new AbortController().signal;
  const token = await bridge.tool.execute(weekly, signal);
  const answer = bridge.projection.project(token);
  assert.deepEqual(answer.rows, rows); assert.equal(answer.timezone, 'UTC'); assert.equal(answer.period, null);
  assert.ok(bridge.projection.validate(answer));
  assert.deepEqual(bridge.evidenceFor(answer.evidence.id).definition, result(queryPlan(weekly)).definition);
  for (const forbidden of ['SELECT ', 'order_date', token.evidence]) assert.ok(!JSON.stringify(answer).includes(forbidden));
  assert.throws(() => bridge.projection.project(token), /unavailable/);
  for (const extra of [{ rows: [{ week_start: '2026-01-05', order_count: 999 }] }, { summary: 'SECRET' }, { definition: 'SECRET' }]) {
    const fresh = await bridge.tool.execute(weekly, signal);
    assert.throws(() => bridge.projection.project({ ...fresh, ...extra }), /unavailable/);
  }
  const latest = await bridge.tool.execute(weekly, signal);
  assert.throws(() => bridge.projection.project({ evidence: 'forged' }), /unavailable/);
  assert.throws(() => bridge.projection.project(latest), /unavailable/);
});

test('weekly rows fail closed on small groups, changed definitions, overflow, order and range violations', async () => {
  for (const mutate of [r => r.rows[0].order_count = 2, r => r.rows[0].order_count = 0,
    r => r.rows[0].order_count = 3.5, r => r.rows[0].order_count = '3',
    r => r.rows[0].week_start = '2025-12-30', r => r.rows[0].raw = 'SECRET',
    r => r.rows.reverse(), r => r.rows.push(r.rows.at(-1)), r => r.rows = Array(54).fill(r.rows[0]),
    r => r.columns.push('raw'), r => r.definition.sql += ' LIMIT 1', r => r.definition.filters = ['SECRET'],
    r => r.definition.source_tables = ['customers'], r => r.summary = 'SECRET',
    r => r.rows.at(-1).week_start = '2027-01-04']) {
    const bridge = evidenceBridge(async (_signal, plan) => { const r = result(plan); mutate(r); return r; });
    await assert.rejects(bridge.tool.execute(weekly, new AbortController().signal), /unavailable/);
  }
  const outOfRange = evidenceBridge(async (_signal, plan) => result(plan));
  await assert.rejects(outOfRange.tool.execute(week, new AbortController().signal), /unavailable/);
  assert.equal(validWeekly({ kind: 'weekly_orders', timezone: 'UTC', week_starts_on: 'Monday', period: { start_week: 'x' }, rows: [] }), false);
});

test('cancellation, expiry and replacement cannot reuse weekly evidence', async () => {
  const bridge = evidenceBridge(async (_signal, plan) => result(plan));
  const c = new AbortController();
  const token = await bridge.tool.execute(weekly, c.signal); c.abort();
  assert.throws(() => bridge.projection.project(token), /unavailable/);
  const signal = new AbortController().signal;
  const expired = await bridge.tool.execute(weekly, signal), now = Date.now;
  try { Date.now = () => now() + 31000; assert.throws(() => bridge.projection.project(expired), /unavailable/); }
  finally { Date.now = now; }
  const old = await bridge.tool.execute(weekly, signal);
  await bridge.tool.execute(weekly, signal);
  assert.throws(() => bridge.projection.project(old), /unavailable/);
});

test('real Wren: UTC year/Sunday/Monday boundaries, whole and filtered weeks, empty range and unchanged fixture', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const python = process.env.FIXTURE_PYTHON || join(root, 'core/wren/.venv/bin/python');
  const wren = process.env.FIXTURE_WREN || join(root, 'core/wren/.venv/bin/wren');
  const dir = await mkdtemp(join(tmpdir(), 'wren-weekly-'));
  try {
    const fixture = join(dir, 'fixture');
    execFileSync(python, [fileURLToPath(new URL('../setup_fixture.py', import.meta.url)), fixture]);
    const binding = { ...JSON.parse(await readFile(join(fixture, 'fixture.json'))), executable: resolve(wren), database: join(fixture, 'data/jaffle.duckdb') };
    binding.projectFiles = await inventory(binding.project); binding.homeFiles = await inventory(binding.home);
    binding.databaseSha256 = sha256(await readFile(binding.database));
    const child = (await loadFixture(binding, 'jaffle')).children.data_worker;
    const run = async args => child.projection.project(await child.tools[0].execute(args, new AbortController().signal));
    assert.equal((await run({ metric: 'order_count' })).value, 12);
    const all = await run(weekly); assert.deepEqual(all.rows, rows);
    const selected = await run(week); assert.deepEqual(selected.rows, [rows[1]]);
    assert.deepEqual(selected.period, { start_week: '2026-01-05', end_week: '2026-01-12' });
    assert.notEqual(all.evidence.id, selected.evidence.id);
    const first = await run({ ...weekly, start_week: '2025-12-29', end_week: '2026-01-05' });
    assert.deepEqual(first.rows, [rows[0]]);
    const empty = await run({ ...weekly, start_week: '2026-02-02', end_week: '2026-02-09' });
    assert.deepEqual(empty.rows, []); assert.ok(child.projection.validate(empty));
    assert.equal(sha256(await readFile(binding.database)), binding.databaseSha256);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
