import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Anchored to the project root so scripts/health-check.sh finds it without config
const PROJECT_ROOT = path.join(__dirname, '../..');
const DEFAULT_HEARTBEAT_FILE = path.join(PROJECT_ROOT, 'data/scheduler-heartbeat.json');

// The service and the health check must agree on this path, but they start in
// different working directories (systemd's WorkingDirectory vs. cron's home
// directory). A relative SDG_HEARTBEAT_FILE is therefore anchored to the
// project root, as the scripts anchor it to their install directory.
// An absolute value is used exactly as given, so a filename with leading or
// trailing spaces still names that file. Otherwise surrounding whitespace is
// ignored and a blank value keeps the default. The scripts apply the same rule.
export function heartbeatFilePath() {
  const value = String(process.env.SDG_HEARTBEAT_FILE ?? '');
  if (path.isAbsolute(value)) return value;
  const text = value.trim();
  if (!text) return DEFAULT_HEARTBEAT_FILE;
  return path.resolve(PROJECT_ROOT, text);
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
