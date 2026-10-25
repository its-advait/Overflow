import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Hex } from "viem";
import { overflowTreasuryAbi, USDC } from "@overflow/schemas";
import { authorizationDigest, signAuthorization, signCreateChild, signPauseChild } from "@overflow/payment-client";
import {
  ATTACKER,
  auth,
  DEMO_TOKEN,
  fakeChain,
  makeApp,
  NODE,
  nodeCreatedLog,
  nodePausedLog,
  nowSec,
  paidLog,
  PAYEE,
  post,
  receipt,
  RELAYER,
  releasedLog,
  reservedLog,
  revert,
  revertString,
  TREASURY,
} from "./fakes.test-util";

async function payment(to: `0x${string}` = PAYEE, value = "50000", nonce?: Hex) {
  const a = auth(to, value, nonce);
  const signature = await signAuthorization(NODE, a);
  return { paymentPayload: { payload: { authorization: a, signature } }, a, signature };
}
const H1 = `0x${"11".repeat(32)}` as const;

describe("GET /health and /supported", () => {
  it("health reports chain, treasury, relayer and queue; never a key", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const res = await app.request("/health");
    const j = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ ok: true, chainId: 84532, treasury: TREASURY, relayer: RELAYER.address, relayerBalanceWei: "1000000000000000000", pendingTx: 0, demoMode: false });
    expect(JSON.stringify(j)).not.toMatch(/7e1a/);
  });
  it("supported lists the exact scheme on Base Sepolia with the treasury as payer", async () => {
    const { app } = makeApp(fakeChain());
    const j = (await (await app.request("/supported")).json()) as { kinds: unknown[] };
    expect(j.kinds).toEqual([{ x402Version: 2, scheme: "exact", network: "eip155:84532", asset: USDC.address, payer: TREASURY }]);
  });
  it("unknown route is a JSON 404 and /demo/bypass is absent outside demo mode", async () => {
    const { app } = makeApp(fakeChain());
    expect((await app.request("/nope")).status).toBe(404);
    expect((await post(app, "/demo/bypass", {})).status).toBe(404);
    expect((await post(app, "/admin/pause", {})).status).toBe(404);
  });
});

describe("POST /verify", () => {
  it("valid authorization simulates settle and returns payer, nodeId and digest", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const p = await payment();
    const { status, json } = await post(app, "/verify", { paymentPayload: p.paymentPayload, paymentRequirements: { payTo: PAYEE, amount: "50000", asset: USDC.address, network: "eip155:84532" } });
    expect(status).toBe(200);
    expect(json).toMatchObject({ isValid: true, payer: NODE.address, nodeId: "1", digest: authorizationDigest(p.a) });
    expect(chain.sent).toHaveLength(0);
  });
  it("policy revert is decoded and never sent", async () => {
    const chain = fakeChain();
    chain.simulate = () => { throw revert("PayeeNotAllowed", [0n]); };
    const { app } = makeApp(chain);
    const p = await payment(ATTACKER);
    const { json } = await post(app, "/verify", { paymentPayload: p.paymentPayload });
    expect(json).toMatchObject({ isValid: false, invalidReason: "Recipient is not approved for anyone", payer: NODE.address });
    expect(json.decoded).toMatchObject({ name: "PayeeNotAllowed", args: ["0"] });
    expect(chain.sent).toHaveLength(0);
  });
  it("rejects from != treasury, mismatched requirements and expired windows before any chain call", async () => {
    const chain = fakeChain();
    let simulated = 0;
    chain.simulate = () => { simulated++; return undefined; };
    const { app } = makeApp(chain);
    const p = await payment();
    const wrongFrom = { ...p.paymentPayload, payload: { ...p.paymentPayload.payload, authorization: { ...p.a, from: ATTACKER } } };
    expect((await post(app, "/verify", { paymentPayload: wrongFrom })).json.invalidReason).toMatch(/from must be the treasury/);
    expect((await post(app, "/verify", { paymentPayload: p.paymentPayload, paymentRequirements: { payTo: ATTACKER, amount: "1", asset: USDC.address } })).json.invalidReason).toMatch(/payTo/);
    expect((await post(app, "/verify", { paymentPayload: p.paymentPayload, paymentRequirements: { payTo: PAYEE, amount: "50001", asset: USDC.address } })).json.invalidReason).toMatch(/below required/);
    const expired = { ...p.paymentPayload, payload: { ...p.paymentPayload.payload, authorization: { ...p.a, validBefore: (nowSec - 1n).toString() } } };
    expect((await post(app, "/verify", { paymentPayload: expired })).json.invalidReason).toMatch(/expired/);
    expect(simulated).toBe(0);
  });
  it("400 with zod issues for floats, bad addresses, short nonces", async () => {
    const { app } = makeApp(fakeChain());
    const p = await payment();
    for (const bad of [{ ...p.a, value: "0.05" }, { ...p.a, to: "0x12" }, { ...p.a, nonce: "0xab" }]) {
      const r = await post(app, "/verify", { paymentPayload: { payload: { authorization: bad, signature: p.signature } } });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ name: "InvalidRequest" });
    }
    expect((await app.request("/verify", { method: "POST", body: "not json" })).status).toBe(400);
  });
});

