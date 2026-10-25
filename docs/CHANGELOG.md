# Changelog

## Unreleased
- feat(contracts): OverflowTreasury core ported from Leash (policy tree, settle() check order, stateful ERC-1271 gate, signed delegation); 51 unit + 3 adversarial tests on real USDC v2.2; `docs/contract-invariants.md`; gas snapshot.
- test(contracts): real USDC v2.2 harness: reproducible fixture build of Circle's FiatTokenV2_2 + proxy + SignatureChecker, `UsdcV22` deploy library, `UsdcReal.t.sol` proving the ERC-1271 caller is the USDC proxy.
- chore: scaffold Overflow monorepo (pnpm workspace, Next.js web, Node service, shared packages, Foundry contracts, docs).
