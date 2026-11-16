import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The install directory's .env, next to config/, data/ and logs/, which are
// all anchored to the install directory rather than the working directory
export const APP_ENV_FILE = path.join(__dirname, '../../.env');

// Loads .env into the environment. The working directory's .env is read first
// (as before), then the install directory's fills any variable still unset, so
// `node /opt/sure-daily-github/src/cli.js run` from cron, pm2 or another
// directory still finds GITHUB_TOKEN. Variables already in the environment and
// the first file that sets a variable win; a missing file is skipped.
export function loadEnv({ cwd = process.cwd(), appEnvFile = APP_ENV_FILE, processEnv = process.env } = {}) {
  const files = [...new Set([path.resolve(cwd, '.env'), path.resolve(appEnvFile)])];
  dotenv.config({ path: files, processEnv, quiet: true });
  return files;
}

// Imported for its side effect by every module that reads the environment
// while it is being imported: ES modules evaluate their imports first, so a
// .env loaded later (e.g. by the config loader) would miss settings such as
// SDG_STATE_FILE that the state singleton reads on import
loadEnv();
