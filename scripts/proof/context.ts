import { overflowTreasuryAbi, type Deployments } from "@overflow/schemas";
import { signCreateChild, signTransfer } from "@overflow/payment-client";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { decodeError, decodeRevertBytes, type DecodedError } from "./decode.js";
import type { Mode, TxRef } from "./types.js";

// ---------------------------------------------------------------------------
// Proof context. Fork mode: the deployed treasury/factory on an anvil fork of
// Base Sepolia; the owner (deployer) is impersonated, every other actor is a
// fresh key that exists only for this run; USDC comes from Circle's real
// FiatToken via an impersonated masterMinter. Keys are never printed.
// ---------------------------------------------------------------------------

const FIAT_ADMIN_ABI = parseAbi([
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature)",
]);

export interface NodeRef {
  id: bigint;
  key: PrivateKeyAccount;
}

export interface Sent {
  hash: Hex;
  status: "success" | "reverted";
  /** Decoded from the mined transaction's trace (fork) or the pre-send simulation. */
  decoded?: DecodedError | undefined;
  simulated?: DecodedError | undefined;
}

export interface ProofContext {
  mode: Mode;
  rpcUrl: string;
  pub: PublicClient;
  deployments: Deployments;
  treasury: Address;
  factory: Address;
  usdc: Address;
  owner: Address;
  relayer: PrivateKeyAccount;
  payees: { search: Address; scrape: Address; attacker: Address };
  txs: TxRef[];
  offsetMs: number;
  log: (line: string) => void;
}

export const nowSeconds = (ctx: ProofContext): number => Math.floor((Date.now() + ctx.offsetMs) / 1000);

async function rpc(ctx: ProofContext, method: string, params: unknown[]): Promise<unknown> {
  return ctx.pub.request({ method: method as never, params: params as never });
}

export async function setEth(ctx: ProofContext, a: Address, wei = 10n ** 19n): Promise<void> {
  await rpc(ctx, "anvil_setBalance", [a, `0x${wei.toString(16)}`]);
}

export function newKey(): PrivateKeyAccount {
  return privateKeyToAccount(generatePrivateKey());
}

/** Fork-only: decode the revert of a mined transaction from its trace. */
export async function traceRevert(ctx: ProofContext, hash: Hex): Promise<DecodedError | undefined> {
  if (ctx.mode !== "fork") return undefined;
  try {
    const t = (await rpc(ctx, "debug_traceTransaction", [hash, { tracer: "callTracer" }])) as { output?: Hex };
    return t.output ? decodeRevertBytes(t.output) : undefined;
  } catch {
    return undefined;
  }
}

/** Sends a call. Simulates first; a revert throws unless `force`, which broadcasts with fixed gas so it lands onchain. */
export async function send(
  ctx: ProofContext,
  from: PrivateKeyAccount | Address,
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] },
  opts: { label: string; force?: boolean; gas?: bigint },
): Promise<Sent> {
  const sender = typeof from === "string" ? from : from.address;
  let simulated: DecodedError | undefined;
  try {
    await ctx.pub.simulateContract({ ...call, account: sender } as never);
  } catch (e) {
    simulated = decodeError(e) ?? { name: "Unknown", args: [e instanceof Error ? e.message.split("\n")[0]! : String(e)] };
    if (!opts.force) throw new Error(`${opts.label}: simulation reverted ${simulated.name}(${simulated.args.join(",")})`);
  }
  const wallet = createWalletClient({ account: from, chain: baseSepolia, transport: http(ctx.rpcUrl) });
  const data = encodeFunctionData(call as never);
  const hash = await wallet.sendTransaction({ to: call.address, data, chain: baseSepolia, ...(simulated || opts.gas ? { gas: opts.gas ?? 800_000n } : {}) } as never);
  const receipt = await ctx.pub.waitForTransactionReceipt({ hash });
  const status = receipt.status;
  ctx.txs.push({ label: opts.label, hash, status });
  const decoded = status === "reverted" ? ((await traceRevert(ctx, hash)) ?? simulated) : undefined;
  return { hash, status, decoded, simulated };
}

export async function ownerWrite(ctx: ProofContext, functionName: string, args: readonly unknown[], label: string): Promise<Sent> {
  return send(ctx, ctx.owner, { address: ctx.treasury, abi: overflowTreasuryAbi, functionName, args }, { label });
}

export async function fundUsdc(ctx: ProofContext, to: Address, amount: bigint): Promise<void> {
  const master = (await ctx.pub.readContract({ address: ctx.usdc, abi: FIAT_ADMIN_ABI, functionName: "masterMinter" })) as Address;
  await rpc(ctx, "anvil_impersonateAccount", [master]);
  await setEth(ctx, master);
  const minter = newKey();
  await setEth(ctx, minter.address);
  await send(ctx, master, { address: ctx.usdc, abi: FIAT_ADMIN_ABI, functionName: "configureMinter", args: [minter.address, amount] }, { label: "fork funding: configureMinter" });
  await send(ctx, minter, { address: ctx.usdc, abi: FIAT_ADMIN_ABI, functionName: "mint", args: [to, amount] }, { label: "fork funding: mint" });
}

