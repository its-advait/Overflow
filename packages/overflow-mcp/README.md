# @overflow/overflow-mcp

A small stdio [MCP](https://modelcontextprotocol.io) server that lets **any agent** (Claude Code, Claude Desktop, anything that speaks MCP) pay x402 APIs on Base Sepolia under an Overflow node's policy. Three tools:

| Tool | What it does | Signs? |
|---|---|---|
| `overflow_budget()` | The node's remaining USDC and per-call limit, read from the treasury (every ancestor counts). | no |
| `overflow_quote(url)` | Fetches the URL's 402, reports price and payee, and asks the facilitator to **simulate** the payment (`POST /verify`, an `eth_call`; nothing is broadcast, the seller receives nothing). | a 60-second probe, sent to `SERVICE_URL` only |
| `overflow_pay(url, maxAmount)` | Pays: one EIP-3009 authorization with `from = the treasury`, settled only by `OverflowTreasury.settle()` through the facilitator. Returns the response body and the settlement tx hash, or the decoded refusal. | yes, once |

Nothing in this server can move USDC except `overflow_pay`, and `overflow_pay` cannot move it except through the treasury: a valid signature is never enough, the treasury's policy (allowlist, caps, per-call limits, pauses, expiry, floor) decides at settlement. The server holds no owner key and never retries a payment.

Amounts are **atomic USDC** (6 decimals) as decimal integer strings: `"20000"` is 0.02 USDC. Floats are rejected.

## Prerequisites

- Node ≥ 20.12 (`.nvmrc` says 20; `process.loadEnvFile` is used), pnpm 12.
- An Overflow service running (`pnpm dev` at the repo root, or any deployment): the facilitator at `SERVICE_URL` (default `http://localhost:4000`) with its SIMULATED sellers at `SELLER_URL` (default `http://localhost:4100`). See the root README, "Run the facilitator (service)".
- A **node key**: an address the treasury knows (`nodeOfKey(address) != 0`). The owner creates the root (`createRoot`) and a parent key can delegate children (facilitator `/delegate`). `pnpm status` lists the nodes. Without one, every tool answers `UnknownAgent`.
- The seller's payee on the owner allowlist (`setAllow(payee, true)`, approved by the controller in Coinbase Wallet; see `docs/controller.md`) and USDC in the treasury. Otherwise payments are refused with `PayeeNotAllowed(0)` / `BelowFloor()`.

## Configuration (env)

The server loads `<repo>/.env` on start (variables already in the environment win; `OVERFLOW_ENV_FILE` points elsewhere). Never put the key in an MCP client config file; keep it in `.env` or a keystore.

| Variable | Required | Meaning |
|---|---|---|
| `SERVICE_URL` | default `http://localhost:4000` | The Overflow facilitator. Its `/health` tells the server the treasury and USDC it settles with. |
| `NODE_SIGNER` | default `env` | Where the node key lives: `env` (the two rows below) or `cdp` (a Coinbase Developer Platform server account, see below). |
| `NODE_PRIVATE_KEY` | `env`: one of | `0x` + 64 hex: the node key. Or just its address when the key lives in a Foundry keystore. |
| `NODE_ACCOUNT` + `NODE_PASSWORD_FILE` | `env`: one of | Foundry keystore name (`cast wallet list`) and a chmod-600 password file; decrypted in memory. |
| `CDP_ACCOUNT_NAME` | `cdp`: required | The CDP EVM server account (EOA) that holds the node key. Looked up by name, never created by the server. |
| `CDP_ACCOUNT_ADDRESS` | `cdp`: optional | Pin: refuse to start if the account's address differs. |
| `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, `CDP_WALLET_SECRET` | `cdp`: required | Read by the CDP SDK itself (`@coinbase/cdp-sdk`); the server only checks they are set and never logs them. |
| `BASE_SEPOLIA_RPC_URL` | recommended | RPC for the chain reads. Unset = `https://sepolia.base.org` (rate limited) with a warning on stderr. |
| `TREASURY` | optional | Pin: the server refuses to start if `/health` reports a different treasury. |
| `CHAIN_ID` | optional | Must be `84532`. Anything else is refused. |

### CDP-held node keys (`NODE_SIGNER=cdp`)

With `NODE_SIGNER=cdp` the node key is a Coinbase Developer Platform EVM **server account** (an EOA whose key lives in CDP's TEE; smart accounts are not supported because they sign ERC-6492 wrapped signatures). The server resolves `CDP_ACCOUNT_NAME` with `getAccount` (a typo fails instead of creating a key), checks the optional `CDP_ACCOUNT_ADDRESS` pin, and signs every `TransferWithAuthorization` through CDP. Each signature is normalized to the chain's `v in {27, 28}` form and must recover to the account before it is used; `@coinbase/cdp-sdk` is loaded only in this mode. Node 20.19+ (the SDK's `jose` is ESM-only).

Before relying on it, run the check once (creates the account if needed, signs three payloads, broadcasts nothing) and register the printed address as a node key (root via `AGENT_ROOT_ADDRESS` at deploy time, or a child via `POST /delegate`):

```bash
pnpm --filter @overflow/payment-client cdp:sign-check -- --name overflow-node-root --json
```

The CDP SDK reports usage and errors to Coinbase unless `DISABLE_CDP_USAGE_TRACKING=true` and `DISABLE_CDP_ERROR_REPORTING=true` are set (`.env.example` sets both). Result of the live check: `docs/coinbase-feedback.md`, "CDP server accounts as agent keys".

## Install

```bash
git clone <this repo> && cd Overflow
pnpm install
cp .env.example .env            # fill BASE_SEPOLIA_RPC_URL, SERVICE_URL, SELLER_URL, NODE_PRIVATE_KEY (or NODE_ACCOUNT + NODE_PASSWORD_FILE, or NODE_SIGNER=cdp)
pnpm --filter @overflow/overflow-mcp build   # -> packages/overflow-mcp/dist/server.js (one ESM file)
```

### Claude Code

```bash
claude mcp add --transport stdio overflow -- node "$(pwd)/packages/overflow-mcp/dist/server.js"
# add --scope user to make it available in every project
```

Start a new Claude Code session; `/mcp` should list `overflow` with three tools. Do **not** launch through `pnpm start`: pnpm prints a banner on stdout and corrupts the JSON-RPC stream. Development variant without a build: `claude mcp add --transport stdio overflow -- "$(pwd)/node_modules/.bin/tsx" "$(pwd)/packages/overflow-mcp/src/server.ts"`.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows). Desktop starts servers with a minimal `PATH`, so use absolute paths for both `node` (`which node`) and the script. No secrets in this file: they come from the repo `.env`.

```json
{
  "mcpServers": {
    "overflow": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/Overflow/packages/overflow-mcp/dist/server.js"]
    }
  }
}
```

Restart Claude Desktop. The server logs to stderr only (`~/Library/Logs/Claude/mcp-server-overflow.log`); values of env vars are never logged.

## 5-minute walkthrough

With `pnpm dev` running in another terminal (SIMULATED sellers on `http://localhost:4100`), ask the agent:

1. **"What's my Overflow budget?"** → `overflow_budget` → e.g. `nodeId "1"`, `remainingUsdc "40.00"`, `perCallUsdc "15.00"`, `blocked: null`, and every node on the walk to the root.
2. **"Quote http://localhost:4100/api/search?q=ev"** → `overflow_quote` → `priceAtomic "20000"` (0.02 USDC), `payTo <search payee>`, `allowlisted true`, `policy.allowed true` (the treasury's own verdict, `simulated: true, broadcast: false`).
3. **"Pay it, at most 20000 atomic"** → `overflow_pay(url, "20000")` → `paid: true`, the seller's JSON `body`, `txHash` and a Basescan `explorerUrl`. The tx is `OverflowTreasury.settle()` relayed by the facilitator; `cast receipt <txHash>` shows the USDC `Transfer` from the treasury to the payee.
4. **"Quote http://localhost:4100/premium-intel"** → `policy.allowed false`, `refusal: PayeeNotAllowed(0)` "Recipient is not approved for anyone", `source: treasury (facilitator POST /verify …)`. This SIMULATED seller pays an attacker address the owner never allowlisted.
5. **"Pay it anyway, up to 50000"** → `overflow_pay` → `paid: false, kind: "refused", signed: false, sentToSeller: false, refusal: PayeeNotAllowed(0)`. Nothing was signed; the seller got one unauthenticated GET and nothing else.

## When policy refuses

`overflow_pay` has three gates before the seller sees a signature, and reports which one spoke:

1. **Client prechecks** (`source: client …`, `signed: false`): `AboveMaxAmount` (price > `maxAmount`), then chain reads mirroring the treasury: `UnknownAgent`, `Paused(n)`, `Expired(n)`, `PayeeNotAllowed(0)` (not on the owner allowlist), `OverPerCall(n)`, `PayeeNotAllowed(n)` (restricted node), `OverBudget(n)`.
2. **The treasury's simulation** (`source: treasury (facilitator POST /verify …)`, `signed: true, sentToSeller: false`): the facilitator ran `settle()` as an `eth_call` with the real signature and the treasury reverted. The signature expires unused (quote probes after 60 s, payments after the seller's `maxTimeoutSeconds`).
3. **The seller's settlement** (`source: treasury (seller's settle …)`, `sentToSeller: true`): the seller relayed it and the treasury reverted on chain (402 `payment_blocked`; with DEMO_MODE the revert is broadcast and `txHash` is set).

| Refusal | Meaning |
|---|---|
| `UnknownAgent(signer)` | The key is not a registered node key. |
| `PayeeNotAllowed(0)` | The payee is not on the owner allowlist (and is not a treasury escrow). |
| `PayeeNotAllowed(n)` | Node `n` is restricted and the payee is not on its own allowlist. |
| `OverPerCall(n)` | The amount is above node `n`'s per-call limit (every ancestor is checked). |
| `OverBudget(n)` | Node `n` (or an ancestor) would pass its cap. |
| `Paused(n)` / `Expired(n)` | Node `n` is paused / its authority has expired. |
| `BelowFloor()` | The treasury would drop under its floor (live reservations count). |
| `AboveMaxAmount(price, max)` | Your own ceiling; nothing left the client. |

**Unknown outcome** (`kind: "unknown"`): the paid request failed in flight, or the seller answered without a `PAYMENT-RESPONSE`. The result carries the authorization `digest`. Reconcile it against the chain before anything else and **never sign a new authorization for the same purchase**; the facilitator answers `409 AlreadySubmitted` with the original result for a digest it has seen.

## Security notes

- Only `overflow_pay` sends a `PAYMENT-SIGNATURE` to a seller. `overflow_quote` signs a probe that goes to `SERVICE_URL` only. `overflow_budget` signs nothing. Tests assert all three.
- Every authorization is `from = the treasury`; the node key can never spend its own funds through this server, and USDC asks the treasury (ERC-1271) before moving anything.
- `paid: true` requires the facilitator's settle receipt in the seller's `PAYMENT-RESPONSE`; a bare 200 is reported as unknown.
- The owner allowlist is read from the chain, never from env or from the seller's 402.
- No credentials in MCP client configs; keys from `.env` or a Foundry keystore; stdout carries only JSON-RPC, logs go to stderr without secret values.

## Development

```bash
pnpm --filter @overflow/overflow-mcp test        # fake seller, fake facilitator, fake treasury; no network
pnpm --filter @overflow/overflow-mcp typecheck
pnpm --filter @overflow/overflow-mcp dev         # tsx src/server.ts (stdio; for manual JSON-RPC poking only)
```
