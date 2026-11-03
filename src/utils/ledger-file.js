import fs from 'fs';

// Contents already copied to .bak, per file, so the repeated loads of one run
// (scan, start, finish) report and copy the same broken file only once
const backedUp = new Map();

// Reads a JSON-object ledger. Returns the parsed object, or null when the file
// is missing or unreadable. An unreadable ledger is replaced by the next save,
// which would silently drop every cooldown, budget and breaker it held, so the
// original is first copied to `<file>.bak` and reported, as state.js and the
// babysitter ledger do.
export function readLedgerObject(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') backupUnreadable(filePath, null, label, error.message);
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    backupUnreadable(filePath, raw, label, error.message);
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    backupUnreadable(filePath, raw, label, 'not a JSON object');
    return null;
  }
  backedUp.delete(filePath);
  return parsed;
}

function backupUnreadable(filePath, raw, label, reason) {
  if (backedUp.has(filePath) && backedUp.get(filePath) === raw) return;
  backedUp.set(filePath, raw);
  try {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  } catch (_) {}
  console.error(`Error loading ${label} (${reason}), starting fresh; the original is kept at ${filePath}.bak`);
}
