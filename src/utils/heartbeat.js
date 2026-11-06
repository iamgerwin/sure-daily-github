import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Anchored to the project root so scripts/health-check.sh finds it without config
const DEFAULT_HEARTBEAT_FILE = path.join(__dirname, '../../data/scheduler-heartbeat.json');

export function heartbeatFilePath() {
  return process.env.SDG_HEARTBEAT_FILE || DEFAULT_HEARTBEAT_FILE;
}

// Minutes an execution may stay in flight before skipped ticks stop refreshing
// the heartbeat, so the health check restarts a process stuck in one run.
// 0 or unset disables the limit. Surrounding whitespace (a systemd
// Environment= or env-file line) is ignored; any other value disables the
// limit and is reported by invalidMaxExecutionMinutes.
export function maxExecutionMs() {
  const text = String(process.env.SDG_MAX_EXECUTION_MINUTES ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return 0;
  return Number(text) * 60 * 1000;
}

// The raw SDG_MAX_EXECUTION_MINUTES when it is set but not whole minutes, so
// the scheduler can warn that hung executions will go undetected; else null.
export function invalidMaxExecutionMinutes() {
  const raw = process.env.SDG_MAX_EXECUTION_MINUTES;
  const text = String(raw ?? '').trim();
  return text === '' || /^[0-9]+$/.test(text) ? null : raw;
}

// Records that the scheduler is alive and its cron ticks still fire. A process
// can stay "active" to systemd while its timer no longer triggers (the December
// 2025 outage), so the health check reads this file's age instead. Never
// throws: a missing heartbeat must not stop a scheduled execution.
export function writeHeartbeat({ now = new Date(), filePath = heartbeatFilePath() } = {}) {
  const tmpFile = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmpFile, JSON.stringify({ lastTickAt: now.toISOString(), pid: process.pid }));
    fs.renameSync(tmpFile, filePath);
    return true;
  } catch (error) {
    try { fs.rmSync(tmpFile, { force: true }); } catch (_) {}
    logger.warn('Failed to write scheduler heartbeat', { file: filePath, error: error.message });
    return false;
  }
}
