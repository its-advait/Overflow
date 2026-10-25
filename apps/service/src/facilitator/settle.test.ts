import { buildPaymentPayload, signTransfer, type PaymentRequirements } from "@overflow/payment-client";
import { USDC, type Address, type Hex } from "@overflow/schemas";
import { BaseError, ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { treasurySettleAbi } from "./abi.js";
import { checkSettleRequirements, createChainFacilitator, type SettleChain, type SettleReceipt } from "./settle.js";

// SIMULATED fixtures: a test node key, a treasury address and a fake chain.
const TREASURY = "0x1111111111111111111111111111111111111111" as Address;
const PAYEE = "0x2222222222222222222222222222222222222222" as Address;
const ATTACKER = "0x4444444444444444444444444444444444444444" as Address; // SIMULATED attacker payee
const NODE = privateKeyToAccount(keccak256(toBytes("overflow.test.node-key")));
const TX = `0x${"77".repeat(32)}` as Hex;
const NOW = 1_800_000_000n;

const req = (over: Partial<PaymentRequirements> = {}): PaymentRequirements => ({
  scheme: "exact",
  network: "eip155:84532",
  amount: "20000",
  asset: USDC.address,
  payTo: PAYEE,
  maxTimeoutSeconds: 120,
  extra: { name: "USDC", version: "2" },
  ...over,
});

async function signedPayload(requirements: PaymentRequirements) {
  const signed = await signTransfer({ nodeAccount: NODE, treasury: TREASURY, to: requirements.payTo as Address, value: requirements.amount, ttlSeconds: 120, nowSeconds: Number(NOW) });
  return { payload: buildPaymentPayload({ accepted: requirements, signed }), signed };
}

function revertError(name: "PayeeNotAllowed" | "OverBudget", node: bigint): Error {
  const data = encodeErrorResult({ abi: treasurySettleAbi, errorName: name, args: [node] });
  return new BaseError("execution reverted", { cause: new ContractFunctionRevertedError({ abi: treasurySettleAbi, data, functionName: "settle" }) });
}

function paidReceipt(nonce: Hex, nodeId = 3n): SettleReceipt {
  const topics = encodeEventTopics({ abi: treasurySettleAbi, eventName: "Paid", args: { id: nodeId, to: PAYEE } }) as [Hex, ...Hex[]];
  const data = encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [20000n, nonce]);
  return { status: "success", blockNumber: 42n, logs: [{ address: TREASURY, topics, data }] };
}

interface FakeOptions {
  simulate?: Error;
  receipt?: SettleReceipt | Error;
  send?: Error;
  consumed?: boolean;
  nodeId?: bigint;
}

function fakeChain(o: FakeOptions = {}) {
  const calls = { simulate: 0, send: 0 };
  const chain: SettleChain = {
    async getBlockTimestamp() {
      return NOW;
    },
    async nodeOfKey() {
      return o.nodeId ?? 3n;
    },
    async authorizationState() {
      return o.consumed ?? true;
    },
    async simulateSettle() {
      calls.simulate++;
      if (o.simulate) throw o.simulate;
    },
    async sendSettle() {
      calls.send++;
      if (o.send) throw o.send;
      return TX;
    },
    async waitForReceipt() {
      if (o.receipt instanceof Error) throw o.receipt;
      return o.receipt ?? { status: "reverted", blockNumber: 42n, logs: [] };
    },
  };
  return { chain, calls };
}

