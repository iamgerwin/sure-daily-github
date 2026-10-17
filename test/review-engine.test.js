import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import {
  buildEngineCommand,
  runEngine,
  runTriage,
  runImplement,
  parseTriage,
  createReviewEngine
} from '../src/utils/review-engine.js';
import { runProcess } from '../src/utils/process.js';

const pr = { number: 7, title: 'Add thing', repoFullName: 'me/demo', headRef: 'feature', baseRef: 'main' };
const comments = [
  { id: 'review_comment:1', kind: 'review_comment', author: 'alice', path: 'a.js', line: 3, body: 'off by one' },
  { id: 'review:2', kind: 'review', author: 'coderabbitai[bot]', path: null, line: null, body: 'nit: naming' }
];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-engine-'));
}

// Records the spawn call and optionally writes a file, like a real engine would
function stubRunner({ write, result = { code: 0, stdout: 'ok', stderr: '' } } = {}) {
  const calls = [];
  const runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (write) write(args, opts);
    return result;
  };
  return { runner, calls };
}

test('buildEngineCommand builds opencode and claude argument arrays', () => {
  assert.deepEqual(buildEngineCommand('opencode', 'openai/gpt-6.1-sol', 'do it'), {
    cmd: 'opencode', args: ['run', '--auto', '--model', 'openai/gpt-6.1-sol', 'do it']
  });
  assert.deepEqual(buildEngineCommand('claude', 'opus', 'do it'), {
    cmd: 'claude', args: ['--model', 'opus', '-p', 'do it', '--permission-mode', 'acceptEdits']
  });
  assert.throws(() => buildEngineCommand('gpt', 'x', 'y'), /Unsupported review engine: gpt/);
});

test('runEngine passes the prompt as a single argument in the PR workdir', async () => {
  const { runner, calls } = stubRunner();
  const prompt = 'fix `rm -rf /` $(whoami); "quoted"';
  const result = await runEngine('opencode', 'm', { cwd: '/tmp/work', prompt, timeoutMs: 1000, runner, env: { A: '1' } });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ok');
  assert.equal(calls[0].cmd, 'opencode');
  assert.equal(calls[0].args.at(-1), prompt);
  assert.deepEqual(calls[0].opts, { cwd: '/tmp/work', env: { A: '1' }, timeoutMs: 1000 });
});

test('runTriage reads decisions from the JSON file named in the prompt', async () => {
  const outputFile = path.join(tmpDir(), 'triage.json');
  const { runner, calls } = stubRunner({
    write: () => fs.writeFileSync(outputFile, JSON.stringify({
      comments: [
        { id: 'review_comment:1', action: 'fix', reasoning: 'real bug', plan: 'use <=' },
        { id: 'review:2', action: 'wontfix', reasoning: 'name matches the API' }
      ]
    }))
  });

  const result = await runTriage({ engine: 'claude', model: 'm', cwd: '/w', pr, comments, diff: 'diff', outputFile, runner });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.decisions, [
    { id: 'review_comment:1', action: 'fix', reasoning: 'real bug', plan: 'use <=' },
    { id: 'review:2', action: 'wontfix', reasoning: 'name matches the API', plan: '' }
  ]);

  const prompt = calls[0].args[calls[0].args.indexOf('-p') + 1];
  assert.ok(prompt.includes(outputFile), 'prompt names the output file');
  assert.ok(prompt.includes('off by one'), 'prompt includes the comments');
  assert.ok(prompt.includes('review_comment:1'));
});

test('runTriage ignores stdout and fails when the engine writes no file', async () => {
  const outputFile = path.join(tmpDir(), 'triage.json');
  fs.writeFileSync(outputFile, '{"comments":[]}'); // stale output from an earlier run
  const { runner } = stubRunner({ result: { code: 0, stdout: '{"comments":[{"id":"review:2","action":"note","reasoning":"x"}]}', stderr: '' } });

  const result = await runTriage({ engine: 'opencode', model: 'm', cwd: '/w', pr, comments, diff: '', outputFile, runner });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not write the triage file/);
});

test('runTriage reports invalid JSON, bad actions, and missing reasoning', async () => {
  const outputFile = path.join(tmpDir(), 'triage.json');
  const cases = [
    ['not json', /not valid JSON/],
    ['{"decisions":[]}', /"comments" array/],
    [JSON.stringify({ comments: [{ id: 'review:2', action: 'merge', reasoning: 'x' }] }), /must be one of: fix, defer, wontfix, note/],
    [JSON.stringify({ comments: [{ id: 'review:2', action: 'note', reasoning: ' ' }] }), /reasoning for review:2 is missing/]
  ];
  for (const [raw, pattern] of cases) {
    const { runner } = stubRunner({ write: () => fs.writeFileSync(outputFile, raw) });
    const result = await runTriage({ engine: 'opencode', model: 'm', cwd: '/w', pr, comments, diff: '', outputFile, runner });
    assert.equal(result.ok, false);
    assert.match(result.error, pattern);
  }
});

