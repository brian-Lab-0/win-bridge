# win-bridge

Local agent for your Windows machine. Lets the [chatp](https://spaces.openbnet.com) web app (running in your browser) drive your desktop — shell, files, UI automation, screenshots — through [Windows-MCP](https://github.com/CursorTouch/Windows-MCP).

Powers the **win-connect** tool inside chatp.

## What it does

- Spawns Windows-MCP as a child process
- Opens a local WebSocket server on `ws://localhost:3738` for the chatp agent
- Serves a status dashboard at `http://localhost:3737`
- Enforces consent (auto / session-armed / per-action), path/app blocklists, audit log

The bridge stays on YOUR machine. Nothing leaves localhost unless you opt into the relay (advanced cross-machine setup).

## One-time setup (Windows)

1. **Install `uv`** (Python package manager, used for Windows-MCP):
   ```powershell
   winget install astral-sh.uv
   ```
   Or via pip: `pip install uv`

2. **Verify Windows-MCP runs:**
   ```powershell
   uvx windows-mcp
   ```
   You should see `Starting MCP server 'windows-mcp' with transport 'stdio'`. Press `Ctrl+C` to stop.

3. **Install bridge dependencies:**
   ```powershell
   npm install
   ```

## Running

```powershell
npm start
```

You should see:
```
  Agent URL    →  ws://localhost:3738
  Dashboard    →  http://localhost:3737
```

Open the chatp web app, go to **Workspace** tab → paste `ws://localhost:3738` (or leave the default) → **Connect**. Done.

## Configuration (`config.json`)

| Key | Default | Notes |
|---|---|---|
| `agentWsPort` | `3738` | Port the agent connects to |
| `dashboardPort` | `3737` | Status dashboard port |
| `consent.mode` | `auto` | `auto` (allow all), `session` (arm once for 30 min), `always-ask` (per-action dashboard prompt) |
| `consent.blockedPaths` | system32, credentials | Glob patterns — always denied |
| `consent.blockedApps` | lsass, explorer | Substring match — always denied |
| `useRelay` | `false` | Set `true` only for cross-machine setups |
| `mcp.command` | `uvx` | Override if Windows-MCP runs differently |

## Trust model

- Console + dashboard show every action the agent attempts
- `auto` mode allows anything not in the blocklist — convenient but trust the agent first
- `session` mode requires clicking "Arm session" in the dashboard once per 30 min
- `always-ask` shows a consent button in the dashboard for each non-readonly action
- Emergency stop button kills MCP + bridge instantly
- Audit log at `~/.chatp-bridge/audit.jsonl` (one event per line, JSON)

## Cross-machine use (optional, advanced)

If the bridge and the chatp web app run on different machines, you need the `desktop-relay` server somewhere both can reach.

1. Deploy `chatp/desktop-relay/relay.js` (Node.js, port 2233 by default)
2. In `config.json` set `useRelay: true`, set `relayUrl` to your relay URL, and pick a `pairingCode`
3. In the chatp Workspace tab, enter the relay URL and the same pairing code

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Cannot reach bridge" in agent UI | Bridge isn't running, or wrong port. Check `npm start` terminal. |
| Dashboard shows "MCP not ready" | `uvx windows-mcp` failed to start. Run it manually to see the error. |
| Port already in use | Another bridge is running, or change `agentWsPort` / `dashboardPort` in `config.json`. |

## Wire protocol (for reference)

Agent → bridge:
```json
{ "id": "req_123", "type": "exec", "action": "PowerShell", "args": { "command": "Get-Date" } }
```

Bridge → agent:
```json
{ "id": "req_123", "type": "result", "output": "...", "screenshot": null }
```

Bridge → agent (broadcast):
```json
{ "type": "hello",  "capabilities": { "mcpReady": true, "mcpTools": [...], ... } }
{ "type": "status", "capabilities": { ... } }
```
