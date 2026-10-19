import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../src/config/loader.js';

process.env.GITHUB_TOKEN = 'ghp_test';

const baseRepo = { owner: 'me', repo: 'demo' };

test('validate preserves per-repo intervalMinutes', () => {
  const cfg = config.validate({
    repositories: [{ ...baseRepo, intervalMinutes: { min: 60, max: 180 } }]
  });
  assert.deepEqual(cfg.repositories[0].intervalMinutes, { min: 60, max: 180 });
});

test('validate defaults intervalMinutes to null when not configured', () => {
  const cfg = config.validate({ repositories: [baseRepo] });
  assert.equal(cfg.repositories[0].intervalMinutes, null);
});

test('validate preserves contentTemplates', () => {
  const templates = [{ title: 'Bug: ${randomBugTitle}', body: 'b', labels: ['bug'] }];
  const cfg = config.validate({ repositories: [baseRepo], contentTemplates: templates });
  assert.deepEqual(cfg.contentTemplates, templates);
});

test('validate defaults contentTemplates to an empty array', () => {
  const cfg = config.validate({ repositories: [baseRepo] });
  assert.deepEqual(cfg.contentTemplates, []);
});

test('validate rejects invalid intervalMinutes', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, intervalMinutes: { min: 90, max: 30 } }] }),
    /intervalMinutes min cannot be greater than max/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, intervalMinutes: { min: 0, max: 30 } }] }),
    /intervalMinutes must have positive numeric min and max/
  );
});

test('validate rejects non-array contentTemplates', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], contentTemplates: { title: 'x' } }),
    /contentTemplates must be an array/
  );
});

test('validate rejects an unknown general.mode instead of falling back to commit mode', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { mode: 'issues' } }),
    /general\.mode must be one of: commit, issue/
  );
});

test('validate accepts commit and issue modes and defaults to commit', () => {
  assert.equal(config.validate({ repositories: [baseRepo], general: { mode: 'issue' } }).general.mode, 'issue');
  assert.equal(config.validate({ repositories: [baseRepo], general: { mode: 'commit' } }).general.mode, 'commit');
  assert.equal(config.validate({ repositories: [baseRepo] }).general.mode, 'commit');
});

test('validate rejects invalid general and schedule timezones', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { timezone: 'Asia/Manilla' } }),
    /general\.timezone is not a valid IANA timezone: Asia\/Manilla/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], schedule: { enabled: true, cron: '0 9 * * *', timezone: 'Mars/Base' } }),
    /schedule\.timezone is not a valid IANA timezone: Mars\/Base/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { timezone: 8 } }),
    /general\.timezone is not a valid IANA timezone/
  );
});

test('validate accepts valid timezones and defaults general.timezone to UTC', () => {
  const cfg = config.validate({
    repositories: [baseRepo],
    general: { timezone: 'Asia/Manila' },
    schedule: { enabled: true, cron: '0 9 * * *', timezone: 'America/New_York' }
  });
  assert.equal(cfg.general.timezone, 'Asia/Manila');
  assert.equal(cfg.schedule.timezone, 'America/New_York');
  assert.equal(config.validate({ repositories: [baseRepo] }).general.timezone, 'UTC');
});

test('validate rejects an empty or non-mapping config with a readable error', () => {
  for (const raw of [undefined, null, 'repositories', ['me/demo']]) {
    assert.throws(
      () => config.validate(raw),
      /Configuration file must contain a YAML mapping/
    );
  }
});

test('validate reports null or non-object repository entries instead of throwing a TypeError', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo, null, 'me/other'] }),
    (error) => {
      assert.match(error.message, /Repository 1: must be a mapping with owner and repo/);
      assert.match(error.message, /Repository 2: must be a mapping with owner and repo/);
      assert.doesNotMatch(error.message, /Repository 0/);
      return true;
    }
  );
});

test('validate leaves branch unset so the repository default branch is used', () => {
  const cfg = config.validate({ repositories: [baseRepo, { ...baseRepo, repo: 'other', branch: 'develop' }] });
  assert.equal(cfg.repositories[0].branch, null);
  assert.equal(cfg.repositories[1].branch, 'develop');
});

test('validate rejects an inverted per-repo dailyTarget range instead of crashing at run time', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: { min: 5, max: 2 } }] }),
    /Repository 0: dailyTarget min cannot be greater than max/
  );
});

