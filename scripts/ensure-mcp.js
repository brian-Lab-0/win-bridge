#!/usr/bin/env node
/**
 * ensure-mcp.js — install/verify Windows-MCP before the bridge tries to spawn it.
 *
 * Staged state machine:
 *   1. PROBE       — is `windows-mcp` already installed as a `uv` tool?
 *   2. INSTALL     — if not, `uv tool install windows-mcp` (one-time, ~95 deps)
 *   3. UPDATE_CHK  — if installed & last-check >7d ago, `uv tool upgrade` in background
 *   4. READY       — package is on disk; safe to `uvx windows-mcp serve`
 *
 * The bridge MUST await this resolving before announcing readiness. We never
 * let `uvx windows-mcp serve` race against a still-downloading install.
 *
 * State persisted at ~/.chatp-bridge/install-state.json:
 *   { installedAt, lastUpdateCheck, version }
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR  = path.join(os.homedir(), '.chatp-bridge');
const STATE_FILE = path.join(STATE_DIR, 'install-state.json');
const UPDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;   // weekly

try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {}

const readState = () => {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); }
  catch { return {}; }
};
const writeState = (patch) => {
  const next = { ...readState(), ...patch };
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(next, null, 2)); } catch {}
};

const which = (bin) => {
  try {
    const out = execSync(process.platform === 'win32' ? `where ${bin}` : `which ${bin}`,
      { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return out.split(/\r?\n/)[0] || null;
  } catch { return null; }
};

// `uv tool list` lines look like:
//   windows-mcp v1.2.3
//   - windows-mcp
// We just need to detect whether the package name appears.
const isInstalled = () => {
  try {
    const out = execSync('uv tool list', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    const match = out.match(/^\s*windows-mcp\b\s*(v?[\d.]+)?/im);
    if (!match) return null;
    return { version: match[1] || 'unknown' };
  } catch { return null; }
};

const runStreaming = (cmd, args, { label, timeoutMs = 300_000 } = {}) => new Promise((resolve, reject) => {
  const child = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  const tag = label ? `[${label}] ` : '';
  child.stdout.on('data', (d) => process.stdout.write(d.toString().replace(/^/gm, tag)));
  child.stderr.on('data', (d) => process.stderr.write(d.toString().replace(/^/gm, tag)));
  const timer = setTimeout(() => {
    try { child.kill(); } catch {}
    reject(new Error(`${cmd} ${args.join(' ')} timed out after ${Math.round(timeoutMs/1000)}s`));
  }, timeoutMs);
  child.on('error', (err) => { clearTimeout(timer); reject(err); });
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (code === 0) resolve();
    else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
  });
});

/**
 * Ensure the windows-mcp package is installed and usable.
 * Resolves with { firstInstall, version, skippedUpdate } when safe to spawn.
 * Rejects with a clear Error if uvx is missing or install fails.
 */
async function ensureWindowsMcp({ onPhase = () => {}, forceUpdate = false } = {}) {
  // ─── 1. uvx must exist ─────────────────────────────────────────────────────
  if (!which('uvx') || !which('uv')) {
    const err = new Error(
      'uv / uvx not found on PATH. Install with `winget install astral-sh.uv` ' +
      '(or `pip install uv`), then restart the bridge.'
    );
    err.code = 'UV_MISSING';
    throw err;
  }

  // ─── 2. Probe whether package is already installed ─────────────────────────
  onPhase({ phase: 'probe', msg: 'checking windows-mcp install state' });
  let installed = isInstalled();
  let firstInstall = false;

  // ─── 3. Install if missing ─────────────────────────────────────────────────
  if (!installed) {
    firstInstall = true;
    onPhase({ phase: 'install', msg: 'first-run install — fetching windows-mcp (~95 packages, 30–90s)' });
    try {
      await runStreaming('uv', ['tool', 'install', 'windows-mcp'], { label: 'uv-install', timeoutMs: 5 * 60_000 });
    } catch (e) {
      // Fall back to `uv tool upgrade` in case it's half-installed.
      onPhase({ phase: 'install_retry', msg: `install failed (${e.message}) — trying upgrade --reinstall` });
      await runStreaming('uv', ['tool', 'install', '--force', 'windows-mcp'], { label: 'uv-install', timeoutMs: 5 * 60_000 });
    }
    installed = isInstalled();
    if (!installed) {
      throw new Error('`uv tool install windows-mcp` completed but the package is not listed by `uv tool list`. Try running it manually.');
    }
    writeState({ installedAt: Date.now(), lastUpdateCheck: Date.now(), version: installed.version });
    onPhase({ phase: 'installed', msg: `windows-mcp ${installed.version} installed` });
    return { firstInstall: true, version: installed.version, skippedUpdate: false };
  }

  // ─── 4. Already installed — decide whether to update-check ────────────────
  const persisted = readState();
  const sinceCheck = Date.now() - (persisted.lastUpdateCheck || 0);
  const shouldUpdate = forceUpdate || sinceCheck > UPDATE_INTERVAL_MS;

  if (!shouldUpdate) {
    onPhase({
      phase: 'cached',
      msg: `windows-mcp ${installed.version} already installed (last update check ${Math.round(sinceCheck / 86_400_000)}d ago — next at 7d)`,
    });
    return { firstInstall: false, version: installed.version, skippedUpdate: true };
  }

  // Update check IS needed. Run synchronously — but with a short timeout so we
  // don't block startup forever if the network is slow. On timeout we proceed
  // with the cached version; the user can `--force-update` later.
  onPhase({ phase: 'update_check', msg: 'checking for windows-mcp updates (weekly)' });
  try {
    await runStreaming('uv', ['tool', 'upgrade', 'windows-mcp'], { label: 'uv-upgrade', timeoutMs: 60_000 });
    const after = isInstalled() || installed;
    writeState({ lastUpdateCheck: Date.now(), version: after.version });
    onPhase({ phase: 'updated', msg: `windows-mcp now ${after.version}` });
    return { firstInstall: false, version: after.version, skippedUpdate: false };
  } catch (e) {
    onPhase({ phase: 'update_skipped', msg: `update check failed (${e.message}) — proceeding with installed ${installed.version}` });
    // Don't bump lastUpdateCheck — we'll retry next launch.
    return { firstInstall: false, version: installed.version, skippedUpdate: true };
  }
}

module.exports = { ensureWindowsMcp, isInstalled, which };

// CLI mode: `node scripts/ensure-mcp.js [--force-update]`
if (require.main === module) {
  const forceUpdate = process.argv.includes('--force-update');
  ensureWindowsMcp({
    forceUpdate,
    onPhase: ({ phase, msg }) => console.log(`[ensure-mcp] ${phase}: ${msg}`),
  }).then((r) => {
    console.log(`[ensure-mcp] ✓ ready (firstInstall=${r.firstInstall}, version=${r.version})`);
    process.exit(0);
  }).catch((err) => {
    console.error(`[ensure-mcp] ✗ ${err.message}`);
    process.exit(1);
  });
}
