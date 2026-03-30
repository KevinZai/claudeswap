#!/usr/bin/env node
// claudeswap — Smart load balancer for multiple Claude MAX subscriptions
// Zero npm dependencies. Drains account with soonest-expiring window first.
// Uses Anthropic unified rate limit headers (5h + 7d windows).
// Endpoints: /_stats /_switch /_health /_log

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { join } = require('node:path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const CONFIG_PATH = process.env.CLAUDESWAP_CONFIG || join(HOME, '.config', 'claudeswap.json');
const STATE_PATH = process.env.CLAUDESWAP_STATE || join(HOME, '.config', 'claudeswap-state.json');

let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`[claudeswap] Cannot read config at ${CONFIG_PATH}: ${e.message}`);
  console.error('[claudeswap] Run "claudeswap init" to create a config file.');
  process.exit(1);
}

const PORT = config.port || 8082;
const LISTEN = config.listen || '127.0.0.1';
const UPSTREAM = config.upstream || 'api.anthropic.com';
const NOTIFY_CMD = config.notify_cmd || null;

// ── Token Resolution ──────────────────────────────────────────────
// Tokens can be:
//   1. Console API key: "sk-ant-api03-..." (uses x-api-key header)
//   2. OAuth token:     "sk-ant-oat01-..." (uses Bearer + beta header)
//   3. Env var:         "$ANTHROPIC_API_KEY" or "${ANTHROPIC_API_KEY}"

const OAUTH_BETA = 'oauth-2025-04-20';

function isOAuthToken(token) {
  return token && token.startsWith('sk-ant-oat');
}

function resolveToken(raw) {
  if (!raw) return null;
  const envMatch = raw.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/);
  if (envMatch) {
    const val = process.env[envMatch[1]];
    if (!val) log(`WARNING: env var ${envMatch[1]} not set`);
    return val || null;
  }
  return raw;
}

const ACCOUNTS = config.accounts.map(a => ({
  name: a.name,
  token: resolveToken(a.token),
}));

// Fallback key: if proxy is running but ALL configured accounts fail,
// fall back to ANTHROPIC_API_KEY from env (the "default" key).
const FALLBACK_TOKEN = config.fallback_key
  ? resolveToken(config.fallback_key)
  : process.env.ANTHROPIC_API_KEY || null;

function maskToken(token) {
  if (!token) return 'NOT SET';
  return '...' + token.slice(-8);
}

// ── Changelog ─────────────────────────────────────────────────────

const MAX_LOG_ENTRIES = 50;
let changelog = [];

function addLogEntry(action, detail) {
  changelog.push({ time: new Date().toISOString(), action, detail });
  if (changelog.length > MAX_LOG_ENTRIES) changelog.shift();
}

// ── State ──────────────────────────────────────────────────────────

const freshAccountState = () => ({
  unified_status: null,
  five_hour_utilization: null,
  five_hour_reset: null,
  five_hour_status: null,
  seven_day_utilization: null,
  seven_day_reset: null,
  seven_day_status: null,
  representative_claim: null,
  cooldown_until: null,
  requests_total: 0,
  last_used: null,
});

let state = { override: null, accounts: {} };
for (const a of ACCOUNTS) state.accounts[a.name] = freshAccountState();

try {
  const saved = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  for (const [name, data] of Object.entries(saved.accounts || {})) {
    if (state.accounts[name]) Object.assign(state.accounts[name], data);
  }
  if (saved.changelog) changelog = saved.changelog.slice(-MAX_LOG_ENTRIES);
  state.override = saved.override || null;
  log('restored state from disk');
} catch { log('no saved state, starting fresh'); }

let dirty = false;
setInterval(() => { if (dirty) { dirty = false; persist(); } }, 5000);

function persist() {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...state, changelog }, null, 2));
  } catch (e) { log(`state save failed: ${e.message}`); }
}

