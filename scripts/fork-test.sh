#!/usr/bin/env bash
# Run the fork suite (contracts/test/fork) against live Base Sepolia. Read-only: no broadcast, no keys.
#   pnpm contracts:fork
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
[[ -f .env ]] || { echo "error: .env not found; copy .env.example" >&2; exit 1; }
set -a; source .env; set +a
: "${BASE_SEPOLIA_RPC_URL:?set BASE_SEPOLIA_RPC_URL in .env}"
(cd contracts && forge test --match-path 'test/fork/*' --fork-url "$BASE_SEPOLIA_RPC_URL" -vv "$@")
