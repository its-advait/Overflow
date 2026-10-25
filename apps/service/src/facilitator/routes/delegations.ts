import { Hono } from "hono";
import { encodeFunctionData, type Hex } from "viem";
import { explorerUrl, overflowTreasuryAbi } from "@overflow/schemas";
import { createChildDigest, pauseChildDigest } from "@overflow/payment-client";
import type { FacilitatorDeps } from "../context";
import { decodeRevert } from "../decode";
import { DelegateBodySchema, invalidRequest, PauseChildBodySchema } from "../schemas";
import { eventArgs } from "./payments";

/** Gasless relays of signed CreateChild / PauseChild messages. The signature is the parent's; we only pay gas. */
export function delegationRoutes(deps: FacilitatorDeps) {
  const app = new Hono();
  const { treasury } = deps;

  async function relay(key: string, route: "delegate" | "pause-child", data: Hex, simulate: () => Promise<unknown>, onSuccess: (receipt: import("viem").TransactionReceipt) => Record<string, unknown>) {
    const existing = await deps.store.get(key);
    if (existing) return { status: 409 as const, body: { ok: false, error: { name: "AlreadySubmitted", reason: `this ${route} message was already relayed` }, original: existing } };
    try {
      await simulate();
    } catch (e) {
      const decoded = decodeRevert(e);
      deps.bus.publish({ kind: "Reverted", source: "facilitator", route, digest: key as Hex, decoded });
      return { status: 200 as const, body: { ok: false, errorReason: decoded.reason, decoded } };
    }
    await deps.store.create({ key, route, status: "pending", createdAt: deps.now().toISOString(), updatedAt: deps.now().toISOString() });
    const res = await deps.relayer.submit({ to: treasury, data, label: route });
    const base = { transaction: res.hash, explorerUrl: explorerUrl("tx", res.hash) };
    if (res.status !== "success") {
      const body = { ok: false, status: res.status, errorReason: res.status === "unknown" ? `no receipt: ${res.error}` : "reverted onchain", ...base };
      await deps.store.update(key, { status: res.status === "unknown" ? "unknown" : "done", txHash: res.hash, result: body });
      return { status: 200 as const, body };
    }
    const body = { ok: true, blockNumber: res.receipt.blockNumber.toString(), ...base, ...onSuccess(res.receipt) };
    await deps.store.update(key, { status: "done", txHash: res.hash, result: body });
    return { status: 200 as const, body };
  }

  app.post("/delegate", async (c) => {
    const parsed = DelegateBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(invalidRequest(parsed.error.issues), 400);
    const { child, signature } = parsed.data;
    const key = createChildDigest(treasury, child);
    const args = [
      {
        parentId: BigInt(child.parentId),
        key: child.key,
        cap: BigInt(child.cap),
        maxPerCall: BigInt(child.maxPerCall),
        expiry: BigInt(child.expiry),
        restricted: child.restricted,
        payees: child.payees,
        nonce: BigInt(child.nonce),
        deadline: BigInt(child.deadline),
      },
      signature,
    ] as const;
    const r = await relay(
      key,
      "delegate",
      encodeFunctionData({ abi: overflowTreasuryAbi, functionName: "createChild", args }),
      () => deps.client.simulateContract({ address: treasury, abi: overflowTreasuryAbi, functionName: "createChild", args, account: deps.relayer.address }),
      (receipt) => {
        const ev = eventArgs(receipt, "NodeCreated");
        return { childId: ev ? String(ev["id"]) : null, parentId: child.parentId, key: child.key };
      },
    );
    return c.json(r.body, r.status);
  });

  app.post("/pause-child", async (c) => {
    const parsed = PauseChildBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(invalidRequest(parsed.error.issues), 400);
    const { signature, ...p } = parsed.data;
    const key = pauseChildDigest(treasury, p);
    const args = [BigInt(p.target), BigInt(p.nonce), BigInt(p.deadline), signature] as const;
    const r = await relay(
      key,
      "pause-child",
      encodeFunctionData({ abi: overflowTreasuryAbi, functionName: "pauseChild", args }),
      () => deps.client.simulateContract({ address: treasury, abi: overflowTreasuryAbi, functionName: "pauseChild", args, account: deps.relayer.address }),
      (receipt) => {
        const ev = eventArgs(receipt, "NodePaused");
        return { target: p.target, pausedBy: ev ? String(ev["by"]) : null };
      },
    );
    return c.json(r.body, r.status);
  });

  return app;
}
