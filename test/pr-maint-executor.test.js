import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ActionExecutor, effectiveMode, actionKey, BREAKER_MS } from '../src/core/executor.js';
import { MARKERS, MERGE_POLICY_CONTEXT } from '../src/core/policy.js';

const OWNER = 'iamgerwin';
const SHA = 'a'.repeat(40);
const NOW = Date.UTC(2026, 9, 17, 12);

function snapshotPr(overrides = {}) {
  return {
    number: 7, author: OWNER, isCrossRepository: false, headRefOid: SHA, state: 'OPEN',
    labels: [], reviewThreads: [], reviews: [], ...overrides
  };
}

const labelAdd = (label, pr = 7) => ({ type: 'label.add', scope: 'pr', pr, headSha: SHA, payload: { label } });
const sticky = (body) => ({ type: 'comment.upsert', scope: 'pr', pr: 7, headSha: SHA, payload: { marker: 'status', body } });
const dashboard = () => ({
  type: 'comment.upsert', scope: 'dashboard', pr: null, headSha: null,
  payload: { marker: 'dashboard', body: `${MARKERS.dashboard}\nok` }
});

function setup(t, { mode = 'act', policy, fresh, caps, dryRun = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-pr-maint-exec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const handler = (name) => async (action) => { calls.push({ name, action }); return { written: 1, id: 1, number: 1 }; };
  const state = { writes: [], breaker: null };
  const executor = new ActionExecutor({
    mode,
    handlers: {
      'label.add:pr': handler('label.add'),
      'label.remove:pr': handler('label.remove'),
      'comment.upsert:pr': handler('sticky'),
      'comment.upsert:dashboard': handler('dashboard'),
      'status.post:pr': handler('status')
    },
    fresh: fresh || (async () => ({ headRefOid: SHA, state: 'OPEN', labels: [] })),
    state,
    ctx: { owner: OWNER, authors: [OWNER], caps },
    repo: 'iamgerwin/demo',
    dryRun,
    now: () => NOW,
    decisionsFile: path.join(dir, 'decisions.jsonl'),
    ...(policy ? { policy } : {})
  });
  const decisions = () => {
    const file = path.join(dir, 'decisions.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  };
  return { executor, calls, state, decisions };
}

test('shadow executor writes only the dashboard, even when the policy allows everything', async (t) => {
  const { executor, calls } = setup(t, { mode: 'shadow', policy: () => ({ allowed: true }) });

  const label = await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() });
  assert.equal(label.status, 'denied');
  assert.equal(label.verdict.rule, 'mode');
  const comment = await executor.run(sticky(`${MARKERS.status}\nx`), { snapshotPr: snapshotPr() });
  assert.equal(comment.status, 'denied');

  const dash = await executor.run(dashboard());
  assert.equal(dash.status, 'done');
  assert.deepEqual(calls.map(c => c.name), ['dashboard']);
});

test('shadow executor never re-reads the PR head (no live reads for denied writes)', async (t) => {
  let reads = 0;
  const { executor } = setup(t, { mode: 'shadow', fresh: async () => { reads++; return {}; } });
  await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() });
  assert.equal(reads, 0);
});

test('an impossible denial trips the breaker, escalates the PR, and drops the mode for the rest of the tick', async (t) => {
  const { executor, calls, state, decisions } = setup(t, { mode: 'act' });

  const bad = await executor.run(sticky(`${MARKERS.status}\nCo-Authored-By: someone`), { snapshotPr: snapshotPr() });
  assert.equal(bad.status, 'denied');
  assert.equal(bad.verdict.rule, 'text-safety');
  assert.equal(state.breaker.from, 'act');
  assert.equal(state.breaker.to, 'shadow');
  assert.equal(state.breaker.until, NOW + BREAKER_MS);
  assert.deepEqual(executor.escalations.map(e => [e.pr, e.reason]), [[7, 'policy-denial']]);
  assert.equal(executor.mode, 'shadow');

  const next = await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() });
  assert.equal(next.verdict.rule, 'mode');
  assert.deepEqual(calls, []);
  assert.deepEqual(decisions().map(d => [d.verdict, d.rule, d.mode]), [['deny', 'text-safety', 'act'], ['deny', 'mode', 'shadow']]);
});

test('a denied action is never retried in the same tick', async (t) => {
  let checks = 0;
  const { executor } = setup(t, { policy: () => { checks++; return { allowed: false, rule: 'lifecycle', kind: 'deny', reason: 'x' }; } });
  assert.equal((await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() })).status, 'denied');
  assert.equal((await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() })).status, 'skipped');
  assert.equal(checks, 1);
});

test('the per-PR rate cap denies the overflow write and trips the breaker without escalating', async (t) => {
  const { executor, calls, state } = setup(t, { caps: { writesPerPrPerTick: 1 } });
  assert.equal((await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() })).status, 'done');
  const second = await executor.run(labelAdd('conflict-resolved'), { snapshotPr: snapshotPr() });
  assert.equal(second.verdict.rule, 'rate');
  assert.equal(state.breaker.to, 'shadow');
  assert.deepEqual(executor.escalations, []);
  assert.equal(calls.length, 1);
  assert.deepEqual(state.writes, [NOW]);
});

