import type { Address, Hex } from "@overflow/schemas";
import { encodePacked, getAddress, keccak256, toHex } from "viem";
import type { EscrowStatusName, RecourseChain, TxOutcome } from "./chain.js";
import type { OrderTermsWire } from "./protocol.js";

// ---------------------------------------------------------------------------
// SIMULATED in-memory factory + escrow semantics for tests (no network). It
// mirrors the contract rules the seller worker depends on; the real contracts
// are exercised by Foundry tests, not here.
// ---------------------------------------------------------------------------

export type FakeWrite = "create" | "transferUsdc" | "markFunded" | "revealKey" | "finalizePayout";

interface FakeEscrow {
  terms: OrderTermsWire;
  status: EscrowStatusName;
  challengeEnd: bigint;
  revealedKey: Hex | null;
}

export interface FakeRecourseChain extends RecourseChain {
  escrows: Map<Address, FakeEscrow>;
  balances: Map<string, bigint>;
  calls: { fn: FakeWrite; args: unknown[] }[];
  /** Test-only: the buyer paying the escrow (what treasury.settle() does on chain). */
  fundEscrow(escrow: Address, amount: bigint): void;
  /** Test-only: buyer refund after the reveal deadline (Created|Funded -> Refunded). */
  claimTimeoutRefund(escrow: Address): void;
  flagSeller(seller: Address): void;
  /** Make the next `fn` write return the given status; `apply` says whether the state change still lands. */
  forceNext(fn: FakeWrite, mode: { status: "unknown" | "reverted"; apply: boolean }): void;
  isEscrowOverride: boolean | null;
}