test('parseTriage reports undecided ids and ignores unknown or duplicate ones', () => {
  const result = parseTriage(JSON.stringify({
    comments: [
      { id: 'review:2', action: 'note', reasoning: 'summary only' },
      { id: 'review:2', action: 'fix', reasoning: 'dup' },
      { id: 'review:999', action: 'fix', reasoning: 'not ours' }
    ]
  }), ['review_comment:1', 'review:2']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.decisions.map(d => [d.id, d.action]), [['review:2', 'note']]);
  assert.deepEqual(result.missing, ['review_comment:1']);
});

test('runTriage fails on a non-zero exit, a spawn error, or a timeout', async () => {
  const outputFile = path.join(tmpDir(), 'triage.json');
  const cases = [
    [{ code: 2, stdout: '', stderr: 'model not found' }, /exited with code 2: model not found/],
    [{ code: null, stdout: '', stderr: '', error: new Error('spawn opencode ENOENT') }, /could not be started: spawn opencode ENOENT/],
    [{ code: null, stdout: '', stderr: '', timedOut: true }, /timed out/]
  ];
  for (const [result, pattern] of cases) {
    const { runner } = stubRunner({ result, write: () => fs.writeFileSync(outputFile, '{"comments":[]}') });
    const triage = await runTriage({ engine: 'opencode', model: 'm', cwd: '/w', pr, comments, diff: '', outputFile, runner });
    assert.equal(triage.ok, false);
    assert.match(triage.error, pattern);
  }
});

test('runImplement returns the parsed report, or null when none was written', async () => {
  const reportFile = path.join(tmpDir(), 'implement.json');
  const items = [{ comment: comments[0], decision: { action: 'fix', reasoning: 'r', plan: 'use <=' } }];

  let { runner, calls } = stubRunner({
    write: () => fs.writeFileSync(reportFile, JSON.stringify({
      fixes: [{ id: 'review_comment:1', summary: 'use <=', locations: [{ path: 'a.js', line: 3 }, { path: '' }, { path: 'b.js' }] }]
    }))
  });
  let result = await runImplement({ engine: 'opencode', model: 'm', cwd: '/w', pr, items, reportFile, runner });
  assert.equal(result.ok, true);
  assert.deepEqual(result.report.fixes[0].locations, [{ path: 'a.js', line: 3 }, { path: 'b.js', line: null }]);
  const prompt = calls[0].args.at(-1);
  assert.match(prompt, /must NOT contain Co-Authored-By/);
  assert.ok(prompt.includes(reportFile));

  fs.rmSync(reportFile);
  ({ runner } = stubRunner());
  result = await runImplement({ engine: 'opencode', model: 'm', cwd: '/w', pr, items, reportFile, runner });
  assert.deepEqual(result, { ok: true, report: null });

  ({ runner } = stubRunner({ result: { code: 1, stdout: '', stderr: 'boom' } }));
  result = await runImplement({ engine: 'opencode', model: 'm', cwd: '/w', pr, items, reportFile, runner });
  assert.equal(result.ok, false);
  assert.match(result.error, /exited with code 1: boom/);
});

test('createReviewEngine binds the configured engine, model, and timeout', async () => {
  const outputFile = path.join(tmpDir(), 'triage.json');
  const { runner, calls } = stubRunner({ write: () => fs.writeFileSync(outputFile, '{"comments":[]}') });
  const engine = createReviewEngine({ engine: 'claude', model: 'sonnet', timeoutMs: 1234, runner });

  await engine.triage({ cwd: '/w', pr, comments: [], diff: '', outputFile });
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].args[1], 'sonnet');
  assert.equal(calls[0].opts.timeoutMs, 1234);
});

test('runEngine never passes the GitHub token or git auth env to the engine by default', async (t) => {
  const saved = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  process.env.GITHUB_TOKEN = 'ghp_secret';
  process.env.GIT_CONFIG_COUNT = '1';
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const { runner, calls } = stubRunner();
  await runEngine('opencode', 'm', { cwd: '/w', prompt: 'p', runner });
  assert.equal(calls[0].opts.env.GITHUB_TOKEN, undefined);
  assert.equal(calls[0].opts.env.GIT_CONFIG_COUNT, undefined);
  assert.equal(calls[0].opts.env.PATH, process.env.PATH);
});

test('runProcess captures output and exit code without a shell', async () => {
  const result = await runProcess(process.execPath, ['-e', 'console.log("hi $HOME"); process.exit(3)']);
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), 'hi $HOME');
  assert.equal(result.timedOut, false);
});

test('runProcess kills a command that exceeds its timeout', async () => {
  const started = Date.now();
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
  assert.ok(Date.now() - started < 10000, 'process should be killed quickly');
});

test('runProcess resolves with an error for a missing binary', async () => {
  const result = await runProcess('sdg-definitely-not-a-binary', []);
  assert.equal(result.code, null);
  assert.match(result.error.message, /ENOENT/);
});
