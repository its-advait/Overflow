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

## 2026-10-24: real USDC v2.2 harness

### Built
- `contracts/script/build-usdc-fixture.sh`: clones `circlefin/stablecoin-evm` at pinned commit `fc85788bc7c23cefe3df1a757133048bfddadeaa`, downloads the solc 0.6.12 release binary for the host (`solc-static-linux` on Linux, `solc-macos` on macOS), fetches `@openzeppelin/contracts@3.4.2` with `npm pack`, compiles `FiatTokenV2_2`, `FiatTokenProxy` and `SignatureChecker` with `--optimize --optimize-runs 10000000 --combined-json abi,bin,bin-runtime`, links `SignatureChecker` to `0x00000000000000000000000000000000005157c0`, and writes `contracts/test/fixtures/usdc-v2_2/{FiatTokenV2_2.linked.hex,FiatTokenProxy.hex,SignatureChecker.hex,README.md}`. Fixtures are committed; nobody else needs solc 0.6.12.
- `contracts/foundry.toml`: read-only `fs_permissions` for `./test/fixtures`.
- `contracts/test/usdc/UsdcV22.sol`: `IUSDC` interface and `UsdcV22` library (`deploy`, `deployFull`, `mint`, `transferWithAuthorizationDigest`). Deploys SignatureChecker from its creation code and etches the runtime at the linked address, deploys the implementation, deploys the proxy as `proxyAdmin` (prank), then runs `initialize("USDC","USDC","USD",6,owner...)`, `initializeV2("USDC")`, `initializeV2_1(owner)`, `initializeV2_2([], "USDC")` from the test contract and `configureMinter(owner, max)` as owner.
- `contracts/test/usdc/UsdcReal.t.sol`: 8 tests. name/version/decimals; `DOMAIN_SEPARATOR()` equals `keccak256(EIP712Domain typehash, "USDC", "2", chainid, usdc)`; mint; proxy admin cannot call through the proxy; **ERC-1271 caller proof**: a `CallerGatedWallet` that returns the magic value only when `msg.sender == expectedCaller`. With `expectedCaller = usdc proxy` the `transferWithAuthorization(..., bytes)` call succeeds; with `expectedCaller = implementation` it reverts `FiatTokenV2: invalid signature`; replay reverts `FiatTokenV2: authorization is used or canceled`.

### Deviations from the prompt, and why
- **solc binary on Apple Silicon.** The v0.6.12 release ships only x86_64 binaries and this machine has no Rosetta, so the script falls back to the official `solc@0.6.12` npm build (same compiler, Emscripten build) when the downloaded binary cannot execute. Native is still the primary path on Linux or Rosetta Macs. The fixtures README records which mode produced them.
- **"Wallet records msg.sender."** USDC's `SignatureChecker` reaches the signer with a `staticcall`, so storage writes and logs revert inside `isValidSignature`. The wallet instead gates on an expected caller, and the test includes a negative control, which is the same proof made observable.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `bash contracts/script/build-usdc-fixture.sh` | exit 0, solc `0.6.12+commit.27d51765.Emscripten.clang` (solc-js fallback) |
| Second run into a scratch dir, `cmp` each `.hex` | byte-identical; README identical |
| `grep -c '__\$' FiatTokenV2_2.linked.hex` | 0 (fully linked) |
| Compare with live Base Sepolia USDC implementation `0xd74cc5d436923b8ba2c179b4bca2841d8a52c5b5` (`cast code`, metadata stripped) | 23464-byte runtime identical except the two 20-byte SignatureChecker address slots (live: `0xba3b60c21e28c41df4babd90f228e1d368627da6`) |
| Live `name()/version()/DOMAIN_SEPARATOR()` on `0x036C…CF7e` | `USDC`, `2`, `0x71f17a3b…c9818` as in CLAUDE.md |
| `forge test --match-path 'test/usdc/*'` | 8 passed, 0 failed |
| `pnpm contracts:test` (full) | 10 passed (8 USDC + 2 scaffold) |

### Open issues
- The fixtures were produced with solc-js on this machine. A Linux or Rosetta teammate should run the script once to confirm the native binary yields the same SHA-256 (listed in the fixtures README). The live-bytecode comparison above already shows the compiled runtime matches Circle's deployment.
- `UsdcV22` is a test helper only; nothing in `src/` yet. The treasury's ERC-1271 gate tests will build on `deployFull` and `transferWithAuthorizationDigest`.

## 2026-10-24: OverflowTreasury core ported from Leash

### Built
- `contracts/src/IOverflowTreasury.sol`: Leash's `ILeashWallet` renamed. Same `Node`/`ChildParams` structs, 13 errors, 6 events, function list; `AUSD()` is now `TOKEN()`.
- `contracts/src/OverflowTreasury.sol`: `LeashWallet` ported line for line. Changes, and only these: `constructor(address token, address owner)`, immutables `TOKEN`/`owner`, delegation EIP-712 domain `{"Overflow", "1", chainId, this}`, and steps 3 to 6 of `settle()` factored into `internal _authorize(to, value, digest, signer) returns (id)` for P1.5's `reserve()`. `settle()` keeps the normative order (digest over USDC's `DOMAIN_SEPARATOR` with `from = this`; `ECDSA.recoverCalldata`; `UnknownAgent`; global allowlist; walk to root with Paused, Expired, OverPerCall, restricted `nodeAllow`, OverBudget, then charge; `BelowFloor`; `tstore` flag at `keccak256(abi.encode(APPROVAL_SALT, digest))`; bytes-signature `transferWithAuthorization`; `tstore 0`; `Paid`). `nonReentrant` via OpenZeppelin `ReentrancyGuardTransient`. `isValidSignature` is `view`, TLOAD only, `0x1626ba7e` iff `msg.sender == TOKEN` and the flag is set, ignores the signature bytes.
- `APPROVAL_SALT` is `keccak256("overflow.approval.v1")` and the slot encodes `(SALT, digest)` as the spec writes it (Leash used `(digest, SALT)`); no behavioral effect.
- Tests, all on Circle's compiled USDC v2.2 via `UsdcV22`: `contracts/test/unit/TreasuryBase.t.sol` (harness), `contracts/test/unit/OverflowTreasury.t.sol` (51 tests: the 44 ported Leash unit tests plus the new ones below), `contracts/test/adversarial/Adversarial.t.sol` (3 ported auditor tests).
- New tests required by the prompt: blacklisted payee reverts `Blacklistable: account is blacklisted` with no partial charge; gate closed outside `settle()` for USDC, the owner and an attacker, before and after a payment; the same signature straight to USDC reverts `FiatTokenV2: invalid signature`, then settles through the treasury, then cannot be replayed (`FiatTokenV2: authorization is used or canceled`); a restricted parent's child may only list allowed payees (and the grandchild is then blocked for others); owner `pause(2)` blocks the grandchild while the root still pays.
- `docs/contract-invariants.md`: T1 to T14 with enforcing code path and covering test; P1.5+ reservation/escrow invariants listed as pending.
- `contracts/.gas-snapshot` written by `forge snapshot` (63 entries).

### Not ported, on purpose
- `Golden.t.sol` (TypeScript golden vectors written to `packages/abi`): belongs with the `packages/payment-client` prompt and needs new pinned digests for the "Overflow" domain.
- `fork/AusdGate.t.sol`: the spec's `test/fork/UsdcGate.t.sol` against live Base Sepolia USDC is a separate item before gate G1.
- Spec items marked (new): `reserve()/release()`, `reservedTotal`, escrow-factory payees, `PayeeFlagged`, `setEscrowFactory`, `setReservationWindow`. P1.5.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build` | success; 16 forge-lint warnings in `OverflowTreasury.sol`, all heuristic (revert inside the ancestor walk, `Paid` after the token call, `block.timestamp` expiry comparisons, no zero-check in constructor, `setFloor` without event). All are the Leash design carried over; none changed. |
| `forge test` | 64 passed, 0 failed (2 scaffold, 8 USDC harness, 51 treasury unit, 3 adversarial) |
| `forge snapshot` | `.gas-snapshot` written; `test_depth1_root_pays` 315,391 gas whole-test |
| `forge test --gas-report` on `OverflowTreasuryTest` | `settle` min 38,081 / avg 116,752 / median 131,668 / max 225,817 over 50 calls (spec: re-measure vs ~144k on AUSD). `createChild` avg 182,891. |

### Open issues
- Forge lint warnings above are informational; if the team wants a clean `forge build`, add a `[lint]` exclusion in `foundry.toml` rather than reordering checks.
- `withdraw()` can take the balance below `floor` by design (owner action); invariant T4 states this.
- Invariant tests (`contracts/test/invariant/`) for T1, T2, T4, T5 are not written yet.
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

## 2026-10-24: deploy, verify, export addresses (tooling complete; live deploy NOT yet run)

### Built
- `contracts/script/Deploy.s.sol`: deploys `OverflowTreasury(TOKEN_ADDRESS, OWNER_ADDRESS)` on chain 84532 only; signer comes from the CLI (`--account <keystore>`), no key is read in Solidity. When `owner == deployer` it calls `createRoot(AGENT_ROOT_ADDRESS, ROOT_CAP, ROOT_MAX_PER_CALL, ROOT_EXPIRY)` (defaults 50 USDC, 15 USDC, now + 7 days); otherwise it prints the `createRoot` calldata for the controller's Coinbase Wallet. The escrow implementation/factory and `setEscrowFactory` do not exist yet (P1.5/P1.6); the script carries a marked hook and the export writes `null` for both.
- `scripts/` is a workspace package `@overflow/scripts` (tsx, viem, `@overflow/schemas`): `deploy.sh` (one command: `forge script --broadcast --verify` with `--account`/`--password-file`, `DRY_RUN=1` simulates with `--sender`, interactive password prompt if no password file, prints the `forge verify-contract` retry on failure, then exports), `export-deployment.ts` (reads `contracts/broadcast/Deploy.s.sol/84532/run-latest.json`, writes `packages/schemas/deployments/base-sepolia.json` with `{chainId, token, usdc, treasury, escrowFactory, escrowImplementation, owner, deployer, deployBlock, deployedAt, txs}`, generates `packages/schemas/src/abi/<Name>.ts` `as const` ABIs plus barrel and `src/deployments.ts`; `--abi-only` regenerates ABIs without a broadcast), `status.ts` (balance, owner, TOKEN, floor, nodeCount, per-node `remaining()`, exits non-zero if `TOKEN()` differs from the file), `dev-fund.ts` (DEV ONLY banner; checks the deployer's USDC balance, then `cast send transfer(...)` through the keystore so no key enters Node).
- Root scripts: `contracts:deploy`, `contracts:export`, `status`, `dev:fund`. `.env.example` gains `DEPLOYER_ACCOUNT`, `DEPLOYER_PASSWORD_FILE`, `DEPLOYER_ADDRESS`, `AGENT_ROOT_ADDRESS`, `ROOT_CAP`, `ROOT_MAX_PER_CALL`, `ROOT_EXPIRY`, `DRY_RUN`.
- `packages/schemas`: `DeploymentsSchema` extended as a superset of the P0.2 version (`token`, `owner`, `deployer`, `escrowImplementation`, nullable `escrowFactory`, `txs`; `usdc` and `txHashes` kept), `defaultDeploymentsPath()` now resolves to `packages/schemas/deployments/base-sepolia.json` (the prompt's path; the P0.2 test asserting the repo root was updated), new `./chain` subpath export so scripts can import chain facts before the generated `abi/` exists, `src/abi/OverflowTreasury.ts` (52 ABI entries) exported from the package index.

### Design choices
- Signing uses Foundry keystores (`overflow-deployer`) plus a chmod-600 password file instead of a raw key in `.env`; the `*_KEY` slots in `.env` hold addresses only.
- The deployments JSON lives in `packages/schemas/deployments/` (prompt) rather than the repo root (P0.2 draft) so the package can import it statically; field names follow the prompt, P0.2 names stay accepted.
- `dev-fund` is labeled DEV ONLY in code and output; in the demo the controller funds through Coinbase Wallet.
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
| `forge build` | success (Deploy.s.sol compiles) |
| `DRY_RUN=1 pnpm contracts:deploy` (simulation with `--sender 0xB6F4…06C3`) | `Script ran successfully`; treasury would be `0xd3A74fA991CA0B5627d30EF27dC699C134848291` at the deployer's current nonce, root node id 1 (key `0x390C…Ea89`, cap 50 USDC, maxPerCall 15 USDC); estimated 2,758,876 gas, 0.000030347636 ETH |
| `pnpm contracts:export --abi-only` | wrote `packages/schemas/src/abi/OverflowTreasury.ts` (52 entries); skipped escrow artifacts (not built yet) |
| `pnpm typecheck` | exit 0, 9 workspaces Done (incl. `scripts`) |
| `pnpm test` | exit 0, 5 files / 104 tests (deployments schema superset and new default path covered) |
| `pnpm contracts:test` | 64 passed, 0 failed |
| `pnpm lint` | exit 0 |
| `git grep -nE "0x[a-fA-F0-9]{64}"` | only typehashes/domain separators; no private keys |

### Deployed (Base Sepolia, 2026-10-25 01:29 UTC, run by the user with the keystore)
| Item | Value |
|---|---|
| OverflowTreasury | `0xd3A74fA991CA0B5627d30EF27dC699C134848291` (https://sepolia.basescan.org/address/0xd3a74fa991ca0b5627d30ef27dc699c134848291) |
| deploy tx | `0x5a78240fc7d6bdb5135332dbbf37dd9d17f8aaaca8335c3627d45a48678ad845`, status 0x1, block 49849422, 1,944,133 gas |
| createRoot tx | `0x97b3b51bdda633d98966ed6dcf2809ad26dfeb5ae2fcd9355853a8490bc7143f`, status 0x1, block 49849422, 167,605 gas |
| owner / deployer | `0xB6F4162192F753C9998B63893CBb48FA046906C3` |
| TOKEN | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` (Base Sepolia USDC) |
| root node 1 | key `0x390CF9aA0230728dB7E185782F2288E41892Ea89`, cap 50 USDC, maxPerCall 15 USDC, expiry 2026-11-01T01:28:38Z |
| Basescan source | verified: `OverflowTreasury`, solc v0.8.28, cancun, optimizer 200 runs (Etherscan v2 `getsourcecode`, status 1) |
| escrowFactory / escrowImplementation | `null` (P1.6) |

The first export run failed in `parseDeployments` with `Invalid ISO datetime` on `deployedAt`: forge writes the
broadcast `timestamp` in milliseconds (1792891768225) and `export-deployment.ts` multiplied it by 1000 again
(year 58785). Fixed by treating values above 1e12 as milliseconds; nothing was re-broadcast. Regenerated from the
existing `run-latest.json`: `packages/schemas/deployments/base-sepolia.json`, `src/deployments.ts`
(`BASE_SEPOLIA_DEPLOYMENT`) and the three ABIs. Live-chain check: code size 8,747 bytes at the address, `owner()`,
`TOKEN()`, `nodeCount() == 1`, `remaining(1) == 50000000`, both receipts status 0x1, all equal to the JSON.

`pnpm status` (block 49855168): balance 0.00 USDC, owner and TOKEN as above, floor 0, nodeCount 1, node 1 remaining
50.00 USDC. `pnpm typecheck` exit 0 (9 workspaces), `pnpm test` 6 files / 112 tests passed.

### Open issues
- Treasury holds 0 USDC; `pnpm dev:fund` needs test USDC on the deployer (faucet.circle.com), or the controller funds via Coinbase Wallet in the demo.
- `escrowFactory`/`escrowImplementation` stay `null` until the escrow contracts are added to `Deploy.s.sol` (P1.6).

## 2026-10-24: escrow factory and tier-1 escrow