export function createFakeRecourseChain(opts: { sellerAddress: Address; usdcBalances?: Record<string, bigint>; now: () => bigint }): FakeRecourseChain {
  const escrows = new Map<Address, FakeEscrow>();
  const balances = new Map<string, bigint>(Object.entries(opts.usdcBalances ?? {}).map(([a, v]) => [a.toLowerCase(), v]));
  const cheats = new Map<string, bigint>();
  const calls: FakeRecourseChain["calls"] = [];
  const forced = new Map<FakeWrite, { status: "unknown" | "reverted"; apply: boolean }>();
  let txCounter = 0;
  let block = 100n;
  const bal = (a: string) => balances.get(a.toLowerCase()) ?? 0n;
  const setBal = (a: string, v: bigint) => balances.set(a.toLowerCase(), v);
  const nextHash = (): Hex => keccak256(toHex(`fake-tx-${++txCounter}`));
  const key = (a: Address) => getAddress(a);

  /** Runs `check` (throws => simulation-reverted), then `apply`, honoring a forced outcome. */
  const write = (fn: FakeWrite, args: unknown[], check: () => void, apply: () => void): TxOutcome => {
    calls.push({ fn, args });
    try {
      check();
    } catch (e) {
      return { status: "simulation-reverted", error: e instanceof Error ? e.message : String(e) };
    }
    const hash = nextHash();
    block += 1n;
    const force = forced.get(fn);
    if (force) {
      forced.delete(fn);
      if (force.apply) apply();
      return force.status === "unknown" ? { status: "unknown", hash, error: "fake: receipt timeout" } : { status: "reverted", hash, blockNumber: block };
    }
    apply();
    return { status: "success", hash, blockNumber: block };
  };
  const must = (escrow: Address): FakeEscrow => {
    const e = escrows.get(key(escrow));
    if (!e) throw new Error("NotAnEscrow()");
    return e;
  };

  const predict = (orderId: Hex, termsHash: Hex): Address => getAddress(`0x${keccak256(encodePacked(["bytes32", "bytes32"], [orderId, termsHash])).slice(26)}`);

  const chain: FakeRecourseChain = {
    sellerAddress: opts.sellerAddress,
    escrows,
    balances,
    calls,
    isEscrowOverride: null,
    predict: async (orderId, termsHash) => predict(orderId, termsHash),
    isEscrow: async (address) => chain.isEscrowOverride ?? escrows.has(key(address)),
    provenCheats: async (seller) => cheats.get(seller.toLowerCase()) ?? 0n,
    status: async (escrow) => must(escrow).status,
    challengeEnd: async (escrow) => must(escrow).challengeEnd,
    usdcBalance: async (address) => bal(address),
    blockTimestamp: async () => opts.now(),
    create: async (terms) => {
      const escrow = predict(terms.orderId, terms.termsHash);
      return write(
        "create",
        [terms],
        () => {
          if (escrows.has(escrow)) throw new Error("OrderExists()");
          if ((cheats.get(terms.seller.toLowerCase()) ?? 0n) !== 0n) throw new Error("SellerFlagged()");
          if (terms.seller.toLowerCase() !== opts.sellerAddress.toLowerCase()) throw new Error("NotSeller()");
        },
        () => escrows.set(escrow, { terms, status: "Created", challengeEnd: 0n, revealedKey: null }),
      );
    },
    transferUsdc: async (to, amount) =>
      write(
        "transferUsdc",
        [to, amount],
        () => {
          if (bal(opts.sellerAddress) < amount) throw new Error("ERC20: transfer amount exceeds balance");
        },
        () => {
          setBal(opts.sellerAddress, bal(opts.sellerAddress) - amount);
          setBal(to, bal(to) + amount);
        },
      ),
    markFunded: async (escrow) =>
      write(
        "markFunded",
        [escrow],
        () => {
          const e = must(escrow);
          if (e.status !== "Created") throw new Error("InvalidStatus()");
          if (bal(escrow) < BigInt(e.terms.amount) + BigInt(e.terms.bond)) throw new Error("NotFunded()");
        },
        () => {
          must(escrow).status = "Funded";
        },
      ),
    revealKey: async (escrow, k) =>
      write(
        "revealKey",
        [escrow, k],
        () => {
          const e = must(escrow);
          if (e.terms.seller.toLowerCase() !== opts.sellerAddress.toLowerCase()) throw new Error("NotSeller()");
          if (e.status !== "Funded") throw new Error("InvalidStatus()");
          if (opts.now() >= BigInt(e.terms.revealDeadline)) throw new Error("RevealDeadlinePassed()");
          if (keccak256(k).toLowerCase() !== e.terms.keyCommitment.toLowerCase()) throw new Error("BadKey()");
        },
        () => {
          const e = must(escrow);
          e.status = "Revealed";
          e.revealedKey = k;
          e.challengeEnd = opts.now() + BigInt(e.terms.challengeWindow);
        },
      ),
    finalizePayout: async (escrow) =>
      write(
        "finalizePayout",
        [escrow],
        () => {
          const e = must(escrow);
          if (e.status !== "Revealed") throw new Error("InvalidStatus()");
          if (opts.now() < e.challengeEnd) throw new Error("ChallengeWindowOpen()");
        },
        () => {
          const e = must(escrow);
          e.status = "Settled";
          setBal(e.terms.seller, bal(e.terms.seller) + bal(escrow));
          setBal(escrow, 0n);
        },
      ),
    fundEscrow: (escrow, amount) => setBal(escrow, bal(escrow) + amount),
    claimTimeoutRefund(escrow) {
      const e = must(escrow);
      if (e.status !== "Created" && e.status !== "Funded") throw new Error("InvalidStatus()");
      if (opts.now() <= BigInt(e.terms.revealDeadline)) throw new Error("RevealDeadlineNotPassed()");
      e.status = "Refunded";
      setBal(e.terms.buyer, bal(e.terms.buyer) + bal(escrow));
      setBal(escrow, 0n);
    },
    flagSeller: (seller) => cheats.set(seller.toLowerCase(), (cheats.get(seller.toLowerCase()) ?? 0n) + 1n),
    forceNext: (fn, mode) => forced.set(fn, mode),
  };
  return chain;
}
