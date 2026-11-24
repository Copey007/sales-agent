// node --check every server function + browser helper (fails on first error).
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = readdirSync('netlify/functions').filter((f) => f.endsWith('.mjs')).map((f) => `netlify/functions/${f}`);
files.push('auth-gate.js', 'netlify/edge-functions/aisdr-gate.js', 'netlify/edge-lib/gate-core.mjs');
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`syntax ok: ${files.length} files`);
