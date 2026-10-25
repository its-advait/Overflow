import { randomBytes } from "node:crypto";
import type { ExtractionClient } from "@overflow/oracle";
import {
  buildTree,
  commitDataset,
  concatBytes,
  encodePayload,
  encryptChunk,
  hashLeaf,
  joinChunks,
  RECORD_FORMAT,
  revealChunkKeys,
  SIGNATURE_BYTES,
  type CommittedDataset,
  type DatasetManifest,
} from "@overflow/recourse-crypto";
import type { Address, Hex } from "@overflow/schemas";
import { toHex } from "viem";
import type { EscrowTermsForRow } from "./oracle-port.js";
import type { OracleModel } from "./oracle-port.js";
import type { SampleFetch } from "./sample-judgment.js";
import type { SampleJudgmentOutput } from "./sample-judgment.js";

// ---------------------------------------------------------------------------
// Test-only SIMULATED seller and model for the step 4 sample judgment. The
// seller's commitments are built with the real @overflow/recourse-crypto, so
// verifyCiphertext / verifySample pass (or fail) for the real reasons.
// ---------------------------------------------------------------------------

const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** One 160-byte record chunk: timestamp || row (padded) || 65 zero signature bytes (no source promise in these tests). */
export function recordChunk(timestamp: number, row: string): Uint8Array {
  return concatBytes(encodePayload({ timestamp: BigInt(timestamp), row }), new Uint8Array(SIGNATURE_BYTES));
}

export const SAMPLE_ROWS = ["Tesla,1200,CA", "Ford,340,TX", "Rivian,90,WA", "Hyundai,410,NY", "GM,220,MI", "Kia,180,FL"];

export interface FakeOrderOptions {
  orderId: Hex;
  resourceId: string;
  buyer: Address;
  seller: Address;
  escrowAddress: Address;
  rows?: string[] | undefined;
  /** Commit a ciphertext whose chunk at this index decrypts to something other than the committed plain leaf (the swap seller). */
  swapIndex?: number | undefined;
}

export interface FakeOrder {
  committed: CommittedDataset;
  cipherChunks: Uint8Array[];
  rootCipher: Hex;
  manifest: DatasetManifest;
  /** The escrow_orders row fields the buyer stored from the seller's verified terms. */
  escrow: EscrowTermsForRow;
}

/** In-memory seller: `${sellerUrl}/orders/:id/cipher`, `/orders/:id/sample`, `/r/:resourceId/manifest`. */
export function fakeSeller(sellerUrl = "http://seller.test") {
  const orders = new Map<string, FakeOrder>();
  const manifests = new Map<string, DatasetManifest>();
  const calls = { cipher: 0, sample: 0, manifest: 0 };

  function addOrder(o: FakeOrderOptions): FakeOrder {
    const rows = o.rows ?? SAMPLE_ROWS;
    const plainChunks = rows.map((row, i) => recordChunk(1_700_000_000 + i * 86_400, row));
    const committed = commitDataset({ plainChunks, sellerSecret: toHex(randomBytes(32)), orderId: o.orderId, buyer: o.buyer });
    let cipherChunks = committed.cipherChunks;
    let rootCipher = committed.rootCipher;
    if (o.swapIndex !== undefined) {
      cipherChunks = [...cipherChunks];
      cipherChunks[o.swapIndex] = encryptChunk(recordChunk(1, "SWAPPED,0,ZZ"), committed.perBuyerKey, o.swapIndex);
      rootCipher = buildTree(cipherChunks.map(hashLeaf)).root;
    }
    const manifest: DatasetManifest = {
      simulated: true,
      productId: o.resourceId,
      title: `EV registrations (SIMULATED ${o.resourceId})`,
      header: "brand,units,state",
      fields: ["brand", "units", "state"],
      granularity: "monthly",
      chunkCount: plainChunks.length,
      rootPlain: committed.rootPlain,
      plainLeaves: committed.plainLeaves,
      sourceKey: o.seller,
      minTimestamp: "0",
      manifestHash: b32(5),
      recordFormat: RECORD_FORMAT,
    };
    const escrow: EscrowTermsForRow = {
      orderIdBytes32: o.orderId,
      escrowAddress: o.escrowAddress,
      sellerAddress: o.seller,
      amountAtomic: "12000000",
      bondAtomic: "1200000",
      termsHash: b32(9),
      manifestHash: b32(5),
      rootPlain: committed.rootPlain,
      rootCipher,
      keyCommitment: committed.keyCommitment,
      revealDeadline: "1900000000",
      challengeWindow: "60",
      sourceKey: o.seller,
      minTimestamp: "0",
    };
    const order: FakeOrder = { committed, cipherChunks, rootCipher, manifest, escrow };
    orders.set(o.orderId.toLowerCase(), order);
    manifests.set(o.resourceId, manifest);
    return order;
  }

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: SampleFetch = async (url, init) => {
    if (!url.startsWith(sellerUrl)) return json({ error: "wrong host" }, 404);
    const path = url.slice(sellerUrl.length);
    let m = /^\/orders\/(0x[0-9a-fA-F]{64})\/cipher$/.exec(path);
    if (m) {
      calls.cipher++;
      const o = orders.get(m[1]!.toLowerCase());
      if (!o) return json({ error: "unknown_order" }, 404);
      const bytes = joinChunks(o.cipherChunks);
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }
    m = /^\/orders\/(0x[0-9a-fA-F]{64})\/sample$/.exec(path);
    if (m) {
      calls.sample++;
      const o = orders.get(m[1]!.toLowerCase());
      if (!o || init?.method !== "POST") return json({ error: "unknown_order" }, 404);
      const { indices } = JSON.parse(String(init.body)) as { indices: number[] };
      return json({ simulated: true, orderId: m[1], reveals: revealChunkKeys(o.committed.perBuyerKey, indices) });
    }
    m = /^\/r\/([^/]+)\/manifest$/.exec(path);
    if (m) {
      calls.manifest++;
      const manifest = manifests.get(decodeURIComponent(m[1]!));
      return manifest ? json(manifest) : json({ error: "unknown_resource" }, 404);
    }
    return json({ error: "route_not_found" }, 404);
  };

  return { sellerUrl, addOrder, fetch, calls, orders };
}

/** Scripted Anthropic client: each `messages.parse` call pops the next verdict (or a raw text when `null`, which fails the schema). */
export function fakeModel(script: (SampleJudgmentOutput | null)[], model = "claude-test") {
  const queue = [...script];
  const users: string[] = [];
  let calls = 0;
  const parse = async (params: { system?: unknown; messages: { role: string; content: unknown }[] }) => {
    calls++;
    const user = params.messages.map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    users.push(user);
    const next = queue.shift();
    if (next === undefined) throw new Error("fake model: script exhausted");
    const raw = next === null ? "not json at all" : JSON.stringify(next);
    return {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model,
      stop_reason: "end_turn",
      stop_sequence: null,
      stop_details: null,
      content: [{ type: "text", text: raw, citations: null, parsed_output: next }],
      usage: { input_tokens: 1, output_tokens: 1 },
      parsed_output: next,
    };
  };
  const client = { messages: { parse } } as unknown as ExtractionClient;
  const oracle: OracleModel = { client, model };
  return {
    model: oracle,
    users,
    get calls() {
      return calls;
    },
  };
}
