# ClaudeSwap

**Smart load balancer for multiple Claude MAX subscriptions.**

Maximize your combined Anthropic rate limits by intelligently routing requests across multiple Claude MAX accounts. Zero dependencies. One command to start.

<img width="100%" alt="image" src="https://github.com/user-attachments/assets/a7f108c9-1374-4023-8b2f-1a3c5ee35ac5" />


## Why?

Claude MAX subscriptions have **two rate limit windows** — a 5-hour sliding window and a 7-day sliding window. If you have multiple MAX accounts, you're leaving capacity on the table unless you route requests intelligently.

ClaudeSwap sits between your tools and the Anthropic API, automatically picking the right account on every request:

1. **Drain the account whose 7-day window expires soonest** — use it before the capacity resets and is wasted
2. **Then the 5-hour window** as a tiebreaker
3. **Then utilization** — prefer the account already being drained (finish it off)
4. **On 429** — automatically retry with the other account, zero downtime

```
$ claudeswap

  ClaudeSwap v1.0.0
  Claude MAX Subscription Load Balancer

  Strategy   drain-first (7d-reset → 5h-reset → utilization)
  Mode       AUTO
  Active     max-primary

  max-primary  ACTIVE   key: ...xZRTIQAA
    5h  ██████░░░░░░░░░░░░░░   30.0%  resets in 2h 15m   ALLOWED
    7d  ███░░░░░░░░░░░░░░░░░   15.0%  resets in 4d 8h    ALLOWED
    claim: five_hour  │  127 reqs  │  last: 3:42:15 PM

  max-secondary              key: ...FdC3BgAA
    5h  ░░░░░░░░░░░░░░░░░░░░    0.0%  resets in 47m      ALLOWED
    7d  ██░░░░░░░░░░░░░░░░░░   10.0%  resets in 2d 3h    ALLOWED
    claim: five_hour  │  84 reqs   │  last: 1:15:22 PM
```

## Quick Start

```bash
# Install globally
npm install -g claudeswap

# Create config
claudeswap init

# Edit with your API keys
nano ~/.config/claudeswap.json

# Start the proxy
node server.cjs
# or with PM2 for production:
pm2 start server.cjs --name claudeswap

# Point Claude Code at the proxy
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
```

That's it. Every request now routes through ClaudeSwap.

## Configuration

Edit `~/.config/claudeswap.json`:

```json
{
  "listen": "127.0.0.1",
  "port": 8082,
  "upstream": "api.anthropic.com",
  "accounts": [
    { "name": "max-primary",   "token": "$ANTHROPIC_API_KEY" },
    { "name": "max-secondary", "token": "$ANTHROPIC_API_KEY_2" }
  ],
  "fallback_key": "$ANTHROPIC_API_KEY",
  "notify_cmd": null
}
```

### Token Resolution

Tokens can be:
- **Console API keys:** `"sk-ant-api03-..."` — sent via `x-api-key` header
- **OAuth tokens (MAX):** `"sk-ant-oat01-..."` — sent via `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20` header (auto-detected)
- **Environment variables:** `"$ANTHROPIC_API_KEY"` or `"${ANTHROPIC_API_KEY}"` — resolved at startup from your shell environment, `.env` file, or secret manager

ClaudeSwap **auto-detects token type** and uses the correct authentication method. OAuth tokens from Claude MAX subscriptions work out of the box — no config needed.

Using env vars means you can rotate keys without touching the config.

### Fallback Key

If all configured accounts are rate-limited (429), ClaudeSwap falls back to `fallback_key` (defaults to `$ANTHROPIC_API_KEY` from env). This ensures your requests still work even when all MAX accounts are exhausted.

### Notifications

Set `notify_cmd` to get alerts when accounts switch:

```json
{
  "notify_cmd": "ntfy pub my-topic"
}
```

The notification message is appended as the last argument. Works with any CLI notification tool (ntfy, Slack webhooks, Discord bots, etc).

## CLI Reference

```
claudeswap                   Show status + recent changes
claudeswap status            Show status + recent changes
claudeswap menu              Interactive mode (navigate with keys)
claudeswap switch <name>     Switch to specific account (manual override)
claudeswap auto              Return to automatic drain-first mode
claudeswap log               Show full changelog
claudeswap health            Quick health check
claudeswap init              Create default config file
claudeswap help              Show help
```

### Interactive Mode

```bash
claudeswap menu
```

Opens a live dashboard where you can switch accounts, view logs, and refresh status — all with single keystrokes. Works great in any terminal.

## HTTP API

