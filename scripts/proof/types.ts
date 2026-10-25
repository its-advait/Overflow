import type { Address, Hex } from "viem";
import type { AnswerKeyRow } from "./answer-key.js";
import type { ProofContext } from "./context.js";

export type Mode = "fork" | "live";

/** PASS and FAIL compare the run against the answer key; BLOCKED sent nothing (a signer or the treasury lacked funds); NOT_RUN is a fork-only case in a live run. */
export type Verdict = "PASS" | "FAIL" | "BLOCKED" | "NOT_RUN";

export interface TxRef {
  label: string;
  hash: Hex;
  status: "success" | "reverted" | "unknown";
}

export interface CheckResult {
  pass: boolean;
  /** What actually happened, from a confirmed chain event or a real API/DB answer. */
  actual: string;
  /** The transaction that shows the planted error being caught (or recovered), when there is one. */
  txHash?: Hex | undefined;
}

/** Live preflight: transactions per sender and USDC the treasury must hold above floor + reservedTotal. */
export interface LiveNeeds {
  relayerTxs: number;
  ownerTxs: number;
  sellerTxs: number;
  treasuryUsdc: bigint;
}

export type LivePlan =
  | { kind: "onchain"; needs: LiveNeeds }
  | { kind: "offchain" }
  | { kind: "skip"; reason: string };

export interface ProofCase<S, O> extends AnswerKeyRow {
  slug: string;
  /** True when the planted error is caught by a transaction (the table then links it). */
  onchain: boolean;
  live: LivePlan;
  setup(ctx: ProofContext): Promise<S>;
  action(ctx: ProofContext, setup: S): Promise<O>;
  check(ctx: ProofContext, outcome: O): Promise<CheckResult> | CheckResult;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCase = ProofCase<any, any>;

export function defineCase<S, O>(c: ProofCase<S, O>): ProofCase<S, O> {
  return c;
}

export interface CaseResult {
  id: number;
  slug: string;
  plantedError: string;
  expected: string;
  caughtBy: string;
  onchain: boolean;
  verdict: Verdict;
  actual: string;
  txHash?: Hex | undefined;
  /** Every transaction the case sent, setup included, in order. */
  txs: TxRef[];
  /** BLOCKED / NOT_RUN: why, with exact balance shortfalls. */
  reasons?: string[] | undefined;
  durationMs: number;
}

export interface RunRecord {
  mode: Mode;
  startedAt: string;
  finishedAt: string;
  chain: {
    chainId: number;
    startBlock: string;
    endBlock: string;
    /** Fork only: the Base Sepolia block anvil forked from. */
    forkBlock?: string | undefined;
    node: string;
  };
  contracts: { treasury: Address; escrowFactory: Address; usdc: Address; owner: Address };
  actors: Record<string, string>;
  summary: { total: number; passed: number; failed: number; blocked: number; notRun: number };
  results: CaseResult[];
  notes: string[];
}

export interface ResultsFile {
  generatedBy: string;
  fork?: RunRecord | undefined;
  live?: RunRecord | undefined;
}
