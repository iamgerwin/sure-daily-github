import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));

function hhmm(timezone, instant) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(instant);
}

test('advanced issue-mode status shows times in general.timezone, not the host clock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-status-'));
  const configFile = path.join(dir, 'config.yaml');
  const issueStateFile = path.join(dir, 'issue-state.json');
  fs.writeFileSync(configFile, [
    'general:',
    '  timezone: "Asia/Manila"',
    '  mode: "issue"',
    'repositories:',
    '  - owner: "me"',
    '    repo: "demo"',
    '    enabled: true',
    '    dailyTarget: { min: 1, max: 3 }',
    ''
  ].join('\n'));

  const now = Date.now();
  const next = new Date(now + 60 * 60 * 1000);
  fs.writeFileSync(issueStateFile, JSON.stringify({
    lastDailyReset: new Date(now).toISOString(),
    repositories: {
      'me/demo': { issuesCreatedToday: 1, lastIssueTime: now, todayTarget: 3, nextIssueTime: next.getTime() }
    }
  }));

  // Host clock is UTC; Asia/Manila is always UTC+8, so the two renderings differ
  const output = execFileSync(process.execPath, [cliPath, 'status', '--config', configFile], {
    env: {
      ...process.env,
      TZ: 'UTC',
      GITHUB_TOKEN: 'ghp_test',
      SDG_ISSUE_STATE_FILE: issueStateFile,
      SDG_STATE_FILE: path.join(dir, 'state.json'),
      LOG_LEVEL: 'error'
    },
    encoding: 'utf8'
  });

  const row = output.split('\n').find(line => line.includes('me/demo'));
  assert.ok(row, output);
  assert.match(row, new RegExp(`${hhmm('Asia/Manila', next)} │$`));
  assert.doesNotMatch(row, new RegExp(`${hhmm('UTC', next)} │$`));
  assert.match(output, /Last daily reset: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(Asia\/Manila\)/);
});
