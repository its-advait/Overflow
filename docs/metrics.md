# Metrics

This page lists only numbers we measured, and each one links to where it came from. Anything we have not measured is in the last section. The list of metrics comes from [SPEC "Numbers to report"](SPEC.md#numbers-to-report). Last updated 2026-10-25.

## Planted errors caught: 7 of 20 (anvil fork)

| Run | Passed | Failed | Blocked | Not run | Source |
|---|---:|---:|---:|---:|---|
| `pnpm proof --fork` (anvil fork of Base Sepolia, chain 84532, blocks 50055856 to 50055885, 2026-10-25T12:57:19.768Z) | **7** | 13 | 0 | 0 | [proof/results.md, Fork run](proof/results.md#fork-run-anvil-fork-of-base-sepolia); [proof/results.json](proof/results.json) `fork.summary` = `{total 20, passed 7, failed 13, blocked 0, notRun 0}` |
| `pnpm proof --live` (Base Sepolia, blocks 50055274 to 50055283, 2026-10-25T12:55:23.564Z) | **0** | 13 | 6 | 1 | [proof/results.md, Live run](proof/results.md#live-run-base-sepolia); [proof/results.json](proof/results.json) `live.summary` = `{total 20, passed 0, failed 13, blocked 6, notRun 1}` |

- The cases that passed are 1 to 7, the policy and USDC-gate refusals. Cases 8 to 20 are NOT IMPLEMENTED: they have no test harness yet, so the runner reports them as FAIL. We do not count them as caught.
- The live run sent nothing. Cases 1 to 5 and 7 are BLOCKED because relayer `0xa0943Eb0ccf97DF2B3B3FF4E2259e3B2785b46A1` holds 0 wei. Case 6 is NOT RUN because it is fork-only in this build. Cases 8 to 20 are NOT IMPLEMENTED. See [PROGRESS, "`pnpm proof` planted-error runner", Verified](PROGRESS.md).
- In both runs the seller, payees and attacker are SIMULATED.

## Unauthorized payment attempts rejected onchain

**Base Sepolia: none recorded.** [PROGRESS.md](PROGRESS.md) has no Base Sepolia rejection with a tx link. No unauthorized attempt was sent there: the live proof run was blocked, and the live mission was not run because the treasury holds 0 USDC and the relayer 0 ETH.

**Anvil fork only: 7 rejections, as mined reverted transactions.** These ran on a local anvil fork of Base Sepolia. The hashes exist only on that local fork and are not on Basescan. Source: [proof/results.md, Fork run](proof/results.md#fork-run-anvil-fork-of-base-sepolia).

| Case | Attempt | Decoded revert | Fork tx (local only) |
|---|---|---|---|
| 1 | Listing tells the agent to pay a SIMULATED attacker | `PayeeNotAllowed(0)`; attacker USDC 0 -> 0 | `0xc3ea58894b6b776098bc9d4a424b57e65703ef64defb42a028d98c1bccb7b4fc` |
| 2 | The same signature sent straight to USDC | `Error("FiatTokenV2: invalid signature")`; nonce not used | `0x5205164443451162972e21114f1dd7948427029563e323022a38a5f94eb21d64` |
| 3 | Search-only agent pays a scraping seller | `PayeeNotAllowed(5)` | `0xdbf4cdfe53e659c58608a778dea8b59b53c8db65e3e1328c400b67c24c94bd7c` |
| 4 | 0.05 USDC payment, over the 0.04 USDC per-call limit | `OverPerCall(7)` | `0xf8f7b601b8efe21a59f6396c9241494ff6402fe5f9c5eeca4f33d5a64a37896d` |
| 5 | Sub-agents together exceed the parent's cap | `OverBudget(9)`; the first sub-agent's payment succeeded first and is not counted here | `0x98cbdcc785005f1dd518d28cb0896637af0a2ec499fb14c6513a4c455a5e8cdd` |
| 6 | Payment after expiry | `Expired(13)` | `0x2a6982df27e426de2a15a2f379b9e7b11dd3bb5147416773d8061e11550251aa` |
| 7 | Child pays while the orchestrator is paused | `Paused(14)` | `0x48df3014d6ee10a70ae6b66bd23ade3f5134c3530cd050a2195dddcf6ba63ef4` |

## Gas per call (local EVM, real USDC bytecode)

Measured by `pnpm contracts:gas` on 2026-10-25 in [`contracts/test/gas/GasReport.t.sol`](../contracts/test/gas/GasReport.t.sol) (`test_gasReport`). The test uses forge gas snapshots on a local EVM against Circle's real USDC v2.2 bytecode (forge 1.8.6, solc 0.8.28, cancun, optimizer 200 runs). Each number is the execution gas of one warm external call, with treasury depth 1 (the root node pays). A full transaction adds about 21,000 intrinsic gas plus calldata. These numbers were **not** measured on Base Sepolia. Source: [gas.md](gas.md).

| Operation | Gas |
|---|---:|
| `settle()` | 170,085 |
| `reserve()` | 224,352 |
| `reserve()` to an escrow | 242,417 |
| `release()` | 60,227 |
| `releaseClosed()` | 66,726 |

**Escrow lifecycle, honest path.** One order goes through these five calls in sequence in `test_gasReport`:

| Step | Gas |
|---|---:|
| escrow `create()` | 420,958 |
| fund: `settle()` to escrow | 155,934 |
| fund: `markFunded()` | 69,156 |
| `revealKey()` | 62,855 |
| `accept()` | 100,802 |
| **Sum of the five measured calls** | **809,705** |

- The sum is arithmetic over the five measured rows, not a single measured transaction.
- The sum excludes intrinsic gas and calldata for each of the five transactions.
- The sum excludes the seller's bond payment, which the test makes but does not snapshot.

Other measured escrow exits: `claimTimeoutRefund()` 61,549; `sweep()` 55,904. Source: [gas.md](gas.md).

## Not yet measured

These are not measured yet:

- **Unauthorized payments rejected on Base Sepolia:** nothing was sent.
- **Duplicate spend avoided by Fusion, in USDC:** no mission ran. The only evidence is a unit test on SIMULATED fixture prices, and it moves no USDC. `packages/fusion/src/rules.test.ts` line 26 asserts the price evidence "one purchase 12.00 USDC vs 17.00 USDC separately (5.00 + 12.00)". That file passed 8 of 8 on 2026-10-25. It records a merge decision on fixture prices, not measured saved spend.
- **Orders that ended in exactly one terminal state and reconciled:** no live mission or `flow:demo` ran on Base Sepolia. See [PROGRESS, "live P6.3 / P6.4 / P6.5 checks"](PROGRESS.md).
- **Planted errors 8 to 20:** not implemented.
- **Gas on Base Sepolia for `settle()`, `reserve()` and the escrow lifecycle:** not measured.