The proxy exposes control endpoints alongside the Anthropic API proxy:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/_health` | GET | Health check |
| `/_stats` | GET | Full JSON status of all accounts |
| `/_switch` | POST | Switch account: `{"account":"name"}` or `{"account":"auto"}` |
| `/_log` | GET | Changelog (last 50 events) |
| `/_active_key` | GET | Returns the currently selected account's token (plain text) |
| `/*` | ANY | Proxied to api.anthropic.com |

## Claude Code Integration

ClaudeSwap integrates with Claude Code in two ways — use either or both:

### Option A: Proxy Mode (Recommended)

Route all Claude Code traffic through ClaudeSwap. The proxy handles authentication, account selection, and 429 retry automatically.

Add to `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8082"
  }
}
```

Or add to your shell profile (`~/.zshrc`):

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
```

That's it. Claude Code sends requests to the proxy, the proxy selects the best account and handles auth (OAuth Bearer for MAX tokens, x-api-key for console keys).

### Option B: apiKeyHelper Mode

Claude Code calls a helper script to get the API key. The script queries ClaudeSwap for the currently selected account's token.

1. Install the helper:

```bash
# Already included — just symlink to your PATH
ln -sf /path/to/claudeswap/apikey-helper.sh ~/.local/bin/claudeswap-key
```

2. Add to `~/.claude/settings.json`:

```json
{
  "apiKeyHelper": "claudeswap-key"
}
```

Claude Code calls this script on startup and every ~5 minutes (or on 401). It returns the token from whichever account ClaudeSwap currently selects.

> **Note:** apiKeyHelper mode doesn't get real-time 429 retry or per-request rate tracking. For full features, use Proxy Mode.

### As a Slash Command

Create `~/.claude/skills/claudeswap/SKILL.md`:

```markdown
---
name: claudeswap
description: Check and control the Claude MAX load balancer
allowed-tools:
  - Bash
---

# ClaudeSwap Control

## Check Status
\```bash
claudeswap
\```

## Switch Account
\```bash
claudeswap switch max-primary
claudeswap switch max-secondary
claudeswap auto
\```
```

Then use `/claudeswap` in any Claude Code session to check or switch accounts.

### Fallback on Proxy Failure

If the proxy goes down, Claude Code will get connection errors. For automatic fallback:

```bash
# In ~/.zshrc — check if proxy is alive before setting base URL
if curl -sf http://127.0.0.1:8082/_health > /dev/null 2>&1; then
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8082
fi
```

## How It Works

### Drain-First Strategy

```
Request arrives
     │
     ├─ Manual override set? → Use that account
     │
     ├─ Account in cooldown (429)? → Use the other
     │
     ├─ Compare 7-day window reset times
     │   └─ Use the account whose 7d window resets SOONEST
     │      (drain it before capacity is wasted)
     │
     ├─ Tie? Compare 5-hour window reset times
     │   └─ Use the account whose 5h window resets SOONEST
     │
     └─ Still tied? Use the account with HIGHER utilization
         (it's already being drained — finish it off)
```

### Rate Limit Headers

ClaudeSwap reads Anthropic's unified rate limit headers from every response:

| Header | Example | Meaning |
|--------|---------|---------|
| `anthropic-ratelimit-unified-5h-utilization` | `0.30` | 30% of 5h window used |
| `anthropic-ratelimit-unified-5h-reset` | `1774753200` | When 5h window resets (Unix epoch) |
| `anthropic-ratelimit-unified-7d-utilization` | `0.15` | 15% of 7d window used |
| `anthropic-ratelimit-unified-7d-reset` | `1775311200` | When 7d window resets (Unix epoch) |
| `anthropic-ratelimit-unified-status` | `allowed` | Overall: allowed or throttled |
| `anthropic-ratelimit-unified-representative-claim` | `five_hour` | Which window is the bottleneck |

No polling, no probing — every real request updates the state. Decisions are always based on the freshest data.

### 429 Handling

1. Account gets 429 → enters cooldown (duration from `retry-after` header)
2. Request automatically retries with the next available account
3. Event logged to changelog
4. Notification sent (if configured)
5. When cooldown expires, account re-enters the rotation

## Production Setup

### PM2 (Recommended)

```bash
pm2 start server.cjs --name claudeswap --interpreter node
pm2 save
```

PM2 auto-restarts on crash and persists across reboots.

### State Persistence

Account state and changelog are saved to `~/.config/claudeswap-state.json` every 5 seconds and on graceful shutdown. State survives restarts.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDESWAP_CONFIG` | `~/.config/claudeswap.json` | Config file path |
| `CLAUDESWAP_STATE` | `~/.config/claudeswap-state.json` | State file path |
| `CLAUDESWAP_URL` | `http://127.0.0.1:8082` | Proxy URL (for CLI) |

## Requirements

- Node.js 18+
- Two or more Anthropic API keys (Claude MAX subscriptions)
- That's it. Zero npm dependencies.

## License

MIT - Kevin Z.
