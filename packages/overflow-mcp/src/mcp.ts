import { McpServer } from "@modelcontextprotocol/server";
import { AtomicAmountSchema } from "@overflow/schemas";
import { z } from "zod";
import { budgetTool, payTool, quoteTool, type Deps } from "./tools";

export const SERVER_INFO = { name: "overflow", version: "0.0.0" } as const;

type ToolResult = { content: { type: "text"; text: string }[]; structuredContent: Record<string, unknown>; isError?: boolean };

function result(value: object, isError = false): ToolResult {
  const structured = JSON.parse(JSON.stringify(value)) as Record<string, unknown>; // bigint-free by construction; strips undefined
  return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured, ...(isError ? { isError: true } : {}) };
}

function failure(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return result({ error: err instanceof Error ? err.name : "Error", message }, true);
}

/**
 * The three tools. Only overflow_pay sends a PAYMENT-SIGNATURE to a seller; overflow_quote signs a 60-second
 * probe that goes to the facilitator's /verify only; overflow_budget signs nothing. Nothing here can move USDC
 * except through OverflowTreasury.settle(), and nothing can mark a payment successful without the facilitator's
 * settle receipt in PAYMENT-RESPONSE.
 */
export function createServer(deps: Deps): McpServer {
  const server = new McpServer(SERVER_INFO);

  server.registerTool(
    "overflow_budget",
    {
      title: "Overflow budget",
      description:
        "What this agent's node may still spend: remaining USDC (min over the node and its ancestors of cap - spent) and the per-call limit (min maxPerCall up the tree), plus paused/expired flags. Chain reads only; amounts are atomic USDC strings (6 decimals) with a formatted copy.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return result(await budgetTool(deps));
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "overflow_quote",
    {
      title: "Overflow quote",
      description:
        "Fetch a URL's x402 402 and report price (atomic USDC), payTo, whether the owner allowlists the payee, whether it fits this node's limits, and the treasury's own verdict from the facilitator's /verify simulation (eth_call; nothing is broadcast, the seller receives nothing). Advisory: settle() decides at payment time.",
      inputSchema: z.object({ url: z.url().describe("The paywalled resource URL (GET)") }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ url }) => {
      try {
        const r = await quoteTool(deps, url);
        return result(r, r.paywalled && !r.policy.allowed);
      } catch (err) {
        return failure(err);
      }
    },
  );

  server.registerTool(
    "overflow_pay",
    {
      title: "Overflow pay",
      description:
        "Pay a URL's x402 402 under this node's policy and return the response body plus the settlement tx hash, or the decoded refusal. The only tool that signs for a seller: one EIP-3009 authorization with from = the Overflow treasury, settled solely by OverflowTreasury.settle() through the facilitator. Refuses before signing when the price exceeds maxAmount, the node's limits, or the owner allowlist; refuses after signing (nothing sent to the seller) when /verify says the treasury would revert. Never retries: an unknown outcome returns the digest to reconcile.",
      inputSchema: z.object({
        url: z.url().describe("The paywalled resource URL (GET)"),
        maxAmount: AtomicAmountSchema.describe("Most you accept to pay, in atomic USDC (6 decimals) as a decimal integer string, e.g. \"20000\" for 0.02 USDC"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ url, maxAmount }) => {
      try {
        const r = await payTool(deps, url, maxAmount);
        return result(r, !r.paid);
      } catch (err) {
        return failure(err);
      }
    },
  );

  return server;
}
