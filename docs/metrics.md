# Metrics

This page lists only numbers we measured, and each one links to where it came from. The live metrics come first and carry no numbers until the live run; anything else we have not measured is in the last section. The list of metrics comes from [SPEC "Numbers to report"](SPEC.md#numbers-to-report). Last updated 2026-10-25.

## Live metrics (to be measured in the live run)

Overflow is proven with a LIVE test and a LIVE demo on Base Sepolia, with live transactions. That run has not happened yet, so these metrics have no numbers. Each will be filled from Basescan links and the reconciled books after the live run.

| Metric | Value | Evidence |
|---|---|---|
| Unauthorized payment attempts rejected onchain (attacker payee `PayeeNotAllowed`, sub-agent over its parent's cap `OverBudget`, paused orchestrator `Paused`, flagged seller `PayeeFlagged`, direct-to-USDC bypass `FiatTokenV2: invalid signature`) | To be measured in the live run | Live tx: TODO (Basescan link after the live run) |
| Orders that reached exactly one terminal state and reconciled (honest PaidOut, ghost timeout refund, swap refund plus bond) | To be measured in the live run | Live tx: TODO (Basescan link after the live run) |
| Duplicate spend avoided by Fusion, in USDC | To be measured in the live run | Live result: TODO (from the live run's reconciled books) |

The sellers, datasets and attacker in the live run are SIMULATED. The only Overflow transactions on Base Sepolia so far are the deployment and two `setAllow` calls on the earlier, now retired treasury ([limitations.md](limitations.md)).

## Measured on a local Anvil fork (not Base Sepolia)

The three Recourse scenarios ran end to end against the real contracts, the real facilitator path and the real indexer on a local Anvil fork of Base Sepolia, with SIMULATED sellers and datasets and a rule-based SIMULATED sample judge. Every transaction stayed local; none of these numbers is a Base Sepolia result. Source: [PROGRESS, "recourse orders end to end on local Anvil"](PROGRESS.md).

| Measure | Value |
|---|---|
| Orders that reached exactly one terminal state | 3 of 3: honest `status()` 3 (Settled), ghost 4 (Refunded, timeout), swap 4 (Refunded, mismatch) |
| USDC left in the three escrows after the run | 0 in each (`cast call USDC balanceOf`) |
| Honest order | `settle()` paid 12000000 (12 USDC) into the escrow; all 528 chunks decrypted to the committed leaves before `accept`; seller USDC balance 11020000 → 23020000 (atomic units, as `cast call` printed them) |
| Ghost order | Timeout refund; seller USDC balance 13000000 → 12000000 (bond 1.0 lost) |
| Swap order | `complainMismatch` on chunk 0; seller USDC balance 10010470 → 7410470 (bond 2.6 lost); `factory.provenCheats(swap seller) = 1` |
| Warnings or errors in the run log | 0 |

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

- **Unauthorized payments rejected on Base Sepolia:** to be measured in the live run.
- **Duplicate spend avoided by Fusion, in USDC:** to be measured in the live run. The only evidence is a unit test on SIMULATED fixture prices, and it moves no USDC. `packages/fusion/src/rules.test.ts` line 26 asserts the price evidence "one purchase 12.00 USDC vs 17.00 USDC separately (5.00 + 12.00)". That file passed 8 of 8 on 2026-10-25. It records a merge decision on fixture prices, not measured saved spend.
- **Orders that ended in exactly one terminal state and reconciled:** to be measured in the live run (3 of 3 on a local Anvil fork, above; not a Base Sepolia result). See [PROGRESS, "live P6.3 / P6.4 / P6.5 checks"](PROGRESS.md).
- **Gas on Base Sepolia for `settle()`, `reserve()` and the escrow lifecycle:** not measured.