describe("POST /settle", () => {
  it("success: simulate, send once, parse Paid, store the result", async () => {
    const chain = fakeChain();
    const { app, store, bus } = makeApp(chain);
    const p = await payment();
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "success", [paidLog(1n, PAYEE, 50000n, p.a.nonce, H1)]);
    const { status, json } = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: true, transaction: H1, nodeId: "1", payer: NODE.address, blockNumber: "100", network: "eip155:84532" });
    expect(json.explorerUrl).toContain(H1);
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0]).toMatchObject({ to: TREASURY, nonce: 7 });
    expect(chain.sent[0]!.gas).toBeUndefined();
    const call = decodeFunctionData({ abi: overflowTreasuryAbi, data: chain.sent[0]!.data });
    expect(call.functionName).toBe("settle");
    expect((call.args as unknown as unknown[])[0]).toBe(PAYEE);
    const rec = await store.get(authorizationDigest(p.a));
    expect(rec).toMatchObject({ status: "done", txHash: H1, route: "settle" });
    expect(bus.replay().filter((e) => e.kind === "Reverted")).toHaveLength(0);
  });
  it("409 with the original result when the digest was already submitted", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const p = await payment();
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "success", [paidLog(1n, PAYEE, 50000n, p.a.nonce, H1)]);
    const first = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    const again = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    expect(again.status).toBe(409);
    expect(again.json.error).toMatchObject({ name: "AlreadySubmitted" });
    expect(again.json.original).toMatchObject({ status: "done", txHash: H1, result: first.json });
    expect(chain.sent).toHaveLength(1);
    // /reserve with the same digest is also a replay
    expect((await post(app, "/reserve", { paymentPayload: p.paymentPayload })).status).toBe(409);
  });
  it("409 while the first submission is still pending", async () => {
    const chain = fakeChain();
    let release!: () => void;
    chain.waitForTransactionReceipt = ({ hash }) => new Promise((r) => { release = () => r(receipt(hash, "success")); });
    const { app } = makeApp(chain);
    const p = await payment();
    const first = post(app, "/settle", { paymentPayload: p.paymentPayload });
    await new Promise((r) => setTimeout(r, 20));
    const second = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    expect(second.status).toBe(409);
    expect(second.json.original).toMatchObject({ status: "pending" });
    release();
    expect((await first).json).toMatchObject({ success: true });
  });
  it("policy revert: decoded, nothing sent, Reverted event published", async () => {
    const chain = fakeChain();
    chain.simulate = () => { throw revert("OverBudget", [2n]); };
    const { app, bus } = makeApp(chain);
    const p = await payment();
    const { status, json } = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: false, errorReason: "Agent 2 or an ancestor would pass its cap" });
    expect(chain.sent).toHaveLength(0);
    expect(bus.replay().at(-1)).toMatchObject({ kind: "Reverted", source: "facilitator", route: "settle", decoded: { name: "OverBudget" } });
  });
  it("front-run: nonce already used by someone else -> success with their tx", async () => {
    const chain = fakeChain();
    const p = await payment();
    chain.simulate = () => { throw revertString("FiatTokenV2: authorization is used or canceled"); };
    chain.reads["authorizationState"] = true;
    chain.logs = [paidLog(1n, PAYEE, 50000n, p.a.nonce, H1)];
    const { app } = makeApp(chain);
    const { json } = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    expect(json).toMatchObject({ success: true, external: true, transaction: H1, kind: "Paid" });
    expect(chain.sent).toHaveLength(0);
  });
  it("forceBroadcast is 403 outside demo mode or with a wrong token", async () => {
    const chain = fakeChain();
    chain.simulate = () => { throw revert("PayeeNotAllowed", [0n]); };
    const p = await payment(ATTACKER);
    const off = makeApp(chain);
    expect((await post(off.app, "/settle", { paymentPayload: p.paymentPayload, forceBroadcast: true })).status).toBe(403);
    const on = makeApp(chain, { demo: true });
    expect((await post(on.app, "/settle", { paymentPayload: p.paymentPayload, forceBroadcast: true }, { "x-demo-token": "wrong" })).status).toBe(403);
    expect(chain.sent).toHaveLength(0);
  });
  it("forceBroadcast in demo mode lands the revert onchain with fixed gas and decodes it", async () => {
    const chain = fakeChain();
    chain.simulate = () => { throw revert("PayeeNotAllowed", [0n]); };
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "reverted");
    const { app, bus } = makeApp(chain, { demo: true });
    const p = await payment(ATTACKER);
    const { status, json } = await post(app, "/settle", { paymentPayload: p.paymentPayload, forceBroadcast: true }, { "x-demo-token": DEMO_TOKEN });
    expect(status).toBe(200);
    expect(json).toMatchObject({ success: false, transaction: H1, forced: true, simulated: true, errorReason: "Recipient is not approved for anyone" });
    expect(chain.sent[0]!.gas).toBe(400_000n);
    expect(bus.replay().at(-1)).toMatchObject({ kind: "Reverted", txHash: H1, simulated: true });
  });
  it("receipt timeout -> status unknown, hash kept, no resend", async () => {
    const chain = fakeChain();
    chain.receiptError = new Error("timed out");
    chain.nextHash = [H1];
    const { app, store } = makeApp(chain);
    const p = await payment();
    const { json } = await post(app, "/settle", { paymentPayload: p.paymentPayload });
    expect(json).toMatchObject({ success: false, status: "unknown", transaction: H1 });
    expect(String(json.errorReason)).toMatch(/never resign/);
    expect((await store.get(authorizationDigest(p.a)))!.status).toBe("unknown");
    expect((await post(app, "/settle", { paymentPayload: p.paymentPayload })).status).toBe(409);
  });
});

