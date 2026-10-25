# Progress

## 2026-10-24: scaffold Overflow monorepo

### Built
- pnpm workspace (`apps/*`, `packages/*`), TypeScript strict via `tsconfig.base.json`, Node >= 20 (`.nvmrc` = 20; verified locally on Node 26.7.0 / pnpm 12.15.0).
- `apps/web`: Next.js 16.4.3 App Router (Turbopack), Tailwind v4, shadcn/ui v4 (`base-nova` style, `components.json`, `src/lib/utils.ts`, `Button`), lucide-react. Home page is labeled "SCAFFOLD: no live data" and imports `@overflow/schemas` to prove `transpilePackages` works.
- `apps/service`: Node + TypeScript with `src/{api,orchestration,facilitator,sellers,chain}/` placeholder modules. `tsx watch` for dev, `tsup` bundle for build. Boots a tiny HTTP server that returns a JSON status object. Depends on viem, zod, `@anthropic-ai/sdk` and all six packages.
- `packages/schemas` (zod; `AddressSchema`, `AtomicAmountSchema`, `CHAIN_ID`, `USDC_DECIMALS`, plus a 3-case smoke test), `packages/oracle`, `packages/fusion`, `packages/payment-client` (viem), `packages/recourse-crypto` (viem), `packages/database` (drizzle-orm + postgres + drizzle-kit, placeholder `scaffold` table and `drizzle.config.ts`).
- `contracts/`: Foundry, solc 0.8.28, `evm_version = "cancun"`, optimizer on, forge-std v1.9.7 and OpenZeppelin Contracts v5.7.0 as git submodules (`foundry.lock` committed). `test/Scaffold.t.sol` checks the toolchain and that `tstore`/`tload` compile and run.
- Root scripts: `dev`, `build`, `typecheck`, `lint`, `test` (vitest projects over `packages/*` and `apps/service`), `contracts:build`, `contracts:test`.
- `.env.example` with all 20 keys (only `CHAIN_ID` and `TOKEN_ADDRESS` carry values). `CLAUDE.md`, `README.md`, `docs/SPEC.md` placeholder, `docs/CHANGELOG.md`.
- `reference/leash` cloned (depth 1) and ignored via `reference/` in `.gitignore`.

### Design choices
- Packages export TypeScript source (`"exports": "./src/index.ts"`), no `dist`. tsx, Next (`transpilePackages`) and Vitest consume it directly, so there is no stale-build step and `pnpm typecheck` works on a fresh clone. The service bundles workspace packages with `tsup` (`noExternal: [/^@overflow\//]`).
- pnpm 12 blocks dependency build scripts by default; `pnpm-workspace.yaml` sets `allowBuilds` for `esbuild` and `unrs-resolver` only. Without this, `pnpm add` inside shadcn/tsx/tsup setups fails with `ERR_PNPM_IGNORED_BUILDS`.
- Web `typecheck` runs `next typegen && tsc --noEmit` because Next 16 generates global types (`LayoutProps`) that plain `tsc` cannot see before a build.

### Stubbed or simulated
- Every package `index.ts` exports a `*_STATUS = "scaffold: not implemented"` constant and nothing else of substance.
- `apps/service/src/sellers` is marked SIMULATED in code; it has no behaviour yet.
- The web home page renders static text and a disabled button; it reflects no chain or API state.
- `contracts/src` is empty (only `.gitkeep`). No Treasury/Escrow code yet.
- `packages/database` has a placeholder table only; no migrations, no client factory.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 |
| `pnpm typecheck` | exit 0, 8 workspaces Done |
| `pnpm build` | exit 0 (`tsup` build success; `next build` compiled, 2 static routes) |
| `pnpm test` | exit 0, 1 file / 3 tests passed |
| `pnpm lint` | exit 0 (web only) |
| `forge build` (contracts) | exit 0, "Compiling 21 files with Solc 0.8.28 ... Compiler run successful!" |
| `forge test` (contracts) | 2 passed, 0 failed |
| `node apps/service/dist/index.js` | served JSON status on the SERVICE_URL port |
| `git check-ignore reference/leash` | matched `.gitignore:22:reference/` |

### Open issues
- ESLint is configured only for `apps/web`. Packages and the service have no linter yet.
- `pnpm dev` runs web and service in parallel but neither has anything to do yet.
- Teammates must clone with `--recurse-submodules` (or run `git submodule update --init`) for `contracts/lib`.
- `docs/SPEC.md` is still the placeholder line; paste the exported spec before the next prompt.
- `drizzle-kit` reads `DATABASE_URL` from the environment; no `.env` loading is wired yet.

## 2026-10-24: `@overflow/schemas` shared types, state machine, chain config

### Built
- `packages/schemas/src/primitives.ts`: `AddressSchema`, `Bytes32Schema`, `HexSchema` (typed as viem `Address`/`Hex` via `z.custom`, so input and output types match), `UintStringSchema`/`AtomicAmountSchema` (decimal integer string, no leading zeros, at most uint256), `IsoDateTimeSchema`, `IsoDateSchema`, `IdSchema`, `USDC_DECIMALS`.
- `money.ts`: `toAtomic("8.40") -> "8400000"` by string arithmetic (rejects >6 decimals, signs, exponents, `.5`, `1.`, and `number` arguments at runtime), `formatUsdc`, `atomicToBigInt`, `bigIntToAtomic`, `sumAtomic`. No `Number` or float anywhere.
- `purchase.ts`: `PurchaseStatusSchema` (11 statuses), `ALLOWED_TRANSITIONS` table, `TERMINAL_STATUSES`, pure `canTransition`/`assertTransition` (`InvalidTransitionError` carries `from`/`to`), `PaymentPathSchema`, `AllocationSchema`, `PurchaseOrderSchema` with exactly the spec's fields plus a refinement that non-empty allocations sum to `amountAtomic`.
- `resource.ts`: `ResourceRequestSchema`, `ResourceListingSchema` (with `simulated` flag), `DateRangeSchema`, `GranularitySchema` + `GRANULARITY_ORDER`, `FormatSchema`, `LicenseSchema` (`unclear` allowed; Fusion treats it as no merge), `FreshnessSchema`.
- `mission.ts`: `MissionSchema`, `AgentNodeSchema` mirroring the onchain `Node` struct (`id`, `key`, `parent`, `depth` 0..2, `cap`, `spent`, `maxPerCall`, `expiry`, `paused`, `restricted`) plus optional offchain `agentId`/`department`.
- `ledger.ts`: `JournalEntrySchema` (double-entry; debits must equal credits; each line is a debit or a credit), `ActivityEventSchema` (with `decodedRevert` for the Blocked lane and `simulated`), `ExceptionRecordSchema`, `ControllerRequestSchema` (discriminated union of owner actions: set-allow, raise-cap, pause, unpause, set-floor, withdraw, set-escrow-factory).
- `hashing.ts`: `computeTermsHash`, `computeOrderId`, `hashIdToBytes32`, with the ABI parameter lists exported (`TERMS_HASH_ABI`, `ORDER_ID_ABI`) so the Solidity side can be checked against them.
- `chain.ts`: `CHAIN_ID`, `USDC` facts (address, name, version, decimals, domain separator, selector), `USDC_EIP712_DOMAIN`, `OVERFLOW_DELEGATION_DOMAIN`, `explorerUrl(kind, value)` for sepolia.basescan.org, `DeploymentsSchema`/`parseDeployments`/`loadDeployments` for `deployments/base-sepolia.json`.
- Dependencies: zod and viem only.

