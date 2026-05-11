#!/usr/bin/env node
// Post-install sanity check: ensure `uvx` is on PATH so the bridge can spawn
// Windows-MCP. Prints a clear install command if it's missing.
// Non-fatal — exits 0 even on failure so `npm install` succeeds.

const { execSync } = require('child_process');
const os = require('os');

const HR = '─'.repeat(64);

function check() {
  try {
    const out = execSync(process.platform === 'win32' ? 'where uvx' : 'which uvx',
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (out) {
      console.log(`[bridge] ✓ uvx found: ${out.split('\n')[0]}`);
      return true;
    }
  } catch { /* fall through */ }
  return false;
}

if (check()) process.exit(0);

console.log('');
console.log(HR);
console.log('  ⚠  uvx not found on PATH');
console.log(HR);
console.log('  The bridge spawns Windows-MCP via `uvx windows-mcp`.');
console.log('  Install uv (the Python package manager that ships uvx):');
console.log('');
if (os.platform() === 'win32') {
  console.log('    winget install astral-sh.uv');
  console.log('    # — or —');
  console.log('    pip install uv');
} else {
  console.log('    curl -LsSf https://astral.sh/uv/install.sh | sh');
  console.log('    # — or —');
  console.log('    pip install uv');
}
console.log('');
console.log('  Then verify Windows-MCP runs:');
console.log('    uvx windows-mcp');
console.log(HR);
console.log('');

// Don't fail the install — let the user finish `npm install` even if uvx isn't
// there yet. The bridge will print a clear error at runtime if it's still missing.
process.exit(0);
