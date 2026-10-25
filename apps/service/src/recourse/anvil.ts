// ---------------------------------------------------------------------------
// Anvil-only JSON-RPC: the safety rail for the local recourse run. Every
// helper here refuses unless the node answers `anvil_nodeInfo`, so none of
// this can ever run against Base Sepolia (which has no such method).
// ---------------------------------------------------------------------------

interface RpcAnswer {
  result?: unknown;
  error?: { code: number; message: string };
}

export async function rpc(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = (await res.json()) as RpcAnswer;
  if (body.error) throw new Error(`${method}: ${body.error.message} (${body.error.code})`);
  return body.result;
}

/** True only when the RPC is an Anvil node (answers anvil_nodeInfo). A public Base Sepolia RPC answers "method not found". */
export async function isAnvil(rpcUrl: string): Promise<boolean> {
  try {
    const info = await rpc(rpcUrl, "anvil_nodeInfo");
    return typeof info === "object" && info !== null;
  } catch {
    return false;
  }
}

export class NotAnvilError extends Error {
  constructor(rpcUrl: string) {
    super(`refused: ${redact(rpcUrl)} is not an Anvil node (anvil_nodeInfo did not answer); the recourse run only ever targets a local fork`);
    this.name = "NotAnvilError";
  }
}

/** Host only; an RPC URL may carry an API key in its path. */
export function redact(rpcUrl: string): string {
  try {
    const u = new URL(rpcUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<rpc>";
  }
}

export async function assertAnvil(rpcUrl: string): Promise<void> {
  if (!(await isAnvil(rpcUrl))) throw new NotAnvilError(rpcUrl);
}

/** Latest block timestamp (unix seconds): the clock every escrow deadline is judged against. */
export async function chainNow(rpcUrl: string): Promise<bigint> {
  const block = (await rpc(rpcUrl, "eth_getBlockByNumber", ["latest", false])) as { timestamp: string } | null;
  if (!block) throw new Error("eth_getBlockByNumber latest returned null");
  return BigInt(block.timestamp);
}

/** Mine `n` empty blocks (Anvil only). */
export async function mine(rpcUrl: string, n = 1): Promise<void> {
  await assertAnvil(rpcUrl);
  for (let i = 0; i < n; i++) await rpc(rpcUrl, "evm_mine");
}

/** Move the chain clock forward by `seconds` and mine one block so `latest` carries the new timestamp (Anvil only). */
export async function increaseTime(rpcUrl: string, seconds: number): Promise<bigint> {
  await assertAnvil(rpcUrl);
  await rpc(rpcUrl, "evm_increaseTime", [seconds]);
  await rpc(rpcUrl, "evm_mine");
  return chainNow(rpcUrl);
}
