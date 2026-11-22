import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(__dirname, '../..');

// Resolves a state-file override (SDG_STATE_FILE, SDG_ISSUE_STATE_FILE). The
// defaults live under the project root; a relative override resolved against
// the working directory would give the service (run from its
// WorkingDirectory) and a manual `cli.js run` started elsewhere two different
// state files, so each would count the daily target from zero and repeat the
// day's commits or issues. Relative values are anchored to the project root
// like the default; surrounding whitespace (a systemd Environment= line) is
// ignored, and a blank value keeps the default.
export function resolveDataPath(value, defaultPath) {
  const text = String(value ?? '').trim();
  if (!text) return defaultPath;
  return path.resolve(PROJECT_ROOT, text);
}