describe("POST /reserve and /release", () => {
  it("reserve parses Reserved and returns the digest", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const p = await payment();
    const digest = authorizationDigest(p.a);
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "success", [reservedLog(digest, 1n, PAYEE, 50000n, BigInt(p.a.validBefore), p.a.nonce, H1)]);
    const { json } = await post(app, "/reserve", { paymentPayload: p.paymentPayload });
    expect(json).toMatchObject({ success: true, transaction: H1, nodeId: "1", reservedDigest: digest, validBefore: p.a.validBefore });
    expect(decodeFunctionData({ abi: overflowTreasuryAbi, data: chain.sent[0]!.data }).functionName).toBe("reserve");
  });
  it("reserve revert (ReservationTooLong) is decoded", async () => {
    const chain = fakeChain();
    chain.simulate = () => { throw revert("ReservationTooLong"); };
    const { app } = makeApp(chain);
    const p = await payment();
    expect((await post(app, "/reserve", { paymentPayload: p.paymentPayload })).json).toMatchObject({ success: false, errorReason: "validBefore is beyond the reservation window" });
  });
  it("release returns refunded from the event and is idempotent", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const digest = `0x${"cd".repeat(32)}` as const;
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "success", [releasedLog(digest, true, H1)]);
    const { json } = await post(app, "/release", { digest });
    expect(json).toMatchObject({ ok: true, released: true, refunded: true, transaction: H1 });
    expect((await post(app, "/release", { digest })).status).toBe(409);
    chain.simulate = () => { throw revert("ReservationLive"); };
    expect((await post(app, "/release", { digest: `0x${"ee".repeat(32)}` })).json).toMatchObject({ ok: false, errorReason: "Reservation has not reached validBefore yet" });
  });
});

