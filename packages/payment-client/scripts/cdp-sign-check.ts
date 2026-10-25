// Step-1 check for CDP-held agent keys: can a Coinbase Developer Platform EVM server account (EOA) sign the two
// EIP-712 payloads Overflow needs, and is the result a plain 65-byte ECDSA signature the chain accepts?
//
//   pnpm --filter @overflow/payment-client cdp:sign-check -- [--name overflow-node-root] [--treasury 0x...] [--json]
//
// Env (repo .env): CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET (read by the CDP SDK only; this script
// checks their presence by name). The account is created when it does not exist (getOrCreateAccount), so run it
// once with the name you will register as a node key, and put the printed address in AGENT_ROOT_ADDRESS /
// CDP_ACCOUNT_ADDRESS.
//
// Nothing is broadcast and nothing is written to disk. The TransferWithAuthorization probe has a 60-second
// validBefore and goes nowhere; the CreateChild and PauseChild payloads use a SIMULATED child key.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { getAddress, hashTypedData, keccak256, recoverAddress, recoverTypedDataAddress, toHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AddressSchema, CHAIN_ID, loadDeployments } from "@overflow/schemas";
import { buildTransferTypedData, signTransfer } from "../src/authorization";
import { USDC_DOMAIN } from "../src/token-domain";
import { cdpSigner, inspectSignature, missingCdpCredentials, type ResolvedNodeSigner } from "../src/signers";
import { CREATE_CHILD_TYPES, PAUSE_CHILD_TYPES, delegationDomain, payeesHash, signCreateChild, signPauseChild, type ChildParams } from "../src/typed-data";

const repoRoot = resolve(import.meta.dirname, "../../..");

/** Repo .env (Node >= 20.12); variables already in the environment win. Values are never printed. */
function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  const before = { ...process.env };
  process.loadEnvFile(path);
  for (const [k, v] of Object.entries(before)) if (v !== undefined) process.env[k] = v;
}

interface CheckResult {
  payload: string;
  domain: Record<string, unknown>;
  primaryType: string;
  rawSignatureBytes: number;
  rawVByte: number | null;
  lowS: boolean | null;
  normalized: boolean;
  signature: Hex | null;
  recoveredFromTypedData: Address | null;
  recoveredFromDigest: Address | null;
  matchesAccount: boolean;
  ms: number;
  error?: string;
}

