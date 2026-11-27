import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BabysitterLedger } from '../src/utils/babysitter-ledger.js';
import { FixerLedger } from '../src/utils/fixer-ledger.js';
import { PrMaintLedger } from '../src/utils/pr-maint-ledger.js';
import { decisionsFilePath } from '../src/core/executor.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Never created: the ledgers only read on construction/load, and a missing file
// loads as empty, so nothing is written into the project root
const RELATIVE = 'no-such-dir/ledger-paths-test.json';

function withEnv(t, name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

const CASES = [
  ['SDG_BABYSITTER_STATE_FILE', () => new BabysitterLedger().filePath, 'data/babysitter-state.json'],
  ['SDG_CONFLICT_FIXER_STATE_FILE', () => new FixerLedger().filePath, 'data/conflict-fixer-state.json'],
  ['SDG_PR_MAINT_STATE_FILE', () => new PrMaintLedger().filePath, 'data/pr-maint-state.json'],
  ['SDG_PR_MAINT_DECISIONS_FILE', () => decisionsFilePath(), 'data/pr-maint-decisions.jsonl']
];

for (const [name, resolve, defaultPath] of CASES) {
  test(`a relative ${name} is resolved against the project root`, (t) => {
    withEnv(t, name, RELATIVE);
    assert.equal(resolve(), path.join(root, RELATIVE));
  });

  test(`an absolute ${name} is used as is, trimmed`, (t) => {
    const absolute = path.join(os.tmpdir(), 'sdg-ledger-paths', 'ledger.json');
    withEnv(t, name, `  ${absolute}\n`);
    assert.equal(resolve(), absolute);
  });

  test(`a blank or unset ${name} keeps the project-root default`, (t) => {
    withEnv(t, name, '   ');
    assert.equal(path.resolve(resolve()), path.join(root, defaultPath));
    withEnv(t, name, undefined);
    assert.equal(path.resolve(resolve()), path.join(root, defaultPath));
  });
}

test('an explicit filePath option still wins over the environment', (t) => {
  withEnv(t, 'SDG_BABYSITTER_STATE_FILE', RELATIVE);
  withEnv(t, 'SDG_CONFLICT_FIXER_STATE_FILE', RELATIVE);
  withEnv(t, 'SDG_PR_MAINT_STATE_FILE', RELATIVE);
  const explicit = path.join(os.tmpdir(), 'sdg-ledger-paths', 'explicit.json');
  assert.equal(new BabysitterLedger({ filePath: explicit }).filePath, explicit);
  assert.equal(new FixerLedger({ filePath: explicit }).filePath, explicit);
  assert.equal(new PrMaintLedger({ filePath: explicit }).filePath, explicit);
});

test('the same relative override names the same ledgers from any working directory', () => {
  const script = `
    const { FixerLedger } = await import(${JSON.stringify(path.join(root, 'src/utils/fixer-ledger.js'))});
    const { PrMaintLedger } = await import(${JSON.stringify(path.join(root, 'src/utils/pr-maint-ledger.js'))});
    const { BabysitterLedger } = await import(${JSON.stringify(path.join(root, 'src/utils/babysitter-ledger.js'))});
    console.log(JSON.stringify([new FixerLedger().filePath, new PrMaintLedger().filePath, new BabysitterLedger().filePath]));
  `;
  const env = {
    ...process.env,
    SDG_CONFLICT_FIXER_STATE_FILE: RELATIVE,
    SDG_PR_MAINT_STATE_FILE: RELATIVE,
    SDG_BABYSITTER_STATE_FILE: RELATIVE
  };
  const run = (cwd) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd, env, encoding: 'utf8' }));
  const fromRoot = run(root);
  const fromElsewhere = run(os.tmpdir());
  assert.deepEqual(fromElsewhere, fromRoot);
  assert.deepEqual(fromRoot, [path.join(root, RELATIVE), path.join(root, RELATIVE), path.join(root, RELATIVE)]);
});
