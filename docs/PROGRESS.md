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