test('validate rejects incomplete or malformed per-repo dailyTarget values', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: { min: 3 } }] }),
    /Repository 0: dailyTarget range must have min and max values/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: { min: 1, max: 2.5 } }] }),
    /Repository 0: dailyTarget range must be whole numbers between 1 and 100/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: 0 }] }),
    /Repository 0: dailyTarget must be a whole number between 1 and 100/
  );
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, dailyTarget: '3' }] }),
    /Repository 0: dailyTarget must be a number or a \{ min, max \} range/
  );
});

test('validate applies the same dailyTarget rules to general settings', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { dailyTarget: { min: 0, max: 3 } } }),
    /dailyTarget range must be whole numbers between 1 and 100/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], general: { dailyTarget: 101 } }),
    /dailyTarget must be a whole number between 1 and 100/
  );
});

test('validate accepts and normalizes valid per-repo dailyTarget values', () => {
  const cfg = config.validate({
    repositories: [
      { ...baseRepo, dailyTarget: 4 },
      { ...baseRepo, repo: 'ranged', dailyTarget: { min: 2, max: 6 } },
      { ...baseRepo, repo: 'inherits' }
    ],
    general: { dailyTarget: { min: 1, max: 3 } }
  });
  assert.deepEqual(cfg.repositories.map(r => r.dailyTarget), [
    { min: 4, max: 4 },
    { min: 2, max: 6 },
    { min: 1, max: 3 }
  ]);
});

test('validate rejects a malformed schedule.cron instead of failing only when the scheduler starts', () => {
  for (const expression of ['0 0 * *x', '61 * * * *', 'every day', 123, ['0 0 * * *']]) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], schedule: { enabled: true, cron: expression } }),
      /schedule\.cron is not a valid cron expression/,
      `${JSON.stringify(expression)} should be rejected`
    );
  }
});

test('validate accepts valid cron expressions and ignores cron when the schedule is disabled', () => {
  for (const expression of ['0 0 * * *', '*/15 9-17 * * 1-5', '0 0 */6 * * *']) {
    const cfg = config.validate({ repositories: [baseRepo], schedule: { enabled: true, cron: expression } });
    assert.equal(cfg.schedule.cron, expression);
  }
  const cfg = config.validate({ repositories: [baseRepo], schedule: { enabled: false, cron: 'not a cron' } });
  assert.equal(cfg.schedule.enabled, false);
});

test('validate still reports a missing cron expression separately', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], schedule: { enabled: true } }),
    (error) => /Cron expression is required/.test(error.message) && !/not a valid cron/.test(error.message)
  );
});

test('validate rejects a non-positive or fractional maxPerExecution', () => {
  for (const maxPerExecution of [0, -1, 1.5, '2']) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], repositorySelection: { strategy: 'random', maxPerExecution } }),
      /repositorySelection.maxPerExecution must be a positive whole number or null/,
      `maxPerExecution ${JSON.stringify(maxPerExecution)} should be rejected`
    );
  }
});

test('validate accepts a positive or null maxPerExecution', () => {
  for (const maxPerExecution of [1, 3, null, undefined]) {
    const cfg = config.validate({ repositories: [baseRepo], repositorySelection: { strategy: 'random', maxPerExecution } });
    assert.equal(cfg.repositorySelection.maxPerExecution, maxPerExecution);
  }
});

test('validate rejects a non-positive or non-numeric repository weight', () => {
  for (const weight of [0, -5, '10', Infinity]) {
    assert.throws(
      () => config.validate({ repositories: [{ ...baseRepo, weight }] }),
      /Repository 0: weight must be a positive number/,
      `weight ${String(weight)} should be rejected`
    );
  }
});

test('validate keeps positive weights and defaults a missing weight to 1', () => {
  const cfg = config.validate({ repositories: [{ ...baseRepo, weight: 2.5 }, { owner: 'me', repo: 'other' }] });
  assert.equal(cfg.repositories[0].weight, 2.5);
  assert.equal(cfg.repositories[1].weight, 1);
});

test('validate rejects fractional or non-positive randomization.issueCount instead of crashing at run time', () => {
  for (const issueCount of [{ min: 1.5, max: 4 }, { min: 0, max: 4 }, { min: -2, max: 4 }, { min: '2', max: 4 }]) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], randomization: { enabled: true, issueCount } }),
      /randomization\.issueCount must (be positive whole numbers|have min and max values)/
    );
  }
  assert.throws(
    () => config.validate({ repositories: [baseRepo], randomization: { enabled: true, issueCount: { min: 9, max: 3 } } }),
    /randomization\.issueCount min cannot be greater than max/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], randomization: { enabled: true, issueCount: { min: 3 } } }),
    /randomization\.issueCount must have min and max values/
  );
});

