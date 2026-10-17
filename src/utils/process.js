import { spawn } from 'child_process';

// Keep the tail: test runners and engines print the useful part (failures) last
const MAX_OUTPUT_CHARS = 256 * 1024;
const KILL_GRACE_MS = 5000;
const POLL_MS = 50;

// Process groups (by leader pid) still running, so an interrupted run can kill
// them: they are detached and would otherwise outlive this process. A group
// stays registered after its leader exits while other members (a background
// grandchild) are still alive; dead groups are pruned on every spawn and kill,
// so the set never holds more than the groups that are actually alive.
const activeGroups = new Set();

function appendTail(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_OUTPUT_CHARS ? next.slice(-MAX_OUTPUT_CHARS) : next;
}

function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (_) {
    // Already exited
  }
}

function groupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function pruneGroups() {
  for (const pid of activeGroups) if (!groupAlive(pid)) activeGroups.delete(pid);
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// SIGTERM every active group, then SIGKILL whatever is still alive after the
// grace period. Resolves once every group is gone (or was SIGKILLed).
export async function killActiveEngines({ graceMs = KILL_GRACE_MS } = {}) {
  const groups = [...activeGroups];
  if (groups.length === 0) return;
  groups.forEach(pid => signalGroup(pid, 'SIGTERM'));
  const deadline = Date.now() + graceMs;
  while (groups.some(groupAlive) && Date.now() < deadline) await sleep(POLL_MS);
  groups.filter(groupAlive).forEach(pid => signalGroup(pid, 'SIGKILL'));
  const reapDeadline = Date.now() + 1000;
  while (groups.some(groupAlive) && Date.now() < reapDeadline) await sleep(POLL_MS);
  pruneGroups();
}

// Spawns a command without a shell and resolves (never rejects) with
// { code, signal, stdout, stderr, timedOut, error }. On timeout the whole
// process group is killed so `npm test` grandchildren cannot linger. `input`
// is written to stdin (prompts go there, not into argv).
export function runProcess(cmd, args = [], { cwd, env = process.env, timeoutMs = 0, input = null } = {}) {
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
      // The leader is gone, but same-group members may live on
      if (child?.pid && !groupAlive(child.pid)) activeGroups.delete(child.pid);
      resolve({ stdout, stderr, timedOut, signal: null, error: null, ...result });
    };

    try {
      child = spawn(cmd, args, { cwd, env, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached });
    } catch (error) {
      finish({ code: null, error });
      return;
    }
    if (detached && child.pid) {
      pruneGroups();
      activeGroups.add(child.pid);
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
    if (input !== null) {
      // A child that exits without reading stdin must not crash us with EPIPE
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS).unref();
      }, timeoutMs);
    }
  });
}
