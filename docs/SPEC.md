# Overflow — Build Spec (Cal Hacks 13.0)

Oct 24, 2026 · @Tanish Rathin Vora

## Summary

Overflow gives a team of AI agents one USDC budget on Base, lets them find, co-fund and buy digital resources over x402, and pays sellers only after verifiable delivery. Every payment is checked onchain before any USDC moves.

**The baseline problem.** x402 lets *an* agent pay. A business still can't safely let a *team* of agents spend its money. Coinbase's tools offer two extremes: approve every action (Wallet MCP), or one limit per wallet (Agentic Wallet, CDP policies). Budgets don't split across sub-agents, and x402 payments are final, so a seller who sends junk keeps the money.

**The security core, kept from Leash.** In Overflow, a valid signature is not enough to move money. A prompt-injected agent can sign a payment to an attacker, and the contract still rejects it. Sending that same signature straight to USDC also fails: USDC asks the treasury whether the signature is valid, and the treasury only says yes inside its own checks.

| Engine | Job | Where it runs | Moves money? |
| --- | --- | --- | --- |
| Oracle | Decide what is worth buying | Offchain: Claude plus deterministic checks | No |
| Fusion | Merge compatible requests into one purchase | Offchain; charged onchain once | No |
| Leash core (OverflowTreasury) | Authorize each payment against the agent tree | Base Sepolia contract | Yes |
| Recourse (OverflowEscrow) | Hold funds; pay the seller or refund the treasury | Base Sepolia contracts | Yes |

Overflow keeps three financial events separate in the contracts, the ledger and the UI:

1. **Authorization:** an agent may commit up to an amount for one specific order.
2. **Escrow funding:** USDC leaves the treasury and sits in that order's escrow.
3. **Final settlement:** the seller is paid, or the treasury is refunded.

| Sponsor | One line |
| --- | --- |
| Coinbase (Payment Agents) | x402 answered how an agent pays; Overflow answers how a business lets a team of agents spend, on Coinbase's rails. |
| Hyphenate | The procurement and accounts-payable seats for a company's agent spend: limited access, a clean record, and a human asked only for exceptions. |
| Microsoft | A production-minded finance agent: idempotent payments, reconciliation, and a stated path to production. |
| Armadin | A tricked agent can't move money: the policy rejects it, the token defers to the treasury, and cheating sellers are refunded by proof. |

**Real versus simulated (say this in every demo).** Real: contracts on Base Sepolia, testnet USDC, the x402 quote-sign-settle flow, live Claude agents, escrow payouts and refunds. Simulated and labeled: the seller catalog and datasets (synthetic, redistributable), the planted cheating sellers, the attacker endpoint, and the fictional company's books.

**What this revision changes from the V2 spec.**

- Keeps Leash's `settle()` and stateful ERC-1271 gate as the treasury's payment primitive. V2 dropped them; they are the Armadin and Coinbase-engineer story.
- Gives every order its own escrow contract address, so the agent's signed `to` field binds the order. This answers V2's open question of how the escrow knows which order was funded.
- Adds `reserve()` and `release()` so Coinbase's facilitator can settle Overflow payments.
- Makes the controller a Coinbase Wallet that approves owner actions through Wallet MCP, removing the server-held owner key.
- Keeps Leash's gasless signed delegation, ancestor pause, balance floor and `remaining()` view.
- Charges a Fusion purchase to the agents' lowest common ancestor, so the onchain budget is charged once.
- Splits Recourse into three tiers: payout and timeout refund first, chunk proofs second, signed-record promises with bonds third.

## Track map

One product and one demo serve four sponsors, but each judge looks for a different proof. For Coinbase, the primary track is **Payment Agents**.

### Coinbase: Best Use of x402, Payment Agents

Prize: $500 USDC plus a recruiter call per eligible team member. Every member must be 18 or older, a US or Canada resident (not Quebec), and hold a verified Coinbase account before submitting.

| Criterion | How Overflow answers it | Evidence to show |
| --- | --- | --- |
| Usefulness | A business lets a team of agents buy data under one budget, with recourse | The mission demo and the baseline-problem line |
| Technical design | Onchain policy tree, ERC-1271 gate, one escrow per order, `reserve()` for Coinbase's facilitator | Architecture diagram, Foundry tests, Basescan links |
| Ease of reuse | `@overflow/payment-client` (drop-in x402 fetch wrapper) and an `overflow_pay` MCP tool any agent can call | A README a stranger can follow end to end |
| Product feedback | Concrete blockers met while building on Coinbase tools | `docs/coinbase-feedback.md` |