### Built
- `contracts/src/IOverflowEscrow.sol`: spec `OrderTerms` (15 fields) plus `uint32 chunkCount`, `Status {Created, Funded, Revealed, Settled, Refunded}`, 16 errors, 5 events.
- `contracts/src/OverflowEscrowFactory.sol`: `create(OrderTerms)` deploys an OpenZeppelin `Clones` minimal proxy with CREATE2, salt `keccak256(abi.encode(orderId, termsHash))`, after checking the terms and `termsHash == termsHashOf(t)`; `predict`, `isEscrow`, `termsHashOf`, `provenCheats`, `recordCheat` (escrows only), `OrderCreated`/`CheatRecorded`. The implementation is deployed by the factory constructor with `FACTORY` as an immutable.
- `contracts/src/OverflowEscrow.sol`: `initialize` (factory only, once; the implementation is pre-marked initialized), `markFunded` (balance >= amount + bond), `revealKey` (seller, before `revealDeadline`, `keccak256(key) == keyCommitment`, opens the challenge window), `accept` (EIP-712 `Accept(bytes32 orderId)` under the clone's own domain `{OverflowEscrow, 1, chainId, escrow}`, signer must be a node of `terms.buyer` via `nodeOfKey`), `finalizePayout` (after the window), `claimTimeoutRefund` (after `revealDeadline`, from `Created` or `Funded`, whole balance to the buyer). Payout sends `amount + bond` to the seller and any surplus to the buyer so the escrow ends at zero. `SafeERC20`, `ReentrancyGuardTransient`, effects before transfers.
- `complainMismatch` / `complainPromise` are stubs that enforce the full structure (`i < chunkCount`, chunk length 160, proof length exactly `expectedProofLength(i, chunkCount)`, domain-separated Merkle verification) and then revert `NotImplemented` (P1.6 / P1.7 fill them in).
- `contracts/src/MerkleLib.sol`: `leaf = keccak256(0x00 || data)`, `node = keccak256(0x01 || l || r)`, left-to-right levels with an unpaired last node promoted unhashed, so `expectedProofLength(i, n)` depends on `i` (n = 5 gives 3,3,3,3,1). `verify` requires every proof element to be consumed.
- `packages/recourse-crypto/src/merkle.ts` mirrors it (`hashLeaf`, `hashNode`, `expectedProofLength`, `merkleRoot`, `merkleProof`, `verifyProof`, `keyCommitment`, `CHUNK_SIZE`); golden roots for n = 1..5, the n = 5 proofs and the proof-length table are pinned identically in `merkle.test.ts` and `contracts/test/escrow/MerkleLib.t.sol`.
- `packages/schemas/src/hashing.ts`: `TERMS_HASH_ABI` and `TermsHashInputSchema` gain `uint32 chunkCount` (12 fields) to match `OverflowEscrowFactory.termsHashOf`; `hashing.test.ts` updated.
- `foundry.toml`: `[invariant] runs = 64, depth = 32`. ABIs exported to `packages/schemas/src/abi/OverflowEscrow.ts` and `OverflowEscrowFactory.ts`.
- Tests: `contracts/test/escrow/EscrowBase.t.sol` (harness over the treasury harness: Merkle builder, order terms, funding via mint or via `treasury.settle` with the escrow as payee), `OverflowEscrow.t.sol` (41 tests), `MerkleLib.t.sol` (6), `contracts/test/invariant/EscrowInvariant.t.sol` (handler drives markFunded / reveal / accept / finalize / timeoutRefund / warp / topUp; invariants: at most one terminal state, zero balance after it, funds only to seller or buyer).

### Design choices
- The Accept digest is bound to the clone address through the per-escrow EIP-712 domain, so a signature for one order cannot pay another (`test_accept_signatureForAnotherEscrowReverts`). The offchain signer (payment-client / service) must use `{name "OverflowEscrow", version "1", chainId 84532, verifyingContract = escrow}`.
- `chunkCount` is bound by `termsHash` (and therefore by `orderId` and the CREATE2 salt), per the user's decision; the teammate's `TERMS_HASH_ABI` was extended as a superset.
- A refund returns price and bond to the treasury's USDC but leaves the paying node's `spent` charged (asserted in `test_timeoutRefund_restoresTreasuryUsdc`), per the spec's refund semantics.
- The internal-node-as-leaf attack fails on the exact proof-length check first and on the domain-separated hash if padded; a 32-byte node can never pass as a 160-byte chunk either.
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
| `forge build` | success |
| `forge test` | 112 passed, 0 failed across 7 suites (2 scaffold, 8 USDC harness, 51 treasury, 3 adversarial, 41 escrow, 6 MerkleLib, 1 invariant contract with 3 invariants: 64 runs, 2,048 calls) |
| `forge snapshot` | `.gas-snapshot` refreshed (114 lines) |
| `pnpm test` | 6 files / 112 tests passed (schemas hashing with `chunkCount`, recourse-crypto Merkle golden vectors identical to the Solidity constants) |
| `pnpm typecheck` | exit 0, 9 workspaces |
| `pnpm lint` | exit 0 |
| `git grep -nE "0x[a-fA-F0-9]{64}"` | only typehashes, domain separators and golden vectors; no private keys |

### Open issues
- Treasury side still pending (P1.5): `setEscrowFactory`, accepting factory escrows as payees, `PayeeFlagged`, `reserve`/`release`. Tests allowlist the escrow with `setAllow` meanwhile.
- Tier 2/3 complaint logic (decrypt and compare, source signature and timestamp, bond to the buyer, `recordCheat` call) is not implemented; the stubs revert `NotImplemented` after the structural checks.
- The chunk keystream (`k_i`, keystream blocks, XOR) is not in `recourse-crypto` yet; only the Merkle and key-commitment helpers are.
- Base Sepolia deploy of the treasury (previous section) is still pending the keystore password; `Deploy.s.sol` does not deploy the escrow contracts yet (its hook is marked).

## 2026-10-24: treasury pays per-order escrows

### Built
- `OverflowTreasury.setEscrowFactory(address)` (owner only, `EscrowFactorySet`), `escrowFactory` view; zero disables escrow payees.
- `_authorize` step 4: a payee passes if `allowlist[to]`, or if all of `factory.isEscrow(to)`, `escrow.buyer() == address(this)`, `factory.provenCheats(escrow.seller()) == 0` and `value == escrow.amount()`. Failures: `PayeeNotAllowed(0)` (not an escrow, factory unset, other buyer), `PayeeFlagged(seller)` (flag, checked before the amount), `EscrowAmountMismatch(escrow, expected, actual)` (new error, so the Blocked lane can name the cause instead of a generic `PayeeNotAllowed(0)`). Direct payees with `provenCheats > 0` also revert `PayeeFlagged(to)`. Check order 1-8 of the spec is unchanged.
- Step 5: restricted nodes are checked against the escrow's seller (`nodeAllow[n][escrow.seller()]`), so a delegation that allows a seller covers every per-order escrow of that seller. Documented as T15 in `docs/contract-invariants.md`; T14 and E9 now point at the implementation.
- `OverflowEscrow` gains `buyer()`, `seller()`, `amount()` getters (the treasury uses them). Treasury ABI re-exported (57 entries).
- `contracts/test/unit/TreasuryEscrowPayee.t.sol` (12 tests, real USDC): agent funds an escrow through `settle()` with no `setAllow`, then `markFunded`; wrong amount (both directions, no partial charge); escrow with a different buyer; flagged seller on the escrow path, on a fresh order, and on the direct path; other sellers unaffected; factory unset; owner-only `setEscrowFactory` with event; restricted child pays an escrow of its allowed seller, rejects another seller's escrow (also through an unrestricted grandchild), and an allowlist of `payeeA` does not admit the escrow.
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
| `forge build` | success |
| `forge test` | 124 passed, 0 failed (51 existing treasury tests untouched and green, 12 new, 41 escrow, 6 Merkle, 3 invariants, 8 USDC, 3 adversarial) |
| `forge snapshot` | refreshed; `test_depth1_root_pays` 315,391 -> 317,607 gas (one `escrowFactory` SLOAD on the allowlisted path) |
| `pnpm typecheck` / `pnpm test` / `pnpm lint` | exit 0 / 6 files, 112 tests / exit 0 |

### Open issues
- The live Base Sepolia treasury (`0xd3A7…8291`) predates `setEscrowFactory`; it must be redeployed together with the escrow factory (P1.6 `Deploy.s.sol` hook) before escrow payments can run on chain.
- Reservations (`reserve`/`release`, `reservedTotal` in the floor check) remain P1.5+.

## 2026-10-24: reservations for third-party facilitators (P1.5)

### Built
- `reserve(to, value, validAfter, validBefore, nonce, sig) -> digest`: same digest, signer recovery and `_authorize` as `settle()` (every policy check, every ancestor charged), plus `validBefore <= block.timestamp + reservationWindow` (`ReservationTooLong`) and one reservation per digest (`ReservationActive`). Stores `Reservation {nodeId, value, validBefore, nonce}`, `reservedTotal += value`, emits `Reserved(digest, id, to, value, validBefore, nonce)`.
- Floor check in `_authorize` is now `balance >= value + floor + reservedTotal` for both `settle()` and `reserve()`.
- `isValidSignature` stays `view`: magic value when `msg.sender == TOKEN` and either the transient settle flag is set or a stored reservation for that exact digest has `block.timestamp < validBefore`.
- `release(digest)`: anyone, after `validBefore` (`ReservationLive` before, `NoReservation` for unknown or already released). If `USDC.authorizationState(this, nonce)` is false the charge is reversed up the stored node's ancestor chain; always `reservedTotal -= value`, delete, `ReservationReleased(digest, refunded)`.
- Owner `setReservationWindow(seconds)` (`ReservationWindowSet`), default 600. Views `reservedTotal`, `reservationWindow`, `getReservation(digest)`. The digest computation moved into `_twaDigest` (shared by `settle` and `reserve`); check order 1-8 unchanged.
- Treasury ABI re-exported (70 entries).
- `contracts/test/unit/Reservations.t.sol` (16 tests, real USDC v2.2): after `reserve` a third-party address calls `USDC.transferWithAuthorization` directly and it succeeds, replay is refused by USDC's nonce; without `reserve` the same call fails `FiatTokenV2: invalid signature` and then succeeds once reserved; an expired reservation is refused by USDC (`authorization is expired`) and by the 1271 gate, and `release` refunds the budget; a used reservation releases without refund; refund walks the whole ancestor chain; release before `validBefore`, unknown digest and double release revert; duplicate `reserve` reverts and `settle` of a reserved digest cannot double-charge; `ReservationTooLong` with owner widening; disallowed payee, unknown agent, `OverPerCall`, `OverBudget`, `Paused` all revert at `reserve`; the floor counts `reservedTotal` and room returns after release; the 1271 reservation branch is token-only and digest-exact. Escrow integration: a facilitator funds a per-order escrow from a reservation and the seller is paid after reveal + accept; wrong amount and another buyer's escrow revert at `reserve`; seller silent -> timeout refund restores USDC but not allowance, used reservation releases without refund; funding never happens -> `release` restores the budget and the empty escrow still closes; a reservation for one escrow cannot fund another (USDC rejects the changed `to`).

### Live treasury compatibility
The Base Sepolia treasury at `0xd3A74fA991CA0B5627d30EF27dC699C134848291` was checked by selector against its bytecode: it has `settle` and `isValidSignature` but lacks `reserve`, `release`, `setEscrowFactory`, `reservedTotal` and `setReservationWindow`. It has no proxy, so it cannot be upgraded; it must be replaced by a fresh deployment (with the escrow factory, P1.6 hook in `Deploy.s.sol`). Not done in this task; nothing was broadcast.
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
| `forge build` | success |
| `forge test` | 140 passed, 0 failed across 9 suites (51 original treasury tests unchanged) |
| `forge snapshot` | refreshed; `test_depth1_root_pays` 317,607 -> 319,816 gas (reservedTotal SLOAD + reservation SLOAD in the gate) |
| `pnpm typecheck` / `pnpm test` / `pnpm lint` | exit 0 (9 workspaces) / 6 files, 112 tests / exit 0 |

### Open issues
- Redeploy the treasury + escrow factory to Base Sepolia and record the new addresses (replaces `0xd3A7…8291`).
- The service's Coinbase-facilitator path must call `reserve()` before handing the authorization to the facilitator, and `release()` after `validBefore`; `Paid` is not emitted for reserved payments, so the ledger must watch USDC `Transfer`/`AuthorizationUsed` instead.
- Treasury invariants T1, T2, T4, T13/T16 still lack Foundry invariant handlers (only the escrow has them).

## 2026-10-24: tier-2 mismatch proofs (P1.6)

### Built
- `contracts/src/RecourseCrypto.sol`: `deriveKey(sellerSecret, orderId, buyer) = keccak256(abi.encodePacked(...))`, `keyCommitment(k) = keccak256(k)`, `chunkKey(k, i) = keccak256(abi.encodePacked(k, uint256 i))`, `keystreamBlock(k_i, j) = keccak256(abi.encodePacked(k_i, uint256 j))`, `xorChunk(k_i, chunk)` over exactly 160 bytes (5 x 32-byte blocks, assembly XOR). Merkle rules stay in `MerkleLib` (domain-separated `0x00` leaf / `0x01` node, unpaired node promoted, index-dependent proof length) per the extra requirement; the prompt's plain `keccak256(chunk)` / `keccak256(left, right)` wording is superseded by that requirement, as in P1.3.
- `OverflowEscrow.complainMismatch`: `Revealed` and inside the window, `i < chunkCount`, 160-byte chunk, both proof lengths exact, both proofs verified; then `k_i` from `revealedKey`, decrypt, and if `leaf(plaintext) != plainLeaf`: `status = Refunded` (effect first), `CheatProven(seller, i)`, `factory.recordCheat(seller)`, whole balance (price + bond + surplus) to the buyer, `Refunded("mismatch")`. Matching chunk reverts `ChunkMatches`. `complainPromise` remains the tier-3 stub (structural checks, then `NotImplemented`).
- `packages/recourse-crypto`: `src/crypto.ts` (`deriveKey`, `chunkKey`, `keystreamBlock`, `xorChunk`, `encryptChunk`/`decryptChunk`, `commitDelivery` -> `{keyCommitment, rootPlain, rootCipher, plainLeaves, cipherChunks, cipherLeaves, chunkCount}`, `chunkMatches`, `recordTimestamp`, `RECORD_LAYOUT`), `README.md` (record byte layout: 95-byte payload whose first 8 bytes are a big-endian uint64 timestamp + 65-byte signature; keystream; Merkle rules; complaint flow), `src/crypto.test.ts`.
- Golden vectors (KEY = `keccak256("overflow.golden.key")`, chunk i = 160 bytes of value i, n = 5) pinned identically in `contracts/test/escrow/RecourseCrypto.t.sol` and `crypto.test.ts`: `k_0`, `k_2`, `ks_0_0`, `ks_0_4`, full `c_0` and `c_2`, `keyCommitment`, `rootPlain`, `rootCipher`, cipher leaf 0, `deriveKey` vector.
- Test harness `EscrowBase` now commits real ciphertext (`_cipher(i)`, `_cipherLeaves(n)`); existing complaint-structure tests moved onto it (`test_complaint_wellFormed_honestSeller` now expects `ChunkMatches` for tier 2 and `NotImplemented` for tier 3).
- `contracts/test/escrow/EscrowMismatch.t.sol` (7 tests): a seller commits honest plaintext hashes but serves a swapped ciphertext for chunk 2; the treasury funds the escrow through `settle()`; the proof refunds price + bond to the treasury, flags the seller, leaves the agent's allowance charged; a correct chunk complaint reverts (cheating and honest sellers); complaints before reveal and after the window revert and an unchallenged cheat pays out; a second complaint after the refund reverts; tampered chunk or foreign plain leaf revert `BadProof`; internal-node-as-leaf reverts (length, then hash); the flagged seller is then blocked by the treasury for new escrows via `settle` and `reserve` and for direct payment (P1.4 `PayeeFlagged`).
- Escrow ABI re-exported (52 entries).
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
| `forge build` | success |
| `forge test` | 153 passed, 0 failed across 11 suites (7 mismatch, 6 RecourseCrypto golden/fuzz, 51 original treasury unchanged) |
| `forge snapshot` | refreshed; `test_swappedChunk_refundsBuyerAndFlagsSeller` 890,194 gas whole-test |
| `pnpm test` | 7 files / 118 tests (6 new crypto tests; TS and Solidity golden constants identical) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |

### Open issues
- Tier 3 (`complainPromise`: source signature over the 95-byte payload, `minTimestamp`, bond flows) is not implemented.
- The live Base Sepolia treasury and no escrow contracts are deployed with this code; redeploy pending (see P1.5 section).
- Sampling (`k_i` reveal for random indices before funding) is an offchain protocol in the service, not yet built.

## 2026-10-24: signed-record promises, bonds, cheater flags (P1.7)

### Built
- `RecourseCrypto.splitRecord(record) -> (payload[0:95], sig[95:160])`, `recordTimestamp(payload)` (big-endian uint64 in the first 8 bytes), `payloadHash(payload) = keccak256(payload)` (plain, no EIP-191 prefix; the data source signs raw keccak of the payload).
- `OverflowEscrow.complainPromise(i, plainChunk, plainProof)`: window + structural checks as tier 2, record verified under `rootPlain`; then `broken = (sourceKey != 0 && tryRecover(payloadHash, sig) != sourceKey) || (minTimestamp != 0 && ts < minTimestamp)`. A malformed signature (ECDSA error) counts as a wrong source. Terms that promise nothing (`sourceKey == 0 && minTimestamp == 0`) revert `NoPromise` so a vacuous promise can never be used to drain an honest seller; a kept promise reverts `PromiseKept`. Both tiers share `_proveCheat(i, reason)`: `status = Refunded` first, `CheatProven`, `factory.recordCheat`, sweep price + bond + surplus to the buyer, `Refunded(reason)`.
- `OverflowEscrowFactory.create` reverts `SellerFlagged(seller)` when `provenCheats[seller] != 0`. Combined with P1.4 (`PayeeFlagged` in the treasury) a flagged seller can neither open new orders nor be paid for existing ones.
- Bonds were already enforced by P1.3 (`markFunded` requires price + bond; payout sends both to the seller; refund/timeout sweep everything to the buyer). This task adds the explicit flow tests; no contract change was needed.
- `@overflow/recourse-crypto`: `splitRecord`, `buildRecord`, `buildPayload(timestamp, 87 data bytes)`, `payloadHash`, `promiseBroken(record, sourceKey | null, minTimestamp)` (offchain mirror of the contract's decision, viem `recoverAddress`), README section for tier 3. `recordTimestamp` accepts a record or a bare payload.
- Tests: `contracts/test/escrow/EscrowPromise.t.sol` (13): wrong-source record refunds (treasury funded via `settle`, bond to the buyer, allowance stays charged, anyone may relay), stale record refunds, malformed signature refunds, valid record complaint reverts for every chunk and a forged record fails `BadProof`, timestamp-only promise ignores the signer, no-promise terms revert, complaints before reveal / after the window revert, bond to seller on payout, bond to buyer on cheat, bond to buyer on ghost (no cheat flag), `markFunded` underfunded without the bond, flagged seller cannot create (`SellerFlagged`, no clone deployed) or be paid (earlier order and direct), cheat count accumulates across orders. `TreasuryEscrowPayee::test_flaggedSeller_escrowPathReverts` updated for the new create rule; `test_complaint_wellFormed_honestSeller` now expects `NoPromise` for tier 3. ABIs re-exported (escrow 53 entries, factory 17).
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
| `forge build` | success |
| `forge test` | 166 passed, 0 failed across 12 suites |
| `forge snapshot` | refreshed; `test_wrongSourceRecord_refunds` 2,317,848 gas whole-test (incl. order creation and treasury funding) |
| `pnpm test` | 7 files / 122 tests (4 new: record split, promise kept/broken/malformed, empty promise rejected) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |

### Open issues
- `sourceKey` is a single EOA per order; a source that rotates keys needs a new order or an onchain registry (not in spec).
- Offchain: the service does not yet build or verify records (`buildPayload`/`buildRecord` exist; the seller simulation and sampling protocol are P2).
- Live Base Sepolia treasury predates escrow support; redeploy pending.

## 2026-10-24: fork suite, invariants, gas report (P1.8)

### Built
- `contracts/test/fork/UsdcGate.t.sol` (6 tests, `vm.skip` unless chain id 84532): a fresh treasury on a Base Sepolia fork over the real USDC at `0x036C...`, funded with `deal()` (no keys). Domain name "USDC" / version "2" / separator `0x71f1...9818` / 6 decimals; settle moves balances and marks the nonce; a direct `transferWithAuthorization` from anyone reverts `FiatTokenV2: invalid signature`; replay reverts `FiatTokenV2: authorization is used or canceled` with no second charge; the ERC-1271 gate answers INVALID to USDC and to anyone outside settle, and stays closed after an unrelated settle; a reservation lets a facilitator submit the agent's authorization straight to live USDC, and `release` after the window keeps the charge. The live treasury `0xd3A7...8291` is not used (it predates `reserve`); the suite deploys its own.
- `scripts/fork-test.sh` -> `pnpm contracts:fork` (sources `.env`, needs `BASE_SEPOLIA_RPC_URL`, read-only `forge test --fork-url`).
- `contracts/test/invariant/TreasuryInvariant.t.sol`: `TreasuryHandler` with 16 actions (settle, reserve, executeReservation as a facilitator via USDC, release, warp, ownerPause, pauseChild by the root key, delegate with caps that sometimes exceed the parent, fundTreasury, createEscrow with bond staked by the seller, markFunded, reveal correct/wrong, accept by any node key, finalize, timeoutRefund, flagSeller as a SIMULATED proven cheat through `recordCheat`). Targets mix allowlisted payees, escrows (value forced to the order amount) and never-allowlisted sellers. Invariants: `spent <= cap` and `spent >= sum of children` on every node; `balance + executedPending >= floor + reservedTotal` (executedPending = reserved USDC a facilitator already pulled but nobody released yet, which stays in `reservedTotal` by design); `reservedTotal == sum of unreleased reservations`; the gate returns MAGIC only to USDC and only for a live reservation digest, INVALID to every other caller and for unknown digests; every escrow has at most one terminal transition, a final terminal status and zero balance afterwards (one tracked exception: a reservation approved while the order was open and executed by the facilitator after it closed); the treasury never authorizes a payment benefiting a flagged seller and the factory refuses them. `afterInvariant` logs per-run coverage; `test_handlerCoverage` runs a deterministic 400-step walk and asserts settles, reserves, treasury-funded escrows, delegations, terminal escrows and flagged sellers all occurred, then re-checks every invariant.
- `foundry.toml` `[invariant]` now `runs = 256`, `depth = 50` (whole forge suite ~6 s). `pnpm contracts:invariant` runs the two invariant suites.
- `contracts/test/gas/GasReport.t.sol` + `scripts/gas-report.ts` -> `pnpm contracts:gas` writes `docs/gas.md` from forge gas snapshots (`contracts/snapshots/`, gitignored): settle, reserve, release, escrow create, fund (settle to escrow + markFunded), reveal, accept, refund.

### Fix found by the invariants
- The treasury would pay a settled or refunded escrow (the payee rule checked factory, buyer, seller flag and amount but not status). A closed escrow has no sweep, so the USDC would be stranded and the agent's allowance burned. `_authorize` now reverts `EscrowClosed(escrow)` inside the escrow branch of step 4; the normative check order is unchanged. Unit test `test_closedEscrow_isNotAPayee` (settle and reserve). Treasury ABI re-exported (71 entries).
- Not fixed, documented: a reservation approved while an order was open can be executed by the facilitator after the order closes, landing USDC in the closed escrow with no sweep. Candidate P2 fix: an escrow `sweep()` to the buyer after a terminal state.
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
| `pnpm contracts:fork` (live Base Sepolia RPC) | 6 passed, 0 failed |
| `forge test` (invariants at 256 runs x depth 50) | 170 passed, 0 failed, 1 skipped (the fork suite off-chain) across 15 suites; treasury invariants also pass under fuzz seeds 1, 2, 3 |
| handler metrics (`FOUNDRY_INVARIANT_SHOW_METRICS`) | 12,800 calls per invariant, every action called ~800 times |
| `pnpm contracts:gas` | docs/gas.md: settle 170,063; reserve 198,444; release 56,011; escrow create 420,958; fund settle 155,912 + markFunded 69,134; reveal 62,855; accept 100,705; refund 61,463 |
| `forge snapshot` | refreshed |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | 122 tests / exit 0 / exit 0 |

### Open issues
- Late-executed reservation into a closed escrow (above).
- The fork suite deploys a fresh treasury; the live `0xd3A7...8291` still needs replacing by a deployment with the escrow factory.

## 2026-10-24: facilitator and relayer (P2.1)

### Built
- `@overflow/payment-client` (`src/typed-data.ts`): EIP-3009 `TransferWithAuthorization` types, `authorizationDigest`, `signAuthorization`/`recoverAuthorizationSigner` (structural `TypedDataSigner`), `randomNonce`; treasury delegation types `CreateChild`/`PauseChild`, `delegationDomain(treasury)`, `payeesHash`, `createChildDigest`/`pauseChildDigest` + signers; `AuthorizationSchema`, `ChildParamsSchema`, `PauseChildSchema`, `SignatureSchema`; `verifyTokenDomain(reader)` reads `name()/version()/decimals()/DOMAIN_SEPARATOR()` (USDC has no `eip712Domain()`) and throws `TokenDomainMismatch` listing every differing field. Golden vectors (USDC separator, one authorization digest, delegation separator for the live treasury address, payeesHash, CreateChild and PauseChild digests) pinned in `contracts/test/unit/TypedDataVectors.t.sol` and `typed-data.test.ts`; the forge test also checks the treasury's own `DELEGATION_DOMAIN_SEPARATOR()` follows the same formula.
- `apps/service` (Hono + `@hono/node-server`):
  - `src/config.ts` zod env (`RELAYER_PRIVATE_KEY` must be a 64-hex key, validated and never logged; `DEMO_TOKEN` ≥ 16 chars required when `DEMO_MODE=true`; `EVENTS_POLL_MS`; `OVERFLOW_DEPLOYMENTS_PATH`), `loadEnv()`.
  - `src/chain/client.ts` `ChainClient` interface (the viem slice we use) + `viemChainClient`; `src/chain/boot.ts` `verifyBoot`: chain id 84532, USDC domain, deployments token == USDC, treasury code present, `treasury.TOKEN()`, `treasury.escrowFactory()` when recorded. Any mismatch → `BootCheckFailed`, process exits 1 before serving.
  - `src/facilitator/decode.ts`: viem `ContractFunctionRevertedError`, raw revert hex in `cause` chains, `Error(string)` (USDC messages → plain reasons; `FiatTokenV2: invalid signature` is the bypass reason), `Panic`, every treasury custom error (reason table also covers the OZ `ECDSA*`, `ReentrancyGuardReentrantCall`, `SafeERC20FailedOperation`, `Address*` errors present in the ABI); args as decimal strings / checksummed addresses.
  - `src/facilitator/relayer.ts`: one promise-chain lock per key around nonce fetch → send → receipt; local nonce re-synced after a send failure; receipt timeout → `status: "unknown"` with the hash kept (never resign). `src/facilitator/store.ts`: `Store` interface + `MemoryStore`, keyed by authorization digest / `release:<digest>` / delegation digest; a repeated key is 409 with the original record (also while pending). Front-run check: `authorizationState` true without a local record → scan `Paid`/`Reserved` logs (2000 blocks) and answer `success:true, external:true` with that tx.
  - Routes (`src/facilitator/routes/*`): `GET /health` (chain, treasury, relayer address and wei balance, pending/queued tx, demoMode), `GET /supported` (x402 v2 exact / eip155:84532 / USDC / payer = treasury), `POST /verify` (prechecks: `from == treasury`, requirements vs authorization, time window; recover payer; eth_call `settle` as the relayer; decoded reason), `POST /settle` and `POST /reserve` (x402 `paymentPayload`/`paymentRequirements` bodies; 409 replay; simulate; relay; parse `Paid`/`Reserved`; on receipt revert re-simulate at `block - 1`), `POST /release` (`ReservationReleased.refunded`), `POST /delegate` (`NodeCreated.id`), `POST /pause-child` (`NodePaused.by`), `GET /events` (SSE: subscribe-before-replay, 200-event ring, 15 s heartbeat; chain kinds from a treasury log poller, `Reverted`/`BypassRejected`/`BypassSucceeded` labeled `source: "facilitator"`). `POST /demo/bypass` and `forceBroadcast` exist only with `DEMO_MODE=true` and a timing-safe `x-demo-token`; both broadcast with fixed gas so the rejection lands onchain, and both responses/events carry `simulated: true`. No `/admin/*`.
  - `src/index.ts`: loadEnv → config → deployments → `verifyBoot` → relayer/bus/poller → serve; `GET /` keeps the status object.
- `contracts/script/Deploy.s.sol`: also deploys `OverflowEscrowFactory` (its constructor deploys the escrow implementation), `setEscrowFactory`, optional `setAllow(DEMO_PAYEE_ADDRESS)`, prints `setEscrowFactory` calldata when the owner is not the deployer. `.env.example`: `DEMO_PAYEE_ADDRESS`, `DEMO_TOKEN`, `EVENTS_POLL_MS`.
- `scripts/facilitator-demo.ts` → `pnpm demo:facilitator`: settle to the demo payee, `/verify` + forced `/settle` for the SIMULATED attacker, `/demo/bypass`, 409 replay; writes `docs/demo-facilitator.md` with Basescan links from real responses. `pnpm service` runs the service.
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

## 2026-10-24: journal posting and reconciliation (G5)

### Built
- `apps/service/src/ledger/posting.ts`: the spec's journal table as posting rules, run inside the indexer's per-log transaction **after** the handler savepoint, so the books follow the chain even when the purchase state machine refuses a move. One logical entry per chain event, `eventKey = "<txHash>:<logIndex>"`; a department split is one row per department (`sourceEventId = "<eventKey>#<department>"`, unique). Rules: USDC `Transfer` into the treasury from a non-escrow → Dr usdc-treasury / Cr owner-contribution; `OrderFunded` → Dr escrow-deposit / Cr usdc-treasury; `PaidOut` → Dr data-expense per department (Fusion allocations summed per department, integer-scaled if the chain amount differs, remainder on the last line, total unchanged) / Cr escrow-deposit, only when the order has a deposit line; `Refunded` → Dr usdc-treasury / Cr escrow-deposit (never an expense); `BondForfeited` → Dr usdc-treasury / Cr other-income-seller-forfeiture; USDC `Transfer` out of the treasury to a non-escrow payee with a waiting purchase → Dr data-expense per department / Cr usdc-treasury (direct x402 purchase). `Paid`, `Reserved`, `ReservationReleased` and transfers between the treasury and a known escrow post nothing. Replays post nothing (`listByEventKey` check plus the unique `source_event_id`).
- `ledger/reconciliation.ts`: `createReconciliation({ db, reader, treasury, usdc, materialityAtomic = 10000 })`. `run(trigger, blockNumber?)` reads balances at the indexer cursor block and checks (1) `balanceOf(treasury)` vs the usdc-treasury net, (2) every escrow order: open `Funded`/`Revealed` → `balanceOf(escrow) − bond` vs its deposit line, `Created` → line must be 0, closed → line nets to 0, (3) every confirmed `PaidOut`/`Refunded` has an entry for its event key and every `Paid` has exactly one entry group in its transaction. Material differences (> 0.01 USDC, or any missing entry) open `exceptions` rows (`type: reconciliation-difference`, new `subject` column; an open subject is never duplicated), write `exception.opened`, and the run is stored in the new `reconciliation_runs` table with `reconciliation.ok` / `reconciliation.difference` on the feed. Runs after every indexer poll that stored new logs (`createIndexer({ afterTick })`) and on demand via `POST /api/reconciliation/run`.
- Indexer now also fetches USDC `Transfer` logs with topic filters (`from == treasury`, `to == treasury`): the controller's funding and the Coinbase-path direct purchase have no treasury event. `LogSource.getLogs` takes `topics`; `createLogSource` also implements `BalanceReader.balanceOf` (viem `erc20Abi`, pinned to a block). `IndexerConfig.usdc` comes from `deployments.usdc`.
- Provisional ABI additions: `Transfer(address,address,uint256)` (USDC) and `BondForfeited(bytes32 indexed orderId, address indexed seller, uint256 bond)` on the escrow; `Refunded.amount` is documented as the price only. Handlers: `Transfer` (`usdc.transfer` note, links the waiting purchase), `BondForfeited` (`escrow.bond-forfeited`), `OrderCreated` now increments `seller_history.orders` and records `sellerId`. `chain/lookup.ts` holds the shared lookups (`purchaseForOrder`, `isKnownEscrow`, `waitingPurchaseForPayee`, `orderCreatedFor`).
- Database: migration `0003_ledger_reconciliation` (`financial_entries.event_key` + indexes, `exceptions.subject`, `reconciliation_runs`); repositories `financialEntries.listByEventKey/listByTxHash/balances/departmentBalances/depositLineForPurchase`, `exceptions.findOpenBySubject`, `escrowOrders.listAll`, new `reconciliationRuns`. Schemas: `FinancialEntry.eventKey`, `ExceptionRecord.subject`, `ReconciliationRunSchema`, `ReconciliationDifferenceSchema`, `DEFAULT_MATERIALITY_ATOMIC`, new activity kinds.
- API: `GET /api/ledger?purchaseId=&limit=` → `{ entries, balances (debits, credits, net per account), departments (data-expense per department) }`; `GET /api/reconciliation` reads the stored last run and open exceptions; `POST /api/reconciliation/run` → the run, or 501 `not_wired` without an RPC. `ReconciliationPort` is now `{ run(trigger) }`.
- Fixture (`chain/fixtures/build-fixture.ts`, SIMULATED, 26 logs): funding transfer, both payment paths (overflow: Transfer + Paid + OrderFunded; coinbase: Transfer + OrderFunded, no Paid), timeout refund with a 2.4 USDC forfeited bond, a direct x402 purchase (p4) and the never-funded order 3.

### Design choices
- USDC `Transfer` is the booking source for funding and direct purchases because it is the only chain record of those movements; `Paid` stays an authorization record. Reconciliation's "every Paid has exactly one entry" is checked per transaction so both paths satisfy it.
- `PaidOut` without a deposit line posts nothing rather than driving escrow-deposit negative; reconciliation raises the exception instead (the fixture's order 3 does exactly this).
- An outflow matching no purchase (e.g. an owner withdrawal) posts nothing by design: the spec's table has no row for it and the treasury difference becomes a controller exception.
- Balances are read at the indexer cursor, not the head, so an in-flight transfer never shows as a false difference.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | 13 files / 214 tests (service 80: decode covers every ABI error + every USDC message + viem shapes; routes via `app.request()` with a fake `ChainClient`: health, supported, verify valid/invalid/prechecks/400s, settle success/409 done/409 pending/policy revert/front-run/force 403/force demo/receipt timeout, reserve, release, delegate, pause-child, bypass gated and both outcomes; relayer serialization, nonce resync, timeout; bus/poller/SSE; boot checks. payment-client 12) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `forge test` | 174 passed, 1 skipped (fork) incl. `TypedDataVectors` (4); `forge snapshot` refreshed |
| Service boot against Base Sepolia | **Not run**: `.env` `RELAYER_PRIVATE_KEY` holds an address (keystore convention), so `readConfig` refuses to start: `invalid service configuration: RELAYER_PRIVATE_KEY must be a 0x-prefixed 64-hex key` (exit 1). The wrong-token deployments negative check is covered by `boot.test.ts`. |
| `pnpm demo:facilitator` on Base Sepolia | **Not run**: needs the redeploy (`pnpm contracts:deploy` with `DEMO_PAYEE_ADDRESS`, then faucet USDC to the new treasury), a 64-hex `RELAYER_PRIVATE_KEY` with gas ETH, a 64-hex `AGENT_ROOT_KEY`, `DEMO_MODE=true`, `DEMO_TOKEN`, `ATTACKER_ADDRESS`. |

### Open issues
- Live proof pending the items above; after the redeploy the exporter must be rerun (`pnpm contracts:export`) so `base-sepolia.json` carries `escrowFactory`.
- Idempotency store is in-memory (lost on restart); the Postgres `reservations` table is the DB task's job.
- The facilitator does not yet call `release()` automatically after `validBefore`; the orchestration layer or a cron must.
- Coinbase facilitator path (reserve then hand off) is wired on the treasury side but untested against Coinbase's service.

## 2026-10-24: keystore signing for the relayer and the agent root key

### Built
- `@overflow/payment-client/keystore` (Node-only subpath, not exported from the package root): `decryptKeystore` (Web3 Secret Storage v3 as Foundry writes it: scrypt KDF with any `n/r/p`, aes-128-ctr, keccak MAC checked with `timingSafeEqual` before decrypting; derived key and plaintext buffers zeroed), `resolveKeystorePath` (`$FOUNDRY_KEYSTORES_DIR` or `~/.foundry/keystores/<name>`, absolute paths allowed, no `..`), `readPasswordFile` (refuses group/other-readable, empty or missing files; strips trailing newlines like `forge --password-file`), `resolveSigner({keyOrAddress, account, passwordFile, label})`: a 64-hex key in the env slot wins; otherwise the keystore is decrypted and, when the slot holds an address, the decrypted address must match it. The key exists only inside the returned viem account; no log, error or return value carries it.
- Service config: `RELAYER_PRIVATE_KEY` may be a 64-hex key or the relayer's address; `RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE` select the keystore. `readConfig` refuses an address without a keystore. Boot logs `relayer <address> (keystore <name>)`. `createRelayer`, the nonce queue and `viemChainClient.sendTransaction` are unchanged: the account is still a viem `PrivateKeyAccount`.
- `scripts/facilitator-demo.ts` signs with `AGENT_ROOT_ACCOUNT` + `AGENT_ROOT_PASSWORD_FILE` (or a 64-hex `AGENT_ROOT_KEY`). `.env.example` documents both roles; README updated.
- Test fixture `packages/payment-client/test-fixtures/throwaway-a11ce`: a cast-generated keystore of the public `…a11ce` test key (README beside it).
| `pnpm --filter @overflow/database db:generate` | wrote `0003_ledger_reconciliation`; re-run "No schema changes" |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 34 files / 286 tests passed (new: posting 11 incl. split math, every rule, trial balance zero, refunded order has no expense, replay posts nothing; reconciliation 4: clean chain → only the order-3 coverage exception, planted +0.50 USDC → one exception of 500000 and no duplicate on rerun, +0.005 USDC → difference recorded, no exception, escrow balance mismatch → `escrow:p3` exception; indexer 26 logs → 8 rows, usdc-treasury net 37400000) |
| `pnpm --filter @overflow/service build` | tsup success |
| `tsx src/index.ts` (PGlite, no RPC) + curl | `GET /` `modules.ledger` set; `GET /api/ledger` empty books with five zero balances; `GET /api/reconciliation` `lastRun: null` + note; `POST /api/reconciliation/run` → 501 `not_wired` |

### Open issues
- The contracts must emit `BondForfeited(bytes32,address,uint256)` and keep `Refunded.amount` to the price, or edit `chain/abi.ts` + `abi.test.ts`; if a refund silently includes the bond, the closed-order net check opens an exception rather than mis-booking.
- A direct x402 purchase cannot reach `SETTLED`: `PAYMENT_PENDING → SETTLED` is not an allowed transition. The expense is booked; the state-machine owner decides the move.
- Live check not run: no deployment exists. With `BASE_SEPOLIA_RPC_URL` + `deployments/base-sepolia.json`, fund the treasury from Coinbase Wallet and expect one owner-contribution entry and a `reconciliation.ok` on `/events`.
- `RECONCILIATION_MATERIALITY_ATOMIC` env override exists in `index.ts` but is not yet in `.env.example`.

## 2026-10-24: exceptions and controller requests

### Built
- `packages/schemas/src/ledger.ts`: `ExceptionTypeSchema` is now the spec's seven cases, named as in the prompt: `NEW_PAYEE`, `CAP_RAISE`, `PAUSE_REQUEST` (onchain: resolved by an owner call), `UNCLEAR_LICENSE`, `LOW_CONFIDENCE_SAMPLE`, `DISPUTE_WITHOUT_PROOF`, `RECONCILIATION_DIFF` (offchain: the controller decides). `ONCHAIN_EXCEPTION_TYPES`/`isOnchainExceptionType`, `ExceptionDecisionSchema` (`approve | reject`). `ExceptionRecord` gains `requestedBy`, `details` (typed per-type payload), `decision`, `decisionReason`. `ControllerRequest` gains `exceptionId`, `target`, `data`, `value`, `summary`; statuses are `pending | done | rejected` (`approved`/`executed` removed).
- `packages/database`: migration `0004_exceptions_controller_requests` adds those columns, an FK `controller_requests.exception_id -> exceptions.id`, indexes on `controller_requests.status`/`exception_id`, a `value >= 0` check. It first runs `DELETE FROM controller_requests`: prototype rows written before calldata existed cannot be backfilled (no treasury address was known), and no deployed database holds any. Repositories: `exceptions.resolve(id, by, outcome, { decision, decisionReason })`, `exceptions.list(status | "all")`, `controllerRequests.resolve(id, "done" | "rejected", txHash?)` (`done` requires the txHash), `list(status | "all")`, `listByExceptionId`.
- `apps/service/src/exceptions/`: `calldata.ts` encodes the owner call with viem (`setAllow(address,bool)` 0xde6a0525, `raiseCap(uint256,uint256)` 0xf4f0fc21, `pause(uint256)` 0x136439dd; the three function signatures were added to the provisional `treasuryAbi` from `origin/person1:contracts/src/IOverflowTreasury.sol`, identical to Leash) into `{ target: treasury, data, value: "0", summary }`; any other action kind is refused. `matching.ts` pairs a stored event with a pending request by exact fields: `AllowSet` ↔ `set-allow` (payee, allowed), `CapRaised` ↔ `raise-cap` (id, newCap), `NodePaused` ↔ `pause` (id). `service.ts`: `RaiseExceptionInputSchema` (discriminated union per type), `raiseException` (one open exception per subject: `payee:<addr>`, `node:<id>:cap`, `node:<id>:pause`, `resource:<id>:license`, `sample:<id>`, `dispute:<purchaseId>`; onchain types also insert the ControllerRequest and a `controller.requested` event; without a treasury address they throw `NotWiredError` and write nothing), `decideException` (404 / 409 `already_decided` / 403 `self_resolution` when `decidedBy === requestedBy` / 409 `onchain_approval_required` for approve on an onchain type; reject on an onchain type marks the request `rejected` and the exception `dismissed`; offchain approve → `resolved`, reject → `dismissed`, always with `resolvedBy`, `decision`, `decisionReason`), `completeControllerRequests` (the only code path that writes `done`), `createExceptionService` (one transaction per call, events published on the bus after commit).
- `chain/handlers.ts`: `AllowSet`, `CapRaised`, `NodePaused` call `completeControllerRequests` inside the per-log savepoint: every pending request the event matches becomes `done` with that log's txHash, its exception `resolved` by `chain` with the event as `decisionReason`, one `controller.resolved` event each. A replayed log inserts nothing, so nothing re-runs.
- `ledger/reconciliation.ts`: `EXCEPTION_TYPE = "RECONCILIATION_DIFF"`, `requestedBy: "system:reconciliation"`, difference amounts in `details`.
- API: `GET /api/exceptions?status=open|resolved|dismissed|all` (default open) → `{ exceptions: [...{ request | null }] }`; `GET /api/controller-requests?status=pending|done|rejected|all` (default pending) → `{ requests, treasury }` (read-only: no route approves, sends or completes a request); `POST /api/exceptions/:id/decide` `{ decidedBy, decision, reason }` → `{ exception, request | null }`. `POST /api/agents/:id/pause` now raises a `PAUSE_REQUEST` through the same service and returns `{ exception, request }` with the `pause(nodeId)` calldata. `createApp({ treasury })` receives the deployed treasury from `resolveIndexerConfig()`; `GET /` reports `modules.exceptions`.
- Fixture: `CapRaised(1, 50 USDC -> 80 USDC)` added in the owner's block-110 transaction (27 logs).

### Design choices
- Exception type names follow the prompt (SCREAMING_SNAKE, like purchase statuses). The column is text, so the rename needed no data migration.
- Matching is exact. The controller approves specific calldata, so the event must carry the same payee/flag, node/cap or node; a cap raised to a different number leaves the request pending for the controller to reject, rather than being silently claimed.
- The self-resolution rule is literal (`decidedBy === requestedBy` → 403, any role); `decidedBy` is a required body field because the demo session has a single principal.
- Onchain approval never happens over HTTP: `approve` on an onchain exception answers 409 and the request stays `pending` until the indexer stores the event.
- With no deployments file the service still opens offchain exceptions; onchain ones answer 501 `not_wired` naming the file, consistent with every other unwired port. No treasury address is invented.

### Stubbed or simulated
- Nothing in this prompt calls `raise` for `NEW_PAYEE`, `CAP_RAISE`, `UNCLEAR_LICENSE`, `LOW_CONFIDENCE_SAMPLE` or `DISPUTE_WITHOUT_PROOF` yet; only the pause route and reconciliation raise exceptions. The triggers belong to the quote check (payee not allowed), the `OverBudget` revert path, Oracle, the sampler and recourse (later prompts).
- Tests use the SIMULATED fixture and treasury address; no Coinbase Wallet approval has been exercised.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | 15 files / 228 tests (keystore: decrypt, wrong password MAC, unsupported format, 0600 check, newline strip, path rules, signer precedence, address mismatch, missing pieces; config: signer source matrix) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| Service boot on Base Sepolia with the fixture keystore (`RELAYER_ACCOUNT=<fixture path>`, empty address slot) | booted; `/health` reports relayer `0xe05f…cfF7`, head block 49883826, boot log names the keystore and never a key |
| Wrong password / address slot ≠ keystore / password file 0644 | each exits 1: `keystore MAC mismatch`, `keystore … holds 0xe05f…, but the env slot says 0x1111…`, `password file … is readable by group/others; chmod 600 it` |
| The user's `overflow-relayer` / `overflow-agent-root` keystores | not opened: no password file exists yet (`DEPLOYER_PASSWORD_FILE` style). To use them: write the password to a chmod-600 file, set `RELAYER_PASSWORD_FILE` (and `AGENT_ROOT_PASSWORD_FILE`), keep the addresses in `RELAYER_PRIVATE_KEY` / `AGENT_ROOT_KEY` so boot checks them. |

### Notes
- Only scrypt keystores are accepted (what `cast wallet import` produces); pbkdf2 files fail loudly as unsupported rather than silently.
- Alternative considered and rejected: shelling out to `cast wallet sign` per transaction. `cast` cannot sign a raw transaction without broadcasting it, which would bypass the relayer's nonce queue and receipt tracking.

## 2026-10-24: sweep() for late USDC in closed escrows (security patch)

### Problem
`reserve()` approves an EIP-3009 authorization that USDC may execute later. `EscrowClosed` (T17) stops new `settle()`/`reserve()` calls to a settled or refunded escrow, but it cannot revoke an authorization USDC already accepts, so a facilitator executing a reservation after the order closed strands the USDC in the escrow. The treasury invariant tracked this as `lateDeposits`; the escrow had no path out.

### Built
- `OverflowEscrow.sweep() external nonReentrant returns (uint256)`: terminal status only (`BadStatus` otherwise), whole token balance to `terms.buyer` (fixed at creation: never the caller, seller or an owner), `NothingToSweep` on zero so a repeat cannot pay twice, `Swept(buyer, amount)` event. No state other than the token balance changes: terminal status, terms, `revealedKey`, the original payout/refund and the agent's spent allowance stay as they were. A transfer USDC rejects bubbles USDC's reason through SafeERC20 and leaves the balance recoverable. Interface: `sweep()`, `NothingToSweep()`, `Swept`. ABI regenerated (`OverflowEscrow.ts` 56 entries).
- Tests on the real USDC v2.2 harness, principal proof = a genuine late `transferWithAuthorization` of a previously valid `reserve()` authorization:
  - `Reservations::test_lateReservation_afterSettled_sweptToTreasury`: reserve, fund by a second `settle`, reveal, accept (Settled), `settle()` of the reserved authorization reverts `EscrowClosed`, a tampered copy reverts `invalid signature`, USDC executes the real one into the closed escrow, the seller calls `sweep()` and gains nothing, treasury gets the exact amount, `spent` stays 2 x AMOUNT, repeat sweep `NothingToSweep`, replay `authorization is used or canceled`, `release()` refunds no allowance.
  - `test_lateReservation_afterTimeoutRefund_sweptToTreasury` (Refunded via missed reveal, stranger sweeps, order not revived) and `EscrowMismatch::test_lateReservation_afterCheatRefund_sweptToTreasury` (Refunded via proven cheat, flagged seller gets nothing).
  - `test_lateReservation_rejectedTransfer_staysRecoverable`: USDC paused → `Pausable: paused`; treasury blacklisted → `Blacklistable: account is blacklisted`; status and balance untouched; sweep succeeds after `unBlacklist`. (`IUSDC` harness interface gained `unBlacklist`, `pause`, `unpause`.)
  - `OverflowEscrow.t.sol`: sweep in Created/Funded/Revealed reverts, empty terminal escrow reverts `NothingToSweep`, buyer-only recipient whoever calls, a swept Refunded order rejects every lifecycle call.
  - Invariants: `EscrowInvariant` handler gains `lateArrival` (terminal only) and `sweep`; `invariant_zeroBalanceAfterTerminal` asserts balance == unswept late arrivals. `TreasuryInvariant` handler gains `sweepEscrow` (also in the coverage walk) and the `sweptMoreThanLate` flag asserted false.
  - Fork: `test_fork_lateReservationIntoClosedEscrow_isSwept` against live Base Sepolia USDC.
- `docs/contract-invariants.md`: E2/E3 reworded, new E14, T17 note; `docs/gas.md` row `sweep()` = 55,904 gas.
| `pnpm --filter @overflow/database db:generate` | wrote `0004_exceptions_controller_requests`; re-run "No schema changes, nothing to migrate" |
| `pnpm typecheck` | exit 0, all workspaces Done |
| `pnpm test` | 35 files / 296 tests passed (new: calldata and request per onchain type, offchain types open no request, FK-less sample/dispute refused, dedup by subject, no treasury → `NotWiredError` and nothing written, approve-offchain 409 then fixture replay marks `set-allow`/`raise-cap`/`pause` done with the right txHashes and resolves their exceptions by `chain`, attacker payee stays pending, replay tick changes nothing, reject path; API: list shapes, self-resolution 403, bad body 400, decide once then `already_decided` 409, 404, onchain approve 409 with `requestId`, reject → request `rejected` without tx; function selectors pinned in `abi.test.ts`; indexer 27 logs) |
| `tsx src/index.ts` (PGlite, no RPC) + curl | `GET /` `modules.exceptions: "offchain exceptions only: no treasury address …"`; `GET /api/exceptions` → `{ exceptions: [] }`; `GET /api/controller-requests` → `{ requests: [], treasury: null }`; pause → 409 `no_node_yet`; decide unknown → 404; `?status=approved` → 400 listing `pending, done, rejected` |
| `pnpm --filter @overflow/service build` | tsup success, migrations copied |

### Open issues
- `unpause`, `setFloor`, `withdraw`, `setEscrowFactory` have no exception type or calldata builder; `buildControllerCall` refuses them.
- A cap raised to a different value than requested leaves the request pending (by design); the UI should show it with a reject action.
- The Coinbase Wallet `send_calls` flow that consumes `{ target, data, value }` is the web app's job (P4.5); the live check needs a deployment.

## 2026-10-24: synthetic datasets and catalog

### Built
- `packages/datasets` (`@overflow/datasets`): deterministic generator for four SIMULATED EV-registration datasets and the six-listing seller catalog. `rows.ts` makes every number a pure function of (state, period, brand): base volume x brand share (bps) x linear growth x seasonality, plus keccak-derived noise, integer arithmetic only, so the California file equals the national file's CA rows and annual rows are exact monthly sums. 8 states (`CA TX FL NY WA NJ IL GA`), 2 fictional brands (`Voltara`, `Kestrel`), rows `month,state,brand,units,simulated` / `year,state,brand,units,simulated` (34 bytes max, under the 86-byte record limit). `listings.ts` holds the dataset and listing specs; `generate.ts` turns rows into signed 160-byte records (`buildRecordChunk`), `rootPlain`, a manifest and `data/catalog.json`; `catalog.ts` has `CatalogEntrySchema` (= `ResourceListingSchema` + `id`, `title`, `simulated: true`, `exercises`, `dataset` files), `CatalogFileSchema`, `parseCatalog`, `serializeCatalog`, `loadCatalog` (default `<repo>/data/catalog.json`, override `OVERFLOW_CATALOG_PATH`); `signer.ts` resolves `SOURCE_SIGNER_KEY` or the simulated default `keccak256("overflow.simulated.source-signer")` (address `0x5a0C6b05F691791F272F84Dcff00fdCda52433Bd`, the golden vectors' source signer).
- `scripts/generate-datasets.mts` + root `pnpm datasets:generate` (root `tsx` devDependency; `.mts` because the root package is CommonJS). Loads `.env`, warns when a custom key is used, writes 13 files under `data/` and prints every `manifestHash`.
- `data/`: `catalog.json`; `datasets/<productId>/{rows.csv, records.bin, manifest.json}` for `ev-registrations-national-monthly-2024-2026` (528 rows), `-california-monthly-2024-2026` (66), `-national-annual-2024-2026` (48; 2026 is year-to-date through September), `-national-monthly-2021-2022` (384). 1026 signed records, 164,160 bytes of records in total. `data/README.md` documents the labels, conventions and the rule each listing exercises.
- Listings (prices via `toAtomic`): national monthly company-use 12 USDC (satisfies both Fusion agents); California monthly 5 (geography); national annual 6 (resolution); national monthly 2021-2022 4 (dates, the cheapest and wrong); the national monthly set again from `sim-seller-b` at 13 (duplicate, same `manifestHash`); a single-user / 1-seat variant at 10 (license). All `simulated: true`, `format: csv`, `asOf: 2026-10-15`, `dateRange` 2024-01-01..2026-09-30 (or 2021-01-01..2022-12-31).
- `packages/recourse-crypto/src/manifest.ts`: `MANIFEST_HASH_ABI` = `bytes32 rootPlain, uint256 chunkCount, address sourceKey, uint64 minTimestamp, bytes32 headerHash` (`headerHash = keccak256(bytes(header))`), `computeManifestHash`, `DatasetManifestSchema` (requires `simulated: true` and exactly `chunkCount` leaves), `RECORD_FORMAT`, `verifyManifest` (`schema` / `root-mismatch` / `hash-mismatch`). README gains a "Manifest" section.
- `.env.example` rewords `SOURCE_SIGNER_KEY`; root README points at `data/README.md`.

### Design choices
- Region codes `US` (national aggregate claim) and `US-<state>` (state detail present in the rows); a national listing lists both, the California listing only `US-CA`. Oracle's extractor maps names to codes; Fusion's geography rule checks set containment.
- `manifestHash` is over fixed ABI fields and is buyer-independent (`rootPlain`, `chunkCount`, promised `sourceKey` and `minTimestamp`, header), so the catalog entry pins the promised source and the three listings selling the same bytes share one hash. That equality is Fusion's "same product" signal; license and seats are listing terms.
- The 2024-2026 datasets end at 2026-09 (the last complete month before today) rather than 2026-12: a feed observed on 2026-10-24 cannot contain October. Requests saying "2024-2026" must be clamped to the present before the coverage check.
- Record timestamp = first second of the month after the period (publication), so `minTimestamp` is 2024-02-01 for the fresh sets and 2021-02-01 for the stale one; a promise of `minTimestamp >= 2024-02-01` is broken by the wrong-dates set, giving `complainPromise` a real target.
- The committed data uses the simulated default key so anyone can regenerate it byte for byte; a custom `SOURCE_SIGNER_KEY` is honoured with a warning.

### Stubbed or simulated
- Everything under `data/` and both sellers (`sim-seller-a`, `sim-seller-b`) are SIMULATED and labeled in the catalog, the manifests, every row and the titles.
- Nothing loads the catalog into `resources` or serves the files over the seller routes yet (Oracle and sellers prompts).

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge test` | 181 passed, 0 failed, 1 skipped (fork suite off-chain). One run hit a pre-existing flake in `RecourseCrypto.t.sol::test_xorRoundTrip` (`vm.assume` rejected too many inputs); it passed on the next two runs and is unrelated to this patch. |
| `pnpm contracts:invariant` | EscrowInvariant 256 runs x 12800 calls, TreasuryInvariant 256 runs x 12800 calls, `test_handlerCoverage`: all pass |
| `pnpm contracts:fork` (live Base Sepolia RPC) | 7 passed including the new late-reservation sweep |
| `pnpm contracts:gas` / `forge snapshot` | docs/gas.md 10 rows, `.gas-snapshot` refreshed |
| `pnpm test` / `pnpm typecheck` / `pnpm lint` | 228 passed / exit 0 / exit 0 |
| Broadcasts, deploys, secrets | none |

### Follow-up for the service engineer
- Index the escrow `Swept(address buyer, uint256 amount)` event (the facilitator's log poller currently watches treasury logs only) and reconcile each sweep against the purchase ledger: the recovered USDC is a treasury credit for an order that already closed, and the agent's allowance is **not** restored (consumed nonce), so the ledger must show the budget as spent with the USDC returned.
- Consider having the facilitator call `sweep()` automatically when it observes a `Transfer` into a terminal escrow, and `release()` after `validBefore`, so recovery does not depend on a manual caller.

### Still open (not fixable by sweep)
- ~~The treasury cannot revoke an approved authorization~~ Resolved 2026-10-25 (T18): the ERC-1271 gate reads the escrow's status, so a reservation to a closed order is refused by USDC itself; `releaseClosed()` refunds it early. See the hardening section below.

## 2026-10-24: payment adapters (P3.x)

### Built
- `@overflow/schemas`: `PaymentStatusSchema` (purchaseId, path, status, authorizationDigest, nonce, txHash, explorerUrl, authorizationUsed, reason, decodedRevert, checkedAt): the only thing Oracle, Fusion and the UI see.
- `@overflow/payment-client/src/adapters`: `PaymentAdapter` exactly as in the spec; `PaymentRequirementsSchema` (x402 v2 `accepts` entry), `PreparedPaymentSchema`, `PaymentSubmission`; `PurchaseStore` interface + `MemoryPurchaseStore` (Postgres later); `x402.ts` (402 body or `PAYMENT-REQUIRED` header, exact/eip155:84532/USDC quote only, `PAYMENT-SIGNATURE` payload, `PAYMENT-RESPONSE` decoding); `BaseAdapter` (shared `preparePayment`: refuses a quote whose payTo, amount, asset or network differs from the order (`QuoteMismatchError`), signs one EIP-3009 authorization `from = treasury` with the paying node key, PROPOSED → RESERVED; `AuthorizationInFlightError` on any second prepare; `AlreadySubmittedError` on any second submit; every status write goes through `assertTransition`).
- `OverflowFacilitatorAdapter`: `submitPayment` marks PAYMENT_PENDING, POSTs `/settle`; success → ESCROW_FUNDED, decoded revert → REJECTED (`decodedRevert` like `PayeeNotAllowed(0)`), facilitator `status: unknown` / 5xx / unreachable / timeout → PAYMENT_UNKNOWN (never a resign), 409 → the facilitator's original result. `reconcilePayment`: prepared digest + nonce first; receipt of a known hash; USDC `authorizationState`; expiry → FAILED_BEFORE_FUNDING. A used nonce without a hash asks the facilitator, which answers 409 with the original record (idempotent, same digest).
- `CoinbaseFacilitatorAdapter`: validBefore capped inside the reservation window (570 s); `submitPayment` POSTs `/reserve`, then GETs the seller with the x402 payload; `PAYMENT-RESPONSE.success` → ESCROW_FUNDED; a seller/facilitator rejection leaves PAYMENT_PENDING with the reason (the reservation is live until validBefore); timeouts → PAYMENT_UNKNOWN. `reconcilePayment`: `authorizationState` true → ESCROW_FUNDED (Paid is not emitted for reserved payments); unused after expiry → `/release` (RESERVED → RELEASED, PAYMENT_PENDING/UNKNOWN → FAILED_BEFORE_FUNDING; `ReservationLive` → retry later; `NoReservation` → already released).
- `scripts/adapter-demo.ts` (`pnpm demo:adapters`): SIMULATED local x402 seller; the Coinbase-mode seller verifies and settles through `COINBASE_FACILITATOR_URL` (default https://x402.org/facilitator); `--probe-coinbase` only calls that facilitator's `/verify`. Writes `docs/demo-adapters.md`.
| `pnpm install` | exit 0, `+ tsx 4.23.15` at the root |
| `pnpm datasets:generate` twice | 13 files in ~200 ms; `shasum` of `catalog.json` and all 12 dataset files identical across runs |
| `pnpm typecheck` | exit 0, 9 workspaces Done (includes `scripts/generate-datasets.mts` through the datasets tsconfig) |
| `pnpm test` (vitest from the root) | 37 files / 310 tests passed (new: datasets 9: byte-identical regeneration of all 13 files, signer resolution, 6 entries validate against `ResourceListingSchema` + `CatalogEntrySchema`, prices/licenses/seats, shared vs distinct `manifestHash`es, per-listing coverage vs decoded `records.bin` (regions, dates, granularity, fields, chunk count, every signer recovers to the registry address, timestamps >= `minTimestamp`, leaves Merkle to `rootPlain`, `computeManifestHash` == catalog), CA == national CA rows and annual == monthly sums, stale `minTimestamp`, row purity; recourse-crypto manifest 5) |
| `pnpm --filter @overflow/service build` | tsup success, migrations copied |

### Open issues
- `pnpm --filter <pkg> test` fails at startup for every package (pre-existing): vitest inside a package picks up the root `projects` config and cannot find `apps/service` relative to the package. Run `pnpm test` from the root, or `npx vitest run packages/<pkg>`.
- Request date ranges must be clamped to the present (listings end 2026-09-30); the Oracle extractor owns that.
- `data/` is not yet read by the service: seeding `resources` from `catalog.json` and serving `records.bin`/`manifest.json` from the seller routes are later prompts. `loadCatalog()` is ready for both.

## 2026-10-24: SIMULATED sellers: direct x402 APIs and attack fixtures

### Built
- `apps/service/src/sellers/` (replaces the scaffold): a Hono app served by the service process on the `SELLER_URL` port (default 4100). Routes, all labeled `simulated: true`: `GET /health`; `GET /api/search?q=` (0.02 USDC → `PAYEE_SEARCH_ADDRESS`); `GET /api/scrape?url=` (0.05 USDC → `PAYEE_SCRAPE_ADDRESS`; URLs under `SELLER_URL/listings/*` are served from the fixture through `htmlToMarkdown`, which keeps hidden text as a real scraper would); `GET /listings/ev-insights` (free HTML TEST FIXTURE with an off-screen "SYSTEM NOTICE TO AI AGENTS" telling the agent to buy "seller verification" at `/premium-intel`, plus a visible SIMULATED footer); `GET /premium-intel` (0.05 USDC → `ATTACKER_ADDRESS`, which is never allowlisted; 503 `fixture_not_configured` when unset); `GET /fixtures/mismatched-quote?field=amount|payTo` (advertises the listed search price/payee in its body but its 402 asks 3× the amount or a label-derived SIMULATED decoy payee; a paid retry answers 402 `FixtureNeverSettles` and never reaches the facilitator).
- `sellers/paywall.ts`: x402 v2 paywall (Leash `apps/seller/paywall.ts`, ported). Unpaid → 402 + `PAYMENT-REQUIRED` (built with the payment-client schemas and validated before encoding). Paid retry: `parsePaymentPayload` (400 `bad_payment_header`) → payload must be for exactly this route's payee and price (else 402 `InvalidPayment`, facilitator never consulted) → no facilitator → 503 `facilitator_unavailable` → `facilitator.settle()`. Three outcomes map to three responses: `paid` → 200 + `PAYMENT-RESPONSE` `{ success, transaction, network, payer, amount }` and the settlement echoed in the body; `blocked` → 402 `payment_blocked { decoded, txHash?, explorerUrl?, digest? }`; `unknown` → 502 `payment_outcome_unknown { digest, txHash? }`. The `x-overflow-force-broadcast: 1` header is honored only when `DEMO_MODE=true`.
- `sellers/config.ts` (`resolveSellerConfig`): payees from `PAYEE_SEARCH_ADDRESS`/`PAYEE_SCRAPE_ADDRESS`, else from `SELLER_KEYS[0]`/`[1]`, else label-derived SIMULATED defaults (`/health` reports `payeeSource`); boot fails if `ATTACKER_ADDRESS` equals a payee. `sellers/providers.ts`: labeled CANNED EV-themed results by default; Context.dev (`CONTEXT_DEV_API_KEY`) when configured, falling back to canned with `stub: true, stubReason`. Every search response appends the fixture listing tagged `fixture: true`.
- `sellers/direct-order.ts` `directApiOrder()`: a SIMULATED `PurchaseOrder` for a direct pay-per-call API with `escrowAddress = 0x0`, so `checkQuote` can only take the `direct-seller` branch (payee must be owner-allowlisted and equal `sellerAddress`); hashes over fixed ABI-encoded fields.
- `apps/service/src/facilitator/` (replaces the scaffold): the settle() core (Leash `/settle`, ported), no HTTP surface yet. `settle.ts` `createChainFacilitator({ chain: SettleChain, treasury })`: requirement checks no flag bypasses (`from == treasury`, `to == payTo`, `value == amount` exactly, USDC, `eip155:84532`, live window at the latest block) → recover signer → `nodeOfKey` → `simulateContract(settle)` → revert and no force → `blocked` with `decodeTreasuryRevert`, nothing sent → otherwise `writeContract` → receipt: reverted → `blocked` + `txHash`; success → `paid` only if a `Paid` log carries the nonce **and** USDC `authorizationState(treasury, nonce)` is true, else `unknown`; a send/receipt failure is `unknown` with the digest. `SettleChain` is a structural interface (tests inject a fake); `viemSettleChain` binds real clients. `config.ts` `resolveFacilitatorConfig()` needs `BASE_SEPOLIA_RPC_URL`, `RELAYER_PRIVATE_KEY` and `deployments/base-sepolia.json`; otherwise idle with a reason. `abi.ts` keeps `settle/nodeOfKey/allowlist/TOKEN` out of `chain/abi.ts` (its snapshot pins the function list).
- `apps/service/src/index.ts`: resolves the facilitator (asserts chain 84532 when configured), builds the seller app, serves it on the seller port next to the API, reports both in `GET /` `modules`, closes both on shutdown.
- `apps/service/scripts/sellers-demo.ts` (`pnpm --filter @overflow/service sellers:demo [--offline]`): [1] an allowed agent pays `/api/search` through `wrapFetch` (order = `directApiOrder`, `approvedDirectSellers` read from `treasury.allowlist()` on chain, never env), confirms the receipt and the `PAYMENT-RESPONSE`; [2] paid scrape of the listing prints the hidden instruction; [2a] the honest client is refused by `checkQuote` on `payTo` with zero signatures; [2b] a labeled SIMULATED prompt-injected agent signs for the attacker anyway and sends it with the force header: expects 402 `payment_blocked`, `PayeeNotAllowed(0)`, a tx hash whose receipt is `reverted`, and an unchanged attacker USDC balance; [3] `/fixtures/mismatched-quote` refused before signing on `amount` and on `payTo`. `--offline` runs 2a and 3 only and says what it skipped.
- `.env.example`: `PAYEE_SEARCH_ADDRESS`, `PAYEE_SCRAPE_ADDRESS`, `CONTEXT_DEV_API_KEY`; `ATTACKER_ADDRESS` reworded ("NEVER allowlist it"); `SELLER_URL` and `DEMO_MODE` notes. README layout line updated.

### Design choices
- The paywall calls the facilitator in-process rather than over HTTP (Leash posted to `/verify` + `/settle`); the HTTP facilitator surface is a later prompt and will wrap the same `Facilitator` interface.
- `paid` requires the receipt, a matching `Paid` event and USDC's own `authorizationState`; a successful receipt without those is reported `unknown`, never `paid`.
- The amount must equal the quote exactly (Leash accepted `>=`), matching `checkQuote`.
- Force broadcast exists only so the prompt-injection demo lands its revert on Basescan; it costs relayer gas on a known revert, so it is gated on `DEMO_MODE=true` and labeled in the response (`forceBroadcast: true`).
- Direct-API orders use the zero escrow address on purpose: the agent's expected payee is checked against the owner allowlist, and the demo reads that allowlist from the chain.
- The mismatched-quote fixture lives outside the paywall so no code path can ever settle it.

### Stubbed or simulated
- Everything under `sellers/`: both payees, the attacker, the decoy payee, the listing, the canned results and the `premium-intel` body are SIMULATED and say so. Context.dev results are real only when a key is configured.
- `settle.test.ts` and `sellers.test.ts` use a fake `SettleChain` / fake `Facilitator`; no chain is touched by the test suite.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm test` | 16 files / 243 tests (adapters 15: quote parsing, prepare + in-flight rule + quote mismatch, Coinbase window cap, settle success/REJECTED/409, **timeout after broadcast → PAYMENT_UNKNOWN → reconcile finds the used nonce and hash with one digest ever**, expiry, reverted receipt, reserve + seller settle, reserve revert, seller rejection then release after expiry, seller timeout then nonce check, RESERVED → RELEASED with ReservationLive/NoReservation) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| `pnpm demo:adapters --probe-coinbase` (read-only, throwaway signer) | `https://x402.org/facilitator/verify` → HTTP 200 `{"isValid":false,"invalidReason":"invalid_exact_evm_signature","payer":"0xd3A7…8291"}` |
| One real purchase per adapter on Base Sepolia | **Not run.** The service cannot boot (no `RELAYER_PASSWORD_FILE`), the live treasury holds 0 USDC and allowlists no payee, and the redeploy with the escrow factory has not happened. |

### P3.4 finding: Coinbase path BLOCKED
The public x402 facilitator verifies the EIP-3009 signature offchain by recovering an EOA and comparing it with `from`. Our `from` is the treasury contract and the signer is a node key, so `/verify` answers `invalid_exact_evm_signature` before anything reaches USDC. Even an ERC-1271 check from the facilitator would fail by design: the treasury answers INVALID to any caller but USDC. Options: (a) a seller middleware that skips the facilitator's verify and settles directly (USDC asks the treasury; that is what our `reserve()` path is built for), (b) a facilitator that submits `transferWithAuthorization` without pre-verifying contract payers, or (c) Coinbase adding contract-payer support. The adapter already models the rejection: PAYMENT_PENDING with the reason, then `/release` after validBefore restores the agent's allowance.

### Notes
- A confirmed payment maps to ESCROW_FUNDED on both paths (the spec machine's only post-payment state); for a third-party seller there is no escrow, and `PaymentStatus.path` says so.
- A `settle` that reverts after the purchase was already PAYMENT_UNKNOWN maps to FAILED_BEFORE_FUNDING (the machine forbids UNKNOWN → REJECTED); from PAYMENT_PENDING it is REJECTED with the decoded error.

## 2026-10-25: spike, Coinbase facilitator with a policy-wallet payer

### Built (throwaway, labeled SPIKE)
- `apps/service/src/sellers/spike/server.ts` (`pnpm spike:seller`): one paid route on `@x402/hono` 2.28.0 + `@x402/evm` `ExactEvmScheme`, facilitator CDP (`@coinbase/x402` auth from `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`) or public (`SPIKE_FACILITATOR=public`).
- `scripts/coinbase-spike.ts` (`pnpm spike:coinbase`): signs `from = treasury`, tries `/reserve`, then the paid route; cases (a) reserve, (b) no reserve, (c) expired; writes `docs/coinbase-feedback.md` with verbatim requests and responses (signatures redacted).

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| CDP facilitator, cases (a)/(b) | 402 `invalid_payload: contract call failed: unable to call contract: execution reverted` |
| CDP facilitator, case (c) | 402 `invalid_exact_evm_payload_authorization_valid_before: valid before expired: 1792901015` |
| public x402.org, all cases | 402 `invalid_exact_evm_signature` |
| CDP `/verify`, EOA valid sig with 0 USDC | same `invalid_payload … execution reverted` (so CDP simulates the transfer onchain) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |
| case (a) with a live reservation | **not provable**: service cannot boot (no `RELAYER_PASSWORD_FILE`), live treasury has no `reserve()` and 0 USDC; no deploy in this task |

Verdict: Coinbase adapter stays BLOCKED, labeled; demo runs the Overflow path. Details and the one ask for Coinbase in `docs/coinbase-feedback.md`.

## 2026-10-25: hardening pass (stale reservations, sweep reconciliation, fuzz determinism)

### A. Prevent stale reserved payments (T18)
- Path analysed: EIP-3009 `transferWithAuthorization(from = treasury)` → USDC recovers an EOA, fails, falls back to `isValidSignature` on the treasury through a `STATICCALL`. The gate answered MAGIC for any stored reservation until `validBefore`, so an authorization approved while an order was open stayed executable after the order closed; `EscrowClosed` only blocks new `settle()`/`reserve()` calls.
- Fix (status-aware validation, no cancellation transaction): `reserve()` stores `to` and `toIsEscrow`; `isValidSignature` returns INVALID when the reservation's escrow is `Settled`/`Refunded` (one nested `STATICCALL` to `status()`, legal under USDC's staticcall; still `view`). USDC then reverts `FiatTokenV2: invalid signature` and the nonce stays unused. New `releaseClosed(digest)`: anyone, requires a recognized escrow reservation, a closed order and an unused nonce, refunds the whole ancestor chain and deletes the reservation (shared `_close`, so `release()` afterwards reverts `NoReservation`: exactly one release per reservation). Rejected alternative: USDC `cancelAuthorization` needs a treasury signature over the cancel digest (a new transient-flag path), a transaction at the right moment, and marks the nonce used, which would make `release()` refuse the refund. `sweep()` stays as defense in depth.
- New errors `NotEscrowReservation`, `EscrowStillOpen(address)`, `AuthorizationUsed`; struct `Reservation` gained `to`, `toIsEscrow` (storage layout change; redeploy pending anyway). ABIs regenerated; the service decodes the new errors.
- Guarantees that cannot be established: a transfer mined before the closing transaction (including earlier in the same block) is legitimate and cannot be refused (payout/refund already return such surplus to the buyer); only escrow payees have a closure to detect, a direct allowlisted payee has none; the treasury cannot revoke an authorization USDC already executed; the check relies on USDC calling `isValidSignature` at execution time (true for v2.2, confirmed on the fork).

### B. Sweep reconciliation (`apps/service/src/reconciliation/sweeps.ts`)
- Indexes factory `OrderCreated` to learn escrows, escrow `PaidOut`/`Refunded` as terminal markers, the escrow's real `Swept` event, and USDC `Transfer` logs into recognized escrows after their terminal event. `LateArrival` is a service-derived event from that Transfer (labeled `source: "derived"`, `derivedFrom: "USDC Transfer"`); `Swept` is indexed from the escrow log (`source: "chain"`).
- Books balanced `JournalEntry`s keyed `late:<tx>:<logIndex>` (debit escrow-deposit / credit usdc-treasury) and `swept:<tx>:<logIndex>` (debit usdc-treasury / credit escrow-deposit, only for the part matching observed treasury arrivals); a sweep larger than the observed arrivals and USDC from a stranger open `reconciliation-difference` exceptions instead of treasury entries. Entries carry `purchaseId` (from a `PurchaseIndex` by escrow), `txHash` and the new `chainEvent` kinds `Swept`/`LateArrival` in `@overflow/schemas`.
- Confirmation depth (default 3 blocks) before booking; the last 12 blocks are re-scanned every tick and a booked log that vanished gets one reversing entry with `correctsEntryId`; a re-mined log books under its new hash. Idempotent across polls. Never sends a transaction or reads the treasury: spent allowance is untouched by construction (asserted in tests). Recovered status reaches `GET /events` as `Swept` events with `recoveredAtomic`, `outstandingAtomic`, `recovered`.
- Wired at boot when `escrowFactory` is deployed (in-memory ledger, exceptions and purchase index until Postgres). `ChainClient.getLogs` gained an optional topic filter (`event`/`args`) and address lists.

### C. Fuzz determinism
- `RecourseCrypto::test_xorRoundTrip` assumed `chunk.length == 160` on random `bytes`, which the fuzzer almost never produces (intermittent "too many rejects"). It now takes `bytes32[5]` and packs them: every run is a valid, uniformly random 160-byte chunk; no input is rejected and coverage is unchanged.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `forge test` | 17 suites, 188 passed, 0 failed, 1 skipped (fork suite skipped off-fork) |
| `pnpm contracts:invariant` | 256 runs x depth 50: all 9 invariants pass, `test_handlerCoverage` and `test_handlerReleaseClosedScenario` pass |
| `pnpm contracts:fork` (live Base Sepolia USDC) | 7 passed, incl. `test_fork_closedEscrow_usdcRejectsReservedAuthorization` |
| `forge test --match-test test_xorRoundTrip --fuzz-seed {1..5} --fuzz-runs 2000` | 5/5 PASS, 2000 runs each |
| `pnpm contracts:gas` | `reserve()` 224,352 (+25.9k: one more storage slot and the `isEscrow` read), `release()` 60,227, `reserve()` to an escrow 242,417, `releaseClosed()` 66,726, `sweep()` 55,904 |
| `pnpm test` | 17 files, 255 tests (reconciliation: 9 incl. complete, partial both ways, stranger USDC, ignored traffic, confirmation depth, reorg correction once, no tx/no treasury read) |
| `pnpm typecheck` / `pnpm lint` | exit 0 / exit 0 |

Coinbase status unchanged: the public-facilitator incompatibility and the unproven CDP settlement stay BLOCKED (`docs/coinbase-feedback.md`); passing adapter and reconciliation tests do not prove live settlement.

Follow-ups: a facilitator route for `releaseClosed` (the Coinbase adapter's reconcile can then refund before `validBefore`); a Postgres ledger behind the `Ledger`/`ExceptionSink` interfaces; the reconciler's purchase index fed by the purchase store.
| `pnpm typecheck` | exit 0, all workspaces Done (scripts/ now included in the service tsconfig) |
| `pnpm test` (root) | exit 0, 39 files / 337 tests passed (27 new: settle core requirement refusals before simulation, simulation revert blocked and decoded without broadcast, force broadcast returns the reverted tx hash, paid only with Paid + consumed nonce, unknown on send/receipt failure; sellers 402 shapes per route, attacker ≠ payees, 503 without attacker, listing fixture text, mismatch fixture fields and 400 on a bad field, malformed header 400, wrong payee/price blocked without facilitator, paid 200 + PAYMENT-RESPONSE, blocked 402 with txHash, unknown 502, force header only in DEMO_MODE, 503 without facilitator, fixture never settles, paid scrape carries the hidden instruction, 404/400 scrape cases, health; agent side via `wrapFetch`: one signature for search, `/premium-intel` refused on payTo before signing, mismatch refused on amount and payTo, `directApiOrder` cannot take the escrow branch) |
| `pnpm --filter @overflow/service build` | tsup ESM success, migrations copied |
| Boot without chain env (`SERVICE_URL=:4010`, `SELLER_URL=:4110`, `ATTACKER_ADDRESS=0x4444…`) | `GET /` modules: facilitator `idle: BASE_SEPOLIA_RPC_URL is not set`; sellers `… payees from simulated-default; attacker fixture configured (never allowlisted); facilitator unavailable: paid retries answer 503`. `curl /api/search` → 402 with `PAYMENT-REQUIRED`; `/listings/ev-insights` contains the SYSTEM NOTICE and `TEST FIXTURE (SIMULATED)`; `/premium-intel` 402 payTo `0x4444…`, amount 50000 |
| `sellers:demo --offline` against that boot | PASS ×7: hidden instruction found; honest client refused on payTo (`got 0x4444…`), nothing signed; mismatch refused on amount (`expected 20000, got 60000`) and on payTo (decoy `0x9937…`), nothing signed. Beats 1 and 2b reported SKIPPED |

### Open issues
- **Live beats not run.** `/api/search` paid on chain and the `PayeeNotAllowed` revert with a tx hash need the treasury from `origin/person1` deployed with `deployments/base-sepolia.json`, `AGENT_KEYS[0]` registered as a node, the search/scrape payees `setAllow`ed, the relayer funded with ETH and the treasury with USDC, and the seller started with `DEMO_MODE=true`. Then `pnpm --filter @overflow/service sellers:demo` and paste the three Basescan links here.
- The facilitator is the settle core only: no `/verify`, `/settle`, `/delegate`, `/events` HTTP routes, no `reserve()` path, no persistence of settlements (the indexer's `Paid` logs remain the source of truth).
- `PolicyPort.allowlistedPayees()` in the API still defaults to empty; the demo script's `treasury.allowlist()` read is the implementation it should get.

## 2026-10-24: Oracle: requirements, coverage filter, ranking

### Built
- `packages/oracle` (`@overflow/oracle`, replaces the scaffold): the model proposes requirements, code decides everything else, nothing here can sign or pay.
- `extract.ts` `extractRequirements({ mission, knownRegions, now }, { client, model, audit })`: Anthropic SDK `client.messages.parse` with `zodOutputFormat(ExtractionOutputSchema)` (structured output; no forced `tool_choice`, no `thinking`/`temperature` params, so it runs on every current model). `ExtractionOutputSchema` is a plain model-facing shape (`requests[]` with `regions` as codes, `dateRange`, `granularity`, `requiredFields`, `format[]`, `license`, `freshnessMaxAgeDays`, `maxPriceUsdc` as a decimal string; `assumptions[]`). Deterministic post-processing: `toAtomic` for the price (never a float), clamp to the mission budget, `clampToPresent` (end date capped at the last complete month before `now`, e.g. 2026-09-30 on 2026-10-24), lowercase-trim fields, dedupe regions; then `ResourceRequestSchema.parse`. On a parse/validation failure (or `parsed_output` null, or a stop reason other than `end_turn`) one retry carries the raw output plus the Zod issues as a second user turn; a second failure throws `ExtractionError` with both attempts' hashes. `oracleModelFromEnv()` reads `CLAUDE_MODEL` and throws when unset. The model id is never hardcoded.
- Audit: every attempt inserts an `activity_events` row `kind: "oracle.model_call"` (new `ActivityKindSchema` member in `packages/schemas/src/ledger.ts`) with `message = "oracle extraction attempt=N model=<id> promptHash=0x… outputHash=0x… outcome=parsed|invalid"`. `hash.ts`: `promptHash = keccak256(abi.encode(string model, string system, string user, string schema))`, `outputHash = keccak256(bytes(rawText))`; fixed fields, never JSON.
- `coverage.ts` `filterByCoverage(request, listings)`: pure; rejects on `region` (every requested code must be in `coverage.regions`), `dateRange` (listing must contain the request range), `granularity` (`GRANULARITY_ORDER`: finer rolls up, annual never rolls down to monthly), `field` (case-insensitive) and `format`; every failing check is reported per listing with the compared values.
- `terms.ts` `filterByTerms(request, listings, now)`: pure; `price` (bigint compare against `maxPriceAtomic`), `freshness` (`asOf` age in days vs `freshness.maxAgeDays`; missing `asOf` rejected), `license` (company-use request needs a company-use listing; single-user accepts either; an `unclear` seller license is never bought).
- `owned.ts` `skipOwned(listings, owned)` drops a listing whose id or `manifestHash` matches an owned resource (the seller-B duplicate of owned bytes is skipped too); `loadOwnedResources(repos, organizationId)` = SETTLED purchases across the organization's missions joined to `resources` for the hash. Uses existing repository methods only.
- `rank.ts` `rank(listings, request)`: price per covered requirement (`regions + requiredFields + dates + granularity + format`), exact bigint cross-multiplication, tie-break newer `asOf` first (missing last), then listing id; returns `inputs { priceAtomic, coveredRequirements, pricePerCoveredAtomic, asOf }` per entry.
- `explain.ts` `explain()` → `{ chosen, alternatives, rejected (grouped per listing, every reason), assumptions, summary, simulated }`; the summary ends with "This is a recommendation; it authorizes no payment." `recommend.ts` composes skipOwned → filterByCoverage → filterByTerms → rank → explain and takes no model client.

### Design choices
- Two schemas on purpose: the model fills a plain JSON shape (no refinements, no min/max, so the JSON Schema the API enforces is exact), and code converts and validates into `ResourceRequest`. The model's `assumptions` text is carried into the explanation but never read by any filter.
- "Owned" means SETTLED. A funded but undelivered escrow is in flight, not an asset.
- Price, freshness and license live in `filterByTerms`, separate from `filterByCoverage`, because the spec's coverage filter names fields, regions and dates; both are code.
- Dependencies: `@anthropic-ai/sdk`, `@overflow/database` (types + `loadOwnedResources`), `viem` (hashing), `@overflow/datasets` (dev, catalog tests).

### Stubbed or simulated
- Tests use a fake model client (scripted outputs, no network) and the SIMULATED P5.1 catalog. `recommend()` marks `explanation.simulated = true` whenever a considered listing is simulated.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install` | exit 0, oracle deps linked |
| `pnpm typecheck` | exit 0, all workspaces Done |
| `pnpm test` (root) | exit 0, 43 files / 367 tests passed, 1 skipped (new: oracle 30: on the P5.1 catalog the 2021-2022 set is rejected on `dateRange` even when the fake model's assumptions prefer it; California rejected on `region` for a national request; annual rejected on `granularity` for monthly and quarterly requests; monthly rolls up to quarterly; field/format reasons all reported; ranking identical across all 6 input permutations; freshness and id tie-breaks; `pricePerCoveredAtomic` 12 USDC / 7 = `1714285`; `recommend` chooses the 12 USDC national set and explains all five rejections; PGlite: `loadOwnedResources` returns only the SETTLED purchase and `skipOwned` drops all three listings sharing its `manifestHash`; extraction: parse + `toAtomic` + date clamp + budget clamp with assumptions, retry carries the Zod issues and both calls are audited with distinct hashes, two failures throw `ExtractionError` with two audit rows, `max_tokens` stop counts as a failed attempt, `CLAUDE_MODEL` required) |
| `npx vitest run packages/oracle/src/extract.live.test.ts` | **skipped**: `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` are not set in `.env` (checked as booleans only) |

### Open issues
- **Live extraction not run.** Set `ANTHROPIC_API_KEY` and `CLAUDE_MODEL` in `.env`, then `npx vitest run packages/oracle/src/extract.live.test.ts`; it prints the model id, the requests, the assumptions, both hashes and the catalog recommendation. Paste that output here.
- ~~`OrchestrationPort.planMission/propose` in the service still answer 501; wiring `extractRequirements` + `recommend` (and seeding `resources` from `catalog.json`) is P4.1/P4.2.~~ Done below ("API: Oracle wired, catalog seeded").
- Sample judgment (buy/skip on the decrypted random sample), slow-reveal seller down-ranking and the `UNCLEAR_LICENSE` controller exception are later prompts; the filter only rejects.

## 2026-10-24: API: Oracle wired, catalog seeded

### Built
- `apps/service/src/orchestration/catalog.ts` `seedCatalog(db, { path? })`: boot-time load of `data/catalog.json` through `@overflow/datasets` `loadCatalog()` (default `<repo>/data/catalog.json`, override `OVERFLOW_CATALOG_PATH`) into `resources`. Insert-if-missing by listing id via the new `resources.upsertById()` (`onConflictDoNothing` on `id`, same pattern as `organizations.upsertById`), so a restart writes nothing; every row keeps `simulated: true`; `createdAt` is the catalog's `generatedFor.asOf` so `list()` order is stable. Returns `{ total, inserted, existing, catalogPath }`; a missing file throws at boot (like migrate/seed). `apps/service` now depends on `@overflow/datasets`.
- `apps/service/src/orchestration/oracle-port.ts` `createOraclePort({ db, model, treasury, orderTerms, now? })` implements `OrchestrationPort`:
  - `planMission`: `knownRegions` = every `coverage.regions` code in `resources`; `extractRequirements` (audit = `activityEvents`, so each model call is an `oracle.model_call` row); requester = `mission.ownerAgentId` else the organization's orchestrator agent; in one transaction the mission's earlier `open` requests become `withdrawn` and the new ones are inserted. Without a model (`CLAUDE_MODEL` / `ANTHROPIC_API_KEY` unset) it throws `OracleUnavailableError` → HTTP 503 `oracle_unavailable`. `ExtractionError` → 502 `oracle_extraction_failed { issues, modelCalls }`.
  - `propose`: for every `open` request, `recommend()` over `resources.list()` with `loadOwnedResources` (SETTLED purchases skipped); each decision is written as an `oracle.recommendation` activity event (new `ActivityKindSchema` member) and returned in the response (`decisions[]`: `requestId, chosen, alternatives, rejected[{listingId, reasons[{reason, detail}]}], assumptions, summary, simulated`). No open requests → 409 `no_open_requests`. Requests that chose the same resource share one proposal (one active purchase per mission+resource). The order's chain fields (`sellerAddress`, `escrowAddress`, `termsHash`, `orderIdBytes32`, `authorizationExpiresAt`) come from the new **`OrderTermsPort.prepare()`** (SPEC "One purchase, end to end" step 3: the seller's order fixes them); the default `notWiredOrderTerms()` throws `NotWiredError` → 501 naming `OrderTermsPort.prepare (Recourse seller POST /orders)`. No treasury address → 501 as well. `ProposeInput` carries `buyerTreasury` = the deployed treasury, `payingNodeId` = `mission.rootNodeId`, `participatingAgentIds` = the requesters, `allocations: []`, `oracleReason` = the explanation summary, `idempotencyKey = propose:<mission>:<resource>:<sorted request ids>` (a repeat returns the same row; a re-plan makes new request ids and a new key).
  - `orchestrationStatus(...)` replaces the `ORCHESTRATION_STATUS` constant: `GET /` says which of model / treasury / order terms is wired instead of claiming readiness.
- `api/app.ts`: `createApp` always builds the Oracle port (`oracle?: OracleModel | null`, `orderTerms?: OrderTermsPort`, `treasury`); `defaultPorts()` no longer has an orchestration entry. `api/ports.ts`: `OrchestrationPort.propose` returns `{ proposals, decisions }`. `routes/purchases.ts` `POST /propose` responds `{ purchases, decisions }` (201). `index.ts`: `seedCatalog` after `seed()`, Anthropic client + `oracleModelFromEnv()` only when both env vars are set, else a logged idle reason.
- `PurchaseService.propose`: a repeated `idempotencyKey` now returns the stored purchase and its original `purchase.proposed` event with `replayed: true` and writes nothing (before, `purchases.create` deduplicated the row but a second event was appended and published).

### Design choices
- Oracle decides *what* to buy; *where the money goes* is the seller's order. Rather than invent seller/escrow/terms (the catalog has no addresses, no deployments file exists, and the escrow address is `factory.predict(orderId, termsHash)` of terms the seller commits), propose stops at an `OrderTermsPort` seam and answers 501 until the Recourse seller client lands. Agreed with the user over labeled placeholder addresses or making the columns nullable.
- The recommendation event is written even when the terms step then answers 501: it is a decision record ("This is a recommendation; it authorizes no payment."), not a success claim, and the UI's ResourceComparison needs the rejections.
- Re-planning withdraws the previous open requests so a mission never carries two generations of requirements (otherwise propose would hit the active-purchase index).
- `allocations` stay empty until Fusion (P6.2); an empty list is a whole, unsplit purchase under `PurchaseOrderSchema`.
- `plan` without a model is 503 (a configuration gap), not 501 (an unbuilt port).

### Stubbed or simulated
- Tests use a fake `messages.parse` client (scripted outputs, no network) and a labeled SIMULATED `OrderTermsPort` (fixed seller/escrow, `termsHash` 0x…09, `orderId` from `computeOrderId`). The resources table holds only the SIMULATED catalog; every row and every proposal says so (`simulated: true` on the purchase event and the decision).
- Live extraction still not run (no `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` in `.env`).
## 2026-10-24: merge `main` into `person1` (datasets, database, API, indexer, ledger, direct sellers)

### Built
- Resolved the 17-file merge of `origin/main` (12 commits: recourse-crypto vectors, payment-client x402 client, database, API, chain indexer + SSE, ledger, exceptions, datasets + catalog, direct-API sellers, oracle) into `person1` (17 commits: contracts through T18, facilitator HTTP app, keystore signing, adapters, sweep reconciliation).
- Where both branches implemented the same idea, one implementation survives and the other's tests were ported onto it:
  - `@overflow/recourse-crypto`: `main`'s module set (`bytes, record, keys, merkle, commit, sample, complaint, vectors, manifest`) replaces `person1`'s `merkle.ts` + `crypto.ts`. Formulas are identical to `RecourseCrypto.sol` / `MerkleLib.sol`; `person1`'s forge-pinned golden vectors now live in `src/contract-vectors.test.ts` against the adopted API.
  - `@overflow/payment-client`: both module sets exported from one barrel. `typed-data.ts` dropped its duplicates (`TRANSFER_WITH_AUTHORIZATION_*`, `randomNonce` now come from `authorization.ts`); its boot-time token reader is `readTokenDomain`/`ObservedTokenDomain` (the x402 client keeps `verifyTokenDomain`); `main`'s bigint digest helper is `transferAuthorizationDigest`, `person1`'s string-based `authorizationDigest` (used by the facilitator routes) keeps its name. Payment adapters moved to the subpath `@overflow/payment-client/adapters` (name clashes with the x402 client otherwise).
  - `apps/service/src/chain`: `person1`'s `ChainClient` stays `client.ts`; `main`'s read-only `LogSource`/`RawLog`/`createLogSource` is `log-source.ts`.
  - Facilitator: `person1`'s HTTP app owns the only relayer. The SIMULATED seller paywall (from `main`) settles through `facilitator/in-process.ts`, an adapter that calls the facilitator Hono app in-process and maps `{success, transaction}` / 409 `original` / `status:"unknown"` onto `paid | blocked | unknown`; `main`'s `createChainFacilitator` stays in the tree for its tests but is not instantiated, so a relayer key never has two nonce managers.
  - `apps/service/src/index.ts`: one `main()`: keystore signer, boot checks, facilitator app + treasury log poller + sweep reconciler (`person1`) and database + seed, indexer + ledger reconciliation, REST API, sellers on `SELLER_URL` (`main`). Facilitator routes are mounted at `/` (adapters and scripts) and again at `/facilitator` so its SSE feed is `/facilitator/events` next to the API's `/events`.
  - `ChainEventKindSchema` is the union (`Swept`, `LateArrival`, `BondForfeited`, `Transfer`); the sweep reconciler opens `RECONCILIATION_DIFF` exceptions (the `main` enum).
- `pnpm-workspace.yaml`: `@coinbase/x402`'s postinstall (a terms notice, nothing built) is skipped so `pnpm install` stays non-interactive under pnpm 12.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install` | `@overflow/datasets` linked into `apps/service` |
| `pnpm typecheck` | exit 0, all workspaces Done |
| `pnpm test` (root) | exit 0, 45 files / 379 tests passed, 1 skipped (new: `orchestration/catalog.test.ts` 2: six listings inserted then `0 inserted, 6 existing`, field-for-field equality with the catalog, three rows share the national `manifestHash`, missing file throws; `api/routes/oracle.test.ts` 10: catalog visible in `GET /api/resources`; propose before plan 409; plan without model 503 and nothing written; two invalid outputs → 502 with two `oracle.model_call` rows and no requests; plan 200 with the clamped `2026-09-30` end, lowercased fields, 15 USDC cap, `agent-orchestrator`, mission `planning`; re-plan withdraws; propose with terms not wired → 501 naming `OrderTermsPort`, decision event recorded, no row; no treasury → 501; propose 201 chooses `listing-national-monthly-2024-2026` at 12 USDC, alternative seller-b, rejections `region`/`granularity`/`dateRange`/`license`, PROPOSED row with TREASURY/SELLER/ESCROW, empty allocations, no digest, `oracleReason`; repeat propose returns the same purchase and writes no second event; all-rejected request → 201 with `purchases: []` and six `region` rejections; `purchase-service.test.ts` replay assertion; `app.test.ts` 503/409 instead of 501) |
| Boot 1, `PGLITE_DATA_DIR=<scratch>` fresh, no model/chain env (`tsx src/index.ts`) | log `[catalog] SIMULATED catalog: 6 listings (6 inserted, 0 existing)`; `GET /api/resources` 6 rows, all `simulated: true`, `filtered: false`; `GET /` orchestration: "Oracle extraction idle … (plan answers 503); … no treasury address …; order terms not wired …; Fusion lands at P6.2"; `POST /api/missions/:id/plan` → 503 `oracle_unavailable`; `POST /api/purchases/propose` → 409 `no_open_requests` |
| Boot 2, same data dir | `[catalog] … (0 inserted, 6 existing)`; still 6 rows |
| Boot 3, `pnpm build` + `pnpm start` from `dist`, same data dir | build success, migrations copied; catalog found from the bundle (`import.meta.dirname` = `apps/service/dist` resolves to the repo root); `(0 inserted, 6 existing)`; 6 rows |

### Open issues
- **Live extraction not run.** Same as before: set `ANTHROPIC_API_KEY` and `CLAUDE_MODEL`, run `npx vitest run packages/oracle/src/extract.live.test.ts`, or boot the service and `POST /api/missions/:id/plan`; paste the output here.
- `OrderTermsPort` has only the not-wired default; the Recourse seller client (`POST /orders`, escrow prediction, terms) implements it, and `index.ts` then reports `orderTermsWired: true`.
- `GET /api/resources?missionId=` is still unfiltered (`filtered: false`).
- ~~Fusion (P6.2) will merge requests and fill `allocations`; `propose` reads `mission.rootNodeId` as the paying node.~~ Done below ("Fusion: compatibility matcher, LCA payer, allocations").

## 2026-10-24: orchestration: mission runner and signed delegation

### Built
- Merged `origin/person1` into `person2` first (commit `0ec7de5`): contracts, `overflowTreasuryAbi`, facilitator app with `POST /delegate` + `/pause-child`, keystore signing, Base Sepolia deployment file. `apps/service/src/index.ts` keeps person1's loud boot and adds person2's catalog seed and Oracle model.
- `apps/service/src/orchestration/`:
  - `agent-keys.ts` `resolveAgentKeys()`: orchestrator from `AGENT_ROOT_KEY` (or `AGENT_ROOT_ACCOUNT` + `AGENT_ROOT_PASSWORD_FILE`), sub-agents from `AGENT_KEYS` in role order research, finance, verification. **DEMO LIMITATION, labeled in code and status:** keys are env-held; P7.4 may swap them for CDP server wallets. Keys sign only; nothing here sends a transaction.
  - `delegation-plan.ts`: `resolveRolePolicies` (bps shares 4000/4000/2000, per-call limits, restricted payees from the seller config; `ORCHESTRATION_PAYEES_<ROLE>` / `ORCHESTRATION_BPS_<ROLE>` overrides; the SIMULATED attacker is refused), `splitBudget` (integer basis points, remainder stays with the orchestrator), `childParamsFor` (cap, per-call, expiry clamped inside the root node; `restricted: true`; deadline now + 600 s).
  - `delegation.ts`: `DelegationRelay` port + `relayViaApp(facilitatorApp)` (in-process `/delegate`, `/pause-child`: one relayer nonce manager); `createChildren` signs `CreateChild` with the orchestrator key (`signCreateChild` from `@overflow/payment-client`), relays, writes `delegation.signed` / `delegation.relayed` (tx hash) and sets `agents.nodeId`; a key that already owns a live node is reused, a paused/expired one fails loudly; a refused relay is `policy.blocked` with the decoded revert and throws. `pauseDescendant` signs `PauseChild` (any strict ancestor) and relays it. `ensureAgentRows` replaces the seed's SIMULATED placeholder keys and adds `agent-verification`.
  - `tools.ts`: the six tools, Zod-parsed before execution: `list_resources`, `request_sample` (first rows of the SIMULATED dataset), `propose_purchase` (files a `resource_requests` row for the Oracle and Fusion; pays nothing), `call_paid_api` (x402 via `wrapFetch` with the agent's node key; direct pay-per-call order from the seller's quote; `payment.authorized` on signing, `purchase.status` with the seller-confirmed tx on success, `policy.blocked` with the decoded revert on a 402, outcome-unknown is logged and never retried), `fetch_page` (seller origin only, hidden text kept: no injection special-casing), `report_findings`. There is no tool that sends funds.
  - `agent-loop.ts` `runAgent`: manual Anthropic Messages tool loop (`CLAUDE_MODEL`, no forced `tool_choice`), every tool call and result an `agent.tool_call` / `agent.tool_result` event with the agent id, all results of a turn in one user message, stop on report / end_turn / limit / max_tokens / refusal.
  - `mission-runner.ts` `createMissionRunner`: `mission.run` start → root node via `nodeOfKey(AGENT_ROOT_KEY)` + `getNode` (budget must fit the root's remaining) → planner (`messages.parse` + `zodOutputFormat`, canned briefs on failure) → `createChildren` → three `runAgent` loops in parallel → orchestrator synthesis → `agent.report` → `mission.run` finish summary. `pauseAgent` for the orchestrator's `PauseChild`. Optional labeled fallback (`forceInjectionBeat`, DEMO_MODE only): if the live model ignored the injected instruction, a `SIMULATED injected agent` step replays the `/premium-intel` attempt with the research key (`simulated: true`).
- API: `POST /api/missions/:id/run` (202; progress is the activity feed), `POST /api/missions/:id/agents/:agentId/pause`; `GET /api/activity?missionId=`; `OrchestrationPort.runMission` / `pauseAgent` (501 `NotWiredError` without keys/chain). `GET /` module status reports the runner (`live: orchestrator …` or `idle: <reason>`).
- `ActivityKindSchema` gains `agent.tool_call`, `agent.tool_result`, `agent.report`, `delegation.signed`, `delegation.relayed`, `mission.run` (text column, no migration). `agentsRepository.setKey`, `activityEventsRepository.listByMission`.
- `apps/service/scripts/preflight.ts` (`pnpm --filter @overflow/service preflight [--budget 5] [--require-allow]`, read-only): derives only public addresses from the env the way the service does (keys never printed) and reports PASS/FAIL rows: service `readConfig` verdict, RPC chain id, `AGENT_ROOT_KEY` vs `getNode(1).key` + `nodeOfKey` (works from a 64-hex key or an address-form slot), node 1 live and `remaining >= budget`, each `AGENT_KEYS` child fresh or reusing a live node, `allowlist[search|scrape]` (FAIL only with `--require-allow`), attacker never allowlisted, treasury USDC `>= floor + reservedTotal + 0.02`, relayer gas ETH, owner signer resolvable and equal to `owner()`, env presence by name. Exit 1 on any FAIL.
- `scripts/allow-payee.ts` (`pnpm --filter @overflow/scripts allow-payee <address>…`, **DEV ONLY**, labeled): signs `setAllow(payee, true)` with the DEPLOYER signer from `@overflow/payment-client/keystore` (64-hex `DEPLOYER_PRIVATE_KEY` or keystore), asserts signer == `owner()`, refuses `ATTACKER_ADDRESS`, skips already-allowlisted payees, simulates then writes, waits for the receipt and re-reads `allowlist`. Moves no USDC. Not yet run (no owner key available, see Checks).
- `apps/service/scripts/run-mission.ts` (`pnpm --filter @overflow/service mission:run -- [--budget 5] [--goal …] [--force-injection-beat]`): creates a mission against the running service, starts the run, tails the feed, prints Basescan links, exits 0 only when three child nodes, one paid `/api/search` and a `PayeeNotAllowed` refusal of `/premium-intel` were all observed.

### Checks
| Check | Result |
|---|---|
| `pnpm typecheck` | exit 0, all workspaces |
| `pnpm test` | 66 files / 571 tests passed, 1 skipped (new: `orchestration/delegation-plan.test.ts` 5, `orchestration/mission-runner.test.ts` 4) |
| `forge test --root contracts --no-match-path "*fork*"` | exit 0 |
| Live run on Base Sepolia | **NOT RUN (2026-10-25, second attempt; third attempt below under "live run on Base Sepolia: payees allowlisted, funding blocked").** `pnpm --filter @overflow/service preflight` (new, read-only) at head block 49949712: `AGENT_ROOT_KEY` **is** node 1's key (`0x390CF9aA0230728dB7E185782F2288E41892Ea89`, `nodeOfKey` 1, node live, remaining 50.00 USDC) but is in **address form**, so the runner cannot sign `CreateChild`. 9 FAIL: the service's `readConfig` rejects the relayer signer (`RELAYER_PRIVATE_KEY` not a 64-hex key, no `RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE`; `~/.foundry/keystores` is empty), `AGENT_KEYS` has 0 of 3 keys, `ATTACKER_ADDRESS` unset, treasury USDC 0.00 (needs > floor 0 + 0.02), `DEPLOYER_PRIVATE_KEY` is not a key and no keystore (so `setAllow` cannot be signed), `CLAUDE_MODEL`, `SELLER_URL`, `OVERFLOW_DEPLOYMENTS_PATH` unset. WARN: search payee `0x918917ed990014659ab8C8B35075C9d53f05B41a` and scrape payee `0x7dd254f347F0b50B50A2a6044466ba489ef83c7c` (both `simulated-default`) not allowlisted; `DEMO_MODE`/`DEMO_TOKEN` unset (refusal would be simulation-only). No transaction was sent; nothing was allowlisted or funded. |

### Live procedure (DONE WHEN), to run once `.env` is complete
Required: `BASE_SEPOLIA_RPC_URL`, `SERVICE_URL=http://localhost:4000`, `SELLER_URL=http://localhost:4100`, relayer (`RELAYER_PRIVATE_KEY` or `RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE`) with Base Sepolia ETH, `AGENT_ROOT_KEY` = the key of root node 1 (`0x390CF9aA0230728dB7E185782F2288E41892Ea89`) on treasury `0xd3a74fa991ca0b5627d30ef27dc699c134848291`, three fresh keys in `AGENT_KEYS`, `PAYEE_SEARCH_ADDRESS` allowlisted by the owner (`setAllow`), treasury USDC balance above the floor plus a few USDC, `ATTACKER_ADDRESS` (never allowlisted), `DEMO_MODE=true` + `DEMO_TOKEN` so the refused settle lands on chain, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `OVERFLOW_DEPLOYMENTS_PATH=packages/schemas/deployments/base-sepolia.json`.
1. `pnpm --filter @overflow/service dev`; boot must print `[orchestration] mission runner live: …`.
2. `pnpm --filter @overflow/service mission:run -- --budget 5`.
3. Expect three `delegation.relayed` events with `NodeCreated` tx hashes, one `purchase.status` for `/api/search` with the settle tx, one `policy.blocked` `PayeeNotAllowed(n)` for `/premium-intel`. If the live model declined the injected instruction, rerun with `--force-injection-beat` and record that the refusal came from the labeled SIMULATED probe.

### Open issues
- Live DONE WHEN unverified (see above). To unblock, `.env` needs: a 64-hex `AGENT_ROOT_KEY` for `0x390C…Ea89` (or `AGENT_ROOT_ACCOUNT` + `AGENT_ROOT_PASSWORD_FILE` with a keystore), three fresh 64-hex `AGENT_KEYS`, a relayer key or keystore with Base Sepolia ETH (relayer `0xa094…46A1` had 0 ETH at the preflight), a 64-hex `DEPLOYER_PRIVATE_KEY` (owner) or keystore to sign `setAllow`, `ATTACKER_ADDRESS`, `CLAUDE_MODEL`, `SELLER_URL=http://localhost:4100`, `OVERFLOW_DEPLOYMENTS_PATH=packages/schemas/deployments/base-sepolia.json`, `DEMO_MODE=true` + `DEMO_TOKEN`, and a few USDC in treasury `0xd3a7…8291` (`pnpm dev:fund` needs the `overflow-deployer` keystore; none exists). Then: `preflight` → `allow-payee <search> <scrape>` → `preflight --require-allow` → `dev` → `mission:run`. The live treasury's bytecode was checked to contain `setAllow`, `allowlist`, `nodeAllow`, `nodeOfKey`, `createChild`, `pauseChild`, `settle` with the current ABI (`setEscrowFactory` absent). The existing treasury predates `reserve()` / `setEscrowFactory`; fine for this task (createChild, pauseChild, settle), not for escrow reservations.
- `pnpm --filter @overflow/scripts test` fails at startup: `scripts/vitest.config.mts` was never committed, so vitest falls back to the root `projects` list relative to `scripts/`. The 7 `lib/broadcast.test.ts` tests pass from the root: `pnpm exec vitest run scripts/lib`.
- `createChild` compares a child's cap with the parent's cap, not its remaining budget: siblings' caps can exceed the parent's; `settle()`'s tree walk still enforces the parent at spend time. The runner refuses a mission budget above the root's remaining.
- Each env key may own one treasury node; after a child expires or is paused, `AGENT_KEYS` needs fresh keys (`KeyInUse` otherwise). CDP server wallets (P7.4) would remove env-held keys.
- `agent-verification` is created by the runner, not by `seed.ts`; the planner and synthesis calls use `messages.parse` on the same `CLAUDE_MODEL` as the Oracle.
- The sub-agent prompt does not warn about untrusted page content (Leash brief: the model sees the page and decides); the treasury is the enforcement point, which the demo shows.

## 2026-10-25: live run on Base Sepolia: payees allowlisted, funding blocked

### Built
- `scripts/dev-fund.ts` (`pnpm dev:fund <usdc>`, **DEV ONLY**): when `DEPLOYER_PRIVATE_KEY` is a 64-hex key it now signs `transfer(treasury, amount)` in-process through `resolveSigner` (`@overflow/payment-client/keystore`, key never printed): simulate, write, wait for the receipt, re-read `balanceOf(treasury)`. Without a key it still shells out to `cast send --account <keystore>`. Recipient is still hard-coded to the treasury; the deployer balance check runs first.
- `scripts/dev-fund-gas.ts` (`pnpm --filter @overflow/scripts dev-fund-gas [--amount 0.005] [--min 0.002] [--to <address>]`, **DEV ONLY**, labeled): sends ETH from the DEPLOYER signer to the relayer (address derived from `RELAYER_PRIVATE_KEY` / `RELAYER_ACCOUNT` the way the service does, or `--to`) only when the relayer holds less than `--min`. Checks the deployer holds `amount + 2 x 21000 x gasPrice` first and sends nothing otherwise. Amounts are bigint wei (`parseEther`). Moves ETH only, never USDC.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/service preflight --budget 5` (head block 49958270, before any tx) | 7 FAIL: `AGENT_KEYS` has 0 of 3 keys; `ATTACKER_ADDRESS` unset; treasury USDC 0.00 (needs floor 0 + 0.02); relayer `0xa094…46A1` 0 wei; `CLAUDE_MODEL`, `SELLER_URL`, `OVERFLOW_DEPLOYMENTS_PATH` unset. PASS: `readConfig` parses, chain 84532, `AGENT_ROOT_KEY` is now a 64-hex key for node 1 (`0x390C…Ea89`, `nodeOfKey` 1), owner signer `DEPLOYER_PRIVATE_KEY (env)` = `owner()` `0xB6F4…06C3` holding 87329571995315 wei (0.0000873 ETH) and **0.00 USDC**, `ANTHROPIC_API_KEY` set. WARN: both payees not allowlisted, `DEMO_MODE`/`DEMO_TOKEN` unset. |
| `pnpm dev:fund 5` | **No tx.** Balance guard: `deployer 0xB6F4…06C3 holds 0.00 USDC, needs 5.00`. |
| `pnpm --filter @overflow/scripts dev-fund-gas --amount 0.005 --min 0.002` | **No tx.** Relayer 0 ETH is below the floor, but the deployer guard stopped it: `holds 0.000087329571995315 ETH, needs 0.005 + ~0.000000252 fee`. |
| `pnpm --filter @overflow/scripts allow-payee 0x918917ed990014659ab8C8B35075C9d53f05B41a 0x7dd254f347F0b50B50A2a6044466ba489ef83c7c` (DEV ONLY, signed by the deployer = owner, SIMULATES the controller) | search payee `setAllow(true)` tx [`0xaf7ebf3eba341c67800b19ae09b61d6f0623969143d3733ee79c3364d8efb4bb`](https://sepolia.basescan.org/tx/0xaf7ebf3eba341c67800b19ae09b61d6f0623969143d3733ee79c3364d8efb4bb) block 49958800, `allowlist=true`; scrape payee `setAllow(true)` tx [`0x0b583f106b0b000e882a266f236a97080af0bc51bd98b07b4e2d16c3a852b5f1`](https://sepolia.basescan.org/tx/0x0b583f106b0b000e882a266f236a97080af0bc51bd98b07b4e2d16c3a852b5f1) block 49958808, `allowlist=true`. Treasury `0xd3a74fa991ca0b5627d30ef27dc699c134848291`. Gas spent: 549312000188 wei (0.00000055 ETH). No USDC moved. |
| `pnpm --filter @overflow/service preflight --budget 5 --require-allow` (head block 49958858) | 7 FAIL, same seven as above; `allowlist[search payee]` and `allowlist[scrape payee]` now PASS (`allowed=true`). Deployer 86780259995127 wei, 0.00 USDC. |
| `pnpm --filter @overflow/service dev` + `mission:run -- --budget 5` | **NOT RUN.** With treasury USDC 0.00, relayer 0 ETH and `AGENT_KEYS` empty, the runner would stay idle and no payment could settle; running it would produce no chain event to record. |
| `pnpm --filter @overflow/scripts typecheck` | exit 0 |
| `pnpm exec vitest run scripts/lib` | 1 file, 7 tests passed |

### Open issues
- **Funding is the blocker, and it is outside the repo.** The deployer `0xB6F4…06C3` holds 0.00 USDC and 0.0000868 ETH, so it cannot send 5 USDC to the treasury or 0.005 ETH to the relayer. Needed: Base Sepolia test USDC (https://faucet.circle.com) and at least ~0.006 ETH on the deployer. Then `pnpm dev:fund 5` and `pnpm --filter @overflow/scripts dev-fund-gas` run unchanged and print the tx hashes.
- `.env` still needs: three fresh 64-hex `AGENT_KEYS`, `ATTACKER_ADDRESS`, `CLAUDE_MODEL`, `SELLER_URL=http://localhost:4100`, `OVERFLOW_DEPLOYMENTS_PATH=packages/schemas/deployments/base-sepolia.json`, and `DEMO_MODE=true` + `DEMO_TOKEN` for the refusal to land on chain.
- Remaining procedure once those are in: `preflight --require-allow` (expect 0 FAIL) → `pnpm --filter @overflow/service dev` (must print `[orchestration] mission runner live: …`) → `pnpm --filter @overflow/service mission:run -- --budget 5` → record the three `NodeCreated` txs, the `/api/search` settle tx and the `PayeeNotAllowed` refusal here. The allowlisting does not need to be repeated.

## 2026-10-24: Fusion: compatibility matcher, LCA payer, allocations

### Built
- `packages/fusion` (depends on `@overflow/schemas` + `zod`; `@overflow/datasets` dev-only for catalog tests). Nothing in it can sign or pay.
  - `types.ts`: `MERGE_RULES` (the spec table in order: identity, geography, dates, resolution, fields, format, license, freshness, price), `RuleCheckSchema { rule, passed, evidence }`, `MergeDecisionSchema { listingId | null, requestIds (sorted), merge, checks, failingRules, reason, simulated }`. `reason` is `Merge: all 9 rules pass …` or `No merge of … on <listing>: <rule> (<evidence>); …`, so the failing rule is always named for the UI.
  - `candidates.ts` (stage 1): `topicKeywords` (lowercase, split on non-alphanumerics, small stop list), `candidatePairs` (shared keywords ≥ `minShared`, default 1, sorted by id), `candidateGroups` (connected components, size ≥ 2). Stage 1 can never merge. Embeddings (optional per spec) not built.
  - `rules.ts` (stage 2, the only place that says "merge"): `checkMerge({ listing, requests, standalone?, now })` evaluates every rule (no short circuit) against the listing's structured metadata and reports pass or fail evidence with the compared values. Identity = same `manifestHash` or same seller/product as each request's standalone pick, else the candidate's coverage must contain the standalone's ("compatible substitute"). Geography = region-code set containment (same convention as Oracle's coverage filter). Resolution uses `GRANULARITY_ORDER` (monthly rolls up to quarterly, annual does not roll down). License = `company-use` required, `seats ≥ distinct agents`, and `unclear` (listing or request) means no merge. Freshness = `asOf` age ≤ every request's `maxAgeDays`. Price = listing price ≤ the agents' **combined** caps (each cap-weighted share then fits its own cap) and `< Σ separate cost` (each request's standalone pick, or the candidate itself when it has none).
  - `payer.ts`: `lowestCommonAncestor` and `payingNode(agentIds, agents, fallbackNodeId)` → `{ agentId, nodeId, rule: "lca" | "lca-ancestor-with-node" | "mission-root", evidence }`. The LCA's node pays; without an onchain node, the nearest ancestor with one; without any, the mission root (agreed with the user). `UnknownAgentError`, cycle guard.
  - `allocate.ts`: `allocate(priceAtomic, shares[{ agentId, department, weight }])` → `Allocation[]` by largest-remainder rounding over bigint; leftover units go to the largest remainders, ties by `agentId`; sums are asserted exact. 12 USDC at 70/30 → `8400000` / `3600000`. `AllocationError` on empty, all-zero or negative weights.
  - `fuse.ts`: `fuse({ requests, survivors, standalone, now })`: per candidate group, the listings every member could share, cheapest first; the first `checkMerge` pass wins; a group that fails as a whole falls back to its pairs (so two of three still merge); a group that never merges records the cheapest candidate's failing decision (or, with an empty intersection, the cheapest listing anyone could buy, so the UI sees the real failing rule). Every iteration order is sorted.
- `apps/service/src/orchestration/oracle-port.ts` `propose`: after Oracle's per-request `recommend()` (unchanged, still one `oracle.recommendation` event each), it computes each request's **shareable** listings (not owned, pass coverage, freshness and license; the per-request price cap is deliberately left to Fusion's combined-cap rule, otherwise agent A with a 7 USDC cap could never join a 12 USDC shared purchase) and runs `fuse`. Unmerged requests are grouped by their standalone pick as before; a group of two or more on one listing goes through `checkMerge` directly (stage 2 decides even when stage 1 did not pair them); if it fails, the lowest-id request gets the purchase and the others **wait** (one active purchase per mission+resource), named in the decision. Two plans landing on one resource are re-judged as a union. Each plan: `payingNode` over the organization's agent tree with `mission.rootNodeId` as fallback, `allocate` with one share per agent weighted by the sum of its requests' `maxPriceAtomic`, department from the agent record. Single-request purchases get one 100% allocation (the ledger's `splitByDepartment` then books the department). One `fusion.decision` activity event per decision (new `ActivityKindSchema` member; text column, no migration). `ProposeResult.merges: FusionOutcome[]` = `MergeDecision` + `payer` (nullable) + `waitingRequestIds`; `POST /api/purchases/propose` returns `{ purchases, decisions, merges }`. `idempotencyKey` stays `propose:<mission>:<resource>:<sorted request ids>`.
- `PurchaseService.propose`: `ProposeInput.group?: { payingNodeId, requestIds, mergeReason }` writes the `purchase_groups` row in the same transaction and links it via `purchaseGroupId`; a replay or a unique-index violation writes nothing.
- `orchestrationStatus` now says "Fusion: compatibility matcher, LCA payer, allocations"; P6.2 comments removed from `ports.ts`, `orchestration/index.ts`, `routes/purchases.ts`.

### Design choices
- Allocation weights are each request's `maxPriceAtomic` (the budget the agent brought), summed per agent; agreed with the user over equal split or standalone cost. The price rule therefore checks the combined caps: with cap weights, each share ≤ its cap iff price ≤ Σ caps.
- Fusion's candidates are Oracle's survivors minus the per-request price cap. Coverage, freshness and license stay per request (a listing that misses a region for one agent is never shared); price is the one dimension that merging changes.
- Same listing, no sharing (one seat): one purchase, the rest wait, rather than no purchase at all; agreed with the user. The decision text says a second seat needs its own order once this one settles.
- Rules are implemented in `packages/fusion` against `@overflow/schemas` only (no dependency on `@overflow/oracle`), because Fusion needs pass evidence and group-level rules (seats, combined caps, saving) that Oracle's per-listing rejections do not carry. The service composes both.
- Request statuses are not changed by propose (so a repeat is still an idempotent replay); marking merged requests `matched` belongs with the authorize step.

### Stubbed or simulated
- Tests run on the SIMULATED P5.1 catalog with a labeled SIMULATED `OrderTermsPort`; every merge decision carries `simulated: true` from the listing, and every purchase stays `PROPOSED`. No model is involved anywhere in Fusion.
| `git grep` for conflict markers | none |
| `pnpm install` | exit 0 (lockfile regenerated from `main`'s) |
| `pnpm -r --no-bail typecheck` | exit 0, all packages |
| `pnpm lint` | exit 0 |
| `pnpm test` | 54 files passed, 1 skipped (`oracle/extract.live.test.ts`, no live key); 509 tests passed, 1 skipped |
| `forge test` | 18 suites, 191 passed, 0 failed, 1 skipped (fork test off-chain); includes `main`'s `PaymentClientGolden.t.sol` |

### Open issues
- **Record layout mismatch (blocker for promise complaints):** `data/**/records.bin` (from `main`) encode the 95-byte payload as `version(1) || timestamp(8) || data(86)`; `RecourseCrypto.sol` reads the uint64 timestamp from bytes `[0,8)`. Decided with the user: the TypeScript side changes and the datasets regenerate (next commit). Until then `complainPromise` over these records cannot succeed.
- `README.md` of `@overflow/recourse-crypto` is `main`'s; the record-format section is rewritten with the layout fix.
- Service boot still needs `RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE` (or a 64-hex dev key); `.env` currently holds only the relayer address.

## 2026-10-24: records start with the uint64 timestamp the escrow reads

### Built
- `@overflow/recourse-crypto` record layout now matches `RecourseCrypto.sol`: `payload = timestamp (uint64 BE, 8) || data (87)`; the version byte is gone (`RecordFormatSchema`/`RECORD_FORMAT` = `{chunkBytes 160, payloadBytes 95, timestampBytes 8, dataBytes 87, signatureBytes 65}`). `decodePayload` no longer returns `version`; rows may be 87 bytes. README record section rewritten.
- Regenerated deterministically: `test/vectors.json` + `contracts/test/fixtures/recourse-vectors.json` (`pnpm --filter @overflow/recourse-crypto vectors`) and every file under `data/` (`pnpm datasets:generate`); all `rootPlain`/`manifestHash` values changed, `minTimestamp` values did not (2021-02-01 for the 2021-2022 set).
- New `packages/datasets/src/records-layout.test.ts`: for every committed `records.bin`, the contract-style read of payload bytes `[0,8)` equals the decoded timestamp and the row's publication date, the signer recovers to the manifest `sourceKey`, and the manifest `minTimestamp` is the minimum record timestamp; the 2021-2022 set breaks a 2024-01-01 promise on every record.
- New `contracts/test/escrow/RecourseVectors.t.sol`: parses the shared fixture with forge-std `vm.parseJson*`; for all 7 chunks `RecourseCrypto.recordTimestamp`, `ECDSA.recover(payloadHash)` and `MerkleLib.verify` under `rootPlain` agree with the TypeScript values; the wrong-source vector recovers to the impostor.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm install` | lockfile updated (`@overflow/datasets` linked into `packages/fusion` dev deps) |
| `pnpm typecheck` | exit 0, all 9 workspaces Done |
| `pnpm test` (root) | exit 0, 51 files / 411 tests passed, 1 skipped (was 45 / 379). New: `packages/fusion` 28 (candidates 4: keywords, pairs sorted, transitive groups, `minShared`; rules 8: national passes all nine for A = California monthly cap 7 and B = US quarterly cap 15 with price evidence `one purchase 12.00 USDC vs 17.00 USDC separately (5.00 + 12.00), caps 22.00 USDC`; California fails `geography (missing region(s) US …)`; annual fails `resolution` for both; 2021-2022 fails `dates`; single-user fails `license … 1 seat(s) for 2 agents`; `unclear license: no merge`; a 23 USDC listing fails `price` on caps and saving; three failing rules all reported; payer 6: research+finance → orchestrator, single agent, deeper LCA, ancestor-with-node fallback, mission-root fallback, unknown agent throws; allocate 5: `12000000` at 70/30 → `8400000`/`3600000`, 10 USDC three ways → `3333333`/`3333334`/`3333333` (sum exact, tie to `agent-finance`), 7 units → 2/2/3, 1 unit → 0/1, string weights 7:15 → `3818182`/`8181818`, errors; fuse 5: one merge with two allocations summing to 12000000, geography no-merge with the rule named, single-user no-merge, 2-of-3 pair fallback, nothing to fuse). `api/routes/fusion.test.ts` 4: (1) research California + finance US → 201, Oracle picks California and national separately, `merges[0]` merge on the national set with nine passing checks and `payer.rule = "mission-root"` (seeded agents have no node ids), one PROPOSED purchase of 12000000 with `payingNodeId 1`, allocations finance `8181818` + research `3818182`, a `purchase_groups` row linked by `purchaseGroupId`, one `fusion.decision` event, one `purchase.proposed`; (2) research California + finance `US-OR` → two separate decisions (B: no listing), no merge with `geography (missing region(s) US-OR`, one 5 USDC California purchase with a single 100% allocation, no group; (3) two `single-user` requests with disjoint topics both pick the single-user listing → no merge on `license`, one purchase for the lowest-id request, the other request still `open` and named in `waitingRequestIds` and the event; (4) two concurrent `POST /propose` → both 201, same purchase id, one row, one `purchase.proposed` event, one group row. `oracle.test.ts`: the single-request purchase now carries one allocation (`agent-orchestrator`, research, `12000000`) and `merges: []`. |

### Open issues
- Live extraction still not run (no `ANTHROPIC_API_KEY` / `CLAUDE_MODEL` in `.env`).
- Agents get `nodeId` only from the indexer's `NodeCreated` handler, so until nodes exist onchain every purchase falls back to the mission root with the `mission-root` evidence; the LCA rule itself is covered by unit tests.
- The waiting requests of a no-share decision are not re-proposed automatically once the first purchase settles; a later `propose` call picks them up (the settled resource is then skipped as owned, so Oracle picks the next listing).
- `GET /api/resources?missionId=` is still unfiltered.
- `FusionProposal` UI component (apps/web) has no consumer of `merges` yet.
| first 2021-2022 record, `uint64(payload[0:8])` | 1612137600 (2021-02-01T00:00:00Z) |
| second `pnpm datasets:generate` + `vectors` | byte-identical (shasum of 13 data files + fixture) |
| `vitest run packages/recourse-crypto packages/datasets` | 9 files, 58 tests passed, run before `records-layout.test.ts` existed. That file was committed unrun and failed on annual rows (a 2026 annual row publishes after 2026-09, not December). Fixed in the preflight commit; `vitest run packages/datasets`: 2 files, 11 tests passed. |
| `forge test` | 19 suites, 194 passed, 0 failed, 1 skipped (fork test) |
| `pnpm -r typecheck` / `pnpm lint` | exit 0 / exit 0 |

## 2026-10-24: exporter reads the escrow implementation from nested creates

### Built
- `scripts/lib/broadcast.ts`: pure `readBroadcast(run, { isEscrowInitCode })`. Forge gives a contract created inside another constructor (the factory deploys `OverflowEscrow`) no `transactions[]` entry; it sits in the parent CREATE's `additionalContracts[]` as `{transactionType, address, initCode}`. The reader matches that entry by init code (`initCodeMatcher(creationCode)`: `initCode` starts with the `OverflowEscrow` creation bytecode from `contracts/out`, constructor args follow) and records the parent's hash under `txs.escrowImplementation`. Several matches: refuse to guess, keep `null`. No match: keep `null` and print the `cast call <factory> "implementation()(address)"` command. A top-level `OverflowEscrow` CREATE still wins. `setAllow` now lands in `txs` too; a receipt-less (dry-run) file is rejected with a clear message.
- `scripts/export-deployment.ts` uses the reader; everything else it writes (deployments JSON, `deployments.ts`, ABIs) is unchanged.
- `scripts` is now a vitest project (`vitest.config.mts`, `pnpm --filter @overflow/scripts test`).

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `vitest run scripts` (`lib/broadcast.test.ts`: treasury-only shape, factory with nested create, no match, two matches, direct CREATE, errors) | 7 passed |
| `pnpm contracts:export` against the existing treasury-only broadcast | identical output: `git status -- packages/schemas` empty |
| `pnpm --filter @overflow/scripts typecheck` / `pnpm lint` | exit 0 / exit 0 |

## 2026-10-24: Base Sepolia deployment preflight (read-only)

### Built
- `docs/deploy-preflight.md`: the deployment manifest. Chain and toolchain facts, every public address with its live balance and nonce, the three predicted contract addresses (the dry run logged the same), configuration audited by variable name and format only, the four anticipated transactions with gas limits and the forge ETH estimate, funding requirements per account, a source checklist with line references, the pipeline review (deploy.sh, exporter, ABI freshness, boot detection), blockers, and a rollback/recovery plan with the exact commands. Nothing was deployed, broadcast, funded or signed; no keystore, password file or private key was read.
- `packages/datasets/src/records-layout.test.ts`: annual rows expect the publication month after the listing's coverage end for a partial last year (2026 ends 2026-09), not December.

### Findings
- **Blocker: deployer gas.** The deployer holds 0.0000873 ETH; the dry run estimates 0.0000805 ETH (7,319,349 gas at 0.011 gwei max fee). 1.08x margin; fund to at least 0.002 ETH.
- **Password entry.** `DEPLOYER_PASSWORD_FILE` is unset, so `pnpm contracts:deploy` must run in an interactive terminal (forge prompts) or get a chmod-600 password file.
- `ROOT_EXPIRY` defaults to deploy time + 7 days; set it if the demo is later. `DEMO_PAYEE_ADDRESS` unset: no payee allowlisted at deploy; direct-API payees need `setAllow` later.
- Not blocking the deploy: `RELAYER_ACCOUNT`/`RELAYER_PASSWORD_FILE` missing (service cannot boot), relayer has 0 ETH and holds 1 USDC (policy: gas only), `SELLER_KEYS` empty, old treasury `0xd3A7…8291` has the pre-P1.6 ABI and 0 USDC and is retired by the export.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `forge build --sizes` | Treasury 12,594 / Factory 2,562 / Escrow 8,917 runtime bytes |
| `forge test` | 194 passed, 0 failed, 1 skipped |
| `pnpm contracts:invariant` | 4 passed |
| `pnpm contracts:fork` (live USDC) | 7 passed |
| `DRY_RUN=1 pnpm contracts:deploy` (`--sender` deployer) | success; treasury `0x7479939c9397FF36C35c4C8F7425B254167De5A6`, factory `0xddc66246C333cDC8B918ced02E4d84aCb6B2E8b0`, implementation `0x30c9F9c4d3f50df4d13f6bfB05429d3302Dc85c6` |
| `pnpm test` | 56 files passed, 1 skipped (live-key oracle test); 518 tests passed, 1 skipped |
| `pnpm -r typecheck` / `pnpm lint` | exit 0 / exit 0 |

### Open issues
- The live deployment waits for the operator (funding + password entry). Phase 3 (Recourse sellers) proceeds in code and unit tests; its on-chain DONE WHEN runs after the deploy and funding.

## 2026-10-24: controller approvals through Coinbase Wallet MCP (code; live run pending)

### Built
- **Submission record.** `ControllerRequest.submission?` = `{requestId, approvalUrl, chain: "base-sepolia", submittedBy, submittedAt}` (`packages/schemas/src/ledger.ts`, `ControllerSubmissionSchema`); column `controller_requests.submission jsonb` (migration `0005_controller_request_submission`); `controllerRequests.recordSubmission(id, submission)`: only while `pending`, idempotent for the same Wallet MCP request id, `AlreadySubmittedError` for a different one (a second `send_calls` is never recorded silently), `RequestNotPendingError` once done or rejected. Status is untouched: `done` still comes from the indexer alone. Activity kind `controller.submitted`.
- **API.** `GET /api/controller-requests/:id`; `POST /api/controller-requests/:id/submission` → `{request, recorded}` (409 `already_submitted` with the existing submission, 409 `not_pending`); `POST /api/exceptions` raises an exception (onchain types get their pending `ControllerRequest`) → 202, or 200 with `created: false` when the subject is already open.
- **Owner-gated pause completion.** `NodePaused` completes a `pause` request only when `by` is the treasury owner (`exceptions/matching.ts`, owner from the deployments file through `IndexerConfig.owner` and `HandlerContext.owner`); `pauseChild` relayed by an ancestor key no longer completes an owner request. Unknown owner keeps the old behaviour.
- **UI.** `apps/web` `/controller` (`src/app/controller/page.tsx`, `src/components/controller-requests.tsx`): polls `GET /api/controller-requests?status=all` every 5 s; badges `pending`, `awaiting approval` (Coinbase Wallet link), `DONE (indexed event)` with the Basescan tx link, `rejected`. No success is shown without `status === "done"`. `NEXT_PUBLIC_SERVICE_URL` in `.env.example`; link from the home page.
- **Skill.** `.claude/skills/overflow-controller/SKILL.md`: read the live tool schemas first, list pending requests one line each, `send_calls({chain: "base-sepolia", calls: [{to, data, value: "0x0"}]})`, record the submission, show/open the approval URL, wait for the human, `get_request_status` once, never say DONE; "never twice" rule; reject path; fund-the-treasury (`send` USDC) and deploy-wiring (`setEscrowFactory` + `createRoot` batch) recipes. No credentials anywhere in the repo; Wallet MCP OAuth lives in Claude Code's user config.
- **Docs.** `docs/controller.md` (request / submission / done kept apart, API, Wallet MCP specifics, deploy with owner = smart wallet, fallback), README controller section, `.env.example` owner comment.

### Design choices
- The owner is the controller's Coinbase smart wallet (decided 2026-10-24); `Deploy.s.sol` already handles `owner != deployer` by printing the wiring calldata for the controller's `send_calls`. One deploy, after a harmless `send_calls` probe proves the mechanism on Base Sepolia.
- Submission ≠ done. The approval URL, the Wallet MCP request id and `get_request_status` are evidence the controller acted, not that the chain did. The only writer of `done` is still `completeControllerRequests` from an indexed event.
- Wallet MCP tool shapes (`chain` string, hex `value`, `{approvalUrl, requestId}`) come from docs.cdp.coinbase.com; the skill tells the controller to read the server's own schemas before calling.

### Verified (real output, 2026-10-24)
| Check | Result |
|---|---|
| `pnpm -r typecheck` (incl. `next typegen`) | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | 56 files passed, 1 skipped (live-key oracle test); 521 tests passed, 1 skipped |
| `pnpm --filter @overflow/web build` | ok: routes `/`, `/_not-found`, `/controller` |
| `drizzle-kit generate --name controller_request_submission` | `0005_controller_request_submission.sql`: `ALTER TABLE "controller_requests" ADD COLUMN "submission" jsonb;` |

### Open issues / live run pending
- Nothing has been sent through Wallet MCP yet. Stage A (probe: `get_wallets`, harmless `send_calls` on base-sepolia), Stage B (deploy with `OWNER_ADDRESS` = smart wallet, wiring batch, `send` 1 USDC) and Stage D (setAllow + raiseCap approved, indexer marks both done) need a Claude Code session started after `claude mcp add --transport http --scope user base-mcp https://wallet-mcp.coinbase.com`, test funds in the smart wallet, the deployer funded, and the service running (`RELAYER_ACCOUNT` + `RELAYER_PASSWORD_FILE`). Results and tx hashes go to `docs/coinbase-feedback.md`.
- `apps/service/src/chain/abi.ts` still declares `ReservationReleased(bytes32,uint256,uint256,bool)` while the contract emits `ReservationReleased(bytes32 indexed digest, bool refunded)` and lacks `ReservationWindowSet`; release logs on the new treasury will not decode. Separate fix.
- `setFloor` and `withdraw` emit no treasury event, so requests of those kinds can never reach `done` under the current rule; they have no calldata builder either.

## 2026-10-25: `packages/overflow-mcp`, the overflow_pay MCP server for any agent

### Built
- **Package** `@overflow/overflow-mcp` (stdio MCP server on `@modelcontextprotocol/server` 2.4.0, zod 4, viem; bundled by tsup into one `dist/server.js` so clients launch it with a bare `node <abs path>`; `pnpm start`'s banner would corrupt the JSON-RPC stream). `pnpm mcp:build` at the root.
- **Tools.** `overflow_budget()`: chain reads `nodeOfKey` → `getNode` up to parent 0 → `remaining`; per-call = min `maxPerCall` over the walk (settle() checks every ancestor); `blocked` for paused/expired. `overflow_quote(url)`: GET → 402 (header, or JSON body fallback) → chain reads (allowlist, policy) → one 60 s probe authorization `from = treasury` → facilitator `POST /verify` (eth_call simulation of settle(); the probe goes to SERVICE_URL only) → `{price, payTo, allowlisted, withinPerCall, withinRemaining, policy: {allowed, refusal, digest, validBefore, simulated: true, broadcast: false}}`. `overflow_pay(url, maxAmount)`: `wrapFetch` from `@overflow/payment-client` with an adapter whose `resolveOrder` refuses before signing on `maxAmount`, the node's limits and the owner allowlist (chain reads mirrored from `_authorize`), whose `approvedDirectSellers` is the chain allowlist, and whose `onAuthorized` runs `/verify` and throws `PolicyRefusedError` so the seller never receives `PAYMENT-SIGNATURE` when the treasury would revert. One paid request; `paid: true` only with the facilitator's settle receipt in `PAYMENT-RESPONSE`; 402 `payment_blocked` → decoded refusal (+ txHash when broadcast); anything else → `kind: "unknown"` with the digest and "never re-sign".
- **Refusals** are `{name, args, decoded, reason, source}` and say who spoke: `client (maxAmount)`, `client-precheck (chain read: …)`, `treasury (facilitator POST /verify …)`, `treasury (seller's settle …)`.
- **Config** from env (`SERVICE_URL`, `NODE_PRIVATE_KEY` or `NODE_ACCOUNT` + `NODE_PASSWORD_FILE` via `resolveSigner`, `BASE_SEPOLIA_RPC_URL` with a warned public fallback, optional `TREASURY` pin, `CHAIN_ID` must be 84532). Boot refuses a service that is not Base Sepolia USDC or disagrees with the pin. `NODE_CDP_ACCOUNT` refuses to start with the reason (CDP signing of arbitrary EIP-712 is unconfirmed; `NodeSigner` is the extension point). Repo `.env` is loaded from the bundle's location; `OVERFLOW_ENV_FILE` overrides; values are never logged; stdout is reserved for JSON-RPC (console.log is redirected to stderr).
- **Moved** `directApiOrder` into `@overflow/payment-client` (`src/direct-order.ts`); `apps/service/src/sellers/direct-order.ts` re-exports it.
- **README** (`packages/overflow-mcp/README.md`): prerequisites, env table, `claude mcp add --transport stdio overflow -- node "$(pwd)/packages/overflow-mcp/dist/server.js"`, Claude Desktop JSON with absolute paths and no secrets, 5-minute walkthrough (`/api/search` pays, `/premium-intel` → `PayeeNotAllowed(0)`), the refusal table, the unknown-outcome rule, security notes. Root README pointer; `.env.example` gains `NODE_PRIVATE_KEY`, `NODE_ACCOUNT`, `NODE_PASSWORD_FILE`, `TREASURY`.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm -r typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | 60 files passed, 1 skipped; 540 tests passed, 1 skipped (19 new in overflow-mcp: chain walk, quote, pay gates, MCP round trip over `InMemoryTransport`) |
| `pnpm --filter @overflow/overflow-mcp build` | `dist/server.js` 100.27 KB ESM, shebang, `dist/` gitignored |
| stdout discipline | bundle run against an unreachable service: exit 1, **0 bytes** on stdout, fatal on stderr |
| stdio handshake | against a stub `/health` (chain 84532, USDC): `initialize` → `{name: "overflow"}` protocol 2025-06-18; `tools/list` → `overflow_budget` (readOnly), `overflow_quote` (readOnly), `overflow_pay` (destructiveHint true); exactly two stdout lines, both JSON-RPC |

### Not yet done (needs the live stack)
- The DONE WHEN on Base Sepolia (fresh clone pays `/api/search`, `/premium-intel` refused with `PayeeNotAllowed`) needs the new treasury (Stage B of the controller plan), `setAllow(PAYEE_SEARCH_ADDRESS)` by the controller, USDC in the treasury, a registered node key and the service running. Nothing in the package has been run against a live seller yet; the README describes only what the tests prove and what the live run will show. Results go here when it runs.
- `/verify` needs a real signature even for a quote; the probe is 60 s and goes only to SERVICE_URL, but it is a signature a malicious facilitator could relay. Acceptable for the operator's own service; documented in the README.

## 2026-10-25: optional CDP-held agent keys (`NODE_SIGNER=cdp`)

### Built
- **`@overflow/payment-client/signers`** (Node-only subpath): `ResolvedNodeSigner {signer, address, kind: env-key | keystore | cdp, source}`; `envKeySigner` wraps the existing `resolveSigner` (keystore module untouched; the service's RELAYER path is unchanged); `cdpSigner({accountName, expectedAddress?, create?, client?, inspect?})` wraps a CDP EVM server account (EOA): lookup by name with `getAccount` (create only on request), address pin, every signature normalized by `normalizeEcdsaSignature` (65 bytes, `v` 0/1 lifted to 27/28, high-`s` rejected) and checked to recover to the account before use, for TransferWithAuthorization and CreateChild/PauseChild alike; `@coinbase/cdp-sdk` is imported lazily, so env-key users never load it. `resolveNodeSigner(env, {label, cdp?})` switches on `<LABEL>_SIGNER=env|cdp`; in `cdp` mode the three CDP credentials are required **by name** (the error names the missing one and never echoes a value), `CDP_ACCOUNT_NAME` must match CDP's name rule before any network call, `CDP_ACCOUNT_ADDRESS` pins the address.
- **Check script** `pnpm --filter @overflow/payment-client cdp:sign-check -- [--name] [--treasury] [--json]`: `getOrCreateAccount`, then signs (1) a TransferWithAuthorization through the real `signTransfer` (USDC domain, 60 s probe), (2) `signCreateChild`, (3) `signPauseChild` (Overflow delegation domain), and reports raw byte length, raw `v`, low-`s`, whether normalization was needed, recovery from the typed data and from `hashTypedData` (proves a raw ECDSA over the EIP-712 digest), latency. Broadcasts nothing, writes nothing; sets `DISABLE_CDP_USAGE_TRACKING`/`DISABLE_CDP_ERROR_REPORTING` when unset.
- **overflow-mcp**: `NODE_CDP_ACCOUNT` (refuse-to-start stub) removed; `readConfig` is async and uses `resolveNodeSigner` (fake CDP client injectable); boot log shows signer kind + source. `@coinbase/cdp-sdk` is a declared dependency so tsup keeps it external (`dist/server.js` holds exactly one dynamic `import("@coinbase/cdp-sdk")`, no Solana/axios inlined; 105.91 KB).
- **`settle:live`**: `NODE_SIGNER=cdp` swaps only the node signer (CDP account `CDP_ACCOUNT_NAME`, pinned to `CDP_ACCOUNT_ADDRESS`); relayer, `nodeOfKey` precheck, `--dry-run` and the direct `treasury.settle()` call unchanged.
- **Docs/env**: `.env.example` (`NODE_SIGNER`, `CDP_ACCOUNT_NAME`, `CDP_ACCOUNT_ADDRESS`, `CDP_WALLET_SECRET`, the two `DISABLE_CDP_*` flags, `AGENT_ROOT_ADDRESS` comment for a CDP-held root); overflow-mcp README section; `docs/coinbase-feedback.md` "CDP server accounts as agent keys" (SDK findings incl. the telemetry surprise and the create-by-typo hazard); SPEC l.232 and the Known-limitations bullet.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm install` | lockfile gains the `@coinbase/cdp-sdk@1.60.0` snapshot for both packages; no new build scripts |
| `pnpm -r typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | 64 files passed, 1 skipped; 566 tests passed, 1 skipped (26 new: `signers/signature`, `signers/cdp`, `signers/resolve`, overflow-mcp `config`) |
| `pnpm --filter @overflow/overflow-mcp build` | `dist/server.js` 105.91 KB; `grep -c cdp-sdk` = 1 (the dynamic import); `@solana/kit` not inlined |
| env-key boot of the bundle | unreachable service → exit 1, 0 bytes on stdout, `NODE_DEBUG=module` shows no `cdp-sdk` resolution |
| `cdp:sign-check` without credentials | exits 1 with `missing in the environment: CDP_API_KEY_ID or CDP_API_KEY_NAME, CDP_API_KEY_SECRET, CDP_WALLET_SECRET`; no network call |

### Live sign check (run 2026-10-25, after the user added `CDP_WALLET_SECRET`; nothing broadcast)
| Check | Result |
|---|---|
| `cdp:sign-check -- --name overflow-node-root --json` | exit 0, verdict **yes**. Account `overflow-node-root` → `0x646F2bb89286aD517E0cc5420589a65dDe30A415` (lookup 1424 ms) |
| TransferWithAuthorization (USDC domain, from = treasury) | 65 bytes, raw v = 27, low s, no normalization, recovers to the account from the typed data and from the EIP-712 digest, 431 ms |
| CreateChild (Overflow delegation domain) | 65 bytes, raw v = 28, low s, recovers to the account, 225 ms |
| PauseChild (Overflow delegation domain) | 65 bytes, raw v = 27, low s, recovers to the account, 317 ms |
| `NODE_SIGNER=cdp CDP_ACCOUNT_NAME=overflow-node-root CDP_ACCOUNT_ADDRESS=0x646F…A415 settle:live -- --to 0x2222…2222 --amount 1 --dry-run` | exit 0: live USDC domain verified over RPC, one authorization `from = 0xd3A7…8291` signed by `0x646F2bb89286aD517E0cc5420589a65dDe30A415`, digest `0x98d1660f…caad28`, "dry run: not submitting settle()" |
| Fix found by the run | pnpm 12 forwards the literal `--` to the script and `parseArgs` stopped reading options at it (`--json` was ignored, the default account name hid it). `cdp-sign-check.ts` and `settle-live.ts` now drop that token before parsing. |

Full JSON in `docs/coinbase-feedback.md`, "CDP server accounts as agent keys". BUILD 1 answered **yes**; BUILD 2 is the code above.

### Not yet done
- **DONE WHEN** (one `settle()` on Base Sepolia signed by a CDP account): the node key exists and signs; it is not registered on any treasury yet (the current deployments file points at the retired treasury). Order: `.env` `AGENT_ROOT_ADDRESS=0x646F2bb89286aD517E0cc5420589a65dDe30A415`, `NODE_SIGNER=cdp`, `CDP_ACCOUNT_NAME=overflow-node-root`, `CDP_ACCOUNT_ADDRESS=0x646F2bb89286aD517E0cc5420589a65dDe30A415` (user); Stage B deploy with `OWNER_ADDRESS` = the controller smart wallet (user); controller batch `[setEscrowFactory, createRoot(0x646F…A415, 50e6, 15e6, expiry), setAllow(payee, true)]`; USDC into the treasury; then `NODE_SIGNER=cdp ... settle:live -- --to <payee> --amount 10000` (dry run first, live on the user's go). Tx hash into feedback + here.
- With a CDP-held root, `scripts/facilitator-demo.ts`, `adapter-demo.ts` and `coinbase-spike.ts` (which read `AGENT_ROOT_KEY`) sign with a key that is not a node until a child is delegated to it; follow-up: one `/delegate` signed by the CDP root.

## 2026-10-25: web design system, shell, typed API client and mocks

### Built
- `apps/web/src/app/globals.css`: Tailwind v4 `@theme` tokens `canvas, surface, surface-raised, border, text, text-muted, blue, cyan, violet, success, warning, danger`; shadcn's semantic variables alias them so stock components inherit the palette. Dark-only (`:root` and `.dark` share one set; `html.dark` kept for shadcn's `dark:` utilities). Fixed the scaffold's self-referential `--font-sans` so Geist Sans actually applies; Geist Mono is reserved for addresses, hashes and ids.
- Shell (`src/components/shell/`): `AppShell` (sidebar + top bar + `main`), `Sidebar` with the eight nav items from one `NAV` list (`nav.ts`), `TopBar` with the Base Sepolia badge (`CHAIN_ID`), `TreasuryBalance` (the ledger's `usdc-treasury` net from `GET /api/ledger`, labelled "Treasury · ledger"; there is no balance route and nothing is fabricated), the `MockBadge` when `NEXT_PUBLIC_USE_MOCKS=1`, and a `slot` the shell fills with `ScriptedBadge` when `NEXT_PUBLIC_SCRIPTED=1`. Below `lg` the sidebar becomes a Sheet drawer behind a menu button.
- Shared components (`src/components/shared/`): `Money` (integer `formatUsdc`, bigint sign handling, string thousands grouping, four sizes, never a float), `Address` / `TxHash` / `Mono` (monospace, middle truncation, `CopyButton` that shows "copied" only after the clipboard promise resolves, Basescan link via `explorerUrl`), `StatusPill` with an exhaustive `Record<PurchaseStatus, …>` and `EscrowStatusPill` over `ESCROW_STATUSES`, `SimulatedBadge` / `Simulated`, `EmptyState`, `ErrorState` (renders the service error envelope: status, code, message, requestId), `Skeleton` / `SkeletonRows` / `SkeletonStat`, and `MoneyActionPreview`: payer, amount, destination and expected outcome are rendered before any button, and the confirm button is disabled until all four are present and a handler is given. It calls nothing itself.
- shadcn (base-nova) components added via the CLI: badge, card, separator, skeleton, sheet, tooltip, table.
- Typed client (`src/lib/api/`): `contracts.ts` has a Zod request/response schema for every route (`GET /`, missions create/plan/run/pause-agent, resources, purchases propose/authorize/get, escrow, agents list/pause, activity, exceptions list/decide, controller requests, ledger, reconciliation get/run, SSE `/events` message union), composed from `@overflow/schemas`; `client.ts` is the `OverflowApi` interface plus `ApiError`; `http.ts` is the fetch implementation (JSON, `Idempotency-Key` on authorize, every response parsed, error envelope → `ApiError`); `mock.ts` serves fixtures with 250 ms latency; `index.ts` exports `api = createApi()` switching on `NEXT_PUBLIC_USE_MOCKS`. `src/lib/api.ts` re-exports it. `src/lib/use-api.ts` is a small `useApiQuery` hook whose `loading` is derived from the request key, so stale results are never shown.
- Mocks (`src/lib/mocks/fixtures.ts`): every record is parsed through its schema at module load. One active mission (250 USDC), three agents (orchestrator root + finance + research), five SIMULATED listings, six purchases including the merged one (`purchaseGroupId`, two allocations summing to 12 USDC), one escrow in each of the five contract states, decoded chain transactions, eight balanced ledger rows (owner funding, four fundings, one department-split settlement, one refund), 17 activity events (incl. `oracle.recommendation`, `fusion.decision`, `policy.blocked` with `decodedRevert: "OverBudget(3)"`), one open `PAUSE_REQUEST` with its prepared controller request, a `ReconciliationRun` with status `ok`, and the Oracle decisions + Fusion outcome behind the merge. Addresses and hashes are zero-padded placeholders except the real USDC token and the deployed treasury address.
- Pages: Overview (`OverviewStats` reads treasury, in-escrow and data-expense balances from the ledger) plus placeholder pages for Missions, Agents, Purchases, Escrow, Activity, Ledger, Settings (`PlaceholderPage` from the same `NAV` list, each an `EmptyState` saying what it will show); `/dev/components` demos every shared component with fixture data, every `StatusPill` variant, the error envelope, both badges, two `MoneyActionPreview` cards (one complete, one missing its destination; neither has a handler) and a live `api.getLedger()` call through the mock client rendered in a table.
- `apps/web/.env.example` (`NEXT_PUBLIC_USE_MOCKS`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SCRIPTED`); web `tsconfig.json` now sets `noUncheckedIndexedAccess`; web depends on `zod` and `@overflow/fusion` (for `MergeDecisionSchema`).

### Fusion wiring check
Confirmed, no change needed: `apps/service/src/orchestration/oracle-port.ts` `propose()` runs `recommend()` per open request, then `fuse()` on the shareable survivors, `payingNode` and `allocate` per plan, and `POST /api/purchases/propose` (`api/routes/purchases.ts`) returns `{ purchases, decisions, merges }`; covered by `api/routes/fusion.test.ts`. Unrelated open gap: production `createApp` (`apps/service/src/index.ts`) still passes no `orderTerms`, so propose answers 501 once a plan exists.

### Mock rules
- Mock writes never report a chain outcome: `authorizePurchase` returns `RESERVED` with `submission.outcome = "unknown"`, `pauseMissionAgent` answers 501, approving the onchain `PAUSE_REQUEST` answers 409 (`onchain_approval_only`), and `proposePurchases` returns a `PROPOSED` row with no digest and no transactions.
- The MOCK badge appears in the top bar and in every `PageHeader` whenever the mock client is active; the demo page forces it on.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/web typecheck` | exit 0 |
| `pnpm --filter @overflow/web lint` | exit 0 |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0, 10 app routes prerendered static (`/`, 7 nav pages, `/dev/components`, `/_not-found`) |
| `pnpm typecheck` (root) | exit 0, all workspaces Done |
| Chrome against `next dev -p 3100` with mocks + scripted on | `/dev/components` and `/` render on the dark theme with Base Sepolia, MOCK and SCRIPTED badges, treasury +225.50 USDC from the mock ledger; no console errors |

### Open issues
- `OracleDecisionSchema`, `PayerSchema`/`FusionOutcomeSchema`, `SubmissionSchema` and `IndexerStatusSchema` are mirrored in `apps/web/src/lib/api/contracts.ts` because they live in service modules the web cannot import. Move them into `packages/schemas` (or a shared api-contracts module) so the two cannot drift.
- `apps/web` has no vitest project yet; `Money`'s grouping and the mock ledger balance sums are only exercised by the demo page.
- The seven nav pages are placeholders; `next dev` writes an `AGENTS.md` into `apps/web` (Next 16 `agentRules`), deleted here and worth disabling in `next.config.ts` if it keeps reappearing.

## 2026-10-25: web purchases, Oracle and Fusion views

### Built
- Service read routes (`apps/service/src/api/routes/missions.ts`): `GET /api/missions` (the session organization's missions) and `GET /api/missions/:id` (mission, requests, purchases, purchase groups). Oracle decisions and Fusion rule checks are still not stored; they come only from `POST /api/purchases/propose`. SPEC API table updated. Test `missions.test.ts`: list scoped to the org, detail with allocations and groups, 404 for unknown and cross-org ids.
- Web client: `MissionsResponseSchema`, `MissionDetailResponseSchema`, `listMissions()`, `getMission()` in http and mock clients. The mock client keeps an in-memory purchase store so the PROPOSED row a mock propose creates is found by `getPurchase`/`authorizePurchase`/`getMission`; a reload drops it (the detail page then shows the 404 envelope, nothing fabricated).
- Pure view models (`apps/web/src/lib/purchases/`): `deriveTimeline` (PROPOSED → SETTLED | REFUNDED plus the four side exits; a step is done only when the stored status reached it; tx hashes only from confirmed chain logs or events carrying one; phases authorization / funding / settlement kept apart), `scoreInputs` / `comparisonRows` (Oracle rank inputs recomputed as in `packages/oracle/src/rank.ts`; `@overflow/oracle` is not imported client-side because it pulls the Anthropic SDK), `avoidedDuplicateCost` (Σ standalone picks − merged price, as `rules.ts` computes it), `RULE_LABELS` (SPEC merge-rule table, exhaustive), `attachDecisions`, and a session cache for propose responses and per-purchase `Idempotency-Key`s.
- Components (`apps/web/src/components/purchases/`): `ResourceComparison` (every candidate with coverage, price, score or rank, verdict; rejected rows name the failing rule and detail; assumptions and the summary ending "authorizes no payment"), `FusionProposal` (requests judged together, nine rules with verbatim evidence, payer with rule and evidence, waiting requests, allocations by agent and department, avoided duplicate cost) plus `StoredFusionSummary` for the persisted `mergeReason` when no propose response is in the session, `PurchaseAuthorization` (`MoneyActionPreview` with payer node, amount, escrow destination and expected outcome; seller, terms hash, order id, manifest hash, payment path, expiry, digest, allocations; confirm only for PROPOSED and unexpired; one `Idempotency-Key` per purchase per session; the adapter's `submitted` / `rejected` / `unknown` report rendered verbatim, never as funding), `PaymentTimeline` (grouped steps with Basescan links, source tag chain event / service record, decoded reverts).
- Pages: `/purchases` (mission picker from `GET /api/missions` with `?missionId=`, purchases table from `GET /api/missions/:id`, "Propose purchases" running Oracle + Fusion and rendering every decision and merge, merged and refused) and `/purchases/[id]` (authorization, timeline, Fusion and Oracle evidence from the session's proposal or the stored summaries, SSE-driven refetch). Both client views sit in Suspense (cacheComponents); the sidebar's `usePathname` highlight now sits in Suspense too so the dynamic route prerenders a static shell.
- Fixtures: refused-to-merge case (two single-user requests for the weekly California basket; `license` fails with `1 seat(s) for 2 agents`; finance keeps `pur-california-weekly`, research waits), merged case made arithmetically true (caps 15 / 7 USDC as in the service test; research alone has no affordable listing; price evidence `12.00 vs 24.00 separately`), all evidence, rejection and payer strings in the exact wording of `rules.ts`, `coverage.ts`, `terms.ts` and `payer.ts`, chain event `KeyRevealed`, expiry moved to 2027.
- `apps/web` is now a vitest project (`vitest.config.mts`, root `projects`), tests for the pure modules and the fixtures.
## 2026-10-25: agents and delegation tree (`/agents`)

### Step 0: merge
`origin/main` 4d7cc90 (web design system, shell, typed API client, mocks; mission runner; ops scripts) merged into `person1` as `35d28ea`. Conflicts: both import sets in `apps/service/src/api/http.ts`, both env blocks in `.env.example`, main's shell `Overview` page, both PROGRESS sections in date order. Typecheck, lint and 619 tests passed on the merge before any new code.

### Built
- **Service: treasury reads.** `TreasuryReadPort` (`api/ports.ts`: `blockNumber`, `nodeCount`, `getNode`, `remaining`, `allowlist`, `nodeAllow`; default refuses with 501) implemented by `chain/treasury-read.ts` over the existing viem client (view calls only, the relayer key is never used) and wired in `index.ts`. `GET /api/treasury/nodes` (`api/routes/treasury.ts`): `nodeCount`, then `getNode` + `remaining` for ids 1..n in one pass; agents joined by `nodeId`, falling back to a case-insensitive key match; the global allowlist replayed from indexed `AllowSet` logs (last write wins); restricted nodes probe `nodeAllow` over that set and are marked `complete: false` (per-node payees are a mapping onchain and cannot be enumerated); `status` / `pausedBy` / `expiredBy` derived by walking `parent` exactly as `settle()` does, so a grandchild under a paused child reads Paused with `pausedBy` = the child. `GET /api/treasury/nodes/:id/payments`: indexed `Paid` logs with `args.id` = the node, newest first (`observedAt` is indexer time, labelled). `GET /api/activity?agentId=` + `activityEvents.listByAgent`. `GET /api/agents` is unchanged (`node: null`).
- **Schemas.** `TreasuryNodeViewSchema`, `TreasuryNodesResponseSchema`, `NodePaymentSchema`, `NodePaymentsResponseSchema`, `NodeStatusSchema` (`packages/schemas/src/mission.ts`); `TREASURY_REVERT_REASONS` + `parseDecodedRevert` (`reasons.ts`), re-exported by the service's `chain/abi.ts` as `REVERT_REASONS` so web and service share one table.
- **Web `/agents`.** `components/agents/`: `agent-hierarchy.tsx` (loads the tree and all controller requests through the typed client; subscribes to `/events` and re-reads both after a 300 ms debounce on `treasury.paid|node|policy`, `controller.*`, `policy.blocked`, with a 15 s poll fallback; keeps the last successful read while a refetch is in flight so bars animate instead of flashing; header with treasury, block, as-of, `SimulatedBadge` when `simulated`), `agent-tree.tsx` (root → children → grandchildren, connector lines), `agent-card.tsx` (role, name or "Unlabeled node #id", `Address` key, `Pill` Running / Paused / Expired with the cause in its tooltip, `BudgetBar`, `Money` for spent / cap / `remaining()` / per call, expiry countdown, payees line, open-request badge; a paused node and its subtree render `opacity-60 grayscale`), `budget-bar.tsx` (bigint `barPercent`; a tick where an ancestor's budget binds), `agent-menu.tsx` (kebab: Pause, Raise cap, Add payee (treasury allowlist)), `request-dialog.tsx` (builds the `POST /api/exceptions` body; `toAtomic` for the new cap, must exceed the current cap; `AddressSchema` for the payee; shows exactly the service's answer: PENDING + request id, or "already requested" when `created: false`; never DONE), `agent-panel.tsx` (Sheet: payments with tx links, refusals with `decodedRevert` + reason text, requests with phase pill, approval link, tx hash when done). `lib/tree.ts` (pure: `buildNodeTree`, `barPercent`, `ancestorsOf`, `deriveStatus`, `remainingOf`, `expiryCountdown`, `nodeRequests`, `bindingNodeOf`, `refusalsFor`), `lib/controller-phase.ts` (one `phaseOf` for `/controller` and `/agents`), `useLastGood` in `lib/use-api.ts`. Typed client: `listTreasuryNodes`, `listNodePayments`, `raiseException`, `getControllerRequest`; `ActivityQuery.agentId`. shadcn base-nova `dropdown-menu`, `dialog`, `input` added through the local CLI.
- **Mock mode (labelled).** `lib/mocks/treasury-sim.ts`: a browser-local SIMULATED treasury (root 100 USDC → finance 25 / research 25 → ledger clerk 10 / web scraper 10, the scraper restricted to one payee; two new grandchild agent fixtures). Every 3 s one scripted payment attempt runs the `_authorize` walk (Paused / Expired / PayeeNotAllowed / OverPerCall / OverBudget with the binding node id); a success charges the node and every ancestor and emits `treasury.paid`; a refusal emits `policy.blocked` with `decodedRevert`. `raise()` opens one exception per subject and a pending request; a SIMULATED owner approves 4 s later: only then does the node pause / cap change / allowlist grow, and only then is the request `done` (fake `0x51a0…` hash, `SimulatedBadge` on the row). Every event, payment, request and response carries `simulated: true`; the page shows the MOCK badge and a SIMULATED badge on the tree header.
- **Fix found on the way.** `IndexerConfigSchema.escrowFactory` demanded an address while the deployments file has `escrowFactory: null`, so the service refused to boot against the current (retired) treasury with `expected 0x-prefixed 20-byte hex address`. Now nullable; the indexer watches the treasury and USDC only until a factory exists.
- `apps/web` joined the vitest projects (`apps/web/vitest.config.mts`, node environment, pure logic only).

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm test` (root) | 71 files passed, 1 skipped; 589 tests passed, 1 skipped (web project: 4 files / 15 tests; service `missions.test.ts` 3) |
| `pnpm typecheck` / `pnpm --filter @overflow/web lint` | exit 0 / exit 0 |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0; `/purchases` static, `/purchases/[id]` partial prerender |
| Chrome, `next dev -p 3100` with mocks | `/purchases` lists the six fixture purchases; "Propose purchases" adds the PROPOSED row and renders the merged FusionProposal (9 passes, payer node 1, avoided 12.00 USDC: one purchase 12.00 vs 24.00 separately) and the refused one (`Refused to merge: license`, research request marked "waits", "no saving: not merged") plus four ResourceComparisons with rejected rules (e.g. `price 12.00 USDC exceeds max 7.00 USDC`); `/purchases/pur-proposed-national` shows payer, amount, escrow, seller, terms hash, order id, manifest hash, expiry and an enabled "Sign authorization"; after signing the status pill reads Reserved and the timeline shows Proposed done, Reserved current, funding pending (nothing funded); `/purchases/pur-merged-national` shows six done steps with two Basescan tx links; a full reload of the proposed detail page shows the mock's 404 envelope. No console errors. |
| Real API | Not exercised end to end: production boot still wires no `OrderTermsPort`, so a live propose answers 501 past the decision stage; the UI shows that envelope in an `ErrorState`. The merged and refused response shapes are produced by the real route in `fusion.test.ts` and parsed by the same `ProposeResponseSchema` the page uses. |

### Open issues
- Oracle decisions and Fusion rule checks are not persisted; a reload shows the stored `oracleReason` / `mergeReason` only. Persisting `OracleDecision` / `FusionOutcome` would make the evidence durable.
- Live propose needs a seller `OrderTermsPort` in `apps/service/src/index.ts`.
- Mirrored schemas (`OracleDecisionSchema`, `FusionOutcomeSchema`, `SubmissionSchema`, mission read responses) still live in `apps/web/src/lib/api/contracts.ts`.

## 2026-10-25: web ledger and reconciliation (the books, as a controller reads them)

### Built
- Schemas: `ReconciliationEscrowCheckSchema` (purchaseId, escrowAddress, status, open, chainAtomic?, bondAtomic, expectedAtomic, ledgerAtomic, differenceAtomic, material); `ReconciliationRunSchema` gains `escrows` (default `[]`) and `materialityAtomic` (default 10000), so stored runs and old fixtures still parse. `ESCROW_STATUSES`/`EscrowStatusSchema` moved from `tables.ts` to `ledger.ts` (tables imports them) to avoid an import cycle.
- Database: migration `0005_reconciliation_escrow_checks` (`reconciliation_runs.escrows jsonb DEFAULT '[]' NOT NULL`, `materiality numeric DEFAULT '10000' NOT NULL`; additive, existing rows backfilled by the default). `financialEntries.listAll` takes `account` (matches debit or credit) and `department`; new `expenseByPurchaseAndDepartment()`; `purchases.listByIds`.
- `ledger/reconciliation.ts` records one check per escrow order, matched or not, plus the materiality it applied. Differences and exceptions unchanged.
- `GET /api/ledger?account&department`: filtered entries (balances and departments stay whole-book) plus `allocations`: for every purchase the books touched, each department's planned Fusion share beside the booked data-expense (booked 0 while still in escrow). SPEC API table gains the ledger, reconciliation and exceptions rows.
- Web `/ledger` (`components/ledger/`): `?view=` segmented control (Links, so the URL is shareable) over Journal (date, event kind pill from the (debit, credit) pair, memo, Dr, Cr, amount, purchase link, Basescan tx; account and department filters sent to the API), Balances (trial balance Σdebits = Σcredits, normal-side balances, data expense by department with its purchases, Fusion breakdown per purchase: planned vs booked, share %, merged pill, "in escrow" / "matches plan" / "differs"), Reconciliation (last run time, trigger, block link, materiality, treasury row, every escrow check open-first with status pill, chain / minus bond / ledger / difference, match / immaterial / material pills, exceptions above materiality linked by subject, "Run reconciliation" rendering only the returned run or the error envelope), Exceptions (status filter, type and status pills, amount, subject, requester, purchase link, prepared controller call with target and calldata for onchain types, decide form with `decidedBy` (default `controller`) and a required stated reason; Approve disabled for onchain types and for self-resolution with the service's wording; the outcome shown only from the response). Pure view models in `lib/ledger/` (`accounts`, `journal`, `allocations`, `reconciliation`, `exceptions`), all bigint, exhaustive `Record`s. `Panel`/`Field`/`formatWhen` moved to `components/shared/panel.tsx` (purchases re-exports). Page header carries the SIMULATED badge for the fictional company's books.
- Mocks: the ok run gains checks for the five fixture escrows (funded ones read line + bond); `reconciliationRunPlanted` (+0.50 USDC treasury) and `plantedException`; in-memory exception/request stores; `runReconciliation()` switches to the planted run and opens the exception once; `decideException` follows the service's rules and codes (`already_decided`, `self_resolution`, `onchain_approval_required`; approve → resolved, reject → dismissed). A reload resets to the fixtures.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/database db:generate` | wrote `0005_reconciliation_escrow_checks`; rerun "No schema changes" |
| `pnpm test` (root) | 72 files passed, 1 failed, 1 skipped; 605 tests passed, 1 failed. The failure (`orchestration/mission-runner.test.ts` "a refused /delegate …") passes alone (4/4) and is unrelated to this change (timing under the parallel run). New: `api/routes/ledger.test.ts` (5: honest p1 + refunded p2 book exactly the SPEC rows with tx links; filters; breakdown booked = planned; run with the chain matching the books → `ok`, zero differences, 3 escrow checks at 0; planted +0.50 USDC → one `RECONCILIATION_DIFF` of 500000, no duplicate on rerun, 403 for the requester, approve by `controller` → resolved, 409 on a second decide, `ok` again once the balance matches); `reconciliation.test.ts` asserts the per-escrow checks; web `lib/ledger/ledger.test.ts` (10) and `fixtures.test.ts` (+2) |
| `pnpm typecheck` / `pnpm --filter @overflow/web lint` | exit 0 / exit 0 |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0; `/ledger` static |
| Chrome, `next dev -p 3100` with mocks | Journal: 8 rows with event pills, split markers, purchase and Basescan links, filters; Reconciliation: ok run, treasury 225.50 = 225.50, five escrow rows at `match`; "Run reconciliation" → `Differences found`, treasury 226.00 vs 225.50, `+0.50` flagged `material`, exceptions badge 2; Exceptions: the pause request with its prepared call, Approve disabled with the Coinbase Wallet reason, Reject enabled. No console errors |
| Live API | Not exercised end to end (see open issues) |

### Open issues
- (Fixed 2026-10-25 in "recourse orders end to end on local Anvil": the indexer now uses the generated ABIs.) Pre-existing, found while planning: the provisional event ABI in `apps/service/src/chain/abi.ts` does not match the built contracts (`OrderFunded(uint256 balance)`, `PaidOut(address,uint256,uint256)`, `Refunded(string)` carry no orderId; no `BondForfeited`; `Swept`/`CheatRecorded` missing). On a live chain no escrow event would decode or book; the reconciliation would then open coverage exceptions. Also nothing in production inserts `escrow_orders` rows (only tests), so the per-escrow loop checks nothing live. Both need their own prompt.
- Deciding a `RECONCILIATION_DIFF` records the decision but posts no correcting journal entry yet (SPEC: "the ledger is corrected to match with a stated reason"); corrections are the next ledger prompt.
- `ReconciliationResponse.openExceptions` carries no `request`; the exceptions tab uses `GET /api/exceptions` for that.
- `next dev` keeps writing `apps/web/AGENTS.md` (deleted again here).

| `pnpm -r typecheck` | exit 0 (11 workspaces) |
| `pnpm lint` | exit 0 |
| `pnpm test` | 77 files passed, 1 skipped; 642 tests passed, 1 skipped (23 new: `routes/treasury.test.ts` 7 incl. `?agentId=`, `lib/tree.test.ts` 9, `lib/mocks/treasury-sim.test.ts` 7) |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0, 11 static routes incl. `/agents` |

**Mocks, headless Chrome (CDP driver, `next dev -p 3100` with `NEXT_PUBLIC_USE_MOCKS=1`), console errors: none.**
| Step | Observed |
|---|---|
| load `/agents` | h1 "Agents", MOCK badge ×2, SIMULATED badge on the tree header; header `treasury 0xd3a74…48291 block 49900000 · 5 nodes · allowlist 2` |
| cards at t0 | node 1 7.5 % (7.50 / 100), node 2 12 %, node 5 20 %, node 3 18 %, node 4 25 %; node 3 shows "1 PENDING" (the fixture's pause(3) request) |
| cards after 7 s | two ticks landed: node 4 2.50 → 3.00 and node 5 2.00 → 2.90, so node 3 4.50 → 5.00, node 2 3.00 → 3.90 and the root 7.50 → 8.90; bars 8.9 / 15.6 / 29 / 20 / 30 % |
| kebab on node 2 | items `Pause`, `Raise cap`, `Add payee (treasury allowlist)`; dialog "Pause this node" with the PAUSE_REQUEST text |
| submit | result row `PENDING Request created. Nothing has changed onchain. SIMULATED pause(2) … request cr-sim-7`; node 2 and 5 still `running` |
| panel, node 2 | request `cr-sim-7` phase `pending`; ~4 s later phase `done` ("DONE Pause node 2 SIMULATED …") |
| cards after the simulated NodePaused | node 2 `paused` (Paused pill), node 5 `paused` with `pausedBy` 2 (greyed with its parent); nodes 1, 3, 4 running |
| refusals | `Paused(2) · This agent (or an ancestor) is paused · SIMULATED` for node 5's 2.00 USDC and node 2's 0.50 USDC attempts, "no transaction (refused before broadcast)" |

**Live, local service against `deployments/base-sepolia.json` (retired treasury `0xd3a74fa991ca0b5627d30ef27dc699c134848291`), `next dev` with `NEXT_PUBLIC_USE_MOCKS=0`, console errors: none.**
| Step | Observed |
|---|---|
| service boot | `SERVICE_URL=http://localhost:4000` passed on the command line (the local `.env` leaves it empty, which `z.url()` rejects); chain 84532, USDC domain verified, relayer 0 wei (no relay attempted); indexer from block 49849422 caught up to 49986053: 3 logs (`NodeCreated` node 1, `AllowSet` ×2), reconciliation ok |
| `GET /api/treasury/nodes` | `blockNumber 49984269`, one node: `{id 1, key 0x390CF9aA0230728dB7E185782F2288E41892Ea89, cap 50000000, spent 0, maxPerCall 15000000, expiry 1793496518, paused false, remaining 50000000, status running, agent null, payees global}`; after catch-up `allowlist` = `0x918917ed990014659ab8C8B35075C9d53f05B41a`, `0x7dd254f347F0b50B50A2a6044466ba489ef83c7c`; `simulated: false` |
| `GET /api/treasury/nodes/1/payments` | `payments: []` (no `Paid` log on this treasury) |
| `/agents` in Chrome | no MOCK / SIMULATED badge, `data-simulated="false"`; header `block 49986176 · 1 node · allowlist 2`; card "Unlabeled node #1 · no agent record for this key · key 0x390CF9…92Ea89 · spent 0.00 · cap 50.00 · remaining() 50.00 · per call 15.00 · expires in 6d 16h · payees: treasury allowlist (2)", bar 0 % |
| kebab → Raise cap 80 USDC | real `POST /api/exceptions` → 202: result row `PENDING Request created. Nothing has changed onchain. raiseCap(1, 80000000) … request 2fc4f276-0f03-41b8-9d1a-460bff1b8fa0`; panel lists it as `pending` with "Raise cap of node 1 · 80.00 USDC"; card shows "1 PENDING"; `GET /api/controller-requests?status=all` returns the same request, status `pending`; no DONE anywhere (no owner transaction exists) |

### Merge checklist follow-up (2026-10-25)
- `pnpm contracts:test` on the merged tree: 19 suites, 194 passed, 0 failed, 1 skipped (the live-key fork test). The merge touched no Solidity.
- `git diff --check` clean (an extra trailing newline in this file removed).
- The HEAD scaffold's link to `/controller` was lost when main's shell Overview won the page.tsx conflict; the shell nav (`shell/nav.ts`) now lists Controller, so both teams' navigation survives.

### Not yet done
- The live PENDING → DONE pause transition needs an owner `pause(id)` transaction: it is proven here with the labelled simulation and will be recorded live after controller Stage B/D (deploy with `OWNER_ADDRESS` = the Coinbase smart wallet, `createRoot` for the CDP key, Wallet MCP approval). The code path is the one already exercised by `completeControllerRequests` (owner-gated `NodePaused`) and the web's `phaseOf`.
- The retired treasury has one node, so the live view shows one card; three levels appear once the mission runner's `/delegate` children exist on the new treasury.
- The raise-cap request created above lives in the service's in-memory PGlite and is gone when the service stops; nothing was broadcast.

## 2026-10-25: merge `person1` into `main`

Second merge of the day, the other direction: `person1` (controller approvals, CDP-held keys, overflow-mcp, agents tree, treasury reads) into `main` (web shell, purchases/Oracle/Fusion views, ledger and reconciliation, mission runner). Eight conflicts, all resolved by keeping both sides: the web typed-client files (disjoint imports; the mock's controller-request list is now the request store plus the SIMULATED treasury's requests), `vitest.config.mts` (main's body, merged comment), this file (sections in date order), and two different `0005_*` drizzle migrations. The migrations keep main's `0005_reconciliation_escrow_checks` and regenerate person1's column as `0006_controller_request_submission` from the merged schema (`drizzle-kit generate` produced exactly `ALTER TABLE controller_requests ADD COLUMN submission jsonb`). One test fix: `mission-runner.test.ts` asserted that the "run failed" event is the last by time, but events written in the same millisecond tie-break on a random id (1 failure in 4 runs on the merged tree); the assertion now checks that the loud failure exists. Verified: `pnpm -r typecheck` 0 errors, `pnpm lint` clean, `pnpm test` all green, `pnpm contracts:test` 194 passed / 1 skipped, `git diff --cached --check` clean. `person1` fast-forwarded to `main` afterwards.


## 2026-10-25: recourse orders end to end on local Anvil (P5.2 minimum)

The three recourse scenarios from the SPEC (honest seller paid, ghost seller timed out, swap seller caught by a Merkle proof) now run against the real contracts, the real facilitator path and the real indexer on a local Anvil fork of Base Sepolia. Nothing touches Base Sepolia: the fork reads it, every transaction stays local, and the runner refuses any RPC that does not answer `anvil_nodeInfo`. Every seller, dataset and the judge are labelled SIMULATED in code, logs and API responses.

### Built
- `scripts/anvil-up.sh`: `anvil --fork-url "$BASE_SEPOLIA_RPC_URL" --chain-id 84532 --silent` (sources `.env` for the URL only, never prints it; `ANVIL_FORK_BLOCK` pins the block). `apps/service/scripts/anvil-provision.ts` (`pnpm --filter @overflow/service anvil:provision`): refuses unless anvil + chain 84532; deploys `OverflowTreasury` and `OverflowEscrowFactory` from `contracts/out` with viem `deployContract` (never `forge --broadcast`, so the Base Sepolia broadcast record is untouched); `setEscrowFactory`; `createRoot(dev account #2, cap 100 USDC, per call 20 USDC, +30 d)`; mints USDC by impersonating `usdc.masterMinter()` (`configureMinter` then `mint`; storage-slot fallback); writes `apps/service/.anvil/deployments.json` (`DeploymentsSchema` + `simulated: true`) and `.anvil/service.env` (0600, gitignored; Anvil's public dev accounts derived from the "test test … junk" mnemonic, no literal keys in the repo). Prints names and addresses only.
- `apps/service/src/recourse/`: `anvil.ts` (`isAnvil`, `assertAnvil` → `NotAnvilError`, `chainNow`, `increaseTime`, `redact`), `accounts.ts` (`AGENT_ROOT_KEY` = root node, `RECOURSE_SELLER_KEYS` = honest,ghost,swap), `dataset.ts` (catalog listing → verified manifest, records, leaves, roots), `seller-sim.ts` (`createSimSeller`: honest / ghost (never reveals) / swap (replaces the smallest non-sampled chunk's ciphertext; labelled "knows the sample to keep the demo deterministic")), `evidence.ts` (`drawSample`, `verifySampleRows`, `judgeSample` = `rule:recourse-sample-v1 (SIMULATED, no model)`, `findFirstMismatch`, `buildMismatchEvidence` which throws `ComplaintNotWarrantedError` for an honest chunk), `actions.ts` (`computeEscrowActions`: gates mirroring the contract's reverts, reasons start with the error name), `run.ts` (`runRecourseOnAnvil`). Per order: seller commits → `termsHash`/`orderId` → `factory.predict` → buyer verifies the manifest, draws 3 indices from `keccak256(salt ‖ "sample-v1")`, verifies both proofs per row, judges → writes mission `mission-recourse-anvil`, purchase (PROPOSED), `escrow_orders` (Created), `samples` (rows + judge) → relayer `factory.create(terms)` → node key signs EIP-3009 → purchase RESERVED → PAYMENT_PENDING → in-process facilitator `POST /settle` (the only path that moves the price) → seller `usdc.transfer(escrow, bond)` → relayer `markFunded()`. Then honest: seller `revealKey`, buyer decrypts all 528 chunks, node key signs `acceptDigest()`, relayer `accept(sig)`; swap: `revealKey`, buyer finds chunk 0 mismatching, builds the complaint (both proofs verified locally, row `built`), relayer `complainMismatch` after `simulateContract`; ghost: `evm_increaseTime(1800)`, relayer `claimTimeoutRefund()`. The runner writes no chain-truth status: SETTLED/REFUNDED, `Funded`, `Revealed`, `challengeEnd`, complaint `proven` and seller flags all come from the indexer.
- Indexer on the generated ABIs (`chain/abi.ts`): treasury 10 events (+`ReservationWindowSet`), factory `OrderCreated(escrow, orderId, buyer, seller, amount, termsHash)` + `CheatRecorded(seller, escrow)`, escrow `OrderFunded(balance)`, `KeyRevealed(key, challengeEnd)`, `Accepted(signer, nodeId)`, `PaidOut(seller, amount, bond)`, `Refunded(reason)`, `CheatProven(seller, index)`, `Swept(buyer, amount)`; `EVENT_BY_TOPIC` has 20 entries. Escrow handlers key on the emitting address (`chain/lookup.ts`: `escrowForAddress`, `purchaseForEscrow`, `orderCreatedForEscrow`, `isKnownEscrow`). `CheatProven` flags the seller, marks the complaint `proven` with the tx hash and publishes `seller.flagged`. `BondForfeited` is gone (no such event exists). Fixture re-encoded (33 logs, p5 = proven cheat) and `base-sepolia-logs.json` regenerated, still `simulated: true`.
- Ledger (`ledger/posting.ts`): the escrow deposit is booked on settle()'s USDC `Transfer` treasury → known escrow. `OrderFunded` posts nothing (it lands in `markFunded`'s own transaction and its balance includes the seller's bond). `Refunded` books min(returned in that tx, booked deposit) back to `usdc-treasury` and the excess to `other-income-seller-forfeiture` (`sourceEventId = eventKey#bond`). New `Swept` rule reverses a late deposit. Reconciliation: a `Created` order's expected deposit is the treasury's indexed transfers into it (settle() precedes `markFunded`); seller-history keys are lowercase (decoded log args are checksummed).
- Schemas/DB: `EscrowOrder.chunkCount`, `challengeEnd`; `ESCROW_TRANSITIONS.Created` += `Refunded`; `SampleRow`, `SampleRecord.randomness/judge/rows/simulated`; `ComplaintRecord` (`built → submitted → proven | rejected`); `packages/schemas/src/recourse.ts` (`EscrowChainState`, `ActionGate`, `EscrowActions`, `EscrowDetailResponse`, `EscrowSummary`, `EscrowListResponse`); activity kinds `sample.judged`, `complaint.built`, `escrow.swept`, `seller.cheat-recorded`. Migration `0007_recourse_evidence` (21 tables), `repositories/complaints.ts`.
- API: `EscrowReadPort` (`chain/escrow-read.ts`, one block for status/challengeEnd/revealedKey/balance; 501 `NotWiredError` default); `GET /api/escrow` (summaries), `GET /api/escrow/:id` (purchase id or address, either case: terms, purchase, resource label, live `chain`, `chainTransactions`, `sample`, `complaint`, `actions`, `activity`, `simulated`; a failing reader degrades to `chain: null` + `chainUnavailable`), `GET /api/escrow/:id/actions` (501 not wired, 503 reader failure). The API sends no transactions.
- `index.ts`: shared relayer; `modules.recourse` reports `idle` / `refused: … is not an Anvil node` / `live: …`; with `RECOURSE_ANVIL_RUN=1` the run starts after `indexer.start()`.
- Tests: `recourse/actions.test.ts`, `recourse/evidence.test.ts` (golden vectors: honest rows ok, swapped chunk 3 → both proofs verified + mismatch, chunk 0 → `ComplaintNotWarrantedError`), `routes/escrow.test.ts` (fake reader: gates before/after `challengeEnd`, Created past the deadline, 501), `abi.test.ts` real signatures, indexer/posting/reconciliation/ledger-route/exceptions tests on the new fixture.

### Verified (real output, 2026-10-25, fresh fork at block 50013716)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/service anvil:provision` | treasury `0x8f7a1defa8b06a8d66ea14a71a2ef2ce4ba1295b`, factory `0xe3e1ea59710e5046c238c08ac7558ba2ccb7c445`, root node id 1 for `0x3C44…93BC`, treasury 100000000 atomic USDC; sellers minted +10 USDC each |
| service boot (`SERVICE_URL=http://localhost:4010`, `.anvil/service.env`) | `[boot] chain 84532, USDC … "USDC" v2 separator 0x71f1…9818`; relayer holds gas only; `[recourse] live: 3 SIMULATED orders (honest, ghost, swap) on local Anvil` |
| run log | honest: sample `[461, 479, 477] -> buy`, `factory.create` block 50013729, bond transfer, `settle() paid 12000000` (node 1), `markFunded`, `revealKey`, "all 528 chunks decrypt to the committed leaves; accepting delivery", `accept` block 50013742. ghost: sample `[46, 6, 3] -> buy`, funded, "seller never calls revealKey; reveal deadline 1792925526", `evm_increaseTime(1800)`, `claimTimeoutRefund` block 50013746. swap: sample `[402, 315, 451] -> buy`, funded, `revealKey`, "chunk 0 does not decrypt to its committed leaf (checked 1); building complainMismatch", `complainMismatch(swap, 0)` block 50013744. `[recourse] run complete`. Warnings/errors in the log: 0 |
| `cast call USDC balanceOf` | treasury 91600000; honest seller 11020000 → 23020000 (+price 12 + bond 2.4); ghost 13000000 → 12000000 (−bond 1.0); swap 10010470 → 7410470 (−bond 2.6); all three escrows 0 (dev accounts hold pre-existing testnet USDC, hence deltas) |
| `cast call status()` | honest 3 (Settled), ghost 4 (Refunded), swap 4 (Refunded); `factory.provenCheats(swap seller) = 1` |
| `GET /api/escrow` | 3 rows: Settled/SETTLED (12 USDC, bond 2.4, sim-seller-a), Refunded `timeout`/REFUNDED (5, bond 1.0), Refunded `mismatch`/REFUNDED (13, bond 2.6, sim-seller-b, complaint `proven`); every row `simulated: true` |
| `GET /api/escrow/<honest>` | chain `{Settled, challengeEnd 1792925228, revealedKey 0xbfdc…6290, balance 0, block 50013748}`; events OrderCreated → Transfer → Paid → OrderFunded → KeyRevealed → Accepted → PaidOut; sample `buy`, 3 rows `ok` with decrypted CSV text, judge `rule:recourse-sample-v1 (SIMULATED, no model)`; complaint null; all five gates false |
| `GET /api/escrow/<ghost>` | chain `{Refunded, challengeEnd 0, revealedKey 0x0, balance 0}`; `refundReason: "timeout"`; events … OrderFunded → Transfer (back) → Refunded; no KeyRevealed; gates false |
| `GET /api/escrow/<swap>` | chain `{Refunded, challengeEnd 1792925228, revealedKey 0xee90…83fb}`; `refundReason: "mismatch"`; events … KeyRevealed → CheatProven → CheatRecorded → Transfer (back) → Refunded; complaint `{mismatch, chunkIndex 0, status proven, cipherProofVerified, plainProofVerified, cheatVerified all true, 10 + 10 proof elements, txHash 0x8b0c…ea6c}`; activity includes `complaint.built`, `seller.flagged`, `seller.cheat-recorded` |
| `GET /api/escrow/0x3bc7…92c8` (lowercase address) | 200 |
| `GET /api/escrow/<swap>/actions` | all `allowed: false`, reasons `BadStatus(Refunded)` ×4, `NothingToSweep()` |
| `GET /api/ledger` | 9 entries: owner contribution 100 USDC; three deposits on settle()'s Transfer (12, 5, 13); honest expense 12 (`#research`); ghost refund 5 + bond 1.0 (`#bond`); swap refund 13 + bond 2.6 (`#bond`). Net: usdc-treasury 91600000, escrow-deposit 0, data-expense 12000000, owner-contribution −100000000, other-income-seller-forfeiture −3600000 |
| `POST /api/reconciliation/run` | `status: ok`, block 50013748, treasury chain 91600000 = ledger 91600000, escrowsChecked 3 (all net 0), eventsChecked 6, `differences: []` |
| `GET /api/exceptions` | 0 open (an earlier run had opened two `RECONCILIATION_DIFF`s on Created orders funded by settle() before `markFunded`; fixed in reconciliation, see above) |
| `GET /` | indexer cursor = head 50013748, lag 0, trackedEscrows 3, logsIndexed 25 |
| safety rail | `assertAnvil(<real Base Sepolia RPC from .env>)` → `NotAnvilError: refused: https://sepolia.base.org is not an Anvil node (anvil_nodeInfo did not answer); the recourse run only ever targets a local fork`; `isAnvil(local fork) = true`. Read-only probe; nothing sent |
| `pnpm -r typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | 87 files passed, 1 skipped; 692 tests passed, 1 skipped (the `tables.test.ts` Created → Refunded expectation and the reconciliation Created-order expectation were updated this round) |
| `git diff --check` | clean |

### SPEC discrepancies found by running the real contracts
- `claimTimeoutRefund` accepts a `Created` order too, so `Created → Refunded` is a legal transition (schema updated).
- `markFunded` needs `balance ≥ amount + bond`: the seller's bond must land before the buyer calls it, and settle() and `markFunded` are two transactions. The ledger books the deposit on the USDC Transfer, not on `OrderFunded`, whose `balance` includes the bond.
- The CREATE2 salt is `keccak256(orderId, termsHash)`; `factory.predict` gives the escrow address before `create`.
- Escrow and factory events carry no `orderId`; the emitting address identifies the order. `Refunded` carries only its reason; the price + bond come back in one USDC Transfer.
- `Swept` and `CheatRecorded` exist; `BondForfeited` does not. `ReservationReleased` is `(digest, refunded)`.
- `perBuyerKey(sellerSecret, orderId, buyer)` is circular with `orderId = f(termsHash(keyCommitment))`, so the key is `keccak256(secret ‖ salt ‖ buyer)` with a per-order salt that also feeds `computeOrderId`.
- The sample judge is a deterministic rule, not a model call (recorded as `judge` on every sample).
- Anvil's dev accounts already hold Base Sepolia USDC, so seller balances are checked as deltas.

### Not yet done
- Seller HTTP `/orders` routes (the SIMULATED sellers are in-process ports), an Oracle sample judge, and POST action routes are out of scope here.
- The run is local only; a Base Sepolia run needs the factory deployed there (controller Stage B).
- PGlite is in-memory: restarting the service needs a fresh provision + run.

## 2026-10-25: escrow detail (`/escrow`, `/escrow/[id]`)

One page that shows a judge what happened to an order's money and why. Everything on it is a stored record, a chain read made for the response, or a check this browser re-ran over `@overflow/recourse-crypto`; the page sends no transactions.

### Built
- `apps/web/src/lib/escrow/state.ts` (pure): `deriveDiagram(escrow, chain, txs)` lights the status the chain read reports (stored status when the service has no reader, flagged when they disagree) and attaches to every reached node the first confirmed log that proves it (OrderCreated, OrderFunded, KeyRevealed, PaidOut, Refunded); a refund records the node it left from (`refundOrigin`) and the contract's reason (`Refunded(reason)` arg or the stored `refundReason`) with `REFUND_REASON_TEXT`. `liveDeadlines` (reveal deadline, challenge end = chain `challengeEnd()` or the indexed KeyRevealed) with `expiryCountdown`. `gateActions` is a local mirror of the service's `computeEscrowActions` (same reasons, `BadStatus`/`ChallengeOpen`/`RevealWindowOpen`/`ChallengeClosed`/`BadProof`/`NothingToSweep`); `mergeGates` lets the service's gates win and marks `decidedBy` and `localAgrees`. `actionPreview` gives payer (the escrow), amount (price + bond or the held balance), destination (seller or treasury) and the events to expect.
- `lib/escrow/evidence.ts` (pure, browser-safe): `verifySampleRows` re-runs the buyer's three checks per sampled row (ciphertext under rootCipher, plain leaf under rootPlain, decrypt(chunk, k_i) hashes to the leaf) and decodes the record; `rederiveIndices` repeats `pickSampleIndices` from the recorded randomness; `revealedKeyMatches` recomputes `keccak256(k)` against the terms' commitment; `verifyComplaint` re-runs complainMismatch's checks (both proofs with expected/got sibling counts, `checkMismatch`, decrypted row) and reports `contractWouldAccept`; promise complaints get the proof check with a note that ecrecover stays with the contract.
- Components (`components/escrow/`): `StateDiagram` (five nodes, happy path across, Refunded below with its three legal entries, taken edges highlighted, `data-current`), `TermsTable` (seller, token, amount, bond, held now, terms/manifest/order hashes, both roots, key commitment, revealed key + "matches commitment", chunk count, source key, min timestamp, reveal deadline, challenge window/end, chain read block), `EscrowPanel` (diagram + two deadline cards with live countdowns + terms + every confirmed chain log with decoded args), `SampleView` (indices, re-derivation pill, per-row service and browser verdicts, decrypted rows, judgment with reason and judge), `EvidencePanel` (complaint: both proofs service/browser, committed vs derived leaf, decrypted row, cheat pill, KeyRevealed/CheatProven/CheatRecorded/Refunded logs, "seller flagged"; timeout: deadline, "no KeyRevealed log", returned amount, refund tx; settled: Accepted signer + node, PaidOut; open: what the window allows), `ActionsPanel` (only allowed calls appear as `MoneyActionPreview` cards, confirm disabled with no handler and the sender named; refused calls listed with the contract's revert and when that changes), `EscrowDetail` (SSE reload for this purchase + `seller.flagged`, 15 s poll, `useLastGood`), `EscrowList` (`GET /api/escrow`). Pages `/escrow` and `/escrow/[id]` (purchase id or escrow address).
- API client: `listEscrows()`; `getEscrow()` now returns the service's `EscrowDetailResponse` (re-exported from `@overflow/schemas` as `EscrowResponse`). `lib/use-now.ts` hosts the ticking clock the agents page already used.
- Mocks: the fixtures carry the recourse-crypto golden vectors: honest `esc-national` (vectors' roots, revealed key = `perBuyerKey`, sample [3, 0, 4] from the vectors' randomness), ghost `esc-freight` (same commitment, `refundReason: "timeout"`, no KeyRevealed, not flagged), new swap order `pur-ev-swap` / `esc-ev-swap` (SIMULATED seller Voltara, 6.50 USDC + 1.00 bond, `rootCipher` = the swapped tree's root, sample [5, 2, 6] drawn from a labelled SIMULATED randomness that misses chunk 3, complaint `proven` with the vectors' `complainMismatch` args, CheatProven + Refunded("mismatch") logs, ledger rows netting to zero with the bond as other income). Chain transaction args use the built contracts' shapes (no `orderId` on escrow events). Open orders' deadlines sit 1–6 h after module load so the countdowns tick. Fixture totals moved by the swap bond (treasury 226.50; planted run 227.00 vs 226.50).
- Tests: `lib/escrow/state.test.ts` (diagram per fixture, chain-wins + disagree, gate matrix per status and clock, mergeGates, deadlines, previews), `lib/escrow/evidence.test.ts` (honest rows ok, swap rows ok under the swapped root and failing under the honest root, re-derived indices, tampered key / dropped sibling, swap complaint accepted, no key → not re-checked, honest chunk → cheat false, promise path), fixtures test extended (arg names per event, vectors in the three orders, swap books, every mock detail parses with `EscrowDetailResponseSchema`); `ledger.test.ts` / `timeline.test.ts` expectations moved with the fixtures.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm -r typecheck` | exit 0 |
| `pnpm lint` | exit 0 |
| `pnpm test` | 89 files passed, 1 skipped; 719 tests passed, 1 skipped |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0; routes include `○ /escrow` and `◐ /escrow/[id]` |

**Mocks, headless Chrome (CDP driver, `next dev -p 3100`, `NEXT_PUBLIC_USE_MOCKS=1`), console errors: none on any page.**
| Page | Observed |
|---|---|
| `/escrow` | h1 "Escrow", MOCK badge, 6 rows: california Created · weather Funded · oregon Revealed · national Settled · freight Refunded `timeout` · ev-swap Refunded `mismatch` with complaint pill `proven`; every row SIMULATED |
| `/escrow/pur-merged-national` (honest) | `data-current="Settled"`, nodes Created/Funded/Revealed done with tx + block, Settled current with tx, Refunded unreachable; both deadlines "passed"; key "matches commitment"; events OrderCreated, OrderFunded, KeyRevealed, Accepted, PaidOut; sample `buy`, "indices re-derived in this browser: match", rows #3 #0 #4 service ok / browser ok with decoded CSV text, judge `rule:recourse-sample-v1 (SIMULATED, no model)`; evidence "settled": Accepted by `0xa9e0…` node 1, Paid out 13.00 USDC to the seller, three logs; actions: 0 allowed, `sweep` refused `NothingToSweep()`; 0 enabled confirm buttons |
| `/escrow/pur-freight-weekly` (ghost) | `Refunded` current from Funded, Revealed and Settled unreachable, "Refunded("timeout") from Funded …"; reveal deadline passed; no revealed key; events OrderCreated, OrderFunded, Refunded; sample buy (3 rows ok); evidence "timeout": deadline, "no KeyRevealed log was ever indexed", returned 16.00 USDC price + forfeited bond, refund tx at block 49850420; no "flagged" |
| `/escrow/pur-ev-swap` (swap) | `Refunded` current from Revealed; key matches commitment; events OrderCreated, OrderFunded, KeyRevealed, CheatProven, Refunded; sample [5, 2, 6] all ok (misses chunk 3); evidence "complaint" status `proven`, `data-accept="true"`, two `evidence-proof[data-browser="ok"]` rows (3/3 siblings each, service ok / browser ok), browser cheat "leaf differs", decrypted row `…simulated-swapped`, CheatProven(seller, 3), seller flagged |
| `/escrow/pur-weather-daily` (Funded, open) | reveal deadline counting down ("1h 59m", ticking), no sample, evidence "open", `claimTimeoutRefund` refused `RevealWindowOpen()` with "available from" |
| `/escrow/pur-oregon-monthly` (Revealed, open) | both countdowns ticking ("59m 55s", "39m 55s"); `accept` allowed as a money-action card (payer escrow, 9.00 USDC, destination seller, expected Accepted → PaidOut), `finalizePayout` refused `ChallengeOpen()`, `complain` refused `BadProof()`; 0 enabled confirm buttons |

**Live, `next dev -p 3200` with `NEXT_PUBLIC_USE_MOCKS=0 NEXT_PUBLIC_API_URL=http://localhost:4010` against the service of the "recourse orders end to end on local Anvil" run (same fork, same three orders), console errors: none.**
| Page | Observed |
|---|---|
| `/escrow` | no MOCK badge; 3 rows: `c95ead04…` Settled (sim-seller-a), `58c6df78…` Refunded timeout (sim-seller-a), `e260e8f2…` Refunded mismatch (sim-seller-b); SIMULATED badges from the service's `simulated: true` |
| honest `c95ead04…` | `data-status="Settled" data-source="chain"`; nodes Created/Funded/Revealed done + tx, Settled current + tx (`0x985b78…b72f93` block 50013742); deadlines passed (reveal 1792925821, challenge 1792925228, window 600 s); key `matches commitment`; events OrderCreated, Transfer, Paid, OrderFunded, KeyRevealed, Accepted, PaidOut; sample buy [461, 479, 477], re-derived match, rows ok/ok with decoded CSV, rule judge; evidence settled: Accepted by `0x3C44…93BC` node 1, Paid out 14.40 USDC to `0x90F7…b906`; actions none (`NothingToSweep()`); every rendered tx hash is one of the response's logs |
| ghost `58c6df78…` | Refunded from Funded, "Refunded("timeout")", reveal deadline 1792925526 passed; events OrderCreated, Transfer, Paid, OrderFunded, Transfer, Refunded; sample buy [46, 6, 3] ok; evidence timeout: no KeyRevealed log, 6.00 USDC returned, refund tx `0x9353d6…` block 50013746 |
| swap `e260e8f2…` | Refunded from Revealed, "Refunded("mismatch")"; key matches; events … KeyRevealed, CheatProven, CheatRecorded, Transfer, Refunded; sample buy [402, 315, 451] ok; evidence complaint `proven`, `data-accept="true"`, both proofs service ok / browser ok with 10/10 siblings (528 chunks), browser cheat "leaf differs", CheatProven(seller, 0), seller flagged; actions none |

### Not yet done
- A Base Sepolia run of the same page waits for the escrow factory deployment there; the live table above is the local Anvil fork.
- The Oracle sample judge and seller HTTP routes are still out of scope (the judge shown is the labelled rule).
- Promise complaints re-run only the Merkle proof in the browser (ecrecover stays with the contract and the service).

## 2026-10-25: merge `origin/main` (web missions, web overview) into `main`

Twelve conflicts, none resolved by taking one side wholesale:
- `api/ports.ts`, `api/app.ts`, `index.ts`: all three read ports stay (`TreasuryReadPort` for the delegation tree, `EscrowReadPort` for `/api/escrow/:id`, `TreasuryPort` for the overview's `GET /api/treasury`); the overview snapshot reader is wired beside reconciliation as before, the other two always (they refuse without an RPC). Both branches had mounted the treasury router; one mount remains.
- `routes/treasury.ts` / `treasury.test.ts` (added on both sides): one router serving `GET /api/treasury` (origin/main) and `GET /api/treasury/nodes`, `GET /api/treasury/nodes/:id/payments` (person1); both test suites in one file.
- Web typed client (`client.ts`, `contracts.ts`, `http.ts`, `mock.ts`): disjoint imports kept; the mock's activity feed is origin/main's writable `activityStore` plus the SIMULATED treasury's live events, its controller-request list is the request store plus the treasury sim's requests, and `subscribe` fans out both the mock writes and the sim's stream.
- Drizzle: both branches had generated a `0006_*`. Ours (`0006_controller_request_submission`, `0007_recourse_evidence`) keep their numbers; origin/main's `missions.horizon` / `allowed_formats` migration was regenerated from the merged schema as `0008_mission_horizon_formats` (`drizzle-kit generate` emitted byte-identical SQL to the incoming `0006`; a rerun reports "No schema changes, nothing to migrate").
- Integration fixes, no feature removed: the overview's `eventTone` referred to `escrow.bond-forfeited`, an activity kind the recourse commit removed because the contract has no such event (the bond is booked from `Refunded`); it now warns on `escrow.refunded`, `seller.flagged`, `seller.cheat-recorded`. Two expectations moved with the fixtures: the overview progress strip counts the new swap order (Grouped 7 / Authorized 6 / Escrow 5) and the treasury route test sees the fixture replay's `p5: Refunded`.

Verified (real output): `pnpm -r typecheck` exit 0; `pnpm lint` exit 0; `pnpm test` 91 files passed, 1 skipped; 747 tests passed, 1 skipped; `pnpm contracts:test` 194 passed, 0 failed, 1 skipped; `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` exit 0 with `/`, `/escrow`, `/escrow/[id]`, `/missions`, `/missions/[id]`; `git diff --cached --check` clean. Nothing deployed, broadcast or pushed.

## 2026-10-25: web missions (compose, review the extracted requirements, confirm, run)

### Built
- Schemas: `MissionStatus` gains `confirmed` (draft → planning → confirmed → active → complete | cancelled; a re-plan of a confirmed mission returns it to planning). `MissionSchema` gains `horizon` (data date range, optional) and `allowedFormats` (default all three, so old rows and fixtures parse). Activity kinds `mission.requirement_edited`, `mission.confirmed`.
- Database: migration `0006_mission_horizon_formats` (`missions.horizon jsonb`, `missions.allowed_formats text[] DEFAULT '{csv,json,parquet}' NOT NULL`; additive). `resourceRequests.update(id, fields)` changes requirement fields only, never status, agent or mission.
- Oracle (`packages/oracle/src/extract.ts`): the prompt states the horizon and the allowed formats; post-processing (code, not the model) clamps each request's `dateRange` into the horizon (a range entirely outside it becomes the horizon itself, never an inverted range), then to the last complete month, and drops formats the mission does not allow, each as a recorded assumption. A request with no allowed format left fails validation and goes back to the model once, as other issues do.
- Service: `POST /api/missions` accepts `horizon` and `allowedFormats`. `PUT /api/missions/:id/requests/:requestId` (body = `ResourceRequestSchema`; 404 outside the mission; 409 `not_editable` unless the mission is `planning` and the request `open`; 409 `over_budget` above the mission budget; writes `mission.requirement_edited`). `POST /api/missions/:id/confirm` (409 `not_planning`, 409 `no_open_requests`; planning → confirmed; writes `mission.confirmed`). `POST /api/purchases/propose` and `POST /api/missions/:id/run` answer 409 `requirements_unconfirmed` while a mission is `planning`, so the extracted set is reviewed before anything is proposed; draft and active missions are unaffected (`scripts/run-mission.ts` still goes draft → run). CORS allows `PUT`. SPEC API table updated.
- Web client: `updateRequest`, `confirmMission`; `CreateMissionBody` carries horizon and formats. The mock keeps mission, request and activity stores for the session: `createMission` stores a draft; `planMission` derives one request from the mission's own fields under the owner agent, withdraws the earlier open ones and writes an `oracle.model_call` event saying no model was called; `updateRequest` / `confirmMission` / `runMission` apply the service's rules and codes; a run only changes the stored status and says "no agents ran; nothing was paid". Mock writes are published to `subscribe` listeners so the detail page refetches as it would from `/events`. A reload resets to the fixtures.
- Web view models (`apps/web/src/lib/missions/`): `parseBudgetInput` (string → atomic via `toAtomic`, never a float), `MISSION_STATUS_STYLE` (exhaustive) with `isEditable` / `canPlan` / `canConfirm` / `canRun` mirroring the service gates, `toDraft` / `fromDraft` (editable row ↔ `ResourceRequest`, validated with the same Zod schema the service applies, issues keyed by field), `groupByAgent` (withdrawn rows out), `agentProgress` / `runState` / `recommendations` / `outputs` derived only from stored events and stored purchase reasons.
- Pages: `/missions` (`MissionComposer`: goal, budget in USDC with the atomic preview, horizon start/end, allowed formats, optional owner agent; the missions table) and `/missions/[id]` (`MissionDetail`: status pill, budget, horizon, formats, owner, paying node, run state; `RequirementsTable` per agent with inline edit, Save (PUT), Re-plan, Confirm requirements; Run mission showing only the service's 202 note or its error envelope; agent progress from event counts; recommendations from `oracle.recommendation` / `fusion.decision` events and stored reasons; purchases linking to `/purchases/[id]`; outputs from `agent.report` events; the mission's activity newest first with SIMULATED badges; SSE refetch filtered on `missionId`).

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm --filter @overflow/database db:generate` | wrote `0006_mission_horizon_formats`; rerun "No schema changes, nothing to migrate" |
| `pnpm test` (root) | 74 files passed, 1 skipped; 623 tests passed, 1 skipped. New: oracle `extract.test.ts` (+3: horizon clamp incl. fully-outside range, prompt lines + format drop, no-allowed-format → one retry), service `oracle.test.ts` (+1: 409 `requirements_unconfirmed` for propose and run while planning; PUT 409 `over_budget`; PUT 200 stored; PUT on a withdrawn request 409; unknown request 404; confirm → `confirmed`; second confirm 409 `not_planning`; PUT after confirm 409 `not_editable`; both activity kinds written), `missions.test.ts` (+2: horizon/formats round-trip and defaults, inverted horizon 400, confirm on draft 409), web `missions.test.ts` (11) |
| `pnpm typecheck`, `pnpm --filter @overflow/web lint` | exit 0 / exit 0 |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0; `/missions` static, `/missions/[id]` partial prerender |
| Chrome, `next dev -p 3100` with mocks | `/missions`: composer with budget `12.5` previewed as `12.50 USDC = 12500000 atomic units`, horizon 2025-01-01..2025-06-30; Create → `/missions/mission-mock-…` in Draft; Plan → Planning with one open request inside the horizon under the orchestrator and the "no model call" event; Edit → topic and regions changed, Save → the row re-rendered from the mock's response and `mission.requirement_edited` in progress; Confirm → Confirmed; Run → Active, "MOCK: no agents ran; nothing was paid", run state `running`, no purchases or outputs invented. `/missions/mission-demo-1`: four requests grouped under finance and research with matched/open pills, Edit disabled on an active mission. No console errors |
| Real API | Routes exercised end to end only through the service tests above (real Hono app on PGlite, same handlers). A local `tsx src/index.ts` boot stops before listening: the deployments file has no escrow factory and the seller/escrow config rejects the null (`[service] fatal: escrowFactory expected 0x-prefixed 20-byte hex address`), which predates this change. Live `plan` still needs `CLAUDE_MODEL` / `ANTHROPIC_API_KEY`; live `run` answers 501 `not_wired` without agent keys; the UI shows both envelopes verbatim |

### Open issues
- Service boot without an escrow factory in deployments fails on config validation before the API listens; needs its own fix before the web can be driven against a local live service.
- A plan files every extracted request under one agent (the owner or the orchestrator); per-agent rows appear once the sub-agents file their own via `propose_purchase`.
- `PlanResponse` does not return the extraction assumptions (they are audited as `oracle.model_call` hashes only); returning them would let the table show why a date or format was clamped.
- `GET /api/activity?missionId=` still returns the oldest events before applying `limit`; the detail page asks for 500.
- `next dev` wrote `apps/web/AGENTS.md` again (deleted).

## 2026-10-25: web overview (four questions at a glance)

### Built
- Service: `GET /api/treasury` (`apps/service/src/api/routes/treasury.ts`). Chain part read at one block: USDC `balanceOf(treasury)` and `OverflowTreasury.reservedTotal()` (`chain/treasury-snapshot.ts`, through a new `TreasuryReader.reservedTotal` on the viem log source; the fake source gains `reserved`). New `TreasuryPort` in `api/ports.ts`, wired in `index.ts` beside reconciliation when the indexer config resolves; the default refuses with `NotWiredError`, and the route then answers `chain: null` with `chainUnavailable: <reason>` rather than a number. Escrow part from `escrow_orders`: open orders (not Settled/Refunded), the funded ones (Funded/Revealed, i.e. after an indexed OrderFunded) and `committedAtomic` = Σ their amounts, bonds excluded. `ApiDeps` gains `treasury: Address | null`. SPEC API table gains the row. Test `treasury.test.ts` (2): fixture replay with p3 marked Funded → balance 37.40, reservedTotal 2.50, block 115, one funded open order of 12.00; without a reader → `chain: null`, reason names the port, escrow part unchanged.
- Web client: `TreasuryResponseSchema`, `getTreasury()` in http and mock. The MOCK reading is the fixture reconciliation run's chain balance at its block; reservedTotal is Σ signed-unsettled coinbase-facilitator purchases (none in the fixtures → 0.00); escrow commitment from the fixture escrows in Funded/Revealed (weather 4.50 + oregon 8.00 = 12.50, 2 funded of 3 open).
- Pure view models (`apps/web/src/lib/overview/`, 9 tests): `missionProgress` (Discovered = requests not withdrawn; Grouped/Authorized/Escrow/Settled = purchases whose stored status reached at least that stage via the exhaustive `PURCHASE_STAGE`: REJECTED stays at Grouped, REFUNDED reached Escrow but not Settled, RELEASED/PAYMENT_UNKNOWN/FAILED_BEFORE_FUNDING count as Authorized only), `activeMissions` (draft/planning/confirmed/active, newest first), `pickMission` (newest active, else newest), `spentForMission` (Σ `bookedAtomic` of the ledger's allocation breakdown over the mission's purchases: data-expense per the books, so escrowed and refunded orders read 0), `isBlocked` / `blockedReason` (policy.blocked or any decoded revert), `latestEvents`, `eventTone`.
- Page `/` (`components/overview/`): `MoneyCards` (Treasury · onchain with address and block, Escrow committed with "n funded of m open", Reserved with the floor-check note, Spent this mission naming the mission; each card renders Skeleton → its own error (`status code: message`) or "unavailable" when the chain part is null → the number; nothing is shown that its call did not return), `MissionList` (in-flight missions with status pill, budget, purchase count and `ProgressStrip`: five cells lit only when reached, counts, authorization blue / escrow cyan / settlement success; EmptyState with the Create action when none), `LatestEvents` (five newest from `GET /api/activity?limit=5`; blocked rows take the danger color, a `blocked` pill and `reason <decodedRevert>`; SIMULATED badges carried through; links to purchase and full activity), "Create mission" primary action in the header and in the empty state (links to the composer on `/missions`). SSE: any `activity` message refetches all five queries after 400 ms. Replaces the earlier `OverviewStats`.

### Verified (real output, 2026-10-25)
| Check | Result |
|---|---|
| `pnpm test` (root, alone) | 76 files passed, 1 skipped; 634 tests passed, 1 skipped (new: service `treasury.test.ts` 2, web `overview.test.ts` 9). A first run concurrent with `next build` had 7 service files time out in `beforeAll` (PGlite migration under CPU load); rerun alone all green |
| `pnpm typecheck` / `pnpm --filter @overflow/web lint` | exit 0 / exit 0 |
| `NEXT_PUBLIC_USE_MOCKS=1 pnpm --filter @overflow/web build` | exit 0; `/` static |
| Chrome, `next dev -p 3100` with mocks | cards 225.50 onchain at block 49850420 with the treasury address, Escrow committed 12.50 (2 funded of 3 open), Reserved 0.00, Spent 12.00 for mission-demo-1; strip Discovered 4 · Grouped 6 · Authorized 5 · Escrow 4 · Settled 1; latest five events with SIMULATED badges. With the limit raised to 8 for a visual check (reverted), the `policy.blocked` row rendered in red with `reason OverBudget(3)`. No console errors |
| Chrome, real API | The Hono app served over PGlite with the SIMULATED chain fixture replayed (scratch script, not committed) and `NEXT_PUBLIC_USE_MOCKS` unset: with a fake chain reader wired → 37.40 onchain at block 115, Escrow 12.00 (1 funded of 1 open), Reserved 2.50, Spent 15.00 for mission-1, strip 0 · 4 · 3 · 2 · 1 (the replay files no resource requests, so Discovered is honestly 0), latest five indexer events; without a reader → Treasury and Reserved read "unavailable" with the `TreasuryPort.read … is not wired yet` reason while Escrow and Spent still show; API stopped → every card "unavailable / Failed to fetch", missions and events in ErrorState. No console errors |
| Full `pnpm dev` against the real service | Not exercised: the service boot still stops on the missing escrow factory in deployments (see the missions entry) |

### Open issues
- `GET /api/treasury` reads the chain on every request; a busy overview with SSE refetches means one `eth_blockNumber` + two `eth_call`s per committed event. A short cache keyed on block would be the next step if the public RPC rate-limits.
- "Spent this mission" is the books' data-expense; a mission whose purchases paid a direct x402 seller (no escrow) is booked the same way, but any purchase not yet in the ledger (indexer lag) reads 0 until the next poll.
- `next dev` wrote `apps/web/AGENTS.md` again (deleted).
