<div align="center">

<img src="https://raw.githubusercontent.com/boppenh/chatp-bridge/main/public/favicon.svg" alt="Spaces Logo" width="96" height="96" />

# Spaces Bridge

### Connect your Windows desktop to [Spaces](https://spaces.openbnet.com) — and let AI truly control your machine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/Platform-Windows-0078D6.svg)](https://www.microsoft.com/windows)

[spaces.openbnet.com](https://spaces.openbnet.com) · [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) · [Report Bug](https://github.com/boppenh/chatp-bridge/issues)

</div>

---

**Spaces Bridge** is a lightweight local agent that runs on your Windows machine. It creates a secure local tunnel between the [Spaces](https://spaces.openbnet.com) web app in your browser and your desktop — giving the Spaces AI the ability to run shell commands, manage files, control the UI, take screenshots, and more. Everything is powered under the hood by [Windows-MCP](https://github.com/CursorTouch/Windows-MCP).

> **Your data stays on your machine.** The bridge only listens on `localhost`. Nothing leaves your local environment unless you explicitly enable relay mode.

---

## ✨ What It Does

| Capability | Details |
|---|---|
| 🔌 **MCP Launcher** | Starts and manages the Windows-MCP subprocess automatically |
| 🌐 **WebSocket Server** | Exposes `ws://localhost:3738` for the Spaces agent to connect |
| 📊 **Live Dashboard** | Status dashboard at `http://localhost:3737` |
| 🔒 **Consent Controls** | Three authorization modes: auto, session, always-ask |
| 🚫 **Path & App Blocklists** | Permanently block sensitive paths and processes |
| 📋 **Audit Logging** | Every action logged to `~/.spaces-bridge/audit.jsonl` |

---

## 🚀 Quick Start (Windows)

### 1. Install `uv` (the Windows-MCP runtime)

```powershell
winget install astral-sh.uv
```

Or via pip: `pip install uv`

### 2. Verify Windows-MCP works

```powershell
uvx windows-mcp
```

You should see `Starting MCP server 'windows-mcp' with transport 'stdio'`. Press `Ctrl+C` to exit.

### 3. Install Bridge dependencies

```powershell
npm install
```

### 4. Start the Bridge

```powershell
npm start
```

Your terminal will show:

```
  Agent URL    →  ws://localhost:3738
  Dashboard    →  http://localhost:3737
```

Open [Spaces](https://spaces.openbnet.com), go to the **Workspace** tab → paste `ws://localhost:3738` (or keep the default) → click **Connect**. That's it.

---

## ⚙️ Configuration (`config.json`)

Copy [`config.example.json`](./config.example.json) to `config.json` and adjust as needed:

| Key | Default | Description |
|---|---|---|
| `agentWsPort` | `3738` | Port the Spaces agent connects to |
| `dashboardPort` | `3737` | Dashboard port |
| `consent.mode` | `auto` | `auto` (allow all), `session` (authorize every 30 min), `always-ask` (confirm each action) |
| `consent.blockedPaths` | system32, credentials | Glob patterns — always denied |
| `consent.blockedApps` | lsass, explorer | Substring matches — always denied |
| `useRelay` | `false` | Set to `true` for cross-machine scenarios |
| `mcp.command` | `uvx` | Windows-MCP launch command (override if needed) |

---

## 🔐 Security & Trust Model

The Bridge puts you in control at all times:

- The console and dashboard show every action the agent requests
- **`auto` mode** — anything not on the blocklist is allowed. Convenient, but only use with agents you trust.
- **`session` mode** — click "Arm session" in the dashboard; authorization lasts 30 minutes.
- **`always-ask` mode** — every non-read-only operation pops a confirmation in the dashboard.
- An **emergency stop** button instantly kills both MCP and the Bridge.
- All events are written to `~/.spaces-bridge/audit.jsonl` (one JSON object per line).

---

## 🖥️ Cross-Machine Usage (Advanced, Optional)

If the Bridge and the Spaces web app run on different machines, you need a `desktop-relay` server that both sides can reach:

1. Deploy `chatp/desktop-relay/relay.js` (Node.js, default port 2233)
2. Set `useRelay: true`, `relayUrl`, and `pairingCode` in `config.json`
3. Enter the relay URL and the same pairing code in the Spaces Workspace tab

---

## 🛠️ Troubleshooting

| Symptom | Fix |
|---|---|
| Agent UI shows "Cannot reach bridge" | Bridge isn't running or the port is wrong — check `npm start` terminal output |
| Dashboard shows "MCP not ready" | `uvx windows-mcp` failed to start — run it manually to see the error |
| Port already in use | Another Bridge instance is running, or change the port in `config.json` |

---

## 📡 Protocol Reference

**Agent → Bridge (request):**
```json
{ "id": "req_123", "type": "exec", "action": "PowerShell", "args": { "command": "Get-Date" } }
```

**Bridge → Agent (response):**
```json
{ "id": "req_123", "type": "result", "output": "...", "screenshot": null }
```

**Bridge → Agent (broadcast):**
```json
{ "type": "hello",  "capabilities": { "mcpReady": true, "mcpTools": ["..."], "..." : "..." } }
{ "type": "status", "capabilities": { "..." : "..." } }
```

---

## 👥 Contributors

| | |
|---|---|
| **Brian** | [@boppenh](https://github.com/boppenh) · [brian@openbnet.com](mailto:brian@openbnet.com) · Founder & Lead Developer |

---

## 📄 License

MIT © [OpenBNet](https://openbnet.com)