function log(msg) { console.log(`[${new Date().toISOString()}] [claudeswap] ${msg}`); }

// ── Notification ──────────────────────────────────────────────────

let lastNotifiedAccount = null;

function notify(fromName, toName, reason) {
  if (toName === lastNotifiedAccount) return;
  lastNotifiedAccount = toName;
  const msg = `[ClaudeSwap] Switched to **${toName}**${fromName ? ` (was ${fromName})` : ''}. Reason: ${reason}`;
  log(msg);
  addLogEntry('switch', `${fromName || '(none)'} → ${toName}: ${reason}`);

  if (NOTIFY_CMD) {
    const [cmd, ...args] = NOTIFY_CMD.split(' ');
    execFile(cmd, [...args, msg], { timeout: 10000 }, () => {});
  }
}

// ── Account Selection ──────────────────────────────────────────────

let activeAccountName = null;

function selectAccount() {
  const now = Date.now();

  if (state.override) {
    const acct = ACCOUNTS.find(a => a.name === state.override);
    if (acct && acct.token) {
      switchTo(acct.name, 'manual override');
      return acct;
    }
  }

  // Filter to accounts that have valid tokens and are not in cooldown
  const viable = ACCOUNTS.filter(a => {
    if (!a.token) return false;
    const s = state.accounts[a.name];
    return !s.cooldown_until || new Date(s.cooldown_until).getTime() <= now;
  });

  if (viable.length === 0) {
    // All accounts exhausted — try fallback
    if (FALLBACK_TOKEN) {
      log('all accounts in cooldown, using fallback key');
      return { name: '_fallback', token: FALLBACK_TOKEN };
    }
    // No fallback — pick soonest-expiring cooldown
    const withTokens = ACCOUNTS.filter(a => a.token);
    if (withTokens.length === 0) {
      log('ERROR: no accounts have valid tokens');
      return ACCOUNTS[0]; // will fail, but at least returns something
    }
    const pick = [...withTokens].sort((a, b) =>
      new Date(state.accounts[a.name].cooldown_until).getTime() -
      new Date(state.accounts[b.name].cooldown_until).getTime()
    )[0];
    switchTo(pick.name, 'both in cooldown, soonest-expiring');
    return pick;
  }

  if (viable.length === 1) {
    switchTo(viable[0].name, 'other account in cooldown');
    return viable[0];
  }

  // Drain-first: 7d-reset → 5h-reset → utilization
  const scored = viable.map(a => {
    const s = state.accounts[a.name];
    const reset7d = s.seven_day_reset ? s.seven_day_reset * 1000 : Infinity;
    const reset5h = s.five_hour_reset ? s.five_hour_reset * 1000 : Infinity;
    const util7d = s.seven_day_utilization ?? 0;
    const util5h = s.five_hour_utilization ?? 0;
    const maxUtil = Math.max(util7d, util5h);
    return { account: a, reset7d, reset5h, util7d, util5h, maxUtil };
  });

  scored.sort((a, b) => {
    const aKnown = a.reset7d !== Infinity || a.reset5h !== Infinity;
    const bKnown = b.reset7d !== Infinity || b.reset5h !== Infinity;
    if (aKnown && !bKnown) return -1;
    if (bKnown && !aKnown) return 1;
    if (a.reset7d !== b.reset7d) return a.reset7d - b.reset7d;
    if (a.reset5h !== b.reset5h) return a.reset5h - b.reset5h;
    return b.maxUtil - a.maxUtil;
  });

  const winner = scored[0];
  let reason;
  if (winner.reset7d !== Infinity) {
    reason = `drain-first: 7d resets ${new Date(winner.reset7d).toISOString()}, 5h=${(winner.util5h * 100).toFixed(1)}% 7d=${(winner.util7d * 100).toFixed(1)}%`;
  } else {
    reason = 'initial selection (no rate data yet)';
  }
  switchTo(winner.account.name, reason);
  return winner.account;
}

