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