test('validate rejects invalid randomization.timeVariations ranges when enabled', () => {
  const withTimeVariations = (timeVariations) => ({
    repositories: [baseRepo],
    randomization: { enabled: true, timeVariations: { enabled: true, ...timeVariations } }
  });
  assert.throws(
    () => config.validate(withTimeVariations({ daily: { min: 30, max: 10 } })),
    /randomization\.timeVariations\.daily min cannot be greater than max/
  );
  assert.throws(
    () => config.validate(withTimeVariations({ hourly: { min: 1, max: 2.5 } })),
    /randomization\.timeVariations\.hourly must be positive whole numbers/
  );
  assert.throws(
    () => config.validate(withTimeVariations({ weekly: { min: 50 } })),
    /randomization\.timeVariations\.weekly must have min and max values/
  );
});

test('validate accepts valid randomization ranges and ignores disabled sections', () => {
  const randomization = {
    enabled: true,
    issueCount: { min: 12, max: 50 },
    timeVariations: { enabled: true, hourly: { min: 1, max: 5 }, daily: { min: 10, max: 10 }, weekly: { min: 50, max: 150 } }
  };
  assert.deepEqual(config.validate({ repositories: [baseRepo], randomization }).randomization, randomization);

  // Bad ranges in disabled sections are never used, so they are not rejected
  assert.doesNotThrow(() => config.validate({
    repositories: [baseRepo],
    randomization: { enabled: true, timeVariations: { enabled: false, daily: { min: 30, max: 10 } } }
  }));
  assert.doesNotThrow(() => config.validate({
    repositories: [baseRepo],
    randomization: { enabled: false, issueCount: { min: 1.5, max: 4 } }
  }));
});

test('validate rejects duplicate repositories, ignoring case', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo, { owner: 'other', repo: 'demo' }, { owner: 'Me', repo: 'Demo' }] }),
    /Repository 2: duplicate of repository 0 \(Me\/Demo\)/
  );
});

test('validate defaults the babysit block when it is absent', () => {
  const cfg = config.validate({ repositories: [baseRepo] });
  assert.deepEqual(cfg.babysit, {
    enabled: false,
    label: 'babysit',
    engine: 'opencode',
    model: 'openai/gpt-6.1-sol',
    ownPRsOnly: true,
    maxPrsPerRun: 5,
    testTimeoutMinutes: 15,
    engineTimeoutMinutes: 30
  });
  assert.equal(cfg.repositories[0].testCommand, null);
});

test('validate keeps configured babysit settings and fills in the rest', () => {
  const cfg = config.validate({
    repositories: [{ ...baseRepo, testCommand: 'npm ci && npm test' }],
    babysit: { enabled: true, label: 'watch-me', engine: 'claude', model: 'opus', ownPRsOnly: false, maxPrsPerRun: 2 }
  });
  assert.equal(cfg.babysit.enabled, true);
  assert.equal(cfg.babysit.label, 'watch-me');
  assert.equal(cfg.babysit.engine, 'claude');
  assert.equal(cfg.babysit.model, 'opus');
  assert.equal(cfg.babysit.ownPRsOnly, false);
  assert.equal(cfg.babysit.maxPrsPerRun, 2);
  assert.equal(cfg.babysit.testTimeoutMinutes, 15);
  assert.equal(cfg.repositories[0].testCommand, 'npm ci && npm test');
});

test('validate rejects invalid babysit settings', () => {
  const cases = [
    [[], /babysit must be a mapping/],
    [{ enabled: 'yes' }, /babysit\.enabled must be true or false/],
    [{ ownPRsOnly: 1 }, /babysit\.ownPRsOnly must be true or false/],
    [{ label: '' }, /babysit\.label must be a non-empty string/],
    [{ engine: 'gpt' }, /babysit\.engine must be one of: opencode, claude/],
    [{ model: '' }, /babysit\.model must be a non-empty string/],
    [{ model: '--dangerously-skip-permissions' }, /babysit\.model must be a non-empty string not starting with "-"/],
    [{ maxPrsPerRun: 0 }, /babysit\.maxPrsPerRun must be a positive whole number/],
    [{ testTimeoutMinutes: 1.5 }, /babysit\.testTimeoutMinutes must be a positive whole number/],
    [{ engineTimeoutMinutes: '30' }, /babysit\.engineTimeoutMinutes must be a positive whole number/]
  ];
  for (const [babysit, pattern] of cases) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], babysit }),
      pattern,
      `${JSON.stringify(babysit)} should be rejected`
    );
  }
});