function switchTo(name, reason) {
  if (activeAccountName === name) return;
  const prev = activeAccountName;
  activeAccountName = name;
  notify(prev, name, reason);
}

// ── Rate Limit Header Parsing ──────────────────────────────────────

function updateFromHeaders(accountName, headers, statusCode) {
  if (accountName === '_fallback') return;
  const s = state.accounts[accountName];
  if (!s) return;

  const get = (key) => headers[key];
  const unifiedStatus = get('anthropic-ratelimit-unified-status');
  const fiveHourUtil = get('anthropic-ratelimit-unified-5h-utilization');
  const fiveHourReset = get('anthropic-ratelimit-unified-5h-reset');
  const fiveHourStatus = get('anthropic-ratelimit-unified-5h-status');
  const sevenDayUtil = get('anthropic-ratelimit-unified-7d-utilization');
  const sevenDayReset = get('anthropic-ratelimit-unified-7d-reset');
  const sevenDayStatus = get('anthropic-ratelimit-unified-7d-status');
  const repClaim = get('anthropic-ratelimit-unified-representative-claim');

  if (unifiedStatus) s.unified_status = unifiedStatus;
  if (fiveHourUtil != null) s.five_hour_utilization = parseFloat(fiveHourUtil);
  if (fiveHourReset != null) s.five_hour_reset = parseInt(fiveHourReset, 10);
  if (fiveHourStatus) s.five_hour_status = fiveHourStatus;
  if (sevenDayUtil != null) s.seven_day_utilization = parseFloat(sevenDayUtil);
  if (sevenDayReset != null) s.seven_day_reset = parseInt(sevenDayReset, 10);
  if (sevenDayStatus) s.seven_day_status = sevenDayStatus;
  if (repClaim) s.representative_claim = repClaim;

  s.last_used = new Date().toISOString();
  s.requests_total++;

  if (statusCode === 429) {
    const retryAfter = headers['retry-after'];
    const cooldownMs = retryAfter ? parseFloat(retryAfter) * 1000 : 60000;
    s.cooldown_until = new Date(Date.now() + cooldownMs).toISOString();
    log(`${accountName} → 429, cooldown ${Math.round(cooldownMs / 1000)}s`);
    addLogEntry('429', `${accountName} rate limited, cooldown ${Math.round(cooldownMs / 1000)}s`);
  } else if (s.cooldown_until) {
    s.cooldown_until = null;
  }

  dirty = true;
}

// ── API Endpoints ─────────────────────────────────────────────────

function handleStats(res) {
  const now = Date.now();
  const accountStats = ACCOUNTS.map(a => {
    const s = state.accounts[a.name];
    return {
      name: a.name,
      active: a.name === activeAccountName,
      key_hint: maskToken(a.token),
      unified_status: s.unified_status,
      five_hour: {
        utilization: s.five_hour_utilization,
        reset: s.five_hour_reset,
        reset_iso: s.five_hour_reset ? new Date(s.five_hour_reset * 1000).toISOString() : null,
        status: s.five_hour_status,
      },
      seven_day: {
        utilization: s.seven_day_utilization,
        reset: s.seven_day_reset,
        reset_iso: s.seven_day_reset ? new Date(s.seven_day_reset * 1000).toISOString() : null,
        status: s.seven_day_status,
      },
      representative_claim: s.representative_claim,
      cooldown_until: s.cooldown_until,
      in_cooldown: s.cooldown_until ? new Date(s.cooldown_until).getTime() > now : false,
      requests_total: s.requests_total,
      last_used: s.last_used,
    };
  });

  const body = JSON.stringify({
    strategy: 'drain-first (7d-reset → 5h-reset → utilization)',
    override: state.override,
    active_account: activeAccountName,
    fallback_available: !!FALLBACK_TOKEN,
    accounts: accountStats,
  }, null, 2);

  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

function handleLog(res) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ entries: changelog }, null, 2));
}

