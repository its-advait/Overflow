#!/usr/bin/env bash
# One command: deploy OverflowTreasury to Base Sepolia, verify on Basescan, export addresses and ABIs.
#
#   pnpm contracts:deploy            broadcast + verify + export
#   DRY_RUN=1 pnpm contracts:deploy  simulate only (no broadcast, no verify, no export)
#
# Signing uses a Foundry keystore (DEPLOYER_ACCOUNT, default overflow-deployer) and a password file
# (DEPLOYER_PASSWORD_FILE, chmod 600). No private key is read by this script.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
die() { echo "error: $*" >&2; exit 1; }

[[ -f .env ]] || die ".env not found; copy .env.example"
set -a; source .env; set +a

: "${BASE_SEPOLIA_RPC_URL:?set BASE_SEPOLIA_RPC_URL}"
: "${OWNER_ADDRESS:?set OWNER_ADDRESS}"
: "${DEPLOYER_ACCOUNT:=overflow-deployer}"
DRY_RUN="${DRY_RUN:-0}"

# Root node key: AGENT_ROOT_ADDRESS, else AGENT_ROOT_KEY when it is an address, else derive from a 64-hex key.
if [[ -z "${AGENT_ROOT_ADDRESS:-}" ]]; then
  if [[ "${AGENT_ROOT_KEY:-}" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    AGENT_ROOT_ADDRESS="$AGENT_ROOT_KEY"
  elif [[ "${AGENT_ROOT_KEY:-}" =~ ^0x[0-9a-fA-F]{64}$ ]]; then
    AGENT_ROOT_ADDRESS="$(cast wallet address --private-key "$AGENT_ROOT_KEY")"
  fi
fi
export AGENT_ROOT_ADDRESS="${AGENT_ROOT_ADDRESS:-}"

SIGNER=()
if [[ -n "${DEPLOYER_PASSWORD_FILE:-}" ]]; then
  [[ -f "$DEPLOYER_PASSWORD_FILE" ]] || die "DEPLOYER_PASSWORD_FILE=$DEPLOYER_PASSWORD_FILE does not exist"
  SIGNER=(--account "$DEPLOYER_ACCOUNT" --password-file "$DEPLOYER_PASSWORD_FILE")
elif [[ "$DRY_RUN" == 1 ]]; then
  # Simulation needs only a sender address.
  SENDER="${DEPLOYER_ADDRESS:-}"
  [[ -z "$SENDER" && "${DEPLOYER_PRIVATE_KEY:-}" =~ ^0x[0-9a-fA-F]{40}$ ]] && SENDER="$DEPLOYER_PRIVATE_KEY"
  [[ -n "$SENDER" ]] || die "DRY_RUN needs DEPLOYER_ADDRESS (or DEPLOYER_PASSWORD_FILE)"
  SIGNER=(--sender "$SENDER")
elif [[ -t 0 ]]; then
  # No password file: forge prompts for the keystore password on this terminal.
  echo "==> no DEPLOYER_PASSWORD_FILE set; forge will prompt for the '$DEPLOYER_ACCOUNT' keystore password"
  SIGNER=(--account "$DEPLOYER_ACCOUNT")
else
  die "set DEPLOYER_PASSWORD_FILE to a chmod-600 file holding the '$DEPLOYER_ACCOUNT' keystore password (non-interactive shell)"
fi

ARGS=(script script/Deploy.s.sol:Deploy --rpc-url "$BASE_SEPOLIA_RPC_URL" --chain 84532 -vvv "${SIGNER[@]}")
if [[ "$DRY_RUN" != 1 ]]; then
  : "${BASESCAN_API_KEY:?set BASESCAN_API_KEY for verification}"
  ARGS+=(--broadcast --verify --verifier etherscan --etherscan-api-key "$BASESCAN_API_KEY")
fi

echo "==> (cd contracts) forge ${ARGS[*]//${BASESCAN_API_KEY:-__none__}/***}" | sed -E 's#(--rpc-url )[^ ]+#\1<rpc>#'
if ! (cd contracts && forge "${ARGS[@]}"); then
  if [[ "$DRY_RUN" != 1 ]]; then
    echo >&2
    echo "Deploy or verification failed. If the contract is deployed but unverified, retry with:" >&2
    echo "  (cd contracts && forge verify-contract <treasury> src/OverflowTreasury.sol:OverflowTreasury --chain 84532 \\" >&2
    echo "    --etherscan-api-key \$BASESCAN_API_KEY --watch \\" >&2
    echo "    --constructor-args \$(cast abi-encode 'constructor(address,address)' \$TOKEN_ADDRESS \$OWNER_ADDRESS))" >&2
  fi
  exit 1
fi

if [[ "$DRY_RUN" != 1 ]]; then
  echo "==> exporting addresses and ABIs"
  pnpm --filter @overflow/scripts export
fi
