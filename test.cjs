#!/usr/bin/env node
// ClaudeSwap test suite — pure Node.js, zero dependencies
// Tests core functions extracted from server.cjs logic

const assert = require('node:assert/strict');
const { describe, it, run } = require('node:test');

// ── Extracted pure functions (mirrors server.cjs logic) ──────────

function isOAuthToken(token) {
  return token && token.startsWith('sk-ant-oat');
}

function maskToken(token) {
  if (!token) return 'NOT SET';
  return '...' + token.slice(-8);
}

function resolveToken(raw, env = {}) {
  if (!raw) return null;
  const envMatch = raw.match(/^\$\{?([A-Z_][A-Z0-9_]*)\}?$/);
  if (envMatch) {
    return env[envMatch[1]] || null;
  }
  return raw;
}

function freshAccountState() {
  return {
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
  };
}

// selectAccount logic extracted for testing (no side effects)
function pickAccount(accounts, stateAccounts, override, now) {
  if (override) {
    const acct = accounts.find(a => a.name === override);
    if (acct && acct.token) return { account: acct, reason: 'manual override' };
  }

  const viable = accounts.filter(a => {
    if (!a.token) return false;
    const s = stateAccounts[a.name];
    return !s.cooldown_until || new Date(s.cooldown_until).getTime() <= now;
  });

  if (viable.length === 0) {
    return { account: null, reason: 'all exhausted' };
  }

  if (viable.length === 1) {
    return { account: viable[0], reason: 'only viable' };
  }

  // Drain-first: 7d-reset → 5h-reset → utilization
  const scored = viable.map(a => {
    const s = stateAccounts[a.name];
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

  return { account: scored[0].account, reason: 'drain-first' };
}

// ── Tests ──────────────────────────────────────────────────────────

describe('isOAuthToken', () => {
  it('detects OAuth tokens', () => {
    assert.equal(isOAuthToken('sk-ant-oat01-abc123'), true);
    assert.equal(isOAuthToken('sk-ant-oat99-xyz'), true);
  });

  it('rejects console API keys', () => {
    assert.equal(isOAuthToken('sk-ant-api03-abc123'), false);
  });

  it('handles null/undefined/empty (falsy)', () => {
    assert.ok(!isOAuthToken(null));
    assert.ok(!isOAuthToken(undefined));
    assert.ok(!isOAuthToken(''));
  });
});

describe('maskToken', () => {
  it('masks token showing last 8 chars', () => {
    assert.equal(maskToken('sk-ant-api03-abcdefghijklmnop'), '...ijklmnop');
  });

  it('handles short tokens', () => {
    assert.equal(maskToken('12345678'), '...12345678');
    assert.equal(maskToken('1234'), '...1234');
  });

  it('returns NOT SET for falsy', () => {
    assert.equal(maskToken(null), 'NOT SET');
    assert.equal(maskToken(undefined), 'NOT SET');
    assert.equal(maskToken(''), 'NOT SET');
  });
});

describe('resolveToken', () => {
  it('resolves $VAR syntax', () => {
    assert.equal(resolveToken('$MY_KEY', { MY_KEY: 'resolved' }), 'resolved');
  });

  it('resolves ${VAR} syntax', () => {
    assert.equal(resolveToken('${MY_KEY}', { MY_KEY: 'resolved' }), 'resolved');
  });

  it('returns null for missing env var', () => {
    assert.equal(resolveToken('$MISSING', {}), null);
  });

  it('returns literal token as-is', () => {
    assert.equal(resolveToken('sk-ant-api03-abc', {}), 'sk-ant-api03-abc');
  });

  it('returns null for null/undefined input', () => {
    assert.equal(resolveToken(null), null);
    assert.equal(resolveToken(undefined), null);
  });

  it('does not resolve partial env patterns', () => {
    assert.equal(resolveToken('prefix-$VAR', {}), 'prefix-$VAR');
    assert.equal(resolveToken('$lower_case', {}), '$lower_case');
  });
});

describe('freshAccountState', () => {
  it('returns correct shape', () => {
    const s = freshAccountState();
    assert.equal(s.requests_total, 0);
    assert.equal(s.cooldown_until, null);
    assert.equal(s.five_hour_utilization, null);
    assert.equal(s.seven_day_utilization, null);
  });

  it('returns independent copies', () => {
    const a = freshAccountState();
    const b = freshAccountState();
    a.requests_total = 99;
    assert.equal(b.requests_total, 0);
  });
});

describe('pickAccount (drain-first selection)', () => {
  const acctA = { name: 'max-primary', token: 'sk-ant-api03-aaa' };
  const acctB = { name: 'max-secondary', token: 'sk-ant-api03-bbb' };
  const now = Date.now();

  it('respects manual override', () => {
    const states = {
      'max-primary': freshAccountState(),
      'max-secondary': freshAccountState(),
    };
    const result = pickAccount([acctA, acctB], states, 'max-secondary', now);
    assert.equal(result.account.name, 'max-secondary');
    assert.equal(result.reason, 'manual override');
  });

  it('returns null when all accounts exhausted', () => {
    const states = {
      'max-primary': { ...freshAccountState(), cooldown_until: new Date(now + 60000).toISOString() },
      'max-secondary': { ...freshAccountState(), cooldown_until: new Date(now + 60000).toISOString() },
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    assert.equal(result.account, null);
  });

  it('picks only viable account when one is in cooldown', () => {
    const states = {
      'max-primary': { ...freshAccountState(), cooldown_until: new Date(now + 60000).toISOString() },
      'max-secondary': freshAccountState(),
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    assert.equal(result.account.name, 'max-secondary');
  });

  it('prefers account with soonest 7d reset', () => {
    const soonReset = Math.floor(now / 1000) + 3600;   // 1h from now
    const laterReset = Math.floor(now / 1000) + 86400;  // 24h from now
    const states = {
      'max-primary': { ...freshAccountState(), seven_day_reset: soonReset, seven_day_utilization: 0.5 },
      'max-secondary': { ...freshAccountState(), seven_day_reset: laterReset, seven_day_utilization: 0.1 },
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    assert.equal(result.account.name, 'max-primary');
  });

  it('prefers account with known rate data over unknown', () => {
    const states = {
      'max-primary': { ...freshAccountState(), seven_day_reset: Math.floor(now / 1000) + 3600 },
      'max-secondary': freshAccountState(),
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    assert.equal(result.account.name, 'max-primary');
  });

  it('breaks 7d tie with 5h reset', () => {
    const sameReset7d = Math.floor(now / 1000) + 86400;
    const states = {
      'max-primary': { ...freshAccountState(), seven_day_reset: sameReset7d, five_hour_reset: Math.floor(now / 1000) + 7200 },
      'max-secondary': { ...freshAccountState(), seven_day_reset: sameReset7d, five_hour_reset: Math.floor(now / 1000) + 3600 },
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    assert.equal(result.account.name, 'max-secondary'); // sooner 5h reset
  });

  it('breaks reset tie with higher utilization (drain it)', () => {
    const sameReset = Math.floor(now / 1000) + 86400;
    const states = {
      'max-primary': { ...freshAccountState(), seven_day_reset: sameReset, seven_day_utilization: 0.8 },
      'max-secondary': { ...freshAccountState(), seven_day_reset: sameReset, seven_day_utilization: 0.3 },
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    assert.equal(result.account.name, 'max-primary'); // higher util = drain it first
  });

  it('skips accounts with no token', () => {
    const noToken = { name: 'max-primary', token: null };
    const states = {
      'max-primary': freshAccountState(),
      'max-secondary': freshAccountState(),
    };
    const result = pickAccount([noToken, acctB], states, null, now);
    assert.equal(result.account.name, 'max-secondary');
  });

  it('clears expired cooldown', () => {
    const states = {
      'max-primary': { ...freshAccountState(), cooldown_until: new Date(now - 1000).toISOString() },
      'max-secondary': freshAccountState(),
    };
    const result = pickAccount([acctA, acctB], states, null, now);
    // Both viable — primary's cooldown is expired
    assert.notEqual(result.account, null);
  });
});

// Run with: node test.cjs
