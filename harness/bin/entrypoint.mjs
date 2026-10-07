import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Node resolves the loaded module but argv may retain a symlink or /tmp alias.
export function isMain(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry); }
  catch { return false; }
}
