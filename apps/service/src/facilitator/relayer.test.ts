import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { createRelayer, makeMutex } from "./relayer";
import { fakeChain, receipt, RELAYER, TREASURY } from "./fakes.test-util";

describe("relayer", () => {
  it("serializes submissions: one in flight, consecutive nonces, no shared nonce", async () => {
    const chain = fakeChain();
    let maxInFlight = 0;
    const r = createRelayer({ client: chain, address: RELAYER.address, receiptTimeoutMs: 100 });
    chain.waitForTransactionReceipt = async ({ hash }) => {
      maxInFlight = Math.max(maxInFlight, r.pending());
      await new Promise((x) => setTimeout(x, 5));
      return receipt(hash, "success");
    };
    const results = await Promise.all([1, 2, 3].map((i) => r.submit({ to: TREASURY, data: `0x0${i}` as Hex, label: `tx${i}` })));
    expect(results.every((x) => x.status === "success")).toBe(true);
    expect(chain.sent.map((s) => s.nonce)).toEqual([7, 8, 9]);
    expect(maxInFlight).toBe(1);
    expect(r.pending()).toBe(0);
    expect(r.queued()).toBe(0);
  });
  it("re-syncs the nonce from the node after a send failure", async () => {
    const chain = fakeChain();
    const r = createRelayer({ client: chain, address: RELAYER.address });
    const send = chain.sendTransaction;
    let fail = true;
    chain.sendTransaction = async (a) => {
      if (fail) { fail = false; throw new Error("nonce too low"); }
      return send(a);
    };
    await expect(r.submit({ to: TREASURY, data: "0x01", label: "a" })).rejects.toThrow(/nonce too low/);
    chain.nonce = 12; // node says the real pending nonce moved
    const ok = await r.submit({ to: TREASURY, data: "0x02", label: "b" });
    expect(ok.status).toBe("success");
    expect(chain.sent[0]!.nonce).toBe(12);
  });
  it("receipt timeout returns unknown with the hash and forgets the local nonce", async () => {
    const chain = fakeChain();
    chain.receiptError = new Error("Timed out while waiting for transaction");
    chain.nextHash = [`0x${"aa".repeat(32)}`];
    const r = createRelayer({ client: chain, address: RELAYER.address, receiptTimeoutMs: 10 });
    const res = await r.submit({ to: TREASURY, data: "0x01", label: "a" });
    expect(res).toMatchObject({ status: "unknown", hash: `0x${"aa".repeat(32)}` });
    chain.receiptError = undefined;
    chain.nonce = 8;
    await r.submit({ to: TREASURY, data: "0x02", label: "b" });
    expect(chain.sent[1]!.nonce).toBe(8);
  });
  it("mutex runs tasks in order even when one rejects", async () => {
    const lock = makeMutex();
    const order: string[] = [];
    const a = lock(async () => { order.push("a"); throw new Error("x"); });
    const b = lock(async () => { order.push("b"); return 2; });
    await expect(a).rejects.toThrow("x");
    expect(await b).toBe(2);
    expect(order).toEqual(["a", "b"]);
  });
});