describe("POST /delegate and /pause-child", () => {
  const child = { parentId: "1", key: ATTACKER, cap: "10", maxPerCall: "5", expiry: (nowSec + 3600n).toString(), restricted: false, payees: [] as `0x${string}`[], nonce: "1", deadline: (nowSec + 60n).toString() };
  it("delegate relays createChild and returns the child id", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const signature = await signCreateChild(NODE, TREASURY, child);
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "success", [nodeCreatedLog(2n, 1n, ATTACKER, H1)]);
    const { json } = await post(app, "/delegate", { child, signature });
    expect(json).toMatchObject({ ok: true, childId: "2", transaction: H1, parentId: "1" });
    expect(decodeFunctionData({ abi: overflowTreasuryAbi, data: chain.sent[0]!.data }).functionName).toBe("createChild");
    expect((await post(app, "/delegate", { child, signature })).status).toBe(409);
  });
  it("delegate revert (ChildExceedsParent) decoded, nothing sent", async () => {
    const chain = fakeChain();
    chain.simulate = () => { throw revert("ChildExceedsParent"); };
    const { app } = makeApp(chain);
    const signature = await signCreateChild(NODE, TREASURY, child);
    expect((await post(app, "/delegate", { child, signature })).json).toMatchObject({ ok: false, errorReason: "Child would have more authority than its parent" });
    expect(chain.sent).toHaveLength(0);
  });
  it("pause-child relays and reports who paused", async () => {
    const chain = fakeChain();
    const { app } = makeApp(chain);
    const p = { target: "2", nonce: "3", deadline: (nowSec + 60n).toString() };
    const signature = await signPauseChild(NODE, TREASURY, p);
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "success", [nodePausedLog(2n, NODE.address, H1)]);
    const { json } = await post(app, "/pause-child", { ...p, signature });
    expect(json).toMatchObject({ ok: true, target: "2", pausedBy: NODE.address });
    chain.simulate = () => { throw revert("NotAncestor"); };
    expect((await post(app, "/pause-child", { ...p, nonce: "4", signature })).json).toMatchObject({ ok: false, errorReason: "Signer is not a strict ancestor of the target node" });
  });
});

describe("POST /demo/bypass", () => {
  it("needs the token, then broadcasts to USDC with fixed gas and reports the onchain rejection", async () => {
    const chain = fakeChain();
    chain.simulate = ({ address }) => { if (address === USDC.address) throw revertString("FiatTokenV2: invalid signature"); };
    chain.nextHash = [H1];
    chain.receipts[H1] = receipt(H1, "reverted");
    const { app, bus } = makeApp(chain, { demo: true });
    const p = await payment(ATTACKER);
    expect((await post(app, "/demo/bypass", { authorization: p.a, signature: p.signature })).status).toBe(403);
    const { json } = await post(app, "/demo/bypass", { authorization: p.a, signature: p.signature }, { "x-demo-token": DEMO_TOKEN });
    expect(json).toMatchObject({ ok: true, rejected: true, simulated: true, transaction: H1 });
    expect(String(json.reason)).toMatch(/only valid inside treasury.settle/);
    expect(chain.sent[0]).toMatchObject({ to: USDC.address, gas: 300_000n });
    expect(bus.replay().at(-1)).toMatchObject({ kind: "BypassRejected", simulated: true });
  });
  it("a bypass USDC accepts is reported as a failure of the gate, never as success", async () => {
    const chain = fakeChain();
    chain.nextHash = [H1];
    const { app, bus } = makeApp(chain, { demo: true });
    const p = await payment(ATTACKER);
    const { json } = await post(app, "/demo/bypass", { authorization: p.a, signature: p.signature }, { "x-demo-token": DEMO_TOKEN });
    expect(json).toMatchObject({ ok: true, rejected: false });
    expect(String(json.reason)).toMatch(/gate is open/);
    expect(bus.replay().at(-1)!.kind).toBe("BypassSucceeded");
  });
});