describe("facilitator settle core", () => {
  it("refuses requirement failures before any simulation", async () => {
    const requirements = req();
    const { payload } = await signedPayload(requirements);
    expect(checkSettleRequirements({ payload, requirements, forceBroadcast: false }, TREASURY, NOW)).toBeUndefined();
    // from != treasury
    const other = "0x9999999999999999999999999999999999999999" as Address;
    expect(checkSettleRequirements({ payload, requirements, forceBroadcast: false }, other, NOW)).toMatch(/from is not the treasury/);
    // payTo differs from what was signed
    expect(checkSettleRequirements({ payload, requirements: req({ payTo: ATTACKER }), forceBroadcast: false }, TREASURY, NOW)).toMatch(/authorization.to/);
    // amount must equal exactly (not merely cover)
    expect(checkSettleRequirements({ payload, requirements: req({ amount: "19999" }), forceBroadcast: false }, TREASURY, NOW)).toMatch(/value does not equal/);
    // expired
    expect(checkSettleRequirements({ payload, requirements, forceBroadcast: false }, TREASURY, NOW + 1000n)).toBe("authorization expired");

    const { chain, calls } = fakeChain();
    const out = await createChainFacilitator({ chain, treasury: TREASURY }).settle({ payload, requirements: req({ amount: "19999" }), forceBroadcast: true });
    expect(out.outcome).toBe("blocked");
    expect(calls.simulate).toBe(0);
    expect(calls.send).toBe(0);
  });

  it("a simulation revert is blocked and decoded; nothing is broadcast without force", async () => {
    const requirements = req({ payTo: ATTACKER });
    const { payload, signed } = await signedPayload(requirements);
    const { chain, calls } = fakeChain({ simulate: revertError("PayeeNotAllowed", 0n) });
    const out = await createChainFacilitator({ chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: false });
    expect(out).toMatchObject({ outcome: "blocked", decoded: { name: "PayeeNotAllowed", args: ["0"], decoded: "PayeeNotAllowed(0)" }, digest: signed.digest, payer: NODE.address, nodeId: "3" });
    expect("txHash" in out).toBe(false);
    expect(calls.send).toBe(0);
  });

  it("force broadcast sends the reverting settle() and reports the tx hash as blocked", async () => {
    const requirements = req({ payTo: ATTACKER });
    const { payload } = await signedPayload(requirements);
    const { chain, calls } = fakeChain({ simulate: revertError("PayeeNotAllowed", 0n), receipt: { status: "reverted", blockNumber: 43n, logs: [] } });
    const out = await createChainFacilitator({ chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: true });
    expect(out).toMatchObject({ outcome: "blocked", txHash: TX, decoded: { name: "PayeeNotAllowed", args: ["0"] } });
    expect(calls.send).toBe(1);
  });

  it("paid only when the receipt succeeded, Paid matches the nonce and USDC consumed it", async () => {
    const requirements = req();
    const { payload, signed } = await signedPayload(requirements);
    const ok = fakeChain({ receipt: paidReceipt(signed.authorization.nonce, 3n) });
    const out = await createChainFacilitator({ chain: ok.chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: false });
    expect(out).toEqual({ outcome: "paid", txHash: TX, blockNumber: "42", nodeId: "3", payer: NODE.address, digest: signed.digest });

    const notConsumed = fakeChain({ receipt: paidReceipt(signed.authorization.nonce), consumed: false });
    expect(await createChainFacilitator({ chain: notConsumed.chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: false })).toMatchObject({
      outcome: "unknown",
      txHash: TX,
      reason: expect.stringContaining("did not consume"),
    });

    const wrongNonce = fakeChain({ receipt: paidReceipt(`0x${"ab".repeat(32)}` as Hex) });
    expect(await createChainFacilitator({ chain: wrongNonce.chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: false })).toMatchObject({
      outcome: "unknown",
      reason: expect.stringContaining("no matching Paid"),
    });
  });

  it("a send or receipt failure is unknown with the digest, never blocked or paid", async () => {
    const requirements = req();
    const { payload, signed } = await signedPayload(requirements);
    const sendFail = fakeChain({ send: new Error("nonce too low") });
    expect(await createChainFacilitator({ chain: sendFail.chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: false })).toEqual({
      outcome: "unknown",
      reason: "send failed: nonce too low",
      digest: signed.digest,
    });
    const receiptFail = fakeChain({ receipt: new Error("timeout") });
    expect(await createChainFacilitator({ chain: receiptFail.chain, treasury: TREASURY }).settle({ payload, requirements, forceBroadcast: false })).toEqual({
      outcome: "unknown",
      reason: "no receipt: timeout",
      digest: signed.digest,
      txHash: TX,
    });
  });
});