async function check(
  resolved: ResolvedNodeSigner,
  payload: string,
  typedData: TypedDataDefinition,
  sign: () => Promise<Hex>,
  lastRaw: { value: string | null },
): Promise<CheckResult> {
  const started = performance.now();
  lastRaw.value = null;
  const base = { payload, domain: typedData.domain as Record<string, unknown>, primaryType: typedData.primaryType as string };
  try {
    const signature = await sign();
    const raw = lastRaw.value ?? signature;
    const info = inspectSignature(raw);
    const digest = hashTypedData(typedData);
    const [fromTyped, fromDigest] = await Promise.all([
      recoverTypedDataAddress({ ...typedData, signature }),
      recoverAddress({ hash: digest, signature }),
    ]);
    return {
      ...base,
      rawSignatureBytes: info.bytes,
      rawVByte: info.vByte,
      lowS: info.lowS,
      normalized: raw !== signature,
      signature,
      recoveredFromTypedData: getAddress(fromTyped),
      recoveredFromDigest: getAddress(fromDigest),
      matchesAccount: getAddress(fromTyped) === resolved.address && getAddress(fromDigest) === resolved.address,
      ms: Math.round(performance.now() - started),
    };
  } catch (e) {
    const raw = lastRaw.value;
    const info = raw ? inspectSignature(raw) : null;
    return {
      ...base,
      rawSignatureBytes: info?.bytes ?? -1,
      rawVByte: info?.vByte ?? null,
      lowS: info?.lowS ?? null,
      normalized: false,
      signature: null,
      recoveredFromTypedData: null,
      recoveredFromDigest: null,
      matchesAccount: false,
      ms: Math.round(performance.now() - started),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main(): Promise<void> {
  loadEnv(resolve(repoRoot, ".env"));
  // The SDK reports usage and errors to Coinbase unless told otherwise; a key-management check has no business doing that.
  process.env["DISABLE_CDP_USAGE_TRACKING"] ??= "true";
  process.env["DISABLE_CDP_ERROR_REPORTING"] ??= "true";

  const { values } = parseArgs({
    // pnpm 12 forwards the literal "--" that separates script args; parseArgs would stop reading options at it.
    args: process.argv.slice(2).filter((a) => a !== "--"),
    options: {
      name: { type: "string", default: process.env["CDP_ACCOUNT_NAME"] || "overflow-node-root" },
      treasury: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const missing = missingCdpCredentials(process.env);
  if (missing.length > 0) {
    throw new Error(`missing in the environment: ${missing.join(", ")} (CDP portal: Secret API key + Wallet Secret; see .env.example)`);
  }

  let treasury: Address;
  if (values.treasury) treasury = getAddress(AddressSchema.parse(values.treasury));
  else {
    try {
      treasury = getAddress((await loadDeployments()).treasury);
    } catch {
      // No deployments file: the domain only needs some verifyingContract; label it.
      treasury = "0x1111111111111111111111111111111111111111";
      console.error("no deployments file; using a SIMULATED treasury address as verifyingContract");
    }
  }

  const lastRaw: { value: string | null } = { value: null };
  const t0 = performance.now();
  const resolved = await cdpSigner({
    accountName: values.name!,
    create: true,
    inspect: (raw) => {
      lastRaw.value = raw;
    },
  });
  const lookupMs = Math.round(performance.now() - t0);
  console.error(`CDP account "${values.name}" -> ${resolved.address} (${lookupMs} ms); treasury ${treasury}; nothing will be broadcast`);

  const now = Math.floor(Date.now() / 1000);
  // SIMULATED child key for the delegation payloads; derived from a label, never funded.
  const simulatedChild = privateKeyToAccount(keccak256(toHex("overflow.simulated.cdp-sign-check-child"))).address;
  const child: ChildParams = {
    parentId: "1",
    key: simulatedChild,
    cap: "10000000",
    maxPerCall: "1000000",
    expiry: String(now + 3600),
    restricted: false,
    payees: [],
    nonce: "0",
    deadline: String(now + 600),
  };
  const pause = { target: "2", nonce: "0", deadline: String(now + 600) };

  // (1) TransferWithAuthorization over USDC's domain, through the same signTransfer() the agents use.
  let transferTypedData: TypedDataDefinition | null = null;
  const transfer = await check(
    resolved,
    "TransferWithAuthorization (USDC domain, from = treasury, 60 s probe)",
    buildTransferTypedData(USDC_DOMAIN, {
      from: treasury,
      to: simulatedChild,
      value: 1n,
      validAfter: 0n,
      validBefore: BigInt(now + 60),
      nonce: `0x${"00".repeat(32)}`,
    }) as TypedDataDefinition,
    async () => {
      const signed = await signTransfer({ nodeAccount: resolved.signer, treasury, to: simulatedChild, value: 1n, ttlSeconds: 60, nowSeconds: now });
      transferTypedData = signed.typedData as TypedDataDefinition;
      return signed.signature;
    },
    lastRaw,
  );
  // signTransfer picks its own nonce; recover against the typed data it actually signed.
  if (transferTypedData && transfer.signature) {
    const td = transferTypedData as TypedDataDefinition;
    const fromTyped = getAddress(await recoverTypedDataAddress({ ...td, signature: transfer.signature }));
    const fromDigest = getAddress(await recoverAddress({ hash: hashTypedData(td), signature: transfer.signature }));
    transfer.recoveredFromTypedData = fromTyped;
    transfer.recoveredFromDigest = fromDigest;
    transfer.matchesAccount = fromTyped === resolved.address && fromDigest === resolved.address;
  }

  // (2) CreateChild and (3) PauseChild over the Overflow delegation domain.
  const createTd: TypedDataDefinition = {
    domain: delegationDomain(treasury),
    types: CREATE_CHILD_TYPES,
    primaryType: "CreateChild",
    message: {
      parentId: 1n,
      key: child.key,
      cap: BigInt(child.cap),
      maxPerCall: BigInt(child.maxPerCall),
      expiry: BigInt(child.expiry),
      restricted: false,
      payeesHash: payeesHash([]),
      nonce: 0n,
      deadline: BigInt(child.deadline),
    },
  };
  const create = await check(resolved, "CreateChild (Overflow delegation domain)", createTd, () => signCreateChild(resolved.signer, treasury, child), lastRaw);
  const pauseTd: TypedDataDefinition = {
    domain: delegationDomain(treasury),
    types: PAUSE_CHILD_TYPES,
    primaryType: "PauseChild",
    message: { target: 2n, nonce: 0n, deadline: BigInt(pause.deadline) },
  };
  const pauseResult = await check(resolved, "PauseChild (Overflow delegation domain)", pauseTd, () => signPauseChild(resolved.signer, treasury, pause), lastRaw);

  const checks = [transfer, create, pauseResult];
  const ok = checks.every((c) => c.matchesAccount && c.rawSignatureBytes === 65 && c.lowS === true);
  const report = {
    checkedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    broadcast: false,
    account: { name: values.name, address: resolved.address, source: resolved.source, lookupMs },
    treasury,
    verdict: ok
      ? "yes: CDP EVM server accounts sign arbitrary EIP-712 typed data with a plain 65-byte ECDSA signature"
      : "no: see the failing check(s); document the blocker in docs/coinbase-feedback.md",
    checks,
  };
  if (values.json) {
    console.log(JSON.stringify(report, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
  } else {
    console.log(report.verdict);
    for (const c of checks) {
      console.log(
        `- ${c.payload}: ${c.error ? `ERROR ${c.error}` : `${c.rawSignatureBytes} bytes, raw v=${c.rawVByte}${c.normalized ? " (normalized to 27/28)" : ""}, lowS=${c.lowS}, recovers to account=${c.matchesAccount}, ${c.ms} ms`}`,
      );
    }
  }
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error(`cdp-sign-check: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
