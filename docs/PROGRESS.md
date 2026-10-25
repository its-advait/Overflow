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