function handleSwitch(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: 'POST required' }));
  }
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { account } = JSON.parse(body);
      if (account === 'auto' || account === null) {
        const prev = state.override;
        state.override = null;
        activeAccountName = null;
        lastNotifiedAccount = null;
        dirty = true;
        persist();
        addLogEntry('override', `cleared (was ${prev || 'auto'})`);
        log('override cleared → auto mode');
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ override: null, mode: 'auto' }));
      }
      if (!ACCOUNTS.find(a => a.name === account)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `unknown account: ${account}`, valid: ACCOUNTS.map(a => a.name) }));
      }
      state.override = account;
      dirty = true;
      persist();
      addLogEntry('override', `set → ${account}`);
      log(`override set → ${account}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ override: account, mode: 'manual' }));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON' }));
    }
  });
}

// ── Proxy ──────────────────────────────────────────────────────────

function proxyRequest(account, body, clientReq, clientRes, retried) {
  const headers = { ...clientReq.headers };

  // Set auth based on token type: OAuth (Bearer) vs API key (x-api-key)
  if (isOAuthToken(account.token)) {
    delete headers['x-api-key'];
    headers['authorization'] = `Bearer ${account.token}`;
    const existing = headers['anthropic-beta'] || '';
    if (!existing.includes(OAUTH_BETA)) {
      headers['anthropic-beta'] = existing ? `${existing},${OAUTH_BETA}` : OAUTH_BETA;
    }
  } else {
    delete headers['authorization'];
    headers['x-api-key'] = account.token;
  }

  headers['host'] = UPSTREAM;
  delete headers['connection'];
  delete headers['transfer-encoding'];
  if (body.length > 0) headers['content-length'] = body.length;

  const upReq = https.request({
    hostname: UPSTREAM, port: 443, path: clientReq.url,
    method: clientReq.method, headers,
  }, (upRes) => {
    updateFromHeaders(account.name, upRes.headers, upRes.statusCode);

    if (upRes.statusCode === 429 && !retried) {
      upRes.resume();
      const other = selectAccount();
      if (other.name !== account.name) {
        log(`retrying with ${other.name} after 429 on ${account.name}`);
        proxyRequest(other, body, clientReq, clientRes, true);
        return;
      }
    }

    const fwdHeaders = { ...upRes.headers };
    delete fwdHeaders['connection'];
    clientRes.writeHead(upRes.statusCode, fwdHeaders);
    upRes.pipe(clientRes);
  });

  upReq.on('error', (err) => {
    log(`upstream error: ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'content-type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'upstream connection failed' }));
    }
  });

  upReq.end(body);
}

function handleActiveKey(res) {
  const account = selectAccount();
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(account.token || '');
}

// ── Server ─────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.url === '/_stats') return handleStats(res);
  if (req.url === '/_switch') return handleSwitch(req, res);
  if (req.url === '/_log') return handleLog(res);
  if (req.url === '/_active_key') return handleActiveKey(res);
  if (req.url === '/_health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, active: activeAccountName, fallback: !!FALLBACK_TOKEN }));
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const account = selectAccount();
    proxyRequest(account, body, req, res, false);
  });
  req.on('error', () => {});
});

server.listen(PORT, LISTEN, () => {
  log(`listening on ${LISTEN}:${PORT}`);
  log(`accounts: ${ACCOUNTS.map(a => `${a.name} (${maskToken(a.token)})`).join(', ')}`);
  log(`fallback: ${FALLBACK_TOKEN ? maskToken(FALLBACK_TOKEN) : 'none'}`);
  log(`strategy: drain-first (7d-reset → 5h-reset → utilization)`);
  log(`override: ${state.override || 'auto'}`);
  addLogEntry('start', `proxy started on ${LISTEN}:${PORT}`);
});

process.on('SIGTERM', () => { persist(); process.exit(0); });
process.on('SIGINT', () => { persist(); process.exit(0); });
