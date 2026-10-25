#!/usr/bin/env bash
# Start a LOCAL Anvil fork of Base Sepolia for the recourse demo. Nothing here touches the live chain beyond
# read-only fork requests through BASE_SEPOLIA_RPC_URL (sourced from .env, never printed).
#   bash scripts/anvil-up.sh            # foreground; Ctrl-C stops it
#   ANVIL_FORK_BLOCK=<n> bash scripts/anvil-up.sh   # pin the fork block (fewer upstream requests)
# Then: pnpm --filter @overflow/service anvil:provision
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "error: .env not found; copy .env.example" >&2; exit 1; }
set -a; source .env; set +a
: "${BASE_SEPOLIA_RPC_URL:?set BASE_SEPOLIA_RPC_URL in .env}"
ANVIL_BIN="${ANVIL_BIN:-$HOME/.foundry/bin/anvil}"
[[ -x "$ANVIL_BIN" ]] || ANVIL_BIN="$(command -v anvil)" || { echo "error: anvil not found (foundryup)" >&2; exit 1; }
ARGS=(--fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532 --port "${ANVIL_PORT:-8545}" --host 127.0.0.1 --silent)
[[ -n "${ANVIL_FORK_BLOCK:-}" ]] && ARGS+=(--fork-block-number "$ANVIL_FORK_BLOCK")
echo "==> anvil fork of Base Sepolia (chain 84532) on http://127.0.0.1:${ANVIL_PORT:-8545}${ANVIL_FORK_BLOCK:+ at block $ANVIL_FORK_BLOCK}"
exec "$ANVIL_BIN" "${ARGS[@]}"
