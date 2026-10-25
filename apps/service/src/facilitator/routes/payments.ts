import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { encodeFunctionData, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { explorerUrl, overflowTreasuryAbi, USDC } from "@overflow/schemas";
import { authorizationDigest, recoverAuthorizationSigner, type Authorization } from "@overflow/payment-client";
import type { FacilitatorDeps } from "../context";
import { decodeRevert, type Decoded } from "../decode";
import { invalidRequest, ReleaseBodySchema, SettleBodySchema, VerifyBodySchema, type VerifyBody } from "../schemas";

type AuthArgs = readonly [Address, bigint, bigint, bigint, Hex, Hex];

function authArgs(a: Authorization, sig: Hex): AuthArgs {
  return [a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, sig];
}

/** Checks that need no chain call: from == treasury, requirements match, time window. */
export function precheck(body: VerifyBody, treasury: Address, now: Date): string | undefined {
  const { authorization: a } = body.paymentPayload.payload;
  if (a.from.toLowerCase() !== treasury.toLowerCase()) return `from must be the treasury ${treasury}`;
  const r = body.paymentRequirements;
  if (r) {
    if (r.payTo.toLowerCase() !== a.to.toLowerCase()) return `payTo ${r.payTo} does not match authorization.to ${a.to}`;
    if (BigInt(a.value) < BigInt(r.amount)) return `value ${a.value} below required amount ${r.amount}`;
    if (r.asset.toLowerCase() !== USDC.address.toLowerCase()) return `asset ${r.asset} is not USDC`;
    if (r.network !== body.paymentPayload.network) return `network ${r.network} does not match payload ${body.paymentPayload.network}`;
  }
  const t = BigInt(Math.floor(now.getTime() / 1000));
  if (t <= BigInt(a.validAfter)) return "authorization not yet valid (validAfter in the future)";
  if (t >= BigInt(a.validBefore)) return "authorization expired (validBefore passed)";
  return undefined;
}

export function demoAuthorized(c: Context, deps: FacilitatorDeps): boolean {
  if (!deps.demoMode || !deps.demoToken) return false;
  const given = c.req.header("x-demo-token") ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(deps.demoToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function eventArgs<T extends string>(receipt: TransactionReceipt, eventName: T): Record<string, unknown> | undefined {
  const logs = parseEventLogs({ abi: overflowTreasuryAbi, logs: receipt.logs, eventName: eventName as never });
  const first = logs[0] as { args?: Record<string, unknown> } | undefined;
  return first?.args;
}

const s = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v));

export function paymentRoutes(deps: FacilitatorDeps) {
  const app = new Hono();
  const { treasury } = deps;

  async function simulate(fn: "settle" | "reserve", args: AuthArgs, blockNumber?: bigint): Promise<Decoded | undefined> {
    try {
      await deps.client.simulateContract({
        address: treasury,
        abi: overflowTreasuryAbi,
        functionName: fn,
        args,
        account: deps.relayer.address,
        ...(blockNumber !== undefined ? { blockNumber } : {}),
      });
      return undefined;
    } catch (e) {
      return decodeRevert(e);
    }
  }

  /** The nonce is already used onchain but we never submitted it: find who did (Paid or Reserved log). */
  async function frontRun(a: Authorization): Promise<{ transaction: Hex; kind: "Paid" | "Reserved" } | undefined> {
    const used = (await deps.client.readContract({
      address: deps.usdc,
      abi: [{ type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bool" }] }],
      functionName: "authorizationState",
      args: [treasury, a.nonce],
    })) as boolean;
    if (!used) return undefined;
    const head = await deps.client.getBlockNumber();
    const from = head > 2000n ? head - 2000n : 0n;
    const logs = await deps.client.getLogs({ address: treasury, fromBlock: from, toBlock: head });
    const parsed = parseEventLogs({ abi: overflowTreasuryAbi, logs }) as Array<{ eventName: string; args: Record<string, unknown>; transactionHash: Hex | null }>;
    for (const l of parsed) {
      if ((l.eventName === "Paid" || l.eventName === "Reserved") && String(l.args["nonce"]).toLowerCase() === a.nonce.toLowerCase() && l.transactionHash) {
        return { transaction: l.transactionHash, kind: l.eventName };
      }
    }
    return { transaction: "0x" as Hex, kind: "Paid" };
  }

  app.get("/health", async (c) => {
    const bal = await deps.client.getBalance(deps.relayer.address);
    return c.json({
      ok: true,
      chainId: deps.deployments.chainId,
      treasury,
      usdc: deps.usdc,
      escrowFactory: deps.deployments.escrowFactory,
      relayer: deps.relayer.address,
      relayerBalanceWei: bal.toString(),
      pendingTx: deps.relayer.pending(),
      queuedTx: deps.relayer.queued(),
      demoMode: deps.demoMode,
    });
  });

  app.get("/supported", (c) =>
    c.json({
      kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532", asset: USDC.address, payer: treasury }],
    }),
  );

  app.post("/verify", async (c) => {
    const parsed = VerifyBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(invalidRequest(parsed.error.issues), 400);
    const body = parsed.data;
    const { authorization: a, signature } = body.paymentPayload.payload;
    const pre = precheck(body, treasury, deps.now());
    if (pre) return c.json({ isValid: false, invalidReason: pre });
    let payer: Address;
    try {
      payer = await recoverAuthorizationSigner(a, signature);
    } catch {
      return c.json({ isValid: false, invalidReason: "malformed signature" });
    }
    const decoded = await simulate("settle", authArgs(a, signature));
    if (decoded) return c.json({ isValid: false, invalidReason: decoded.reason, decoded, payer });
    const nodeId = (await deps.client.readContract({ address: treasury, abi: overflowTreasuryAbi, functionName: "nodeOfKey", args: [payer] })) as bigint;
    return c.json({ isValid: true, payer, nodeId: nodeId.toString(), digest: authorizationDigest(a) });
  });

  /** Shared body of /settle and /reserve. */
  async function submitAuthorization(c: Context, fn: "settle" | "reserve") {
    const parsed = SettleBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(invalidRequest(parsed.error.issues), 400);
    const body = parsed.data;
    const { authorization: a, signature } = body.paymentPayload.payload;
    const digest = authorizationDigest(a);

    const existing = await deps.store.get(digest);
    if (existing) return c.json({ ok: false, error: { name: "AlreadySubmitted", reason: `digest ${digest} was already submitted` }, original: existing }, 409);

    const pre = precheck(body, treasury, deps.now());
    if (pre) return c.json({ success: false, errorReason: pre, digest });

    let payer: Address;
    try {
      payer = await recoverAuthorizationSigner(a, signature);
    } catch {
      return c.json({ success: false, errorReason: "malformed signature", digest });
    }

    const force = body.forceBroadcast;
    if (force && fn === "settle" && !demoAuthorized(c, deps)) {
      return c.json({ ok: false, error: { name: "Forbidden", reason: "forceBroadcast needs DEMO_MODE=true and a valid x-demo-token" } }, 403);
    }

    const args = authArgs(a, signature);
    const simulated = await simulate(fn, args);
    if (simulated && !(force && fn === "settle")) {
      const fr = await frontRun(a);
      if (fr && fr.transaction !== "0x") {
        return c.json({ success: true, external: true, transaction: fr.transaction, explorerUrl: explorerUrl("tx", fr.transaction), kind: fr.kind, payer, digest });
      }
      deps.bus.publish({ kind: "Reverted", source: "facilitator", route: fn, digest, decoded: simulated });
      return c.json({ success: false, errorReason: simulated.reason, decoded: simulated, payer, digest });
    }

    const created = await deps.store.create({ key: digest, route: fn, status: "pending", createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    if (!created) {
      const orig = await deps.store.get(digest);
      return c.json({ ok: false, error: { name: "AlreadySubmitted", reason: `digest ${digest} was already submitted` }, original: orig }, 409);
    }

    const data = encodeFunctionData({ abi: overflowTreasuryAbi, functionName: fn, args });
    const res = await deps.relayer.submit({ to: treasury, data, label: fn, ...(force ? { gas: 400_000n } : {}) });
    const base = { payer, digest, transaction: res.hash, explorerUrl: explorerUrl("tx", res.hash), network: "eip155:84532" };

    if (res.status === "unknown") {
      const result = { success: false, status: "unknown", errorReason: `no receipt: ${res.error}; reconcile before retrying, never resign`, ...base };
      await deps.store.update(digest, { status: "unknown", txHash: res.hash, result });
      return c.json(result);
    }
    if (res.status === "reverted") {
      const decoded = simulated ?? (await simulate(fn, args, res.receipt.blockNumber - 1n)) ?? { name: "Unknown", args: [], reason: "reverted onchain", source: "unknown" as const };
      const result = { success: false, errorReason: decoded.reason, decoded, blockNumber: res.receipt.blockNumber.toString(), ...base, ...(force ? { simulated: true, forced: true } : {}) };
      await deps.store.update(digest, { status: "done", txHash: res.hash, result });
      deps.bus.publish({ kind: "Reverted", source: "facilitator", route: fn, digest, decoded, txHash: res.hash, explorerUrl: explorerUrl("tx", res.hash), ...(force ? { simulated: true as const } : {}) });
      return c.json(result);
    }
    const ev = fn === "settle" ? eventArgs(res.receipt, "Paid") : eventArgs(res.receipt, "Reserved");
    const result = {
      success: true,
      blockNumber: res.receipt.blockNumber.toString(),
      nodeId: ev ? s(ev["id"]) : null,
      ...(fn === "reserve" ? { reservedDigest: ev ? s(ev["digest"]) : digest, validBefore: a.validBefore } : {}),
      ...base,
    };
    await deps.store.update(digest, { status: "done", txHash: res.hash, result });
    return c.json(result);
  }

  app.post("/settle", (c) => submitAuthorization(c, "settle"));
  app.post("/reserve", (c) => submitAuthorization(c, "reserve"));

  app.post("/release", async (c) => {
    const parsed = ReleaseBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(invalidRequest(parsed.error.issues), 400);
    const digest = parsed.data.digest;
    const key = `release:${digest}`;
    const existing = await deps.store.get(key);
    if (existing) return c.json({ ok: false, error: { name: "AlreadySubmitted", reason: `release of ${digest} was already submitted` }, original: existing }, 409);
    try {
      await deps.client.simulateContract({ address: treasury, abi: overflowTreasuryAbi, functionName: "release", args: [digest], account: deps.relayer.address });
    } catch (e) {
      const decoded = decodeRevert(e);
      deps.bus.publish({ kind: "Reverted", source: "facilitator", route: "release", digest, decoded });
      return c.json({ ok: false, released: false, errorReason: decoded.reason, decoded, digest });
    }
    await deps.store.create({ key, route: "release", status: "pending", createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    const res = await deps.relayer.submit({ to: treasury, data: encodeFunctionData({ abi: overflowTreasuryAbi, functionName: "release", args: [digest] }), label: "release" });
    if (res.status !== "success") {
      const result = { ok: false, released: false, status: res.status, transaction: res.hash, explorerUrl: explorerUrl("tx", res.hash), digest };
      await deps.store.update(key, { status: res.status === "unknown" ? "unknown" : "done", txHash: res.hash, result });
      return c.json(result);
    }
    const ev = eventArgs(res.receipt, "ReservationReleased");
    const result = { ok: true, released: true, refunded: ev ? Boolean(ev["refunded"]) : null, transaction: res.hash, explorerUrl: explorerUrl("tx", res.hash), blockNumber: res.receipt.blockNumber.toString(), digest };
    await deps.store.update(key, { status: "done", txHash: res.hash, result });
    return c.json(result);
  });

  return app;
}
