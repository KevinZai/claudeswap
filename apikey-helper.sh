#!/bin/bash
# ClaudeSwap apiKeyHelper — returns the currently selected account's token
# Configure in ~/.claude/settings.json:
#   "apiKeyHelper": "~/.local/bin/claudeswap-key"
# Claude Code calls this to get the API key for each request.

CLAUDESWAP_URL="${CLAUDESWAP_URL:-http://127.0.0.1:8082}"

key=$(curl -sf "${CLAUDESWAP_URL}/_active_key" 2>/dev/null)

if [ -z "$key" ]; then
  # Proxy is down — fall back to ANTHROPIC_API_KEY from env
  echo "${ANTHROPIC_API_KEY:-}"
  exit 0
fi

echo "$key"