test('setup writes spend the hourly budget and pause at the cap without tripping the breaker', async (t) => {
  const { executor, state, decisions } = setup(t, { caps: { writesPerHour: 2 } });
  let done = 0;
  const write = async () => { done++; };
  assert.equal(await executor.runSetup('create label a', write), true);
  assert.equal(await executor.runSetup('create label b', write), true);
  assert.equal(await executor.runSetup('create label c', write), false);
  assert.equal(done, 2);
  assert.deepEqual(state.writes, [NOW, NOW]);
  assert.equal(state.breaker, null);
  assert.equal(executor.mode, 'act');
  assert.deepEqual(decisions().map(d => [d.type, d.verdict, d.rule || null]), [
    ['setup', 'allow', null], ['setup', 'allow', null], ['setup', 'deny', 'rate']
  ]);

  const shadow = setup(t, { mode: 'shadow' });
  assert.equal(await shadow.executor.runSetup('create label d', write), false, 'shadow never runs setup');
  assert.deepEqual(shadow.decisions().map(d => [d.type, d.verdict, d.rule || null]), [['setup', 'deny', 'mode']]);
});

test('a dashboard upsert at the hourly cap is denied without tripping the breaker', async (t) => {
  const { executor, state, calls } = setup(t, { caps: { writesPerHour: 1 } });
  state.writes = [NOW - 1000];
  const outcome = await executor.run(dashboard());
  assert.equal(outcome.status, 'denied');
  assert.equal(outcome.verdict.rule, 'rate');
  assert.equal(state.breaker, null);
  assert.equal(executor.mode, 'act');
  assert.deepEqual(calls, []);
});

test('the fresh read receives the action, so a needs-human clear can ask for live checks', async (t) => {
  const seen = [];
  const { executor } = setup(t, { fresh: async (number, action) => { seen.push([number, action.type]); return { headRefOid: SHA, state: 'OPEN', labels: [] }; } });
  await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() });
  assert.deepEqual(seen, [[7, 'label.add']]);
});

test('the head pin re-reads the PR and refuses a write after the head moved', async (t) => {
  const { executor, calls } = setup(t, { fresh: async () => ({ headRefOid: 'b'.repeat(40), state: 'OPEN', labels: [] }) });
  const result = await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() });
  assert.equal(result.verdict.rule, 'head-pin');
  assert.deepEqual(calls, []);
});

test('live labels from the head pin feed the lifecycle invariant', async (t) => {
  const { executor } = setup(t, { fresh: async () => ({ headRefOid: SHA, state: 'OPEN', labels: ['sdg:waiting'] }) });
  const result = await executor.run(labelAdd('sdg:conflict'), { snapshotPr: snapshotPr() });
  assert.equal(result.verdict.rule, 'lifecycle');
});

test('in shadow, a would-be removal is simulated so the following add is judged on the would-be labels', async (t) => {
  const { executor, decisions } = setup(t, { mode: 'shadow' });
  const pr = snapshotPr({ labels: ['sdg:waiting'] });
  await executor.run({ type: 'label.remove', scope: 'pr', pr: 7, headSha: SHA, payload: { label: 'sdg:waiting' } }, { snapshotPr: pr });
  const add = await executor.run(labelAdd('sdg:conflict'), { snapshotPr: pr });
  assert.equal(add.verdict.rule, 'mode');
  assert.deepEqual(pr.labels, ['sdg:waiting'], 'the snapshot itself is untouched');
  assert.deepEqual(decisions().map(d => d.rule), ['mode', 'mode']);
});

test('decisions are logged with comment bodies reduced to a hash', async (t) => {
  const { executor, decisions } = setup(t);
  await executor.run(sticky(`${MARKERS.status}\nhello`), { snapshotPr: snapshotPr() });
  const [record] = decisions();
  assert.equal(record.verdict, 'allow');
  assert.equal(record.outcome, 'written');
  assert.equal(record.payload.body, undefined);
  assert.match(record.payload.bodySha1, /^[0-9a-f]{40}$/);
});

test('a dry run evaluates and simulates but writes nothing, not even the decisions log', async (t) => {
  const { executor, calls, decisions } = setup(t, { dryRun: true });
  const result = await executor.run(labelAdd('sdg:waiting'), { snapshotPr: snapshotPr() });
  assert.equal(result.status, 'planned');
  assert.deepEqual(calls, []);
  assert.deepEqual(decisions(), []);
  assert.equal(executor.decisions.length, 1);
});

test('status posts reach their handler with the pinned head', async (t) => {
  const { executor, calls } = setup(t);
  const action = { type: 'status.post', scope: 'pr', pr: 7, headSha: SHA, payload: { context: MERGE_POLICY_CONTEXT, state: 'pending', description: 'x' } };
  assert.equal((await executor.run(action, { snapshotPr: snapshotPr() })).status, 'done');
  assert.equal(calls[0].action.headSha, SHA);
});

test('effectiveMode caps the configured mode while the breaker is active', () => {
  const breaker = { until: NOW + 1000, to: 'act' };
  assert.equal(effectiveMode('autonomous', breaker, NOW), 'act');
  assert.equal(effectiveMode('shadow', breaker, NOW), 'shadow');
  assert.equal(effectiveMode('autonomous', breaker, NOW + 1000), 'autonomous');
  assert.equal(effectiveMode('act', null, NOW), 'act');
});

test('actionKey tells different bodies apart without embedding them', () => {
  assert.notEqual(actionKey(sticky('a')), actionKey(sticky('b')));
  assert.equal(actionKey(sticky('a')), actionKey(sticky('a')));
  assert.ok(!actionKey(sticky('secret body')).includes('secret body'));
});
