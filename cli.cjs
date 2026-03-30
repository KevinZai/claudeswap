#!/usr/bin/env node
// claudeswap CLI — Interactive load balancer control for Claude MAX accounts

const http = require('node:http');
const readline = require('node:readline');

const VERSION = '1.0.0';
const BASE = process.env.CLAUDESWAP_URL || 'http://127.0.0.1:8082';

// ── HTTP Client ───────────────────────────────────────────────────

function fetch(path, method, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: method || 'GET',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', () => reject(new Error(
      `Cannot reach ClaudeSwap at ${BASE}\n  Is the proxy running? Try: pm2 status claudeswap`
    )));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Rendering ─────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const WHITE = '\x1b[37m';
const BG_GREEN = '\x1b[42m';
const BG_RED = '\x1b[41m';

function bar(util, width) {
  if (util == null) return DIM + '░'.repeat(width) + '   n/a' + RESET;
  const filled = Math.round(util * width);
  const pct = (util * 100).toFixed(1).padStart(5) + '%';
  const color = util > 0.8 ? RED : util > 0.5 ? YELLOW : GREEN;
  return color + '█'.repeat(filled) + RESET + DIM + '░'.repeat(width - filled) + RESET + ' ' + pct;
}

function timeUntil(epochSec) {
  if (!epochSec) return DIM + 'n/a' + RESET;
  const ms = epochSec * 1000 - Date.now();
  if (ms <= 0) return YELLOW + 'now' + RESET;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h > 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function statusBadge(status) {
  if (!status) return '';
  if (status === 'allowed') return BG_GREEN + WHITE + ' ALLOWED ' + RESET;
  return BG_RED + WHITE + ' THROTTLED ' + RESET;
}

// ── Commands ──────────────────────────────────────────────────────

const LOGO = `
${CYAN}   ╔═╗╦  ╔═╗╦ ╦╔╦╗╔═╗╔═╗╦ ╦╔═╗╔═╗${RESET}
${CYAN}   ║  ║  ╠═╣║ ║ ║║║╣ ╚═╗║║║╠═╣╠═╝${RESET}
${CYAN}   ╚═╝╩═╝╩ ╩╚═╝═╩╝╚═╝╚═╝╚╩╝╩ ╩╩  ${RESET} ${DIM}v${VERSION}${RESET}
${DIM}   Claude MAX Subscription Load Balancer${RESET}`;

async function showStatus(compact) {
  const d = await fetch('/_stats');
  const log = await fetch('/_log').catch(() => ({ entries: [] }));

  console.log(LOGO);
  console.log();
  console.log(`  ⚡ Strategy   ${CYAN}${d.strategy}${RESET}`);
  console.log(`  🎯 Mode       ${d.override ? YELLOW + '🔒 MANUAL → ' + d.override + RESET : GREEN + '🔄 AUTO' + RESET}`);
  console.log(`  🔑 Active     ${BOLD}${d.active_account || '(none)'}${RESET}`);
  if (d.fallback_available) console.log(`  🛟 Fallback   ${GREEN}ready${RESET}`);
  console.log(`  ${'─'.repeat(50)}`);

  for (const a of d.accounts) {
    const flag = a.active ? ` ${BG_GREEN}${WHITE} ◀ ACTIVE ${RESET}` : '';
    const cool = a.in_cooldown ? ` ${BG_RED}${WHITE} 🚫 COOLDOWN ${RESET}` : '';
    const icon = a.active ? '🟢' : (a.in_cooldown ? '🔴' : '⚪');
    console.log();
    console.log(`  ${icon} ${BOLD}${a.name}${RESET}${flag}${cool}  ${DIM}🔑 ${a.key_hint}${RESET}`);

    const h5 = a.five_hour;
    const h7 = a.seven_day;

    console.log(`    ⏱️  5h  ${bar(h5.utilization, 20)}  resets in ${timeUntil(h5.reset)}  ${statusBadge(h5.status)}`);
    console.log(`    📅 7d  ${bar(h7.utilization, 20)}  resets in ${timeUntil(h7.reset)}  ${statusBadge(h7.status)}`);
    console.log(`    ${DIM}📊 claim: ${a.representative_claim || 'n/a'}  │  ${a.requests_total} reqs  │  last: ${a.last_used ? new Date(a.last_used).toLocaleTimeString() : 'never'}${RESET}`);
  }

  console.log();

  const entries = log.entries || [];
  if (entries.length > 0 && !compact) {
    const recent = entries.slice(-8);
    console.log(`  📋 ${DIM}Recent Changes (${recent.length} of ${entries.length})${RESET}`);
    console.log(`  ${'─'.repeat(50)}`);
    for (const e of recent) {
      const t = new Date(e.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const icon = e.action === '429' ? '🚨' : e.action === 'switch' ? '🔀' : e.action === 'start' ? '🚀' : '📝';
      const color = e.action === '429' ? RED : e.action === 'switch' ? CYAN : e.action === 'start' ? GREEN : DIM;
      console.log(`  ${DIM}${t}${RESET}  ${icon} ${color}${e.detail}${RESET}`);
    }
    console.log();
  }
}

async function switchAccount(name) {
  const result = await fetch('/_switch', 'POST', { account: name });
  if (result.error) {
    console.error(`  ${RED}Error: ${result.error}${RESET}`);
    if (result.valid) console.error(`  Valid: ${result.valid.join(', ')}`);
    process.exit(1);
  }
  console.log(`  ${GREEN}✓${RESET} Mode: ${result.mode}, Override: ${result.override || 'auto'}`);
}

async function showLog() {
  const log = await fetch('/_log');
  const entries = log.entries || [];
  if (entries.length === 0) return console.log(`  ${DIM}No changelog entries yet.${RESET}`);
  console.log();
  console.log(`  ${BOLD}Changelog${RESET} ${DIM}(${entries.length} entries)${RESET}`);
  console.log();
  for (const e of entries) {
    const t = new Date(e.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const color = e.action === '429' ? RED : e.action === 'switch' ? CYAN : e.action === 'start' ? GREEN : DIM;
    console.log(`  ${DIM}${t}${RESET}  ${color}[${e.action}]${RESET} ${e.detail}`);
  }
  console.log();
}

async function showHealth() {
  const h = await fetch('/_health');
  if (h.ok) {
    console.log(`  ${GREEN}✓${RESET} Proxy healthy — active: ${BOLD}${h.active || '(none)'}${RESET}${h.fallback ? `, fallback: ${GREEN}ready${RESET}` : ''}`);
  } else {
    console.log(`  ${RED}✗${RESET} Proxy unhealthy`);
  }
}

async function initConfig() {
  const HOME = process.env.HOME || process.env.USERPROFILE;
  const configPath = `${HOME}/.config/claudeswap.json`;
  const fs = require('node:fs');
  if (fs.existsSync(configPath)) {
    console.log(`  Config already exists at ${configPath}`);
    return;
  }
  const template = {
    listen: '127.0.0.1',
    port: 8082,
    upstream: 'api.anthropic.com',
    accounts: [
      { name: 'account-1', token: '$ANTHROPIC_API_KEY' },
      { name: 'account-2', token: '$ANTHROPIC_API_KEY_2' },
    ],
  };
  fs.mkdirSync(`${HOME}/.config`, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(template, null, 2));
  console.log(`  ${GREEN}✓${RESET} Config created at ${configPath}`);
  console.log(`  Edit account names and tokens, then start the proxy.`);
}

// ── Interactive Menu ──────────────────────────────────────────────

async function interactiveMenu() {
  let running = true;

  while (running) {
    await showStatus(true);

    const d = await fetch('/_stats');
    const accountNames = d.accounts.map(a => a.name);

    console.log(`  ${BOLD}Commands:${RESET}`);
    accountNames.forEach((name, i) => {
      const active = d.accounts[i].active ? ` ${DIM}(active)${RESET}` : '';
      console.log(`    ${BOLD}${i + 1}${RESET}  Switch to ${name}${active}`);
    });
    console.log(`    ${BOLD}a${RESET}  Auto mode`);
    console.log(`    ${BOLD}l${RESET}  View full changelog`);
    console.log(`    ${BOLD}r${RESET}  Refresh status`);
    console.log(`    ${BOLD}q${RESET}  Quit`);
    console.log();

    const answer = await prompt(`  ${CYAN}>${RESET} `);
    const trimmed = answer.trim().toLowerCase();

    if (trimmed === 'q' || trimmed === 'quit' || trimmed === 'exit') {
      running = false;
    } else if (trimmed === 'a' || trimmed === 'auto') {
      await switchAccount('auto');
    } else if (trimmed === 'l' || trimmed === 'log') {
      await showLog();
      await prompt(`  ${DIM}Press Enter to continue...${RESET}`);
    } else if (trimmed === 'r' || trimmed === 'refresh') {
      // Just loop again to refresh
    } else {
      const idx = parseInt(trimmed, 10) - 1;
      if (idx >= 0 && idx < accountNames.length) {
        await switchAccount(accountNames[idx]);
      } else if (trimmed !== '') {
        console.log(`  ${RED}Unknown command: ${trimmed}${RESET}`);
      }
    }

    if (running) {
      // Clear screen for fresh view
      process.stdout.write('\x1b[2J\x1b[H');
    }
  }
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

// ── Main ──────────────────────────────────────────────────────────

const HELP = `
  ${BOLD}claudeswap${RESET} v${VERSION} — Claude MAX Subscription Load Balancer

  ${BOLD}Usage:${RESET}
    claudeswap                   Show status + recent changes
    claudeswap status            Show status + recent changes
    claudeswap menu              Interactive mode (navigate with keys)
    claudeswap switch <name>     Switch to account (manual override)
    claudeswap auto              Return to automatic mode
    claudeswap log               Show full changelog
    claudeswap health            Quick health check
    claudeswap init              Create config file
    claudeswap help              Show this help

  ${BOLD}Config:${RESET}    ~/.config/claudeswap.json
  ${BOLD}State:${RESET}     ~/.config/claudeswap-state.json
  ${BOLD}Proxy:${RESET}     ${BASE}

  ${DIM}https://github.com/k3v80/claudeswap${RESET}
`;

const [,, cmd, arg] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case undefined:
      case 'status':
        await showStatus();
        break;
      case 'menu':
      case '-i':
      case '--interactive':
        process.stdout.write('\x1b[2J\x1b[H');
        await interactiveMenu();
        break;
      case 'switch':
        if (!arg) { console.error(`  Usage: claudeswap switch <account-name>`); process.exit(1); }
        await switchAccount(arg);
        break;
      case 'auto':
        await switchAccount('auto');
        break;
      case 'log':
        await showLog();
        break;
      case 'health':
        await showHealth();
        break;
      case 'init':
        await initConfig();
        break;
      case 'help': case '--help': case '-h':
        console.log(HELP);
        break;
      default:
        console.error(`  ${RED}Unknown command: ${cmd}${RESET}`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (e) {
    console.error(`  ${RED}${e.message}${RESET}`);
    process.exit(1);
  }
})();
