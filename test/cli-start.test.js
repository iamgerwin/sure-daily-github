import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const projectLogs = fileURLToPath(new URL('../logs', import.meta.url));

// Starts the scheduler, collects stdout until the banner is printed, then stops it
function startBanner(configFile, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, 'start', '--config', configFile], {
      cwd,
      env: { ...process.env, GITHUB_TOKEN: 'ghp_test', LOG_LEVEL: 'error' }
    });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`start did not print its banner:\n${output}`));
    }, 10000);
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('Press Ctrl+C')) child.kill('SIGTERM');
    });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

test('start reports the log directory the logger writes to, not one relative to cwd', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdg-cli-start-'));
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

  try {
    const output = await startBanner(configFile, dir);
    const line = output.split('\n').find(l => l.startsWith('Logs:'));
    assert.ok(line, output);
    assert.equal(line.replace(/^Logs:\s+/, ''), projectLogs);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
