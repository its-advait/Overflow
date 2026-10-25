import { Hono } from "hono";
import { encodeFunctionData } from "viem";
import { explorerUrl } from "@overflow/schemas";
import { authorizationDigest } from "@overflow/payment-client";
import type { FacilitatorDeps } from "../context";
import { BYPASS_REASON, decodeRevert } from "../decode";
import { BypassBodySchema, invalidRequest } from "../schemas";
import { demoAuthorized } from "./payments";

const USDC_TWA_ABI = [
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "from" },
      { type: "address", name: "to" },
      { type: "uint256", name: "value" },
      { type: "uint256", name: "validAfter" },
      { type: "uint256", name: "validBefore" },
      { type: "bytes32", name: "nonce" },
      { type: "bytes", name: "signature" },
    ],
    outputs: [],
  },
] as const;

/**
 * SIMULATED attack for the demo: send an agent's authorization straight to USDC, skipping the treasury. USDC asks
 * the treasury (ERC-1271) and gets INVALID, so the transfer reverts. Mounted only when DEMO_MODE=true; every call
 * needs the x-demo-token header. The transaction is broadcast with fixed gas so the rejection is onchain.
 */
export function demoRoutes(deps: FacilitatorDeps) {
  const app = new Hono();
  app.post("/demo/bypass", async (c) => {
    if (!demoAuthorized(c, deps)) return c.json({ ok: false, error: { name: "Forbidden", reason: "x-demo-token missing or wrong" } }, 403);
    const parsed = BypassBodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json(invalidRequest(parsed.error.issues), 400);
    const { authorization: a, signature } = parsed.data;
    const digest = authorizationDigest(a);
    const args = [a.from, a.to, BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, signature] as const;
    let decoded;
    try {
      await deps.client.simulateContract({ address: deps.usdc, abi: USDC_TWA_ABI, functionName: "transferWithAuthorization", args, account: deps.relayer.address });
    } catch (e) {
      decoded = decodeRevert(e);
    }
    const res = await deps.relayer.submit({ to: deps.usdc, data: encodeFunctionData({ abi: USDC_TWA_ABI, functionName: "transferWithAuthorization", args }), gas: 300_000n, label: "demo/bypass" });
    const base = { simulated: true as const, label: "SIMULATED attacker bypass", digest, transaction: res.hash, explorerUrl: explorerUrl("tx", res.hash) };
    if (res.status === "unknown") return c.json({ ok: false, rejected: null, status: "unknown", ...base });
    const rejected = res.status === "reverted";
    deps.bus.publish({ kind: rejected ? "BypassRejected" : "BypassSucceeded", source: "facilitator", route: "demo/bypass", digest, txHash: res.hash, explorerUrl: explorerUrl("tx", res.hash), simulated: true, ...(decoded ? { decoded } : {}) });
    return c.json({ ok: true, rejected, reason: rejected ? (decoded?.reason ?? BYPASS_REASON) : "USDC accepted the bypass: the gate is open (investigate)", decoded: decoded ?? null, blockNumber: res.receipt.blockNumber.toString(), ...base });
  });
  return app;
}
