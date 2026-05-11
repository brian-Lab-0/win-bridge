#!/usr/bin/env node
/**
 * chatp Desktop Bridge
 *
 * Runs on the user's Windows machine. Spawns Windows-MCP as a child process
 * (MCP over stdio) and opens an outbound WebSocket to chatp desktop-relay.
 * Agents (in the browser) send action requests over the relay; the bridge
 * checks consent, forwards to MCP, and returns results.
 *
 * Trust UI:
 *   - Console activity log
 *   - Browser dashboard at http://localhost:3737 (consent prompts + audit)
 *   - Emergency-stop hotkey (PowerShell-registered): kills MCP + WS
 *
 * Usage:
 *   node bridge.js                    # uses ./config.json
 *   node bridge.js --config=path.json
 *   node bridge.js --pairing=ABC123 --relay=ws://host:2233
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');
const WebSocket = require('ws');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; })
);

const configPath = args.config || path.join(__dirname, 'config.json');
let config;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch {
  console.error(`[bridge] No config.json found — copy config.example.json to config.json`);
  process.exit(1);
}
if (args.pairing) config.pairingCode = args.pairing;
if (args.relay)   config.relayUrl    = args.relay;

if (!config.pairingCode || config.pairingCode === 'CHANGE-ME') {
  console.error(`[bridge] Set "pairingCode" in config.json (or pass --pairing=XYZ)`);
  process.exit(1);
}

const PAIRING        = String(config.pairingCode || 'BRIDGE').trim().toUpperCase();
const RELAY_URL      = config.relayUrl || 'ws://localhost:2233';
const DASHBOARD_PORT = config.dashboardPort || 3737;
const AGENT_WS_PORT  = config.agentWsPort  || 3738;   // direct agent WS (no relay needed)
const CONSENT        = config.consent || { mode: 'always-ask', allowedActions: [] };

const AUDIT_DIR  = path.join(os.homedir(), '.chatp-bridge');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.jsonl');
try { fs.mkdirSync(AUDIT_DIR, { recursive: true }); } catch {}

// ─── Audit + state ──────────────────────────────────────────────────────────

const state = {
  mcpReady: false,
  mcpError: null,                             // last spawn / init error, surfaced to dashboard + agent
  mcpTools: [],                               // tool names from MCP tools/list — empty until ready
  mcpToolSchemas: {},                         // { toolName: inputSchema } — populated after tools/list
  relayConnected: false,
  agentJoined: false,
  sessionArmed: CONSENT.mode === 'auto',     // auto = pre-armed; session = arm via dashboard
  sessionExpiresAt: 0,
  recent: [],                                 // ring of {ts, action, status, output?}
  pendingConsent: new Map(),                  // id → {action, args, resolve, expiresAt}
};

const audit = (entry) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  try { fs.appendFileSync(AUDIT_FILE, line + '\n'); } catch {}
  state.recent.unshift({ ts: Date.now(), ...entry });
  if (state.recent.length > 100) state.recent.pop();
  console.log(`[bridge] ${entry.kind || 'event'}: ${entry.action || entry.msg || ''}`);
};

// ─── MCP child process (Windows-MCP over stdio) ─────────────────────────────

let mcp = null;
const mcpPending = new Map();   // id → { resolve, reject, expiresAt }
let mcpId = 1;

const startMcp = () => {
  const cmd  = config.mcp?.command || 'windows-mcp';
  const args = config.mcp?.args || [];
  const cwd  = config.mcp?.cwd || undefined;

  state.mcpError = null;
  mcp = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });

  mcp.on('error', (err) => {
    state.mcpError = `spawn failed: ${err.message} (is "${cmd}" on PATH?)`;
    audit({ kind: 'mcp_error', msg: state.mcpError });
    state.mcpReady = false;
    rejectAllPending(state.mcpError);
    if (relayWs && relayWs.readyState === 1) sendStatus();
  });
  mcp.on('exit', (code) => {
    state.mcpError = state.mcpError || `MCP child exited (code=${code}). Check that "${cmd}" is installed and runnable.`;
    audit({ kind: 'mcp_exit', msg: `code=${code}` });
    state.mcpReady = false;
    rejectAllPending(state.mcpError);
    if (relayWs && relayWs.readyState === 1) sendStatus();
  });
  mcp.stdin.on('error', (err) => {
    audit({ kind: 'mcp_stdin_error', msg: err.message });
    rejectAllPending(`MCP stdin error: ${err.message}`);
  });

  let buf = '';
  mcp.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf-8');
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && mcpPending.has(msg.id)) {
          const { resolve } = mcpPending.get(msg.id);
          mcpPending.delete(msg.id);
          resolve(msg);
        }
      } catch (e) {
        // MCP banner / log line — ignore
      }
    }
  });
  mcp.stderr.on('data', (d) => {
    const s = d.toString().trim();
    if (s) console.error(`[mcp] ${s}`);
  });

  // MCP initialise handshake → then list tools so we know what actions are real
  setTimeout(async () => {
    try {
      const init = await callMcp('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'chatp-bridge', version: '0.1.0' } }, 15_000);
      state.mcpReady = true;
      state.mcpError = null;
      audit({ kind: 'mcp_ready', msg: init?.result?.serverInfo?.name || 'connected' });

      try {
        const tl = await callMcp('tools/list', {}, 10_000);
        const tools = tl?.result?.tools || [];
        state.mcpTools = tools.map((t) => t.name);
        state.mcpToolSchemas = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema || {}]));
        audit({ kind: 'mcp_tools', msg: `${state.mcpTools.length} tools: ${state.mcpTools.join(', ').slice(0, 200)}` });
      } catch (e) {
        audit({ kind: 'mcp_tools_error', msg: e.message });
      }

      if (relayWs && relayWs.readyState === 1) sendStatus();
    } catch (err) {
      state.mcpError = `MCP init failed: ${err.message}`;
      audit({ kind: 'mcp_init_error', msg: state.mcpError });
      if (relayWs && relayWs.readyState === 1) sendStatus();
    }
  }, 500);
};

const rejectAllPending = (msg) => {
  for (const [id, p] of mcpPending.entries()) {
    p.resolve({ jsonrpc: '2.0', id, error: { code: -1, message: msg } });
  }
  mcpPending.clear();
};

const callMcp = (method, params, timeoutMs = 60_000) => {
  return new Promise((resolve, reject) => {
    if (!mcp || mcp.killed || mcp.exitCode !== null) { reject(new Error(state.mcpError || 'MCP not running')); return; }
    const id = mcpId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    const timer = setTimeout(() => {
      if (mcpPending.has(id)) { mcpPending.delete(id); reject(new Error(`MCP timeout (${method})`)); }
    }, timeoutMs);
    mcpPending.set(id, { resolve: (msg) => { clearTimeout(timer); resolve(msg); } });
    try {
      mcp.stdin.write(JSON.stringify(payload) + '\n', (err) => {
        if (err) { mcpPending.delete(id); clearTimeout(timer); reject(new Error(`MCP stdin write failed: ${err.message}`)); }
      });
    } catch (e) {
      mcpPending.delete(id); clearTimeout(timer); reject(e);
    }
  });
};

const callMcpTool = async (action, args) => {
  const res = await callMcp('tools/call', { name: action, arguments: args || {} });
  if (res?.error) return { error: String(res.error.message || JSON.stringify(res.error)).slice(0, 1500) };
  const content = res?.result?.content;
  if (!content) return { output: JSON.stringify(res?.result ?? null).slice(0, 3000) };
  let output = '';
  let screenshot = null;
  for (const c of content) {
    if (c.type === 'text') output += (output ? '\n' : '') + c.text;
    if (c.type === 'image') screenshot = c.data;
  }
  // Truncate large text output to keep WS messages reasonable
  if (output.length > 4000) output = output.slice(0, 4000) + '\n…[truncated]';
  return { output, screenshot };
};

// ─── Consent gate ────────────────────────────────────────────────────────────

const READ_ONLY = new Set(['screenshot', 'list_windows', 'list_apps', 'get_clipboard', 'list_files', 'read_file']);

const isBlocked = (action, args) => {
  if (CONSENT.blockedApps?.some(a => String(args?.app || '').toLowerCase().includes(a.toLowerCase()))) {
    return `Blocked app: ${args.app}`;
  }
  const p = args?.path || args?.file || '';
  for (const pat of (CONSENT.blockedPaths || [])) {
    const rx = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'), 'i');
    if (rx.test(p)) return `Blocked path: ${p}`;
  }
  return null;
};

const requiresConsent = (action) => {
  if (CONSENT.mode === 'auto') return false;
  if (CONSENT.allowedActions?.includes(action)) return false;
  if (CONSENT.mode === 'session' && state.sessionArmed && Date.now() < state.sessionExpiresAt) {
    return !READ_ONLY.has(action) && false;  // session-armed: skip prompt for any action
  }
  return true;
};

const askConsent = (action, args, timeoutMs = 40_000) => {
  return new Promise((resolve) => {
    const id = `c_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const expiresAt = Date.now() + timeoutMs;
    state.pendingConsent.set(id, { action, args, resolve, expiresAt });
    audit({ kind: 'consent_request', action, msg: `awaiting dashboard approval (id=${id})` });
    setTimeout(() => {
      if (state.pendingConsent.has(id)) {
        state.pendingConsent.delete(id);
        resolve(false);
        audit({ kind: 'consent_timeout', action });
      }
    }, timeoutMs);
  });
};

// ─── Capabilities snapshot + shared exec handler ────────────────────────────

const directAgents = new Set();   // direct-WS agent connections

const getCapabilities = () => ({
  mcpReady: state.mcpReady,
  mcpError: state.mcpError,
  mcpTools: state.mcpTools,
  mcpToolSchemas: state.mcpToolSchemas,
  sessionArmed: state.sessionArmed,
  consentMode: CONSENT.mode,
  hostname: os.hostname(),
  platform: os.platform(),
});

const sendStatus = () => {
  const msg = JSON.stringify({ type: 'status', connected: true, capabilities: getCapabilities() });
  if (relayWs && relayWs.readyState === 1) relayWs.send(msg);
  for (const ws of directAgents) { if (ws.readyState === 1) ws.send(msg); }
};

const handleExec = async (id, action, args, reply) => {
  if (!state.mcpReady) {
    reply({ id, type: 'result', error: state.mcpError || 'Windows-MCP not ready — restart the bridge.' });
    return;
  }
  if (state.mcpTools.length && !state.mcpTools.includes(action)) {
    reply({ id, type: 'result', error: `"${action}" is not a valid tool. Available: ${state.mcpTools.join(', ')}` });
    return;
  }
  const blockedReason = isBlocked(action, args);
  if (blockedReason) { reply({ id, type: 'result', error: blockedReason }); return; }

  if (requiresConsent(action)) {
    const ok = await askConsent(action, args, 40_000);
    if (!ok) { reply({ id, type: 'result', error: 'Action denied — arm the session in the bridge dashboard.' }); return; }
  }

  audit({ kind: 'action_start', action });
  try {
    const result = await callMcpTool(action, args);
    audit({ kind: 'action_done', action, msg: result.error ? `error` : 'ok' });
    reply({ id, type: 'result', ...result });
  } catch (err) {
    audit({ kind: 'action_error', action, msg: err.message });
    reply({ id, type: 'result', error: err.message });
  }
};

// ─── Relay WebSocket (outbound — optional, for remote/cross-machine setups) ──

let relayWs = null;
let reconnectTimer = null;

const connectRelay = () => {
  const url = `${RELAY_URL}?role=bridge&pairing=${encodeURIComponent(PAIRING)}`;
  console.log(`[bridge] Connecting to relay ${url}`);
  relayWs = new WebSocket(url);

  relayWs.on('open', () => {
    state.relayConnected = true;
    audit({ kind: 'relay_open', msg: PAIRING });
    sendStatus();
  });

  relayWs.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); }
    catch { return; }

    if (msg.type === 'agent_joined') {
      state.agentJoined = true;
      audit({ kind: 'agent_joined' });
      sendStatus();
      return;
    }
    if (msg.type === 'peer_gone') {
      state.agentJoined = false;
      audit({ kind: 'agent_gone' });
      return;
    }
    if (msg.type === 'paired') {
      audit({ kind: 'paired', msg: 'bridge role accepted' });
      return;
    }
    if (msg.type === 'ping') {
      relayWs.send(JSON.stringify({ id: msg.id, type: 'result', output: 'pong' }));
      return;
    }
    if (msg.type === 'exec') {
      await handleExec(msg.id, msg.action, msg.args,
        (result) => { if (relayWs.readyState === 1) relayWs.send(JSON.stringify(result)); });
      return;
    }
  });

  relayWs.on('close', () => {
    state.relayConnected = false;
    audit({ kind: 'relay_close', msg: 'reconnecting in 5s' });
    if (!reconnectTimer) reconnectTimer = setTimeout(() => { reconnectTimer = null; connectRelay(); }, 5000);
  });

  relayWs.on('error', (err) => {
    audit({ kind: 'relay_error', msg: err.message });
  });
};

// ─── Direct agent WebSocket server (no relay needed for same-machine use) ────

const agentWss = new WebSocket.Server({ port: AGENT_WS_PORT });
console.log(`[bridge] Direct agent WS on ws://localhost:${AGENT_WS_PORT}`);

agentWss.on('connection', (ws) => {
  directAgents.add(ws);
  state.agentJoined = true;
  audit({ kind: 'agent_joined', msg: 'direct WS' });
  ws.send(JSON.stringify({ type: 'hello', capabilities: getCapabilities() }));

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.type === 'exec') {
      await handleExec(msg.id, msg.action, msg.args,
        (result) => { if (ws.readyState === 1) ws.send(JSON.stringify(result)); });
    }
    if (msg.type === 'ping') ws.send(JSON.stringify({ id: msg.id, type: 'result', output: 'pong' }));
  });

  ws.on('close', () => {
    directAgents.delete(ws);
    if (directAgents.size === 0) { state.agentJoined = false; audit({ kind: 'agent_gone', msg: 'direct WS' }); }
  });
  ws.on('error', (err) => audit({ kind: 'agent_ws_error', msg: err.message }));
});

// ─── Local dashboard (consent UI + activity feed) ───────────────────────────

const dashHtml = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf-8');

const dashServer = http.createServer((req, res) => {
  // CORS — allow any origin so the deployed agent can poll /state across origins.
  // All endpoints are localhost-only (bound to 127.0.0.1), so wildcard is safe.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashHtml);
    return;
  }
  if (req.method === 'GET' && req.url === '/state') {
    const pending = [...state.pendingConsent.entries()].map(([id, v]) => ({ id, action: v.action, args: v.args, expiresAt: v.expiresAt }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      mcpReady: state.mcpReady,
      mcpError: state.mcpError,
      mcpTools: state.mcpTools,
      relayConnected: state.relayConnected,
      agentJoined: state.agentJoined,
      pairing: PAIRING,
      agentWsUrl: `ws://localhost:${AGENT_WS_PORT}`,   // paste-this URL for the agent
      sessionArmed: state.sessionArmed,
      sessionExpiresAt: state.sessionExpiresAt,
      consentMode: CONSENT.mode,
      pending,
      recent: state.recent.slice(0, 30),
    }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/consent/')) {
    const [, , id, decision] = req.url.split('/');
    const entry = state.pendingConsent.get(id);
    if (entry) {
      state.pendingConsent.delete(id);
      entry.resolve(decision === 'allow');
      audit({ kind: 'consent_' + decision, action: entry.action });
    }
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/arm') {
    state.sessionArmed = true;
    state.sessionExpiresAt = Date.now() + 30 * 60_000;     // 30 min
    audit({ kind: 'session_armed', msg: 'auto-allow for 30 min' });
    sendStatus();
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/disarm') {
    state.sessionArmed = false;
    state.sessionExpiresAt = 0;
    audit({ kind: 'session_disarmed' });
    sendStatus();
    res.writeHead(204); res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/stop') {
    audit({ kind: 'stop', msg: 'emergency stop from dashboard' });
    if (mcp && !mcp.killed) mcp.kill();
    if (relayWs) relayWs.close();
    setTimeout(() => process.exit(0), 200);
    res.writeHead(204); res.end();
    return;
  }
  res.writeHead(404); res.end();
});

dashServer.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[bridge] ✗ Dashboard port ${DASHBOARD_PORT} is already in use.`);
    console.error(`[bridge]   Another bridge is probably running, OR change "dashboardPort" in config.json.`);
    process.exit(1);
  }
  console.error(`[bridge] dashboard server error: ${err.message}`);
  process.exit(1);
});
dashServer.listen(DASHBOARD_PORT, '127.0.0.1', () => {
  console.log(`[bridge] Dashboard at http://localhost:${DASHBOARD_PORT}`);
});

// ─── Boot ────────────────────────────────────────────────────────────────────

console.log('');
console.log('  ════════════════════════════════════════════════════════════');
console.log('  win-bridge ready');
console.log('  ════════════════════════════════════════════════════════════');
console.log(`  Agent URL    →  ws://localhost:${AGENT_WS_PORT}`);
console.log(`  Dashboard    →  http://localhost:${DASHBOARD_PORT}`);
console.log(`  Consent mode →  ${CONSENT.mode}`);
console.log('  ════════════════════════════════════════════════════════════');
console.log(`  Paste the Agent URL into the chatp web app's Workspace tab,`);
console.log(`  then click Connect. No pairing code needed for local use.`);
console.log('  ════════════════════════════════════════════════════════════');
console.log('');
console.log(`[bridge] audit log: ${AUDIT_FILE}`);

if (!args['dashboard-only']) {
  startMcp();
  if (config.useRelay) connectRelay();    // opt-in: only connect to relay if configured
}

// Ctrl-C → clean shutdown
process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down');
  if (mcp && !mcp.killed) mcp.kill();
  if (relayWs) relayWs.close();
  process.exit(0);
});
