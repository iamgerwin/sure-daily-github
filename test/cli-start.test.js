import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const root = path.join(path.dirname(cliPath), '..');

// Starts the scheduler from `cwd`, reads the banner, then stops it with SIGTERM
function startBanner(cwd, configFile, heartbeatFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'start', '--config', configFile], {
      cwd,
      env: { ...process.env, GITHUB_TOKEN: 'ghp_test', LOG_LEVEL: 'error', NO_COLOR: '1', SDG_HEARTBEAT_FILE: heartbeatFile },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('Press Ctrl+C')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr });
    });
  });
}

test('start reports the install log directory when run from another directory', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-start-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configFile = path.join(dir, 'config.yaml');
  fs.writeFileSync(configFile, [
    'schedule:',
    '  enabled: true',
    '  cron: "0 0 1 1 *"',
    'repositories:',
    '  - owner: "me"',
    '    repo: "demo"',
    ''
  ].join('\n'));

  const { stdout, stderr } = await startBanner(dir, configFile, path.join(dir, 'heartbeat.json'));

  assert.match(stdout, /Scheduler Started/, stderr);
  const line = stdout.split('\n').find(l => l.startsWith('Logs:'));
  assert.equal(line, `Logs:      ${path.join(root, 'logs')}`);
  assert.doesNotMatch(stdout, /\.\/logs\//);
});
