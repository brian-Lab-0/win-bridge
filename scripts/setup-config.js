#!/usr/bin/env node
// Auto-generate config.json from config.example.json on first run.
// Picks a random pairing code so users never see "CHANGE-ME" errors.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root       = path.resolve(__dirname, '..');
const exampleCfg = path.join(root, 'config.example.json');
const userCfg    = path.join(root, 'config.json');

if (fs.existsSync(userCfg)) {
  console.log('[setup] config.json already exists — leaving it untouched.');
  process.exit(0);
}

if (!fs.existsSync(exampleCfg)) {
  console.error('[setup] config.example.json missing — cannot generate config.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(exampleCfg, 'utf-8'));

// 6-char A-Z + 0-9 code (skip ambiguous chars: 0/O, 1/I)
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = Array.from(crypto.randomBytes(6)).map(b => alphabet[b % alphabet.length]).join('');
cfg.pairingCode = code;

fs.writeFileSync(userCfg, JSON.stringify(cfg, null, 2) + '\n', 'utf-8');
console.log('[setup] ✓ config.json created');
console.log(`[setup]   pairing code: ${code}  (only needed for relay/cross-machine mode)`);
