'use strict';
// File-name globs that must NEVER be mirrored to GitHub. robocopy /XF matches
// file names and wildcard patterns (case-insensitive on Windows).
const SECRET_FILE_GLOBS = [
  '.env', '.env.*', '*.env', '*.pem', '*.key', '*.p12', '*.pfx', '*.keystore',
  '.npmrc', '.yarnrc', 'credentials*', '.credentials.json', 'secrets*', '.secrets.*',
  'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub', 'id_ecdsa', 'id_dsa',
  // TAO's own config.json holds the Telegram bot token + GitHub PAT + Gemini
  // keys. If a workspace ever IS this repo's folder (or a sibling project uses
  // the same name), /MIR + git add -A would push it to the GitHub mirror.
  // `config.json` is TAO's exact secret filename — keep it out of every mirror.
  'config.json', '.netrc', '.git-credentials', '*.tfvars', '*.tfstate',
];
module.exports = { SECRET_FILE_GLOBS };