# The controller: owner actions through Coinbase Wallet MCP

The treasury owner is the controller's Coinbase smart wallet. No server holds the owner key. Every owner action
(`setAllow`, `raiseCap`, `pause`, `unpause`, `setFloor`, `withdraw`, `setEscrowFactory`, `createRoot`) is a call the
human approves in Coinbase Wallet. The controller is a Claude Code session with the Wallet MCP server connected
(`claude mcp add --transport http --scope user base-mcp https://wallet-mcp.coinbase.com`), running the
`overflow-controller` skill in `.claude/skills/`.

## Three events, kept apart

| Event | Who | Where it is recorded |
|---|---|---|
| Request | an agent (or an operator) raises an exception; onchain types get a `ControllerRequest` with `{target, data, value}` | `POST /api/exceptions`, `POST /api/agents/:id/pause`; row `status: pending` |
| Submission | the controller sends the call with Wallet MCP `send_calls` and records `{requestId, approvalUrl}` | `POST /api/controller-requests/:id/submission`; row gains `submission`, status still `pending` |
| Done | the indexer stores the treasury event (`AllowSet`, `CapRaised`, `NodePaused` by the owner) | row `status: done`, `txHash`; exception `resolved` by `chain` |

The approval URL, the Wallet MCP request id, and even `get_request_status` saying "confirmed" never mark a request
done. Only the indexed event does. A request the chain never confirms stays `pending` until the controller rejects it.

## Flow

```
agent / operator  ──POST /api/exceptions──▶  service: exception + ControllerRequest (pending)
controller        ──GET /api/controller-requests──▶  list, one line each
controller        ──send_calls({chain:"base-sepolia", calls:[{to:target, data, value:"0x0"}]})──▶  Wallet MCP → {approvalUrl, requestId}
controller        ──POST /api/controller-requests/:id/submission──▶  service records it (UI: "awaiting approval" + link)
human             ──approves in Coinbase Wallet──▶  smart wallet executes; msg.sender == owner
controller        ──get_request_status(requestId)──▶  reports verbatim; still not DONE
indexer           ──treasury event stored──▶  request done + txHash, exception resolved, SSE controller.resolved
```

## API

- `GET /api/controller-requests?status=pending|done|rejected|all` → `{requests, treasury}`.
- `GET /api/controller-requests/:id`.
- `POST /api/controller-requests/:id/submission` `{requestId, approvalUrl, submittedBy}` → `{request, recorded}`.
  Idempotent for the same `requestId`. `409 already_submitted` for a different one (the earlier submission is in
  `details.existing`): a second `send_calls` is never recorded silently. `409 not_pending` once done or rejected.
- `POST /api/exceptions` with a `RaiseExceptionInput` (`NEW_PAYEE {payee}`, `CAP_RAISE {nodeId, newCapAtomic}`,
  `PAUSE_REQUEST {nodeId}`, plus the offchain types) → `202 {exception, request, created}`.
- `POST /api/exceptions/:id/decide` `{decidedBy, decision: "reject", reason}` rejects; approving an onchain type here is refused.

## Wallet MCP specifics

- `chain` is `"base-sepolia"`; `value` is hex wei (`"0x0"` for every owner call); `calls` run atomically.
- The wallet is a Coinbase smart wallet. Owner calls use `msg.sender`, so ERC-6492-wrapped signatures (which `sign`
  may return) do not matter for them.
- Tool argument names come from the live server (`/mcp`); the docs are a guide. The spike results and exact shapes are in
  `docs/coinbase-feedback.md`.

## UI

`apps/web` `/controller` polls `GET /api/controller-requests?status=all` every 5 s and shows each request with a
badge: `pending`, `awaiting approval` (with the Coinbase Wallet link), `DONE (indexed event)` with the Basescan tx link,
or `rejected`. The page never shows success that did not come from `status === "done"`.

## Deploying with the smart wallet as owner

`OWNER_ADDRESS=<smart wallet>` then `pnpm contracts:deploy`. With `owner != deployer`, `Deploy.s.sol` deploys the
treasury and the escrow factory and prints the `setEscrowFactory` and `createRoot` calldata; the controller sends both
in one `send_calls` batch (skill section "Deploy wiring"). Until that batch lands, `pnpm dev` refuses to boot because
`treasury.escrowFactory()` does not match the deployments file.

## Fallback (testnet only)

If `send_calls` cannot execute on Base Sepolia, the owner becomes a CDP server wallet and Wallet MCP is used only for
funding (`send`) and signing. The UI and README then say "owner: CDP server wallet (testnet fallback)". Not in use.