Required deliverables: a project summary (who it's for, what it does, the agent platform, the Coinbase tools), a working example (demo plus repo with setup), an architecture explanation (components, controls, known limitations), and builder feedback (biggest blocker, workaround, the one missing capability). Real money isn't required; label simulated actions, keep credentials private, and don't manage funds for other people.

### Hyphenate: Autonomous Systems for Finance

Prize: $8,000, $5,000 and $3,000 for the top three; expedited interviews for the top five.

Seats line (submit as written): *Procurement analyst and accounts-payable clerk for a company's AI-agent data spend.*

| Judging question | How Overflow answers it | Evidence to show |
| --- | --- | --- |
| Is it real enough? | Messy sellers (late, cheating, duplicate listings), a real ledger, onchain money | Planted-error set with answer key; reconciliation report |
| Would you hire it? | Limited access (agent caps), a clean record (journal plus audit trail), knows when to ask (controller escalations) | Segregation-of-duties table; escalation log |
| Did we see something new? | Accounts payable where "goods received" is a cryptographic check, for agents buying data | Recourse refund on Basescan |
| The moment | Catches a seller who swapped data, refunds onchain, reverses the entry, blocks the seller everywhere | The demo video opens with it |

Required deliverables: a demo video that opens with the moment, a live demo at judging (they may try their own scenario), one line on the seats, and proof of what's real, what's simulated, and how you know.

### Microsoft: Grand Prize, Built for the Real World (and Customer Impact Award)

Prize: a Surface laptop per member, a remote talk at a Microsoft FDE team tech talk, and 1:1 mentorship.

| Criterion | How Overflow answers it |
| --- | --- |
| Customer understanding | Named user: finance and ops teams running agent fleets that buy data and APIs |
| Measurable usefulness | Duplicate spend avoided, unauthorized attempts blocked, every order reconciled, all measured from runs |
| Path from prototype to production | Audit, custody through Coinbase server wallets, mainnet USDC, private policies (see Risks) |
| Responsible design | Claude proposes, contracts decide; humans approve exceptions; limits stated plainly |
| End-to-end functionality | One mission from goal to a settled, booked purchase with no manual database edits |

### Armadin: Best Security Hack

The sponsor sheet listed criteria as "coming soon" and the prize as Apple headphones; check the live site.

| Attack | Overflow's defense | Proof in the demo |
| --- | --- | --- |
| Prompt injection asks the agent to pay an attacker | Payee isn't allowlisted, so `PayeeNotAllowed` | Revert on Basescan |
| Valid signature sent straight to USDC | USDC asks the treasury via ERC-1271; no flag set, so invalid | `FiatTokenV2: invalid signature` |
| Sub-agent overspends or exceeds its parent | Each payment is charged up the tree | `OverBudget` revert |
| Seller swaps data after payment | Chunk proof of misbehavior | Refund plus bond |
| Seller takes the money and vanishes | Reveal deadline | Timeout refund |
| One order finalized twice | One terminal state per escrow | Foundry invariant test |

## Architecture

Agents and the Overflow service propose and sign; only the three contracts move USDC, and USDC asks the treasury before every transfer.

&#91;embedded content: Overflow architecture · offchain service, onchain contracts, external parties\]

The treasury calls USDC to transfer, and USDC calls back into the treasury (ERC-1271) to confirm. Sellers send 402 quotes and ciphertext to the agents directly (not drawn).

### Trust boundaries

| Component | Trusted to | Not trusted to |
| --- | --- | --- |
| Claude agents | Propose purchases and sign within their node | Spend outside policy; they can be prompt-injected |
| Overflow service and facilitator | Relay, index, run the adapters | Hold funds or the owner key |
| OverflowTreasury | Enforce policy on every payment | Judge whether data is good |
| Coinbase facilitator | Submit reserved payments | Bypass policy, since USDC asks the treasury |
| Sellers | Deliver what they committed to | Anything else; escrow pays only after a reveal |
| Controller | Set policy and approve exceptions | Approve every routine payment |

### One purchase, end to end

1. The mission owner sets a goal and budget; Oracle extracts requirements and ranks listings.
2. Fusion merges compatible requests into one `PurchaseOrder` with allocations.
3. The seller creates the order's escrow through the factory and commits the roots and the key hash.
4. The agent downloads the ciphertext, checks `rootCipher`, and samples chunks; Oracle judges the sample.
5. The agent requests the resource; the seller's 402 names the escrow as `payTo`.
6. The payment client checks the quote against the order, and the paying node signs EIP-3009 with `from` = treasury.
7. The adapter calls `settle()` (Overflow facilitator), or calls `reserve()` and hands the payload to Coinbase's facilitator.
8. USDC asks the treasury via ERC-1271; the treasury says yes only for this checked digest; USDC moves into the escrow.
9. The seller reveals the key and the agent checks the file. `accept()` pays the seller, or a proof or timeout refunds the treasury.
10. The indexer reads events, the ledger books entries, and reconciliation confirms the chain and the books agree.

## Security core carried over from Leash

OverflowTreasury is LeashWallet renamed and extended. Every rule below already exists in the Leash repo, and the suite passed 57 of 57 tests against Circle's compiled USDC v2.2 code. Additions are marked **(new)**.

### Data model

- `Node { key, parent, depth, cap, spent, maxPerCall, expiry, paused, restricted }`. Node ids start at 1; id 0 means "no parent", and "global" in `PayeeNotAllowed(0)`.
- `MAX_DEPTH = 2`: root (orchestrator), child, grandchild.
- Storage: `allowlist[payee]` (global, owner-set), `nodeAllow[id][payee]` (per node, set at delegation), `nodeOfKey[key]`, `usedDelegation[structHash]`, `floor`.
- `TOKEN` and `owner` are immutable. The owner is the controller's Coinbase Wallet address **(new)**.

### `settle()` check order (keep it exactly)

1. Rebuild the digest USDC will check: EIP-712 `TransferWithAuthorization` with `from` = the treasury, using USDC's `DOMAIN_SEPARATOR()`.
2. Recover the signer with OpenZeppelin `ECDSA.recoverCalldata`, which rejects malformed and high-s signatures.
3. Map the signer to a node; unknown keys revert `UnknownAgent(signer)`.
4. Require a global-allowlisted payee, or a factory-made escrow whose seller isn't flagged **(new)**; otherwise `PayeeNotAllowed(0)`.
5. Walk from the node to the root. At each level check `Paused(n)`, `Expired(n)` (when `block.timestamp >= expiry`), `OverPerCall(n)`, a restricted node without `nodeAllow` (`PayeeNotAllowed(n)`), and `OverBudget(n)`; then charge `spent += value`.
6. Revert `BelowFloor()` if the balance is under `value + floor + reservedTotal` (reservations are **new**).
7. `tstore` a flag at `keccak256(APPROVAL_SALT, digest)`, call USDC's `transferWithAuthorization(..., bytes signature)`, then `tstore` it back to 0.
8. Emit `Paid(id, to, value, nonce)`.

Every check and charge runs before the token call, so any revert leaves no partial charge. `settle()` is `nonReentrant`.

### The stateful ERC-1271 gate

- `isValidSignature(digest, sig)` returns `0x1626ba7e` only when `msg.sender == TOKEN` and the transient flag for that exact digest is set; otherwise `0xffffffff`.
- It ignores the signature bytes, because `settle()` already proved who signed.
- It is `view` and reads transient storage, so it can't approve permits or anything outside a running `settle()`.
- Verified call path on USDC: proxy, then FiatTokenV2\_2, then `SignatureChecker` by delegatecall, then a staticcall to the treasury. The treasury therefore sees `msg.sender` = the USDC address.
- **(new)** It also returns valid for an unexpired `reserve()` approval of that exact digest (see the Coinbase section).

### Gasless signed delegation

- A parent creates a child by signing EIP-712 `CreateChild(uint256 parentId,address key,uint256 cap,uint256 maxPerCall,uint256 expiry,bool restricted,bytes32 payeesHash,uint256 nonce,uint256 deadline)`, where `payeesHash = keccak256(abi.encodePacked(payees))`.
- Domain: `{name "Overflow", version "1", chainId 84532, verifyingContract = treasury}` (Leash used "Leash").
- Anyone can relay the signed message (the service's `/delegate`), so agents never need ETH for gas.
- `createChild` checks: deadline not passed, parent exists, struct hash unused, signer is the parent's key, parent not paused or expired, depth at most 2, child cap, per-call limit and expiry within the parent's, and a key that isn't zero, the owner, the treasury or already in use. A restricted parent's child may only list payees the parent allows, else `ChildExceedsParent`.
- `PauseChild(uint256 target,uint256 nonce,uint256 deadline)`, signed by any strict ancestor, pauses the target. Because `settle()` walks up the tree, pausing a node stops its whole subtree.

### Owner actions (Coinbase Wallet, human-approved)

`createRoot`, `pause`, `unpause`, `raiseCap`, `setAllow`, `setFloor`, `withdraw`, plus **(new)** `setEscrowFactory` and `setReservationWindow`. Each is a Wallet MCP `send_calls` request the controller approves in Coinbase Wallet.

### Views

`getNode`, `remaining(id)` (the smallest `cap − spent` over the node and its ancestors), `nodeCount`, `nodeOfKey`, `allowlist`, `nodeAllow`, `usedDelegation`, `floor`, `owner`, `TOKEN`, `DELEGATION_DOMAIN_SEPARATOR`, and **(new)** `reservedTotal`.

### Errors and what the Blocked lane says

| Error | Meaning shown to the user |
| --- | --- |
| `UnknownAgent(signer)` | Signed by a key that isn't a registered agent |
| `PayeeNotAllowed(0)` | Recipient isn't approved for anyone |
| `PayeeNotAllowed(n)` | Recipient isn't approved for agent n |
| `OverPerCall(n)` | Single payment above agent n's limit |
| `OverBudget(n)` | Agent n or an ancestor would pass its cap |
| `Expired(n)`, `Paused(n)` | Agent n's authority expired or was paused |
| `BelowFloor()` | Payment would drop the treasury under its floor |
| `TooDeep`, `ChildExceedsParent`, `BadDelegation`, `KeyInUse`, `NotAncestor`, `NotOwner` | Delegation or admin misuse |
| `PayeeFlagged(seller)` **(new)** | Seller has a proven cheat on record |
| `ReservationTooLong`, `ReservationActive` **(new)** | Reservation misuse |

### Events

`NodeCreated`, `Paid`, `NodePaused`, `NodeUnpaused`, `CapRaised`, `AllowSet`, plus **(new)** `Reserved`, `ReservationReleased`, `EscrowFactorySet`. The dashboard and ledger read only these events, never local flags.

### Leash limits that carry over

Policies are public onchain, depth stops at two levels, `settle()` cost about 144k gas on AUSD (re-measure on USDC), and the code is unaudited. Leash's server-held owner key is **fixed** by the Coinbase Wallet controller.

## USDC and Coinbase integration

Overflow pays in Base Sepolia USDC over x402, uses a Coinbase Wallet (through Wallet MCP) as the human controller, and settles third-party purchases through Coinbase's facilitator after a `reserve()` call.

### USDC facts (verified)

| Fact | Value |
| --- | --- |
| Address (Base Sepolia, chain 84532) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| EIP-712 domain | name `USDC`, version `2` |
| Domain separator | `0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818` |
| Decimals | 6; use integer atomic units everywhere, never floats |
| Signed transfer | `transferWithAuthorization(..., bytes signature)`, selector `0xcf092995`; contract signers are checked through ERC-1271 |
| Domain check at boot | No `eip712Domain()`; read `name()`, `version()` and `DOMAIN_SEPARATOR()` |
| Revert style | `Error(string)`, e.g. `FiatTokenV2: invalid signature`, `FiatTokenV2: authorization is used or canceled` |
| Compliance | Circle's blacklist still applies: `Blacklistable: account is blacklisted` |
| Test funds | faucet.circle.com (Base Sepolia) |

Verified offline against Circle's compiled FiatTokenV2\_2 behind its real proxy: `settle()` pays, the direct bypass fails, replay fails, and a blacklisted payee is rejected with no partial charge. Still open: run `test/fork/UsdcGate.t.sol` against live Base Sepolia USDC before gate G1.

### Which Coinbase tool does what

| Tool | Role in Overflow | Confirm before relying on it |
| --- | --- | --- |
| Coinbase Wallet MCP (`wallet-mcp.coinbase.com`) | Controller: funds the treasury (`send`), approves owner actions (`send_calls`), signs EIP-712 (`sign`). Every write needs the human's approval in Coinbase Wallet | That `send_calls` works on Base Sepolia |
| Coinbase x402 facilitator | Settles purchases from third-party x402 sellers after `reserve()` | That it accepts a contract wallet as payer |
| `@x402` seller middleware | Sellers' 402 responses and payment checks | — |
| CDP server wallets (CDP MCP or SDK) | Optional: hold agent node keys so no raw private keys exist (`NODE_SIGNER=cdp`, `@overflow/payment-client/signers`) | That CDP accounts sign arbitrary EIP-712: SDK types say yes (`EvmServerAccount.signTypedData`); live result in docs/coinbase-feedback.md |
| Bazaar discovery | Oracle's live resource discovery | V2 cites `search_resources` and `proxy_tool_call`; unverified here |
| Coinbase MCP (`agents.coinbase.com/mcp`) | Not core; trading-focused | Coinbase's docs page said x402 is "coming soon"; V2 cites a Sep 22, 2026 launch. Ask at the booth |

Rule kept from V2: no client may sign or settle from an unrestricted wallet while the UI claims Overflow protected the payment. A payment from a Coinbase account balance isn't subject to the treasury's rules, and the UI must label it that way.

### One payment interface, two paths

```ts
interface PaymentAdapter {
  getPaymentRequirements(resourceUrl: string): Promise<PaymentRequirements>;
  preparePayment(purchaseId: string): Promise<PreparedPayment>;   // node key signs EIP-3009, from = treasury
  submitPayment(purchaseId: string): Promise<PaymentSubmission>;
  reconcilePayment(purchaseId: string): Promise<PaymentStatus>;   // reads the chain before any retry
}
```

| Adapter | Used for | How it settles |
| --- | --- | --- |
| `OverflowFacilitatorAdapter` | Overflow's own sellers and escrow funding | The Overflow service calls `treasury.settle()` (Leash path, transient gate) |
| `CoinbaseFacilitatorAdapter` | Third-party x402 sellers | `treasury.reserve()` first; then the standard payload goes to the seller, Coinbase's facilitator calls USDC, and USDC gets a yes from the treasury |

Oracle, Fusion and the UI never know which path ran. They see a `PaymentStatus` and a transaction hash. Before signing, the payment client rejects any quote whose `payTo`, amount, asset or network differs from the purchase order.

### `reserve()` and `release()` (new contract feature)

- `reserve(to, value, validAfter, validBefore, nonce, sig)` runs every `settle()` check and charges budgets. It stores `reservations[digest] = {nodeId, value, validBefore, nonce}`, adds `value` to `reservedTotal`, and emits `Reserved`.
- `validBefore` must fall within `reservationWindow` (default 10 minutes), else `ReservationTooLong`. A digest can't be reserved twice (`ReservationActive`).
- `isValidSignature` returns valid for a stored, unexpired reservation when `msg.sender == TOKEN`. USDC's own nonce prevents a second use.
- `release(digest)` is callable by anyone after `validBefore`. If `authorizationState(treasury, nonce)` is false, it refunds `spent` up the chain, since the money never moved. Either way it subtracts from `reservedTotal`, deletes the record, and emits `ReservationReleased`.
- The floor check counts `reservedTotal`, so reserved USDC can't be promised twice.
- Cost: one extra transaction and about one Base block of latency per third-party purchase.

## Recourse: delivery-backed escrow

Every purchase gets its own escrow contract. The seller is paid only after a valid key reveal and an unchallenged window; otherwise the treasury is refunded. Build it in three tiers, and ship tier 1 before starting tier 2.

| Tier | What it delivers | Ship by |
| --- | --- | --- |
| 1. Escrow core | Per-order escrow, funding, key reveal, buyer accept, payout, timeout refund, one terminal state | Gate G2 |
| 2. Chunk proof | Buyer proves one chunk doesn't match the commitment, and gets refunded | After G4 |
| 3. Promises, bonds, flags | Records signed by the data source, a seller bond, proven cheaters blocked by the treasury | Stretch |

### The escrow address is the order

- `OverflowEscrowFactory.create(terms)` deploys a minimal clone with CREATE2, salted with `orderId`. The terms fix buyer (the treasury), seller, token, amount, `termsHash`, `manifestHash`, commitments, deadlines and bond.
- The seller's 402 response uses that escrow as `payTo`. The agent's signed `to` therefore binds the order, the amount and the terms, with no custom x402 payload.
- The treasury accepts a factory escrow as payee if its buyer is the treasury and its seller isn't flagged. The agent still needs budget.
- `orderId = keccak256(abi.encode(missionId, resourceId, buyer, seller, amount, termsHash, salt))`, built from fixed fields. Never hash JSON, because key order and number formats change the hash.

### States and functions

States: `Created → Funded → Revealed → Settled`, with `Refunded` reachable from `Funded` (timeout) and `Revealed` (valid proof).

&#91;embedded content: Recourse escrow states · 5 states, 2 terminal\]

A timeout or a valid proof refunds the treasury; an accept or a quiet challenge window pays the seller. Nothing leaves a terminal state.

- `markFunded()`: anyone; requires a USDC balance of at least the amount.
- `revealKey(key)`: seller only, before `revealDeadline`; requires `keccak256(key) == keyCommitment`.
- `accept(sig)`: a treasury node signs `Accept(orderId)`; the escrow checks `treasury.nodeOfKey(signer) != 0` and pays the seller at once.
- `finalizePayout()`: anyone, after the challenge window closes with no valid complaint.
- `claimTimeoutRefund()`: anyone, after `revealDeadline` with no reveal; funds return to the treasury.
- `complainMismatch(...)` and `complainPromise(...)` (tiers 2 and 3): during the challenge window; a valid proof refunds the price plus the bond.

Invariants: exactly one terminal state; funds go only to the seller or the treasury; terms can't change after creation; no payout before a reveal; no refund after settlement.

### Delivery cryptography

- Data is split into fixed-size chunks, one record per chunk (for example a 95-byte payload plus a 65-byte signature, 160 bytes).
- Per-buyer key `k = keccak256(sellerSecret, orderId, buyer)`. Each sale gets a fresh key, because a revealed key is public.
- Chunk key `k_i = keccak256(k, i)`; keystream blocks `keccak256(k_i, j)`; ciphertext `c_i = p_i XOR keystream`.
- The seller commits `rootPlain` (Merkle root of `keccak256(p_i)`), `rootCipher` (Merkle root of `keccak256(c_i)`) and `keyCommitment = keccak256(k)`.
- The buyer downloads all ciphertext first and checks it against `rootCipher` before funding.
- `packages/recourse-crypto` mirrors the contract's chunking, keystream and Merkle code in TypeScript; golden vectors keep the two identical.

### Sampling before buying

After the commitment is onchain, the buyer picks random chunk indices and the seller reveals only those `k_i`. A chunk key exposes nothing about `k` or other chunks. If 20% of chunks are junk, 20 random samples catch it about 99% of the time. Oracle (Claude) then judges the decrypted sample against the requirements.

### Complaints

- **Mismatch (tier 2):** the buyer submits `c_i` with its proof under `rootCipher`, and the expected leaf with its proof under `rootPlain`. The contract derives `k_i` from the revealed key, decrypts, hashes, and refunds if the hash differs.
- **Broken promise (tier 3):** the buyer submits plaintext `p_i` with its proof under `rootPlain`. The contract runs `ecrecover` against the promised source key and compares the record's timestamp with the promised minimum; a failure refunds.
- A complaint without a valid proof reverts. An allegation alone never refunds.

### Bonds and cheater flags (tier 3)

- The seller posts a bond (default 20% of the price) at creation. It is returned on payout and paid to the treasury on a proven cheat or a missed reveal.
- The factory records `provenCheats[seller]`, and the treasury reverts `PayeeFlagged` on any escrow or direct payment to a flagged seller. One proof blocks that seller for every Overflow treasury.

### Refund semantics (kept from V2)

A refund restores the treasury's USDC, not the agent's spent allowance. Only `release()` of an unused reservation restores allowance, because that money never moved.

### What Recourse can't do

It proves delivery matches the commitment and the stated promises; it does not prove the data is true. A seller can deliver the exact committed file with wrong numbers. Use synthetic, redistributable datasets in the demo, because a revealed key decrypts that ciphertext for anyone holding it.

## Fusion: one purchase for many agents

Fusion merges agents' requests into one purchase only when a real listing satisfies every request and its license allows shared use. Otherwise the purchases stay separate.

### Structured requests

Every request carries: topic, regions, date range, granularity, required fields, format, license need, freshness, and max price. Two agents both saying "EV sales" is not a match.

| Requirement | Agent A | Agent B |
| --- | --- | --- |
| Topic | EV registrations | EV registrations |
| Region | California | United States |
| Dates | 2024–2026 | 2025–2026 |
| Granularity | Monthly | Quarterly |
| Fields | Brand, units | Brand, units |
| License | Company use | Company use |

A nationwide, monthly 2024–2026 dataset with state detail and a company-use license satisfies both. A California-only dataset fails B; an annual-only dataset fails A; a single-user license fails both.

### Merge rules (all must pass)

| Dimension | Rule |
| --- | --- |
| Resource identity | Same product, or an explicitly compatible substitute |
| Geography | Covers every requested region at usable detail |
| Dates | Covers both requested periods |
| Resolution | Supports each agent's granularity (monthly can roll up to quarterly, not the reverse) |
| Fields | Every mandatory field for both agents is present |
| Format | Both agents can read it, or a supported conversion exists |
| License | Shared internal use and the seat count are permitted |
| Freshness | Meets both agents' recency needs |
| Price | One purchase actually costs less than two |

### Two-stage matcher

1. Keyword or embedding similarity proposes candidate pairs.
2. Deterministic checks against the seller's structured metadata decide. Only stage 2 can merge.

An unclear license means no merge.

### Money mechanics

- The merged purchase is signed by the **lowest common ancestor** of the participating agents and charged up that chain once. If the research and finance agents share the orchestrator as parent, the orchestrator's node pays.
- Each child's onchain cap is untouched; its share is a subledger allocation.
- Example: a 12 USDC dataset split 70/30 between research and finance books 8.40 and 3.60 USDC, with one 12 USDC transfer onchain.
- One active purchase per (mission, resource): a unique database key plus an `idempotencyKey`, so concurrent "buy" calls resolve to the same purchase.
- **P2 alternative:** `settleShared()`, where each contributing node signs its share and is charged onchain. Only if time remains.

### Acceptance tests

- Overlapping, compatible requests give one purchase with two allocations that sum to the price.
- Same topic, incompatible geography gives two separate decisions.
- Same dataset with a single-user license gives no merge.
- Two concurrent buys give at most one funded order.

## Oracle: decide what is worth buying

Oracle turns the mission into structured requirements, filters listings with code, ranks what's left, and judges a provably random sample before any Recourse purchase. It can't sign or pay.

| Step | Behavior | Implementation |
| --- | --- | --- |
| Requirement extraction | Goal becomes topics, regions, dates, granularity, fields, formats | Claude output parsed into a Zod schema; the user can edit it before any purchase |
| Discovery | Overflow's seller catalog; optional live x402 listings | Catalog JSON, plus Bazaar if confirmed |
| Coverage filter | Rejects listings missing a required field, region or date | Deterministic code, not the model |
| Existing-asset check | Skips resources the company already owns | Query `purchases` |
| Ranking | Price per covered requirement; freshness breaks ties | Deterministic score, shown with its inputs |
| Sample judgment | Claude reads the decrypted random sample and returns buy or skip, with a reason | Reason stored on the purchase and in the ledger memo |
| Explanation | What was chosen, what was rejected, and the assumptions | Shown in `ResourceComparison` |

Guardrails: model output is always parsed and validated; a recommendation never authorizes a payment; each model call's prompt and output hash are stored for audit. Value-of-information math (EVSI) stays out of the MVP.

Acceptance tests:

- A dataset with the wrong date range is rejected even when Claude prefers it.
- A low-quality sample gives "skip" with a stated reason.
- An Oracle proposal can't reach the treasury without a purchase order and an agent signature.

## Finance layer for Hyphenate

Overflow fills two seats, procurement analyst and accounts-payable clerk for agent data spend. It keeps a double-entry subledger tied to chain events and asks the controller only about exceptions.

### Company and people

- **Company:** a small research firm whose analysts run AI agents that buy market data. Open question: pick its name and two departments before recording.
- **Seats filled:** procurement (find, merge, request) and AP (fund escrow, release, refund, book).
- **People it answers to:** the controller (a human with a Coinbase Wallet), department heads who own budgets, and a read-only auditor. A model can play the department heads and auditor in the demo.

### Segregation of duties

| Action | Requested by | Approved by | Enforced by |
| --- | --- | --- | --- |
| Buy within budget from an approved seller | Agent | Policy the controller set earlier | Treasury `settle()` or `reserve()` |
| Add a new seller or payee | Agent | Controller in Coinbase Wallet | `onlyOwner` plus Wallet MCP approval |
| Raise a budget | Agent or department head | Controller | `raiseCap`, owner only |
| Release escrow early | Buying agent (`accept`) | Recourse checks passed | Escrow contract |
| Refund | Anyone, after a deadline or with a proof | Contract rules | Escrow contract |
| Change any policy | Only the controller | — | The owner key is on no server |

The agent that requests a payment can never approve its own policy change.

### Journal entries (immediate-expense policy)

| Event | Debit | Credit |
| --- | --- | --- |
| Controller funds the treasury | USDC treasury | Owner contribution |
| Reservation made | No entry (memo only) | — |
| Escrow funded, 8 USDC | Escrow deposit (asset) 8 | USDC treasury 8 |
| Delivery accepted | Data expense, by department, 8 | Escrow deposit 8 |
| Timeout or proven-cheat refund | USDC treasury 8 | Escrow deposit 8 |
| Seller bond forfeited | USDC treasury (bond) | Other income: seller forfeiture |
| Direct x402 API purchase | Data expense, by department | USDC treasury |

Fusion allocations split the expense line across departments without changing the total. A refunded order never also stays posted as an expense.

### Reconciliation

- After every run: the onchain treasury balance equals the ledger's USDC treasury account; each open escrow's balance equals that order's escrow-deposit line; every `Paid`, `PaidOut` and `Refunded` event has exactly one entry.
- A difference above the materiality threshold (default 0.01 USDC) opens an exception for the controller.
- Three sources can disagree: the chain (the bank), the ledger, and the escrow terms (the contract). The chain wins on balances, the escrow terms win on what was agreed, and the ledger is corrected to match with a stated reason.

### Time and memory

- Seller history persists across missions. A proven cheat in an earlier order blocks that seller later (the onchain flag), and Oracle down-ranks sellers with slow reveals.
- Budgets carry a period through `expiry`. Renewals are controller actions logged with who and why.

### When it asks a human

A new payee; a budget raise; an unclear license; a low-confidence sample judgment; a reconciliation difference above materiality; a dispute with no contract-checkable proof.

### Audit trail

Each entry links purchase ID, decision reason (Oracle), allocation (Fusion), authorization digest, transaction hash, escrow outcome and journal entry. Nothing is deleted; corrections are new entries.

## Contracts and interfaces

Three contracts, no upgradeability, no new tokens: OverflowTreasury (Leash core plus reservations), OverflowEscrowFactory, and OverflowEscrow (one clone per order). Agree on these signatures before anyone builds against them.

### OverflowTreasury.sol

```solidity
// payments
function settle(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata sig) external;
function reserve(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes calldata sig) external returns (bytes32 digest);
function release(bytes32 digest) external;
function isValidSignature(bytes32 digest, bytes calldata sig) external view returns (bytes4);
// tree
function createRoot(address key, uint256 cap, uint256 maxPerCall, uint256 expiry) external returns (uint256 id);   // owner
function createChild(ChildParams calldata c, bytes calldata parentSig) external returns (uint256 id);               // anyone relays
function pauseChild(uint256 target, uint256 nonce, uint256 deadline, bytes calldata ancestorSig) external;        // anyone relays
// owner (Coinbase Wallet)
function pause(uint256 id) external;
function unpause(uint256 id) external;
function raiseCap(uint256 id, uint256 newCap) external;
function setAllow(address payee, bool allowed) external;
function setFloor(uint256 newFloor) external;
function withdraw(address to, uint256 amount) external;
function setEscrowFactory(address factory) external;
function setReservationWindow(uint256 secondsMax) external;
// views
function getNode(uint256 id) external view returns (Node memory);
function remaining(uint256 id) external view returns (uint256);
function reservedTotal() external view returns (uint256);
```

### OverflowEscrowFactory.sol

```solidity
function create(OrderTerms calldata t) external returns (address escrow); // CREATE2 clone, salt = t.orderId
function predict(bytes32 orderId, bytes32 termsHash) external view returns (address);
function isEscrow(address a) external view returns (bool);
function provenCheats(address seller) external view returns (uint256);
function recordCheat(address seller) external;                           // callable only by its own escrows
```

### OverflowEscrow.sol

```solidity
struct OrderTerms {
  bytes32 orderId; address buyer; address seller; address token; uint256 amount; uint256 bond;
  bytes32 termsHash; bytes32 manifestHash; bytes32 rootPlain; bytes32 rootCipher; bytes32 keyCommitment;
  uint64 revealDeadline; uint64 challengeWindow; address sourceKey; uint64 minTimestamp;
}
enum Status { Created, Funded, Revealed, Settled, Refunded }

function markFunded() external;
function revealKey(bytes32 key) external;                       // seller
function accept(bytes calldata buyerNodeSig) external;          // treasury node signs Accept(orderId)
function finalizePayout() external;
function claimTimeoutRefund() external;
function complainMismatch(uint256 i, bytes calldata cipherChunk, bytes32[] calldata cipherProof,
                          bytes32 plainLeaf, bytes32[] calldata plainProof) external;
function complainPromise(uint256 i, bytes calldata plainChunk, bytes32[] calldata plainProof) external;
```

Escrow events: `OrderCreated`, `OrderFunded`, `KeyRevealed`, `Accepted`, `PaidOut`, `Refunded(reason)`, `CheatProven(seller, index)`.

### Shared offchain type (`packages/schemas`)

```ts
type PurchaseOrder = {
  id: string;
  orderIdBytes32: `0x${string}`;
  missionId: string;
  resourceId: string;
  buyerTreasury: `0x${string}`;
  sellerAddress: `0x${string}`;
  escrowAddress: `0x${string}`;
  chainId: 84532;
  tokenAddress: `0x${string}`;
  amountAtomic: string;
  payingNodeId: number;
  participatingAgentIds: string[];
  allocations: { agentId: string; department: string; amountAtomic: string }[];
  resourceManifestHash: `0x${string}`;
  termsHash: `0x${string}`;
  paymentPath: "overflow-facilitator" | "coinbase-facilitator";
  authorizationDigest?: `0x${string}`;
  txHashes: `0x${string}`[];
  createdAt: string;
  authorizationExpiresAt: string;
  status: PurchaseStatus;
};
```

`PurchaseOrder.id` is the one identifier linking Oracle's decision, the database reservation, the x402 payment, the escrow and the journal entry.

### Invariants (Foundry invariant tests)

- Every node's `spent` is at most its `cap` and at least the sum of its children's `spent`.
- The treasury balance is at least `floor + reservedTotal` after every call.
- `isValidSignature` returns valid only to USDC, and only inside `settle()` or for a live reservation.
- Every escrow reaches at most one of `Settled` or `Refunded`, and holds zero USDC afterwards.
- A flagged seller never receives a new payment.

## Offchain services and repo layout

One TypeScript service, one Next.js app, Postgres (SQLite if time is short), and the three contracts. Leash pieces are reused where marked.

### Repo

```
overflow/
├── apps/
│   ├── web/                 Next.js dashboard (Leash: tree bars, Blocked lane, kebab controls, Basescan links, replay)
│   └── service/
│       ├── api/             REST endpoints below
│       ├── orchestration/   missions, Oracle, Fusion, purchase state machine
│       ├── facilitator/     Leash: /verify /settle /delegate /events (SSE); /admin removed
│       ├── sellers/         Recourse sellers: honest, swap, ghost (labeled simulated)
│       └── chain/           viem clients, event indexer, reconciliation job
├── packages/
│   ├── schemas/             Zod types shared by everyone
│   ├── oracle/  fusion/
│   ├── payment-client/      Leash leash-client: EIP-3009 signing, golden-vector tests
│   ├── recourse-crypto/     chunking, keystream, Merkle trees (mirror of the contract)
│   └── database/
├── contracts/
│   ├── src/                 OverflowTreasury.sol, OverflowEscrowFactory.sol, OverflowEscrow.sol
│   ├── test/                unit/ fork/ invariant/ adversarial/ fixtures/usdc-v2_2/
│   └── script/              Deploy.s.sol
├── docs/                    architecture, threat-model, contract-invariants, limitations, coinbase-feedback
└── .env.example, README.md
```

`test/fixtures/usdc-v2_2` holds Circle's compiled USDC, so unit tests run against real token code offline.

### Leash parts worth keeping

| From the Leash repo | Keep as | Change |
| --- | --- | --- |
| `contracts/src/LeashWallet.sol`, `ILeashWallet.sol` | `OverflowTreasury` | Add reservations, factory escrows, cheater flags; owner = Coinbase Wallet |
| `packages/leash-client` | `payment-client` | Token domain read via `name()`/`version()`; quote checked against the order |
| `apps/facilitator` `/verify`, `/settle`, `/delegate`, `/events` | `service/facilitator` | Drop `/admin/*` and `/demo/bypass` auth gaps; owner actions move to Wallet MCP |
| `apps/seller` paywall, injection fixture, attacker endpoint | `service/sellers` | Add Recourse order and sample endpoints |
| `apps/agents` orchestrator, sub-agents, `DEMO_SCRIPTED` | `service/orchestration` | Keep the labeled scripted mode as a fallback only |
| `apps/dashboard` | `apps/web` | Add missions, purchases, escrow, ledger pages |

### Purchase state machine

`PROPOSED → RESERVED → PAYMENT_PENDING → ESCROW_FUNDED → DELIVERY_PENDING → SETTLED | REFUNDED`

Also `REJECTED` (a policy revert, with its error), `PAYMENT_UNKNOWN` (broadcast with no receipt yet), `FAILED_BEFORE_FUNDING`, and `RELEASED` (a reservation expired unused). Never retry an uncertain payment with a new nonce; reconcile the old transaction first.

### Database tables

V2's tables (`organizations`, `missions`, `agents`, `resource_requests`, `resources`, `purchase_groups`, `allocations`, `purchases`, `chain_transactions`, `escrow_orders`, `financial_entries`, `activity_events`), plus:

- `reservations`: digest, nodeId, value, validBefore, status.
- `samples`: purchaseId, indices, verdict, reason.
- `seller_history`: seller, orders, on-time reveals, proven cheats.
- `exceptions`: type, amount, status, resolvedBy.

Amounts are integer atomic units. `idempotencyKey` is unique.

### API

| Endpoint | Purpose |
| --- | --- |
| `POST /api/missions`, `POST /api/missions/:id/plan` | Create a mission (goal, budget, data horizon, allowed formats); extract requirements (mission → `planning`) |
| `PUT /api/missions/:id/requests/:requestId`, `POST /api/missions/:id/confirm` | The owner edits one extracted requirement (only while `planning` and `open`); confirms the set (`planning` → `confirmed`). Propose and run answer 409 `requirements_unconfirmed` while a mission is `planning` |
| `GET /api/missions`, `GET /api/missions/:id` | List missions; a mission with its requests, purchases and Fusion groups |
| `GET /api/resources` | Candidates with coverage |
| `POST /api/purchases/propose` | Oracle plus Fusion proposal; with a Recourse seller wired, the seller's `POST /orders` answer is verified (hashes recomputed, treasury/USDC/price/manifest checked, escrow = `factory.predict`) and mirrored as an `escrow_orders` row in the same transaction; a failed check answers 502 `seller_terms_rejected` and writes nothing |
| `POST /api/purchases/:id/authorize` | Steps 4 to 7 for one PROPOSED purchase (`Idempotency-Key` required). The sample judgment runs first: code fetches the cipher and manifest and verifies them against the escrow row (a mismatch ends the purchase `FAILED_BEFORE_FUNDING`, 409 `sample_mismatch`), then a random sample is decrypted and the model judges it against the mission's confirmed requirements (`skip` → `FAILED_BEFORE_FUNDING`, 409 `sample_skipped`). Only then the seller's 402 quote is checked against the order, the agent signs and the adapter submits. 202 with `submission.outcome` `submitted` (tx hash) / `rejected` (decoded treasury revert) / `unknown` (`PAYMENT_UNKNOWN`, reconcile before any retry) / `held`: a low-confidence `buy` raises a `LOW_CONFIDENCE_SAMPLE` exception, nothing is signed and the purchase stays `PROPOSED`; while that exception is open the route answers 409 `sample_low_confidence`, after approval the next call proceeds on the stored sample, after rejection it ends `FAILED_BEFORE_FUNDING`. A quote that disagrees with the order is never signed: `REJECTED` with `decodedRevert` `QuoteMismatch(<field>)` and 409 `quote_mismatch`. Funding is set only by the indexer from `OrderFunded` |
| `GET /api/purchases/:id`, `GET /api/escrow/:id` | Order, chain and escrow state |
| `GET /api/agents`, `POST /api/agents/:id/pause` | Tree; pause opens a controller approval |
| `GET /api/activity`, `GET /events` (SSE) | History and live feed |
| `GET /api/ledger?purchaseId&account&department&limit` | Journal rows (filters), whole-book balances by account and department, Fusion allocation breakdown (planned vs booked per purchase and department) |
| `GET /api/reconciliation`, `POST /api/reconciliation/run` | Last run (treasury and every escrow check, differences, materiality) with open exceptions; on-demand run |
| `GET /api/treasury` | Overview money cards: USDC `balanceOf(treasury)` and `reservedTotal()` read at one block (null with the reason when no RPC is wired) plus the USDC the open, funded escrows hold |
| `GET /api/exceptions?status`, `POST /api/exceptions/:id/decide` | Exceptions with their prepared controller request; the controller's offchain decision (onchain types: reject only) |
| Seller: `GET /r/:id?order=` (402, payee = the per-order escrow), `GET /r/:id/manifest`, `POST /orders`, `GET /orders/:id`, `GET /orders/:id/cipher`, `POST /orders/:id/sample`, `GET /sellers`, `GET`/`PUT /sellers/:id/behavior` | Recourse seller protocol (SIMULATED sellers; behavior honest, swap or ghost) |

There is no generic `/api/execute`.

### Stack

Next.js and TypeScript; Tailwind, shadcn/ui and Lucide; Solidity with OpenZeppelin; Foundry; viem; Base Sepolia; USDC; `@x402` packages; Coinbase Wallet MCP and CDP; the Anthropic SDK as the only model provider; Postgres with Drizzle; Zod; Foundry and Vitest for tests. No Redis, Kafka, LangChain, second chain or second language.

### UI

V2's components: `TreasuryBalance`, `BudgetUtilization`, `MissionComposer`, `AgentHierarchy`, `ResourceComparison`, `FusionProposal`, `PurchaseAuthorization`, `PaymentTimeline`, `EscrowPanel`, `TransactionEvidence`, `ActivityFeed`. Plus Leash's: a Blocked lane showing the decoded revert reason, a per-agent menu (pause, raise cap; each opens a controller approval), and Basescan links on every transaction.

Dark theme per your references. Every money action shows the payer, amount, destination and expected outcome before it runs. A Pause button changes contract state, never a local flag. Refund buttons appear only when the contract would accept them.

## Demo script

Open with the moment, keep one mission running throughout, and label every simulated part on screen. Target length is 3:00.

| Time | Screen | What happens | Proves |
| --- | --- | --- | --- |
| 0:00–0:20 | Escrow detail | A seller swapped one record after the sample. The agent submits a chunk proof; refund plus bond land on Basescan; the seller is flagged | Hyphenate moment, Armadin |
| 0:20–0:40 | Overview | "x402 lets an agent pay. A business can't safely let a team of agents spend." Mission: research the EV market, 50 USDC | The problem |
| 0:40–1:05 | Agents | Controller funds the treasury from Coinbase Wallet; the orchestrator delegates to three sub-agents by signature, paying no gas | Coinbase, the Leash core |
| 1:05–1:30 | Purchases | Oracle rejects a dataset with the wrong dates; Fusion merges two agents' requests into one 12 USDC purchase | Hyphenate, Microsoft |
| 1:30–2:00 | Payment timeline | An agent pays a third-party x402 API through Coinbase's facilitator (`reserve()`), then funds the dataset's escrow | Coinbase |
| 2:00–2:25 | Blocked lane | An injected listing makes an agent sign a payment to an attacker: `PayeeNotAllowed`. The same signature sent to USDC: `FiatTokenV2: invalid signature` | Armadin, Coinbase engineers |
| 2:25–2:45 | Ledger | The honest seller is paid; entries are booked by department; reconciliation shows no differences | Hyphenate, Microsoft |
| 2:45–3:00 | Overview | The flagged seller tries a new order and is blocked. Closing line | All four |

For live pitches outside Hyphenate, swap the first two rows so the problem comes first.

### Extra beats from the Leash demo, if asked

- A search-only agent can't pay a scraping seller: `PayeeNotAllowed(n)`.
- An agent passes its cap: `OverBudget`; the controller raises the cap in Coinbase Wallet and work resumes.
- Pausing the orchestrator stops its whole subtree.
- Every refusal appears in the Blocked lane with its reason and a Basescan link.

### Scripted replay (labeled fallback)

`DEMO_SCRIPTED=record` saves every model answer of one mission, keyed by call site (`oracle.extract`, `sample.judge`, `mission.plan`, `mission.synthesize`, `agent.<role>`), to `data/scripted/<name>.json`. `DEMO_SCRIPTED=replay` answers each model call from that file and never calls the API; the call site runs the same Zod validation, and everything after the model (order terms, signing, settle, escrow funding, reveal, accept, indexing, ledger) runs for real with new transactions. Replay never fakes a chain result, and a missing or exhausted recording fails that call loudly. Labels: every service log line starts with `[SCRIPTED]`, each replayed call is an `oracle.model_call` event saying "SCRIPTED replay", `GET /` reports `scripted.mode`, and the web top bar shows the SCRIPTED badge from that field.

### A judge's own scenario

Hyphenate may run its own case. Expose these controls in Settings, each working live with no code change: seller behavior (honest, swap, ghost), price, agent caps, a new payee, and a license flag.

### Closing line

"Overflow lets a team of agents spend on its own under rules a human sets once. It checks every payment onchain, and it gets the money back when a seller cheats."

## Proof it works

Show three kinds of proof: contract tests, a planted-error set with an answer key, and real Base Sepolia transactions. Every number in the submission comes from a run, never an estimate.

### Contract tests (Foundry)

- **Ported from Leash:** settle, delegation, pause, floor, replay and bypass tests. They already run against Circle's compiled USDC.
- **Fork:** `UsdcGate.t.sol` against live Base Sepolia USDC (domain, settle, bypass, replay, gate closed outside settle).
- **Reservations:** a reserved payment settles through a direct USDC call; an expired, unused one restores budget on `release()`; a used one doesn't; the floor counts reservations.
- **Escrow:** payout, timeout refund, `accept`, mismatch proof, promise proof, a false complaint reverts, a double finalize reverts, bond flows, a flagged seller is blocked.
- **Invariants:** the five listed under Contracts and interfaces.

### Offchain tests (Vitest)

The Fusion compatibility matrix; Oracle's coverage filter; state-machine transitions; quote-versus-order checks (a mismatched `payTo` or price is never signed); reconciliation after a simulated timeout; payment-client golden vectors that match the contract's digests.

### Planted-error set with answer key

| # | Planted error | Expected outcome | Caught by |
| --- | --- | --- | --- |
| 1 | A listing tells the agent to pay an attacker | `PayeeNotAllowed(0)` | Treasury |
| 2 | The same signature sent straight to USDC | `FiatTokenV2: invalid signature` | ERC-1271 gate |
| 3 | A search-only agent pays a scraping seller | `PayeeNotAllowed(n)` | Node allowlist |
| 4 | A payment above the per-call limit | `OverPerCall(n)` | Treasury |
| 5 | Sub-agents together exceed the parent's cap | `OverBudget(parent)` | Tree walk |
| 6 | A payment after expiry | `Expired(n)` | Treasury |
| 7 | The orchestrator is paused and a child pays | `Paused(root)` | Tree walk |
| 8 | The seller never reveals the key | Timeout refund | Escrow |
| 9 | The seller swaps one chunk after sampling | Mismatch proof, refund plus bond | Escrow |
| 10 | A record is signed by the wrong source key | Promise proof, refund | Escrow |
| 11 | The buyer complains about a correct file | Complaint reverts; seller paid | Escrow |
| 12 | Two agents request the same compatible data | One purchase, two allocations | Fusion |
| 13 | Same topic, wrong region | Two separate decisions | Fusion |
| 14 | A single-user license | No merge | Fusion |
| 15 | A dataset missing required dates | Rejected before purchase | Oracle |
| 16 | Two concurrent buys of one order | One funded order | Idempotency key |
| 17 | An RPC timeout after broadcast | Reconciled; no second payment | State machine |
| 18 | A flagged seller opens a new order | `PayeeFlagged` | Treasury and factory |
| 19 | The seller's quote differs from the order | Not signed | Payment client |
| 20 | The ledger is off by a planted 0.50 USDC | Exception opened for the controller | Reconciliation |

Run the whole set from a script, record the results table, and put it in the Hyphenate proof and the README.

### Numbers to report

- Planted errors caught, out of 20.
- Unauthorized payment attempts rejected onchain.
- Duplicate spend avoided by Fusion, in USDC.
- Orders that ended in exactly one terminal state and reconciled.
- Gas per `settle()`, per `reserve()`, and per full escrow lifecycle on USDC.

## Build plan to Sunday 9:00 AM PT

Gates G1 to G3 are the survival line; nothing else starts until they pass. Submissions close Oct 25, 2026 at 9:00 AM Pacific.

### Gates, in order

1. **G1, real USDC through the treasury.** Treasury deployed on USDC; the controller funds it; an allowed agent pays and a disallowed one reverts; the fork test passes.
2. **G2, escrow tier 1.** A real payout and a real timeout refund on Base Sepolia.
3. **G3, the Coinbase path.** One x402 purchase through Coinbase's facilitator after `reserve()`. If it can't work, document the exact blocker and ship the Overflow-facilitator path, labeled.
4. **G4, coordination.** Oracle rejects and ranks; Fusion merges one compatible pair.
5. **G5, the books.** Journal entries and reconciliation match chain outcomes.
6. **G6, judge-ready.** The full flow reruns from a clean start; the video is recorded, opening with the moment.

If G1 fails, stop adding features. If G2 slips, drop Recourse tiers 2 and 3. If G3 fails, its blocker becomes the main builder-feedback item.

### Owners (four engineers)

| Engineer | Owns | First deliverable |
| --- | --- | --- |
| A, onchain authorization | `OverflowTreasury` (port of LeashWallet), reservations, factory checks, Foundry suite, deploy script | G1 |
| B, escrow and delivery | Factory and escrow, `recourse-crypto`, seller services (honest, swap, ghost) | G2 |
| C, orchestration | Oracle, Fusion, state machine, database, reconciliation, ledger | G4, G5 |
| D, product and Coinbase | Next.js app, Wallet MCP controller flow, payment adapters, demo and video | G3, G6 |

With fewer people, A and B merge (contracts) and C and D merge (app). Agree on purchase IDs, event schemas, signatures and contract addresses before splitting up. D builds against typed mock responses until the contracts land.

### Checkpoints (shift to the current time)

| By | Must be true |
| --- | --- |
| Sat 8 PM | G1 passes on Base Sepolia |
| Sat midnight | G2 passes; decide whether tier 2 starts |
| Sun 3 AM | G3 resolved either way; G4 working |
| Sun 6 AM | G5 done; feature freeze |
| Sun 6–8:30 AM | Record the video, write the Coinbase and Hyphenate deliverables, rehearse |
| Sun 9 AM | Submitted |

### Cut order if behind

Cut first: Fusion `settleShared`, then promise proofs and bonds, then chunk mismatch proofs, then Bazaar discovery, then CDP server-wallet agent keys. Never cut: G1, the G2 refund, the bypass demo, or the labels on simulated parts.

### Out of scope (from V2)

Multi-company coalitions, automatic allowance restoration after refunds, full FairSwap for arbitrary files, credit or identity checks, trading, cross-chain, extra agent frameworks, ERP integration, a mobile app, and mainnet.

## Risks, open questions and limits

The biggest risk is Coinbase's facilitator refusing a contract-wallet payer; the fallback keeps the demo honest and turns the blocker into builder feedback.

| Risk | Likelihood | If it happens |
| --- | --- | --- |
| Coinbase's facilitator rejects the treasury as payer after `reserve()` | Medium | Use the Overflow-facilitator path, label it, make it the main builder-feedback item |
| Wallet MCP `send_calls` doesn't work on Base Sepolia | Medium | Use a CDP server wallet as controller on testnet; show Wallet MCP for funding only |
| Wallet MCP returns ERC-6492-wrapped signatures | Medium | Matters only where a contract checks the controller's signature; owner calls use `msg.sender` and are unaffected |
| Live USDC behaves differently from Circle's compiled source | Low | Caught by the fork test before G1 |
| Escrow cryptography bugs | Medium | Ship tier 1 only; put tier 2 behind a flag |
| Running out of time | High | Follow the cut order |
| Pre-existing code rule | — | Disclose Leash as prior work; write all Overflow code this weekend |

### Open questions

- Does Coinbase's "MCP for Agents" requirement accept Wallet MCP plus CDP, or must it be the Coinbase MCP? Ask at the booth.
- Did the Coinbase MCP gain x402 payments? V2 cites a Sep 22, 2026 launch; the Coinbase docs page read for this spec still said "coming soon".
- Is the Bazaar discovery MCP (`search_resources`) available on testnet?
- How many people are on the team, and who takes each engineer role?
- What are the company's name and departments for the Hyphenate story?

### Known limitations (copy into `docs/limitations.md`)

- Policies and budgets are public onchain.
- Recourse proves delivery against commitments and promises, not truth.
- A revealed key makes that ciphertext readable, so the demo uses synthetic data.
- Agent trees stop at two levels below the root.
- Agent keys sit in server secrets by default; `NODE_SIGNER=cdp` moves a node key into a CDP server account (optional, see docs/coinbase-feedback.md for what was verified live).
- Refunds don't restore allowance.
- Unaudited and testnet-only; about 144k gas per `settle()` (AUSD measurement), plus one transaction for each reservation.

## Submission checklist

### Everyone

- [ ] Every member has a verified Coinbase account, is 18 or older, and lives in the US or Canada (not Quebec)
- [ ] Devpost discloses Leash (B@BHacks) as prior work and lists what was built this weekend
- [ ] README gives setup in order, ships `.env.example`, and commits no secrets
- [ ] Simulated sellers, data and the attacker are labeled on screen and in the README

### Coinbase (Payment Agents)

- [ ] Project summary: who it's for, what it does, the agent platform (Claude via the Anthropic SDK), the Coinbase tools used
- [ ] Working example: demo video plus a repo with setup steps a stranger can follow
- [ ] Architecture: diagram, controls, known limitations
- [ ] Builder feedback: biggest blocker, workaround, one missing capability (candidates: a facilitator that settles through a payer's policy contract; budgets that roll up through sub-agents in agent wallets)
- [ ] Opt in to the follow-up conversation with Coinbase

### Hyphenate

- [ ] Demo video that opens with the moment
- [ ] The one-line seats statement
- [ ] Proof: the real-versus-simulated table, the planted-error answer key, and the results table
- [ ] Live demo ready for a judge's own scenario

### Microsoft

- [ ] One slide: customer, measurable usefulness, path to production, responsible design
- [ ] An end-to-end run with no manual database edits

### Armadin

- [ ] Criteria checked on the live site
- [ ] `docs/threat-model.md` plus the attack demos: injection, bypass, swap, ghost

## Sources

- [Leash repo](https://github.com/AnthonyOlakangil/leash): contract interface, check order, delegation, facilitator and seller routes
- [Coinbase agent tools overview](https://docs.cdp.coinbase.com/ai-agents/overview)
- [Coinbase Wallet MCP](https://docs.cdp.coinbase.com/ai-agents/coinbase-for-agents/wallet-mcp)
- [Base Account Spend Permissions](https://docs.base.org/base-account/improve-ux/spend-permissions)
- [Circle stablecoin-evm (USDC source)](https://github.com/circlefin/stablecoin-evm)
- [x402 repository](https://github.com/x402-foundation/x402): Base Sepolia USDC address and domain
- [Cal Hacks 13.0 on Devpost](https://cal-hacks-13-0.devpost.com/)
- Shared by the team: the Coinbase CalHacks Challenge 2026 PDF, the Hyphenate track brief, the sponsor track sheet, and the Overflow V2 and Part 3 specs

Build prompts for Claude Code, in run order: Claude Code prompts