test('validate defaults the prMaint block to disabled shadow mode for iamgerwin', () => {
  const cfg = config.validate({ repositories: [baseRepo] });
  assert.deepEqual(cfg.prMaint, {
    enabled: false,
    mode: 'shadow',
    authors: ['iamgerwin'],
    rateLimits: { writesPerPrPerTick: 20, writesPerHour: 200 },
    budgets: { claudeRunsPerPrPerDay: 6, claudeRunsPerDay: 40, pushesPerPrPerDay: 4, mergesPerDay: 3 }
  });
});

test('validate keeps configured prMaint settings and fills in nested defaults', () => {
  const cfg = config.validate({
    repositories: [baseRepo],
    prMaint: { enabled: true, mode: 'act', authors: ['someone', 'dependabot[bot]'], rateLimits: { writesPerHour: 50 }, budgets: { mergesPerDay: 1 } }
  });
  assert.equal(cfg.prMaint.enabled, true);
  assert.equal(cfg.prMaint.mode, 'act');
  assert.deepEqual(cfg.prMaint.authors, ['someone', 'dependabot[bot]']);
  assert.deepEqual(cfg.prMaint.rateLimits, { writesPerPrPerTick: 20, writesPerHour: 50 });
  assert.equal(cfg.prMaint.budgets.mergesPerDay, 1);
  assert.equal(cfg.prMaint.budgets.claudeRunsPerDay, 40);
});

test('validate rejects invalid prMaint settings', () => {
  const cases = [
    [[], /prMaint must be a mapping/],
    [{ enabled: 'yes' }, /prMaint\.enabled must be true or false/],
    [{ mode: 'yolo' }, /prMaint\.mode must be one of: shadow, act, autonomous/],
    [{ authors: [] }, /prMaint\.authors must be a non-empty list of GitHub logins/],
    [{ authors: 'iamgerwin' }, /prMaint\.authors must be a non-empty list of GitHub logins/],
    [{ authors: ['bad login'] }, /prMaint\.authors\[0\] must be a GitHub login/],
    [{ rateLimits: [] }, /prMaint\.rateLimits must be a mapping/],
    [{ rateLimits: { writesPerHour: 0 } }, /prMaint\.rateLimits\.writesPerHour must be a positive whole number/],
    [{ rateLimits: { writesPerDay: 5 } }, /prMaint\.rateLimits\.writesPerDay is not a known setting/],
    [{ budgets: { mergesPerDay: 1.5 } }, /prMaint\.budgets\.mergesPerDay must be a positive whole number/]
  ];
  for (const [prMaint, pattern] of cases) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], prMaint }),
      pattern,
      `${JSON.stringify(prMaint)} should be rejected`
    );
  }
});

test('validate rejects an empty or non-string repository testCommand', () => {
  for (const testCommand of ['', '  ', 42, ['npm', 'test']]) {
    assert.throws(
      () => config.validate({ repositories: [{ ...baseRepo, testCommand }] }),
      /Repository 0: testCommand must be a non-empty string/
    );
  }
});

test('validate accepts the same repo name under different owners', () => {
  const cfg = config.validate({ repositories: [baseRepo, { owner: 'other', repo: 'demo' }] });
  assert.equal(cfg.repositories.length, 2);
});

test('validate passes testCommand through and defaults conflictFixer', () => {
  const cfg = config.validate({ repositories: [{ ...baseRepo, testCommand: 'npm run test:unit' }, { owner: 'me', repo: 'other' }] });
  assert.equal(cfg.repositories[0].testCommand, 'npm run test:unit');
  assert.equal(cfg.repositories[1].testCommand, null);
  assert.deepEqual(cfg.conflictFixer, {
    testTimeoutMinutes: 15,
    installDeps: true,
    scanTimeoutSeconds: 120,
    attemptTtlMinutes: 60,
    retryCooldownMinutes: 240,
    sourceHunks: 'push',
    mode: 'allowlist',
    allowlist: [],
    denylist: []
  });
});

test('validate keeps configured conflictFixer settings', () => {
  const settings = {
    testTimeoutMinutes: 30, installDeps: false, scanTimeoutSeconds: 45, attemptTtlMinutes: 10, retryCooldownMinutes: 20, sourceHunks: 'claude'
  };
  const cfg = config.validate({ repositories: [baseRepo], conflictFixer: settings });
  assert.deepEqual(cfg.conflictFixer, { ...settings, mode: 'allowlist', allowlist: [], denylist: [] });
});

