import { spawn } from 'child_process';

// Keep the tail: test runners and engines print the useful part (failures) last
const MAX_OUTPUT_CHARS = 256 * 1024;
const KILL_GRACE_MS = 5000;

function appendTail(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}

// Spawns a command without a shell and resolves (never rejects) with
// { code, signal, stdout, stderr, timedOut, error }. On timeout the whole
// process group is killed so `npm test` grandchildren cannot linger.
export function runProcess(cmd, args = [], { cwd, env = process.env, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const detached = process.platform !== 'win32';
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let timer = null;
    let child;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, signal: null, error: null, ...result });
    };

    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached });
    } catch (error) {
      finish({ code: null, error });
      return;
    }

    const kill = (signal) => {
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (_) {}
    };

    child.stdout.on('data', (chunk) => { stdout = appendTail(stdout, chunk.toString()); });
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, chunk.toString()); });
    child.on('error', (error) => finish({ code: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);
    }
  });
}
