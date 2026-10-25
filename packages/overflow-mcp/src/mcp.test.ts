import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import { createServer } from "./mcp";
import { defaultChain, FakeFetch, NOW, PREMIUM_URL, SEARCH_URL, sellerRoutes, SERVICE_URL, spySigner, TREASURY, verifyRoute } from "./test-fixtures";
import { TOOL_NAMES } from "./tools";

async function connected() {
  const ff = new FakeFetch([...sellerRoutes(), verifyRoute]);
  const signer = spySigner();
  const server = createServer({ fetch: ff.fetch, chain: defaultChain(), signer, signerSource: "NODE_PRIVATE_KEY (env)", treasury: TREASURY, serviceUrl: SERVICE_URL, now: () => NOW });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "overflow-mcp-test", version: "0.0.0" });
  await client.connect(clientTransport);
  return { ff, signer, client };
}

type Structured = Record<string, unknown> & { paid?: boolean; nodeId?: string | null; policy?: { allowed: boolean; refusal: { name: string } | null } };

describe("MCP round trip (in-memory transport)", () => {
  it("exposes exactly the three tools; only overflow_pay is marked destructive", async () => {
    const { client } = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) expect(t.annotations?.destructiveHint).toBe(t.name === "overflow_pay");
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(t.name !== "overflow_pay");
  });

  it("budget and quote never send a PAYMENT-SIGNATURE to a seller; pay does, once, and returns the tx hash", async () => {
    const { client, ff, signer } = await connected();
    const budget = await client.callTool({ name: "overflow_budget", arguments: {} });
    expect(budget.isError).toBeFalsy();
    expect((budget.structuredContent as Structured).nodeId).toBe("1");
    expect((budget.structuredContent as Structured)["remainingUsdc"]).toBe("40.00");

    const refused = await client.callTool({ name: "overflow_quote", arguments: { url: PREMIUM_URL } });
    expect(refused.isError).toBe(true);
    expect((refused.structuredContent as Structured).policy).toMatchObject({ allowed: false, refusal: { name: "PayeeNotAllowed" } });
    const allowed = await client.callTool({ name: "overflow_quote", arguments: { url: SEARCH_URL } });
    expect(allowed.isError).toBeFalsy();
    expect((allowed.structuredContent as Structured).policy).toMatchObject({ allowed: true });
    // The invariant: so far no request outside SERVICE_URL carried a payment signature.
    expect(ff.calls.filter((c) => c.paymentSignature !== null && !c.url.startsWith(SERVICE_URL))).toHaveLength(0);

    const paid = await client.callTool({ name: "overflow_pay", arguments: { url: SEARCH_URL, maxAmount: "20000" } });
    expect(paid.isError).toBeFalsy();
    expect(paid.structuredContent).toMatchObject({ paid: true, txHash: expect.stringMatching(/^0x/) });
    expect(ff.calls.filter((c) => c.paymentSignature !== null)).toHaveLength(1);
    expect(signer.signTypedData).toHaveBeenCalledTimes(3); // two quote probes (to /verify only) + one payment
    const text = paid.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toContain('"paid": true');
  });

  it("a refused pay is isError with the decoded refusal; a float maxAmount never reaches the handler", async () => {
    const { client, signer } = await connected();
    const r = await client.callTool({ name: "overflow_pay", arguments: { url: PREMIUM_URL, maxAmount: "50000" } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ paid: false, kind: "refused", refusal: { name: "PayeeNotAllowed", args: ["0"] } });
    const bad = await client.callTool({ name: "overflow_pay", arguments: { url: SEARCH_URL, maxAmount: "0.02" } }).catch((e: unknown) => ({ isError: true as const, error: e }));
    expect(bad.isError).toBe(true);
    expect(signer.signTypedData).not.toHaveBeenCalled();
  });
});