test('validate rejects invalid conflictFixer and testCommand values', () => {
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, testCommand: '  ' }] }),
    /Repository 0: testCommand must be a non-empty string/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], conflictFixer: { testTimeoutMinutes: 0 } }),
    /conflictFixer.testTimeoutMinutes must be a positive whole number/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], conflictFixer: { installDeps: 'yes' } }),
    /conflictFixer.installDeps must be true or false/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], conflictFixer: ['x'] }),
    /conflictFixer must be a mapping/
  );
  for (const field of ['scanTimeoutSeconds', 'attemptTtlMinutes', 'retryCooldownMinutes']) {
    for (const value of [0, -5, 1.5, '60']) {
      assert.throws(
        () => config.validate({ repositories: [baseRepo], conflictFixer: { [field]: value } }),
        new RegExp(`conflictFixer.${field} must be a positive whole number`)
      );
    }
  }
});

test('validate accepts each sourceHunks strategy and rejects anything else', () => {
  for (const sourceHunks of ['push', 'claude', 'escalate']) {
    const cfg = config.validate({ repositories: [baseRepo], conflictFixer: { sourceHunks } });
    assert.equal(cfg.conflictFixer.sourceHunks, sourceHunks);
  }
  assert.equal(config.validate({ repositories: [baseRepo], conflictFixer: { sourceHunks: null } }).conflictFixer.sourceHunks, 'push');
  for (const sourceHunks of ['Push', 'newer', '', true, 1]) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], conflictFixer: { sourceHunks } }),
      /conflictFixer.sourceHunks must be one of: push, claude, escalate/
    );
  }
});

test('validate normalizes repo gating settings', () => {
  const cfg = config.validate({
    repositories: [{ ...baseRepo, conflictFixer: false }, { owner: 'me', repo: 'other' }],
    conflictFixer: { mode: 'denylist', allowlist: ['me/demo'], denylist: ['Me/Legacy.repo'] }
  });
  assert.equal(cfg.repositories[0].conflictFixer, false);
  assert.equal(cfg.repositories[1].conflictFixer, null);
  assert.equal(cfg.conflictFixer.mode, 'denylist');
  assert.deepEqual(cfg.conflictFixer.allowlist, ['me/demo']);
  assert.deepEqual(cfg.conflictFixer.denylist, ['Me/Legacy.repo']);
});

test('validate rejects invalid repo gating settings', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], conflictFixer: { mode: 'everything' } }),
    /conflictFixer.mode must be one of: allowlist, denylist, all/
  );
  assert.throws(
    () => config.validate({ repositories: [baseRepo], conflictFixer: { allowlist: 'me/demo' } }),
    /conflictFixer.allowlist must be a list of "owner\/repo" strings/
  );
  for (const entry of ['demo', 'me/', '/demo', 'me/de mo', 'me/demo/x', 42]) {
    assert.throws(
      () => config.validate({ repositories: [baseRepo], conflictFixer: { denylist: ['me/ok', entry] } }),
      /conflictFixer.denylist\[1\] must be an "owner\/repo" string/
    );
  }
  assert.throws(
    () => config.validate({ repositories: [{ ...baseRepo, conflictFixer: 'yes' }] }),
    /Repository 0: conflictFixer must be true or false/
  );
});

test('validate rejects repository labels that are not a list of names', () => {
  for (const labels of ['bug', ['bug', ''], ['bug', 3], { name: 'bug' }]) {
    assert.throws(
      () => config.validate({ repositories: [{ ...baseRepo, labels }] }),
      /Repository 0: labels must be a list of non-empty label names/
    );
  }
});

test('validate rejects contentTemplates labels that are not a list of names', () => {
  assert.throws(
    () => config.validate({ repositories: [baseRepo], contentTemplates: [{ title: 'a' }, { title: 'b', labels: 'bug' }] }),
    /contentTemplates\[1\]\.labels must be a list of non-empty label names/
  );
});

test('validate accepts label lists and defaults repository labels', () => {
  const cfg = config.validate({
    repositories: [{ ...baseRepo, labels: ['bug', 'help wanted'] }, { owner: 'me', repo: 'other' }],
    contentTemplates: [{ title: 'a', labels: ['feature'] }, { title: 'b' }]
  });
  assert.deepEqual(cfg.repositories[0].labels, ['bug', 'help wanted']);
  assert.deepEqual(cfg.repositories[1].labels, ['automated']);
  assert.deepEqual(cfg.contentTemplates[0].labels, ['feature']);
});