### Design choices
- **termsHash field order (contract must match):** `keccak256(abi.encode(address token, uint256 amount, uint256 bond, bytes32 manifestHash, bytes32 rootPlain, bytes32 rootCipher, bytes32 keyCommitment, uint64 revealDeadline, uint64 challengeWindow, address sourceKey, uint64 minTimestamp))`. Buyer, seller, missionId and resourceId are bound by `orderId`, so they are not repeated.
- **orderId (spec formula):** `keccak256(abi.encode(bytes32 missionId, bytes32 resourceId, address buyer, address seller, uint256 amount, bytes32 termsHash, bytes32 salt))`, where the offchain string ids become `bytes32 = keccak256(bytes(id))`. Fixed fields only, never JSON.
- Transition table: `PROPOSED -> RESERVED | REJECTED | FAILED_BEFORE_FUNDING`; `RESERVED -> PAYMENT_PENDING | RELEASED | REJECTED | FAILED_BEFORE_FUNDING`; `PAYMENT_PENDING -> ESCROW_FUNDED | PAYMENT_UNKNOWN | REJECTED | FAILED_BEFORE_FUNDING`; `PAYMENT_UNKNOWN -> ESCROW_FUNDED | FAILED_BEFORE_FUNDING` (reconcile only, never back to a payment state); `ESCROW_FUNDED -> DELIVERY_PENDING | REFUNDED`; `DELIVERY_PENDING -> SETTLED | REFUNDED`; the other five are terminal. 17 allowed pairs out of 121.
- `loadDeployments` imports `node:fs/promises` dynamically so `@overflow/schemas` stays importable from Next client bundles. Default path is `<repo>/deployments/base-sepolia.json`, overridable with `OVERFLOW_DEPLOYMENTS_PATH`.
- Zod 4 keeps running later checks after an earlier one fails, so the uint256/uint64 guards and the sum refinements re-validate before calling `BigInt()`.
- Intra-package imports are extensionless (`./chain`, not `./chain.js`): Turbopack does not map `.js` specifiers back to `.ts` sources under `transpilePackages`.
- `apps/web/tsconfig.json` target raised from ES2017 to ES2020 so `tsc` accepts bigint literals in the shared source it type-checks (Next's SWC output is unaffected).

### Stubbed or simulated
- `deployments/base-sepolia.json` does not exist yet; `loadDeployments` throws an error naming the path until the deploy script (P1.2) writes it.
- No schema here is wired to a database, API route or UI yet.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install` | exit 0 |
| `pnpm test` | exit 0, 5 files / 103 tests passed (full 11x11 transition matrix, toAtomic edge cases, orderId/termsHash determinism and per-field sensitivity, viem `domainSeparator` == pinned USDC constant, deployments loader round-trip) |
| `pnpm typecheck` | exit 0, 8 workspaces Done |
| `pnpm --filter @overflow/web build` | exit 0, compiled, 2 static routes |

### Open issues
- `pnpm --filter @overflow/schemas test` fails at startup because Vitest in a package directory picks up the root `projects` config and resolves `apps/service` relative to the package. Run `pnpm test` from the root (or add a per-package `vitest.config`) until the scaffold is adjusted.
- Engineer B must copy the `termsHash` and `orderId` field orders above into `OverflowEscrowFactory`/`OverflowEscrow` and add a golden-vector test against `computeOrderId`.

## 2026-10-24: `@overflow/recourse-crypto` chunking, keys, Merkle proofs, golden vectors

### Built
- `packages/recourse-crypto/README.md` documents the record format as a contract: chunk = 160 bytes = payload (95) + signature (65, `r||s||v`, v in {27,28}); payload = `0x01` + uint64 big-endian timestamp + 86 bytes of one UTF-8 CSV row right-padded with `0x00`; signature = raw ECDSA over `keccak256(payload)` with no EIP-191 prefix (viem `sign({ hash })`, RFC 6979 deterministic).
- `src/record.ts`: `encodePayload` (rejects rows over 86 bytes and rows containing NUL), `decodePayload`, `payloadHash`, `signPayload`, `buildRecordChunk`, `splitChunk`/`parseChunk`, `recoverRecordSigner`, `verifyRecordPromise` (wrong-source / stale-timestamp / malformed), `splitDataset`/`joinChunks`.
- `src/keys.ts`: `perBuyerKey = keccak256(encodePacked(bytes32 secret, bytes32 orderId, address buyer))`, `chunkKey(k, uint256 i)`, `keystreamBlock(k_i, uint256 j)`, 160-byte keystream = blocks 0..4, XOR encrypt/decrypt, `keyCommitment = keccak256(k)`, dataset helpers.
- `src/merkle.ts`: leaf = `keccak256(chunk)`, parent = `keccak256(left || right)`, odd last node carried up unchanged, proofs skip carried levels. `verifyProof` works with or without the leaf count (see design choice below); `expectedProofLength`, `computeRootFromProof`.
- `src/commit.ts`: `commitDataset` -> `rootPlain`, `rootCipher`, `keyCommitment`, `leafCount`, `k`, both chunk/leaf arrays and trees; `verifyCiphertext`, `verifyPlainLeaves` for the buyer before funding.
- `src/sample.ts`: `pickSampleIndices(n, count, randomBytes)` (keccak256(random || uint256 j) mod n, unique, draw order), `revealChunkKeys`, `verifySample` (cipher proof, plain proof, decrypt-and-hash).
- `src/complaint.ts`: `buildMismatchComplaint` -> `{ i, cipherChunk, cipherProof, plainLeaf, plainProof }`, `buildPromiseComplaint` -> `{ i, plainChunk, plainProof }` (+ verdict). Both throw `ComplaintNotWarrantedError` when the contract would revert. `checkMismatch` exposes the contract's derivation.
- `src/vectors.ts` + `scripts/gen-vectors.ts` (`pnpm --filter @overflow/recourse-crypto vectors`): SIMULATED 7-chunk dataset, label-derived throwaway keys, every intermediate value, one swapped chunk (index 3) with ready `complainMismatch` args, one wrong-source record (index 5) with ready `complainPromise` args. Written to `packages/recourse-crypto/test/vectors.json` and copied to `contracts/test/fixtures/recourse-vectors.json`.
- `src/cli.ts` (`pnpm --filter @overflow/recourse-crypto cli -- <cmd>`): `records`, `commit`, `encrypt`, `sample`, `decrypt`, `prove`. Added `tsx` as a devDependency for the script and CLI.

### Design choices
- **Proof shape without the leaf count.** Because the odd node is carried up unchanged, proof lengths vary by index. `verifyProof(root, leaf, index, proof)` still works without `n`: depth = `max(bitLength(index), proof.length)` and the missing levels are the topmost even-position levels of the path (a node that is last at one level is last at every level above). Algorithm is written out in the README for the Solidity mirror.
- **Second-preimage caveat.** Without `n`, a bare 32-byte leaf that is really an internal node verifies with a shorter proof. Chunk-backed leaves (`cipherChunk`, `plainChunk`) are immune; the bare `plainLeaf` in `complainMismatch` is not. The contract must pin the shape: store `chunkCount` and check the proof length, or require `cipherProof.length == plainProof.length`. TS callers should pass `leafCount` (from the manifest) whenever known; `verifySample` and the vectors tests do.
- Complaint builders validate locally and refuse to build a complaint the contract would reject, so the UI never shows a "refund pending" for an allegation the chain will revert.
- `leafCount` is part of the manifest, not the roots; `commitDataset` returns it.

### Stubbed or simulated
- All vector key material and the dataset are labeled SIMULATED; no real source signer exists yet.
- Not wired to the seller endpoints, the escrow contract, or the UI yet.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install --offline` | exit 0 (tsx linked from the store) |
| `pnpm typecheck` | exit 0, all workspaces Done |
| `pnpm test` | exit 0, 11 files / 138 tests passed (35 new: record round trips and rejections, key derivation vs raw keccak, proofs for every index for 1..20 leaves incl. the odd-level case, sample verification and failure reasons, detected swapped chunk, detected wrong-source and stale records, vector regeneration byte-identical and fixture copy identical) |
| `pnpm --filter @overflow/recourse-crypto vectors` twice | identical files, `git status` clean for both JSON files |
| CLI smoke (records -> commit -> encrypt -> sample -> decrypt -> prove) | plaintext round trip `cmp` identical; single-chunk decrypt with a revealed `k_i` matches |

### Open issues
- Engineer B: `OverflowEscrow` must either store `chunkCount` or enforce `cipherProof.length == plainProof.length` in `complainMismatch` (see caveat above), and should add a Foundry test that replays `contracts/test/fixtures/recourse-vectors.json`.
- Plain leaves of short CSV rows are low-entropy; a published leaf list is brute-forceable. Acceptable for synthetic demo data; note in limitations.

## 2026-10-24: `@overflow/recourse-crypto` domain-separated, shape-pinned Merkle proofs

### Built
- `hashLeaf(chunk) = keccak256(0x00 || chunk)` and rejects any chunk that is not exactly 160 bytes; `hashPair(l, r) = keccak256(0x01 || l || r)`. `LEAF_PREFIX`/`NODE_PREFIX` exported.
- `expectedProofLength(index, chunkCount)` for the odd-node carry-up tree; `verifyProof({ root, leaf, index, proof, chunkCount })` now requires `chunkCount`, rejects `index >= chunkCount`, and rejects any proof whose length differs from the expected one. `computeRootFromProof(leaf, index, proof, chunkCount)` walks the known shape; the shape-inferring verifier from the previous entry is gone.
- `verifySample` requires `chunkCount`; `verifyCiphertext`/`verifyPlainLeaves` take `chunkCount` and require exactly that many entries. `leafCount` renamed to `chunkCount` everywhere, including the vectors JSON.
- Vectors regenerated (`test/vectors.json`, `contracts/test/fixtures/recourse-vectors.json`): all leaves, roots and proofs changed; keys, ciphertext and signatures did not. README Merkle section rewritten with pseudo-Solidity for `expectedProofLength` and `verify`.

### Design choices
- Two independent defenses: the `0x00`/`0x01` prefixes keep leaf and node hashes in separate domains, and the pinned proof length means a shorter proof presenting an internal node as a leaf is rejected before any hashing. The attack test in `merkle.test.ts` is kept and now asserts failure.
- The escrow must read `chunkCount` from its own stored terms or committed manifest, never from the complainant's calldata.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0, 8 workspaces Done |
| `pnpm test` | exit 0, 11 files / 139 tests passed (includes the second-preimage attack now failing, 160-byte rejection, expectedProofLength == getProof length for 1..40 leaves) |
| `pnpm --filter @overflow/recourse-crypto vectors` twice | identical; fixture copy byte-identical (`cmp`) |

### Open issues
- Engineer B: `OverflowEscrow` needs `chunkCount` in storage (OrderTerms or manifest-bound) to call `verify`; the README pseudo-Solidity is the reference. Replay `contracts/test/fixtures/recourse-vectors.json` in a Foundry test.

## 2026-10-24: `@overflow/payment-client` x402 quote checks and EIP-3009 signing

### Built
- `src/x402.ts`: x402 **v2** wire format from github.com/x402-foundation/x402 (`specs/x402-specification-v2.md`, `specs/transports-v2/http.md`, `specs/schemes/exact/scheme_exact_evm.md`). Header names `PAYMENT-REQUIRED` (server -> client, base64 JSON `PaymentRequired`), `PAYMENT-SIGNATURE` (client -> server, base64 JSON `PaymentPayload`), `PAYMENT-RESPONSE` (base64 JSON `SettlementResponse`). Zod schemas for `PaymentRequirements { scheme, network (CAIP-2), amount, asset, payTo, maxTimeoutSeconds, extra }`, `PaymentRequired { x402Version: 2, error?, resource, accepts[], extensions? }`, `PaymentPayload { x402Version: 2, resource?, accepted, payload: { signature, authorization } }`, and `SettlementResponse`. `parsePaymentRequired(response)` reads the header only (bodies are a server concern per the transport spec), `parsePaymentPayload`, `parsePaymentResponse` (null when absent, throws when malformed).
- `src/token-domain.ts`: `verifyTokenDomain(publicClient)` reads `name()`, `version()`, `decimals()`, `DOMAIN_SEPARATOR()` (and `getChainId()` when available) and throws `TokenDomainMismatchError` listing every field that is not `USDC` / `2` / `6` / the separator computed for `{USDC, 2, 84532, token}`.
- `src/quote.ts`: `checkQuote(requirements, order, { approvedDirectSellers })` in this order: scheme `exact`; network `eip155:84532`; `order.tokenAddress` and `asset` == USDC; `payTo` == `order.escrowAddress`, or an approved direct seller that is also `order.sellerAddress`; `amount` == `order.amountAtomic` as integers (not `<=`); `extra.name`/`extra.version` == `USDC`/`2`; `extra.assetTransferMethod` absent or `eip3009`. Any failure throws `QuoteMismatchError { field, expected, actual }`. Returns a branded `CheckedQuote`. `selectRequirements(paymentRequired)` picks the `accepts[]` entry we can pay.
- `src/authorization.ts` (ported from `reference/leash/packages/leash-client`): `buildAuthorization` with `validAfter = now - 5` (USDC requires `block.timestamp > validAfter` strictly), `validBefore = now + min(ttl, reservationWindow)` (default window 600 s from the spec), random 32-byte nonce, `from` = the treasury. `authorizationDigest` (viem `hashTypedData`), `authorizationStructHash`, `authorizationDigestFromSeparator`, `isAuthorizationLive` (mirrors FiatTokenV2's two strict checks). `signTransfer({ nodeAccount, treasury, to, value, ttlSeconds, ... })` refuses when the node key is the treasury or the domain is not USDC v2 on 84532, signs, and verifies the signature recovers to the node key before returning `{ authorization, authorizationJson, typedData, digest, signature, signer }`. `NodeSigner` is structural (`{ address, signTypedData }`) so a CDP server wallet can replace a viem `LocalAccount`.
- `src/header.ts`: `buildPaymentPayload({ accepted, resource, signed })` (refuses if `accepted` disagrees with what was signed) and `buildPaymentHeader(payload)` -> `{ name: "PAYMENT-SIGNATURE", value }`.
- `src/fetch.ts`: `wrapFetch(fetch, { nodeAccount, treasury, adapter, domain?, reservationWindowSeconds?, now? })`. Non-402 passes through. For a 402: parse, `selectRequirements`, `adapter.resolveOrder` (null -> return the 402 unpaid), `checkQuote` (throws before any signing), sign, `adapter.onAuthorized` (persist the digest **before** the paid request), exactly one paid request, `adapter.onPaymentResult` with the decoded `PAYMENT-RESPONSE`. A transport failure after sending throws `PaymentOutcomeUnknownError(digest)`; nothing in this package retries.
- `src/golden.ts` + `scripts/gen-golden.ts` (`pnpm --filter @overflow/payment-client golden`): fixed SIMULATED vector (treasury `0x1111...`, to `0x2222...`, 20000 atomic, validAfter 1791700000, validBefore 1791700120, nonce `keccak256("overflow.golden.nonce")`, test key `keccak256("overflow.golden.key")`) written to `packages/payment-client/test/golden.json` and `contracts/test/fixtures/payment-client-golden.json`. Digest `0xb2d39a5bf926c7a6e8c9447445a9b38006b415db638e540792757a03b40e2dc8`, pinned on both sides.
- `contracts/test/PaymentClientGolden.t.sol`: recomputes the USDC domain separator, the struct hash and the digest in Solidity, asserts the pinned constant, replays the JSON fixture (`vm.parseJson*`), and checks `vm.sign` produces the identical signature (RFC 6979) that `ecrecover`s to the fixture signer. `foundry.toml` gained `fs_permissions = [{ access = "read", path = "./test/fixtures" }]`.
- `scripts/settle-live.ts` (`pnpm --filter @overflow/payment-client settle:live -- --to 0x... [--amount 10000] [--dry-run] [--treasury 0x...]`): loads the repo `.env`, verifies the live USDC domain, signs with `AGENT_KEYS[0]`, then (unless `--dry-run`) simulates and sends `treasury.settle()` with `RELAYER_PRIVATE_KEY`, decodes the `Paid` event, and confirms on chain via `USDC.authorizationState(treasury, nonce)` and the payee balance delta. Custom treasury reverts are decoded by name. The treasury ABI is the spec's signature; adjust if Engineer B's contract differs.

### Design choices
- Header-only 402 decoding (no body fallback), matching the x402 TS reference client for v2.
- `amount` must equal the order exactly; `extra.assetTransferMethod` other than `eip3009` (Permit2, ERC-7710) is refused because the treasury only understands `transferWithAuthorization`.
- Direct (non-escrow) payees need two things: the owner's allowlist passed as `approvedDirectSellers`, and equality with `order.sellerAddress`. The treasury enforces its own allowlist on chain; this is the offchain pre-check.
- `wrapFetch` never retries the paid request and reports the outcome through `adapter.onPaymentResult`; reconciliation belongs to the service's `reconcilePayment` (P7.2). Request bodies must be re-readable.
- Optional wire fields use `z.preprocess(dropNull, ...optional())` so explicit `null` from other implementations is accepted and the TypeScript output keys stay optional.

### Stubbed or simulated
- `test-fixtures.ts` orders, sellers and the golden key are SIMULATED and labeled.
- No `PaymentAdapter` implementation yet (`OverflowFacilitatorAdapter` / `CoinbaseFacilitatorAdapter` are P7.x); `wrapFetch` takes the small `PaymentFetchAdapter` hook interface they will implement.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0, 8 workspaces Done |
| `pnpm test` | exit 0, 18 files / 198 tests passed (59 new: every `checkQuote` failure incl. one-atomic-unit deltas and lowercase addresses, spec example headers decoded byte-for-byte, strict `validAfter`/`validBefore` boundaries, reservation-window cap, nonce uniqueness, from = treasury, refusals, digest == manual `0x1901` construction, golden vector regeneration byte-identical, `wrapFetch` single paid attempt / no second request on mismatch / unknown-outcome path) |
| `forge test` | 5 passed, 0 failed (3 new in `PaymentClientGoldenTest`: typehash + domain, pinned digest, fixture digest and signature) |
| `settle:live --dry-run` against `https://sepolia.base.org` with a throwaway key | live USDC returned `USDC`, `2`, `6`, separator `0x71f17a3b...9818` (matches pinned); signed authorization with `from` = treasury, signer = node key |

### Open issues
- **`settle()` on Base Sepolia not run.** No `OverflowTreasury` is deployed yet (`contracts/src` is empty on this branch and `main`; no `deployments/base-sepolia.json`), and the local `.env` has no RPC URL or keys. Once Engineer B deploys and registers a node key from `AGENT_KEYS`, run `pnpm --filter @overflow/payment-client settle:live -- --to <allowlisted payee>` and paste the Basescan link here.
- `PaymentFetchAdapter.resolveOrder` is where the service must map a 402 to a `PurchaseOrder` in `RESERVED`; the state transitions themselves are not in this package.

## 2026-10-24: `@overflow/database` schema, migrations, repositories

### Built
- `packages/schemas/src/tables.ts`: row schemas for every table that lacked one: `OrganizationSchema`, `AgentRecordSchema`, `MissionRecordSchema`, `ResourceRequestRecordSchema`, `ResourceRecordSchema`, `PurchaseGroupSchema`, `AllocationRecordSchema`, `PurchaseRecordSchema` (= `PurchaseOrderSchema` + `idempotencyKey`, `purchaseGroupId`, `oracleReason`, `updatedAt`, keeps the allocation-sum refinement), `ChainTransactionSchema`, `EscrowOrderSchema` + `ESCROW_STATUSES`/`ESCROW_TRANSITIONS`, `FinancialEntrySchema` (debit account != credit account), `ReservationRecordSchema`, `SampleRecordSchema`, `SellerHistorySchema`. `ActivityEventSchema`, `ExceptionRecordSchema`, `ControllerRequestSchema` are used as-is.
- `packages/database/src/schema.ts`: 17 Drizzle `pg-core` tables (`organizations`, `missions`, `agents`, `resource_requests`, `resources`, `purchase_groups`, `allocations`, `purchases`, `chain_transactions`, `escrow_orders`, `financial_entries`, `activity_events`, `reservations`, `samples`, `seller_history`, `exceptions`, `controller_requests`). Every money column is `numeric(78,0)` read as a decimal string with a `>= 0` check; no `real`/`double precision` anywhere. `pgEnum` for purchase and escrow status; other statuses are text validated by Zod at the boundary.
- Constraints: `purchases.idempotency_key` UNIQUE; partial unique index `purchases_active_mission_resource_uidx ON (mission_id, resource_id) WHERE status NOT IN (<TERMINAL_STATUSES>)`; `chain_transactions (tx_hash, log_index)` UNIQUE; `financial_entries.source_event_id` UNIQUE NOT NULL with `debit_account`, `credit_account`, `amount`, `memo` NOT NULL, `purchase_id` FK and a `debit_account <> credit_account` check; `reservations.digest` UNIQUE; `escrow_orders.purchase_id` and `escrow_address` UNIQUE; FKs between every related pair.
- `drizzle/0000_init.sql` + `meta/` generated by `drizzle-kit generate` (committed). `pnpm --filter @overflow/database db:generate` reports "No schema changes" against the committed migration.
- `src/client.ts`: `createDatabase()` picks the `postgres` driver when `DATABASE_URL` is set, otherwise PGlite (`PGLITE_DATA_DIR`, or in-memory). Returns `{ db, dialect, migrate, close }`; `selectDialect()` is exported and unit-tested. `migrate()` applies the same `drizzle/` folder on either driver.
- `src/errors.ts`: `UniqueViolationError` (SQLSTATE 23505, constraint name recovered from `constraint_name`/`constraint`/message, through Drizzle's `cause` chain), `NotFoundError`, `isUniqueViolation`, `withDbErrors`.
- `src/repositories/*`: one typed repository per table, `createRepositories(db)` bundles them. Every function validates input with the row schema and parses output through it before returning. Notable: `purchases.create` is idempotent on `idempotencyKey` (`onConflictDoNothing` then re-read) and surfaces a (mission, resource) collision as `UniqueViolationError` naming the partial index; `purchases.transition` locks the row (`FOR UPDATE`) and uses `assertTransition` from schemas; `chainTransactions.record` is idempotent on (tx_hash, log_index) and reports `inserted: false` on replay; `financialEntries.post` is strict (duplicate source event throws) and `balance()` sums with `bigint`; `escrowOrders.setStatus` follows `ESCROW_TRANSITIONS`; `sellerHistory.upsertIncrement` adds counters atomically in SQL; `controllerRequests.resolve("executed")` requires the confirmed `txHash`.
- `src/seed.ts` + `scripts/seed.ts`, `scripts/migrate.ts`: one SIMULATED organization (`COMPANY_NAME`, default "Larkspur Research Partners", `simulated: true`), departments `research` and `finance`, three agents (orchestrator, research analyst, finance analyst) with labeled placeholder keys. Idempotent (fixed ids).
- `.env.example`: added `PGLITE_DATA_DIR` and `COMPANY_NAME`.

### Design choices
- **PGlite instead of SQLite as the no-server fallback.** No Postgres or Docker is installed on this machine, so the prompt's "SQLite behind the same Drizzle interface" clause applied. PGlite is in-process Postgres (WASM): the same `pg-core` schema, the same migration SQL, partial unique indexes, `numeric(78,0)`, `FOR UPDATE` and `jsonb` all run unchanged, so there is exactly one schema definition. A SQLite fallback would have needed a second `sqlite-core` schema and lost the partial index. The selected dialect is logged at startup and returned from `createDatabase`; nothing falls back silently.
- `financial_entries` is the per-row form the prompt specifies (`debit_account`, `credit_account`, `amount`, `memo`, `source_event_id`). `JournalEntrySchema` (multi-line) stays in schemas as the presentation form. `source_event_id` is required and unique for every row: chain-derived entries use the `chain_transactions.id`, corrections and funding entries use a synthetic id, so "every event books exactly once" is enforced by the database.
- Partial-index predicate is rendered from `TERMINAL_STATUSES` as SQL literals (`sql.raw`); drizzle-kit cannot inline bound parameters into an index `WHERE`. The statuses are a fixed enum, not user input.
- Timestamps are `timestamptz` with Drizzle `mode: "date"`; repositories convert to ISO strings so `IsoDateTimeSchema` accepts them (Drizzle's string mode emits a space-separated format Zod rejects).
- `samples.confidence` (a model score, not money) is stored as text and parsed to a number on read, so an audit for float columns finds none.
- Per-package `vitest run` inherits the root `projects` config and fails on path resolution; run tests from the root (`pnpm test` or `pnpm vitest run packages/database`).

### Stubbed or simulated
- The seed company, its departments and the three agent keys are SIMULATED placeholders (`0x…0A01/0A02/0A03`); the service must replace keys when real nodes are created.
- No service code uses the repositories yet; the service only imports the package for typecheck/bundle.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | exit 0, 24 files / 228 tests passed (database: 5 files / 26 tests; schemas: 6 files / 107 tests) |
| `pnpm typecheck` | exit 0, all workspaces Done |
| `pnpm --filter @overflow/database db:generate` | "No schema changes, nothing to migrate" |
| `PGLITE_DATA_DIR=<scratch> pnpm --filter @overflow/database db:migrate` | `dialect=pglite`, "migrations applied" |
| `... db:seed` twice | both runs: `seeded organization "Larkspur Research Partners" (SIMULATED) departments=research,finance agents=3`; second run added nothing |
| `pnpm --filter @overflow/service build` | tsup ESM build success (PGlite does not break the bundle) |
| duplicate purchase | same `idempotencyKey` returns the same row; new key for an active (mission, resource) throws `UniqueViolationError("purchases_active_mission_resource_uidx")`; after `REJECTED`, a new active purchase is accepted |
| duplicate event | `chainTransactions.record` replay returns `inserted: false`; raw duplicate insert violates `chain_transactions_tx_hash_log_index_unique`; duplicate `financialEntries.post` throws `UniqueViolationError("financial_entries_source_event_id_unique")` |

### Open issues
- No real Postgres server was exercised here; the `postgres-js` branch of `createDatabase` is covered only by the dialect-selection unit test. Run `DATABASE_URL=... pnpm --filter @overflow/database db:migrate` against a server before the demo.
- ~~`DEFAULT_MIGRATIONS_FOLDER` resolves relative to the package source; a bundled service must set `OVERFLOW_MIGRATIONS_DIR`.~~ Fixed below (same day).
- Enum changes (`purchase_status`, `escrow_status`) need a new migration; text statuses do not.

## 2026-10-24: bundled service finds its migrations

### Built
- `apps/service/tsup.config.ts` copies `packages/database/drizzle` to `dist/drizzle` after every build (`onSuccess`). `pnpm --filter @overflow/service start` is now `OVERFLOW_MIGRATIONS_DIR=dist/drizzle node dist/index.js`, so the bundle needs no manual setup.
- `apps/service/src/index.ts` opens the database with `createDatabase()`, applies migrations before listening, reports `{ dialect, migrationsFolder, migrated: true }` in its status JSON (real state, not a flag), and closes the database on SIGINT/SIGTERM.
- `createDatabase` resolves the folder to an absolute path, exposes it as `handle.migrationsFolder`, and fails fast with `no migrations found at <path> (set OVERFLOW_MIGRATIONS_DIR ...)` when `meta/_journal.json` is missing, instead of letting the migrator throw a less specific error.
- `apps/service/package.json` now lists `@electric-sql/pglite`, `drizzle-orm` and `postgres` directly: tsup bundles `@overflow/database` but leaves the drivers external, and pnpm's strict `node_modules` only resolves them for packages that declare them.
- `.env.example`: `OVERFLOW_MIGRATIONS_DIR` documented (empty = default `packages/database/drizzle`; built service uses `dist/drizzle`).

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/service build` | tsup success, `copied packages/database/drizzle -> dist/drizzle`; `dist/drizzle/{0000_init.sql,meta/_journal.json,meta/0000_snapshot.json}` present |
| `PGLITE_DATA_DIR=<fresh dir> pnpm --filter @overflow/service start` | logs `dialect=pglite`, `migrations applied (dialect=pglite, from .../apps/service/dist/drizzle)`, listens; `GET /` returns `database: { dialect: "pglite", migrationsFolder: ".../apps/service/dist/drizzle", migrated: true }`; the directory is populated with a PGlite cluster |
| `node dist/index.js` with `OVERFLOW_MIGRATIONS_DIR` unset | exits 1 with `no migrations found at .../apps/service/drizzle (set OVERFLOW_MIGRATIONS_DIR to the drizzle/ folder)` |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 228 passed |

### Open issues
- `pnpm start` sets the variable with POSIX `VAR=value cmd` syntax; on Windows use `cross-env` or set it in the shell.
- Still no real Postgres server exercised; see the previous section.

## 2026-10-24: REST API and purchase state machine

### Built
- `apps/service/src/orchestration/purchase-service.ts`: `createPurchaseService(db)` with `propose()` and `transition(purchaseId, to, evidence)`, the only code path that changes a purchase's status. One `db.transaction` per call: load, `assertTransition` (schemas), evidence rules, `purchases.transition`, store the digest / append the tx hash the evidence carries, write exactly one `activity_events` row whose message is `"<from> -> <to>: <reason> [<source.kind>:<source.reference>]"`. `TransitionEvidenceSchema` = `{ reason, source: { kind: api|adapter|chain|reconciliation|seller|oracle, reference }, txHash?, authorizationDigest?, decodedRevert?, agentId?, simulated }`. Event kinds: `RESERVED`/`PAYMENT_PENDING` → `payment.authorized`, `ESCROW_FUNDED` → `escrow.funded`, `SETTLED` → `escrow.settled`, `REFUNDED` → `escrow.refunded`, `REJECTED` → `policy.blocked`, else `purchase.status`.
- Evidence rules (each refused with `TransitionEvidenceError`, nothing written): `ESCROW_FUNDED`/`SETTLED`/`REFUNDED` need a `txHash` and a `chain` or `reconciliation` source; `REJECTED` needs `decodedRevert`; `PAYMENT_PENDING` needs `authorizationDigest`; leaving `PAYMENT_UNKNOWN` needs a `reconciliation` source.
- `apps/service/src/api/` (Hono 4.13.13 + `@hono/node-server` 2.1.5, both already in the lockfile): `POST /api/missions`, `POST /api/missions/:id/plan`, `GET /api/resources`, `POST /api/purchases/propose`, `POST /api/purchases/:id/authorize`, `GET /api/purchases/:id`, `GET /api/escrow/:id` (purchase id or escrow address), `GET /api/agents` (nested tree, `node: null` until the chain module fills it), `POST /api/agents/:id/pause`, `GET /api/activity`, `GET /api/ledger`, `GET /api/reconciliation`. Every body, query and param is Zod-parsed; every 2xx is parsed through its response schema before sending (`respond()`), so a shape drift is a 500 and never a wrong 200. One error envelope `{ error: { code, message, details?, requestId } }`; 400 validation, 404, 409 (`invalid_transition {from,to}`, `missing_evidence`, `quote_mismatch {field,expected,actual}`, `active_purchase_exists`, `no_root_node`, `no_node_yet`), 422 `idempotency_key_reused`, 501 `not_wired`.
- `api/ports.ts`: `OrchestrationPort` (plan, propose; P4.1/P4.2), `PaymentAdapter` (spec's four methods plus `path`; `preparePayment` takes the branded `CheckedQuote`, so an adapter cannot sign an unchecked quote; P7.x), `PolicyPort.allowlistedPayees()` (chain), `ReconciliationPort.latest()` (P4.4). `defaultPorts()` throws `NotWiredError` → HTTP 501 naming the port and the prompt it lands in. No default returns success.
- Authorize flow: `Idempotency-Key` required → load order (must be `PROPOSED`) and resource → adapter for `order.paymentPath` (501 if none) → `adapter.getPaymentRequirements` → `checkQuote` (payment-client) with the policy port's allowlist → on mismatch `FAILED_BEFORE_FUNDING` with the reason, 409, nothing signed → `preparePayment` → `RESERVED` (digest, reserve tx if any) → `PAYMENT_PENDING` **before** `submitPayment` → `rejected` → `REJECTED` + `decodedRevert`; `unknown` → `PAYMENT_UNKNOWN`; `submitted` → tx hash appended only. The route never sets `ESCROW_FUNDED`; that needs a confirmed chain event through the indexer.
- Idempotency: `packages/database` gained `idempotency_keys` (`key` PK, `scope`, `request_hash`, `status_code`, `response jsonb`, `created_at`), migration `0001_idempotency_keys`, `IdempotencyRecordSchema`, repository `put()` (insert-if-absent, returns `{ inserted, row }`) / `get()`. `api/idempotency.ts` hashes the canonical `{scope, method, path, body}` (a cache key, not signed material) and replays the stored status and body on a repeat; same key with a different request → 422; the response carries `replayed: true|false`.
- `POST /api/agents/:id/pause` inserts a `ControllerRequest { kind: "pause", nodeId }` (`requestedBy` = session principal), writes `controller.requested`, returns 202. 409 when the agent has no onchain node. There is no paused column, flag or cache anywhere; the treasury's `NodePaused` event is the only source.
- `api/session.ts`: one demo session `{ organizationId: OVERFLOW_ORG_ID ?? "org-demo", principal: "owner", ownerAddress: OWNER_ADDRESS | null }`, no credentials; every query is scoped to the organization. Owner actions only create controller requests whose `txHash` is set after the Coinbase Wallet approval confirms (P4.5).
- `apps/service/src/index.ts`: migrate → idempotent `seed()` (logs the SIMULATED company) → `createApp` → `serve()`. `GET /` keeps the status JSON (`scaffold: false`, real module states). CORS allows `content-type` and `idempotency-key`.
- `.env.example`: `OVERFLOW_ORG_ID`.

### Design choices
- Hono over Express: `app.request()` lets the route tests run without a port, and both packages were already in the lockfile via `@modelcontextprotocol/sdk`, so no new network dependency.
- The API never fakes a result for a port that is not built: 501 `not_wired` with the prompt number. `GET /api/reconciliation` returns 200 with `lastRun: null` and a note, because the UI polls it.
- Quote mismatch ends the purchase (`FAILED_BEFORE_FUNDING`) rather than leaving it `PROPOSED`; the partial unique index then allows a fresh proposal for the same resource. Agreed with the user.
- Idempotency results live in the database, not memory, so a repeat after a restart still replays the original result instead of hitting the state machine's 409.
- There is no `/api/execute`, and no route accepts calldata, ABI data or raw transactions; the test asserts `/api/execute` is 404.

### Stubbed or simulated
- Oracle/Fusion (`plan`, `propose`), payment adapters, the policy allowlist reader and the reconciliation job are ports with 501 / empty defaults. The route tests use a labeled SIMULATED fake adapter.
- `GET /api/agents` returns offchain records only; `node` is `null` (no fabricated cap/spent/paused).
- Seeded agent keys are still the SIMULATED placeholders; `POST /api/missions` without `rootNodeId` answers 409 until the orchestrator node exists onchain.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/database db:generate` | "No schema changes, nothing to migrate" after `0001_idempotency_keys` |
| `pnpm typecheck` | exit 0, all workspaces Done |
| `pnpm test` | exit 0, 27 files / 253 tests passed (service: 2 files / 22 tests: validation 400s, non-JSON body, mission create + `no_root_node`, 501 for plan/propose, reconciliation `lastRun: null`, reads, `/api/execute` 404, missing key 400, authorize once + replay with adapter called once, reused key 422, second key 409 `{from: PAYMENT_PENDING, to: RESERVED}`, REJECTED purchase 409 with no new event, attacker `payTo` → `quote_mismatch` + `FAILED_BEFORE_FUNDING` + adapter never signs, no adapter → 501 and status unchanged, pause 409/202 with pending request and no "paused" anywhere; PurchaseService: propose event, legal move, illegal move writes nothing, evidence rules, decoded revert, duplicate active purchase; database: idempotency put/get/first-wins, 18 tables) |
| `pnpm --filter @overflow/service build` | tsup ESM success; migrations copied |
| `PGLITE_DATA_DIR=<scratch> tsx src/index.ts` + curl | `GET /` `scaffold: false`, `api: "ready"`; `GET /api/agents` 3 seeded agents; pause → 409 `no_node_yet`; `POST /api/execute` → 404; `POST /api/missions` → 201; `POST /api/purchases/propose` → 501 `not_wired (lands in P4.2)`; `GET /api/reconciliation` → `lastRun: null` with note |

### Open issues
- `GET /events` (SSE) from the spec's API table belongs to the facilitator module and is not here.
- The `PaymentAdapter` signatures (`preparePayment(purchaseId, CheckedQuote)`, `submitPayment` outcome union) are the contract P7.x must implement; the chain indexer must drive `ESCROW_FUNDED`/`SETTLED`/`REFUNDED` through `PurchaseService.transition` with `source.kind: "chain"` and the tx hash.
- `GET /api/resources?missionId=` is accepted but not yet filtered by Oracle's coverage check (`filtered: false` says so).
- No authentication on the demo session; fine on localhost, not for exposure.

## 2026-10-24: chain event indexer and SSE stream

### Built
- `apps/service/src/chain/abi.ts`: **provisional** human-readable ABI (viem `parseAbi`) for the treasury (nine events, sixteen errors), the factory (`OrderCreated`) and the escrow (`OrderFunded`, `KeyRevealed`, `Accepted`, `PaidOut`, `Refunded(orderId, amount, reason)`, `CheatProven(seller, index)`). The six Leash-era treasury events are copied from `origin/person1:contracts/src/IOverflowTreasury.sol`; `Reserved`, `ReservationReleased`, `EscrowFactorySet` and every factory/escrow event are derived from the spec because no Solidity for them exists on any branch. `abi.test.ts` snapshots every signature; `REVERT_REASONS` carries the spec's Blocked-lane wording.
- `chain/config.ts`: `resolveIndexerConfig()` = `BASE_SEPOLIA_RPC_URL` + `loadDeployments()` (`deployments/base-sepolia.json`, override `OVERFLOW_DEPLOYMENTS_PATH`) + `INDEXER_POLL_MS` (2000) / `INDEXER_REORG_DEPTH` (12) / `INDEXER_CHUNK_BLOCKS` (190, the public RPC's `eth_getLogs` range cap). Returns `{ ok:false, reason }` instead of inventing anything.
- `chain/client.ts`: `LogSource` structural interface + `createLogSource(rpcUrl)` (viem, `assertChain()` checks 84532). `chain/decode.ts`: `decodeLog` (bigints → decimal strings), `decodeTreasuryRevert` (viem cause chain, raw data, Solidity `Error(string)`/`Panic`, fallback `Unknown("<short message>")`).
- `chain/indexer.ts`: `createIndexer({ db, source, config, bus })` with `start/stop/tick/status`. Each poll re-reads from `max(deployBlock, cursor + 1 − reorgDepth)` to head in chunks; an `OrderCreated` inside a chunk re-queries that chunk for the new escrow; every log is one transaction: `chainTransactions.record` (idempotent on `(tx_hash, log_index)`; replay → no effects) then the handler in a savepoint (a state-machine refusal keeps the chain row, warns, writes nothing else). Stored logs the chain no longer returns in the window get `confirmed=false` + an `indexer.unconfirmed` event; reappearing ones are re-confirmed. Cursor `indexer:base-sepolia` in the new `indexer_cursors` table (migration `0002_indexer_cursors`, plus indexes on `purchases.order_id_bytes32`/`escrow_address` and `chain_transactions.block_number`/`event_name`). Escrows are reloaded from stored `OrderCreated` rows on restart.
- `chain/handlers.ts`: `OrderFunded → ESCROW_FUNDED`, `KeyRevealed → DELIVERY_PENDING`, `PaidOut → SETTLED`, `Refunded → REFUNDED`, `ReservationReleased(budgetRestored) → RELEASED`, all through `PurchaseService.transition` with `source.kind: "chain"` (`reconciliation` only when leaving `PAYMENT_UNKNOWN`) and the tx hash; the escrow mirror moves in the same call (`evidence.escrow`). `Paid` and `Reserved` only link and record (authorization ≠ funding ≠ settlement). `NodeCreated` sets `agents.nodeId` by key; `KeyRevealed` scores on-time/late reveals; `CheatProven` flags the seller. Unmatched escrow events are recorded and labeled "no matching purchase".
- `orchestration/purchase-service.ts`: accepts an `Executor` (joins the indexer's transaction), `evidence.escrow { status, revealedKey?, refundReason? }` applied via `escrowOrders.setStatus` when a row exists, and a `publish` hook called after commit. `chain/failed.ts`: `recordFailedTransaction()` → decoded revert, `REJECTED` through the service when a live purchase is named, else a standalone `policy.blocked` event with `decodedRevert`/`txHash`.
- `chain/bus.ts` + `api/routes/events.ts`: in-process `ActivityBus`; `GET /events` (Hono `streamSSE`) sends `event: indexer` (real status), replays history (`Last-Event-ID` → `activityEvents.listAfter`, `?since=` → `listSince`, else last `replay` events), then live committed events with `id:` = event id; 15 s heartbeat; unsubscribes on abort. `GET /` now includes `indexer` and `modules.chain`.
- Repositories added: `indexerCursors.get/set`, `purchases.listByOrderId/listByEscrowAddress/getByAuthorizationDigest`, `chainTransactions.listByEvent/listInBlockRange/setConfirmed/setPurchaseId`, `activityEvents.listAfter/listSince`; `agents.getByKey` is case-insensitive. `ActivityKind` gains `treasury.*`, `escrow.created/revealed/accepted`, `seller.flagged`, `indexer.unconfirmed`. `InvalidEscrowTransitionError` → HTTP 409.
- `chain/fixtures/build-fixture.ts` → `base-sepolia-logs.json`: SIMULATED recorded log set (18 logs, blocks 101–111) encoded from the provisional ABI with the service test addresses. `chain/fake-source.ts`: test `LogSource`.

### Design choices
- Per-log transaction with the handler in a savepoint: the ledger's "one row per event" and the state machine's refusals never fight; a refused `PaidOut` for a never-funded purchase leaves the chain row and the purchase status untouched.
- `confirmed` is now truthful (reorg withdraws it) instead of a constant `true`.
- No `financial_entries` are posted here (ledger prompt); `controller_requests` are not resolved from `NodePaused`/`CapRaised` (P4.5).

### Stubbed or simulated
- The ABI is provisional until the contracts land; the fixture is encoded, not recorded from a deployment (its JSON says `simulated: true`).
- No deployments file or deployed contract exists, so the indexer runs idle on this machine.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/database db:generate` | wrote `0002_indexer_cursors`; re-run "No schema changes" |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 32 files / 270 tests passed (new: abi 3, decode 5, indexer 4, failed 2, events 3; database migrations test now expects 19 tables) |
| indexer fixture replay | 18 logs → 18 `chain_transactions`; p1 `PAYMENT_PENDING → SETTLED` (escrow `Settled`, key `0x…77`), p2 `→ REFUNDED` (escrow `Refunded`, reason "timeout: no reveal before deadline"), p3 stays `PROPOSED` with its `PaidOut` recorded and refused; reservation `d2` released; `agent-orchestrator.nodeId = 1`; seller `onTimeReveals 1, provenCheats 1, flagged`; cursor 115; 3 escrows tracked; the chunk 100–104 was re-queried for escrow 1 |
| restart | second indexer on the same DB: `fromBlock 104`, 0 inserted, 0 new activity, 3 escrows rediscovered |
| reorg | dropping `NodePaused` (block 110) → `confirmed=false` + one `indexer.unconfirmed`; restoring it → re-confirmed, 0 inserted |
| `GET /events` | `indexer` frame, replayed `purchase.proposed`, live `payment.authorized` from a real `transition()`; `Last-Event-ID` replays one later event; `?since=yesterday` → 400; listener count 0 after abort |
| `tsx src/index.ts` (PGlite, no RPC) + curl | `GET /` → `modules.chain: "idle: BASE_SEPOLIA_RPC_URL is not set"`, `indexer.state: "idle"`; `curl -N /events` → `event: indexer` idle frame |
| `resolveIndexerConfig` with RPC set, no file | `ok:false, reason: "deployments file not found at …/deployments/base-sepolia.json …"` |
| `createLogSource("https://sepolia.base.org")` probe | `assertChain` ok, head 49873975, 7 USDC logs in the last 20 blocks, block timestamp read |
| `pnpm --filter @overflow/service build` | tsup success, migrations copied |

### Open issues
- **Live Base Sepolia check not run**: no Overflow contract is deployed and `deployments/base-sepolia.json` does not exist. Once person1 deploys: set `BASE_SEPOLIA_RPC_URL`, start the service, run `settle()`, watch `curl -N localhost:4000/events` for `treasury.paid`.
- The provisional event signatures (`Reserved`, `ReservationReleased`, `EscrowFactorySet`, factory and escrow events) must be matched by the contracts or edited in `chain/abi.ts` + `abi.test.ts`.
- Escrow-order rows are expected from the sellers/order prompt; without one, the purchase still moves and the indexer warns.
- `PolicyPort.allowlistedPayees()` could now read `AllowSet` rows; not wired.
