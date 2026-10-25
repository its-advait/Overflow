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