export async function usdcBalance(ctx: ProofContext, a: Address): Promise<bigint> {
  return (await ctx.pub.readContract({ address: ctx.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] })) as bigint;
}

export async function authorizationUsed(ctx: ProofContext, nonce: Hex): Promise<boolean> {
  return (await ctx.pub.readContract({ address: ctx.usdc, abi: FIAT_ADMIN_ABI, functionName: "authorizationState", args: [ctx.treasury, nonce] })) as boolean;
}

export async function nodeOf(ctx: ProofContext, key: Address): Promise<bigint> {
  return (await ctx.pub.readContract({ address: ctx.treasury, abi: overflowTreasuryAbi, functionName: "nodeOfKey", args: [key] })) as bigint;
}

export async function getNode(ctx: ProofContext, id: bigint): Promise<{ spent: bigint; cap: bigint; expiry: bigint }> {
  const n = (await ctx.pub.readContract({ address: ctx.treasury, abi: overflowTreasuryAbi, functionName: "getNode", args: [id] })) as { spent: bigint; cap: bigint; expiry: bigint };
  return n;
}

export async function chainTime(ctx: ProofContext): Promise<bigint> {
  return (await ctx.pub.getBlock()).timestamp;
}

/** Fork: evm_increaseTime + evm_mine to reach `ts`. */
export async function advanceTo(ctx: ProofContext, ts: bigint): Promise<void> {
  const now = await chainTime(ctx);
  if (ts > now) {
    await rpc(ctx, "evm_increaseTime", [Number(ts - now)]);
    await rpc(ctx, "evm_mine", []);
  }
  ctx.offsetMs = Number(await chainTime(ctx)) * 1000 - Date.now();
}

/** Owner createRoot with a fresh key (fork). */
export async function createRoot(ctx: ProofContext, o: { cap: bigint; maxPerCall: bigint; ttl?: number }): Promise<NodeRef> {
  const key = newKey();
  const expiry = BigInt(nowSeconds(ctx) + (o.ttl ?? 86_400));
  await ownerWrite(ctx, "createRoot", [key.address, o.cap, o.maxPerCall, expiry], "owner createRoot");
  return { id: await nodeOf(ctx, key.address), key };
}

/** Parent signs CreateChild (gasless delegation); the relayer submits createChild. */
export async function createChild(
  ctx: ProofContext,
  parent: NodeRef,
  o: { cap: bigint; maxPerCall: bigint; expiry?: bigint; restricted?: boolean; payees?: Address[] },
): Promise<NodeRef> {
  const key = newKey();
  const expiry = o.expiry ?? (await getNode(ctx, parent.id)).expiry;
  const child = {
    parentId: parent.id.toString(),
    key: key.address,
    cap: o.cap.toString(),
    maxPerCall: o.maxPerCall.toString(),
    expiry: expiry.toString(),
    restricted: o.restricted ?? false,
    payees: o.payees ?? [],
    nonce: BigInt(generatePrivateKey()).toString(),
    deadline: String(nowSeconds(ctx) + 600),
  };
  const sig = await signCreateChild(parent.key, ctx.treasury, child);
  const args = [
    { parentId: parent.id, key: key.address, cap: o.cap, maxPerCall: o.maxPerCall, expiry, restricted: child.restricted, payees: child.payees, nonce: BigInt(child.nonce), deadline: BigInt(child.deadline) },
    sig,
  ];
  await send(ctx, ctx.relayer, { address: ctx.treasury, abi: overflowTreasuryAbi, functionName: "createChild", args }, { label: "relayer createChild (gasless delegation)" });
  return { id: await nodeOf(ctx, key.address), key };
}

/** The node signs EIP-3009 (from = treasury) with the payment client; the relayer submits treasury.settle(). */
export async function pay(ctx: ProofContext, node: NodeRef, to: Address, value: bigint, label: string, force = true) {
  const signed = await signTransfer({ nodeAccount: node.key, treasury: ctx.treasury, to, value, ttlSeconds: 120, nowSeconds: nowSeconds(ctx) });
  const a = signed.authorization;
  const sent = await send(
    ctx,
    ctx.relayer,
    { address: ctx.treasury, abi: overflowTreasuryAbi, functionName: "settle", args: [a.to, a.value, a.validAfter, a.validBefore, a.nonce, signed.signature] },
    { label, force, gas: 500_000n },
  );
  return { signed, sent };
}

export async function directToUsdc(ctx: ProofContext, from: PrivateKeyAccount, signed: Awaited<ReturnType<typeof signTransfer>>, label: string): Promise<Sent> {
  const a = signed.authorization;
  return send(
    ctx,
    from,
    { address: ctx.usdc, abi: FIAT_ADMIN_ABI, functionName: "transferWithAuthorization", args: [a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, signed.signature] },
    { label, force: true, gas: 300_000n },
  );
}

export function makeClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }) as PublicClient;
}
