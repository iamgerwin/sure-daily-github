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
