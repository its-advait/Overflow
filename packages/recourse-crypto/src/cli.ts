// Tiny manual-testing CLI. Run with: pnpm --filter @overflow/recourse-crypto cli -- <command> ...
// Files are raw concatenations of 160-byte chunks. Output is JSON on stdout.
import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Address, Hex } from "viem";
import { AddressSchema, Bytes32Schema, HexSchema } from "@overflow/schemas";
import { z } from "zod";
import { toHexString } from "./bytes";
import { commitDataset } from "./commit";
import { decryptChunkWithChunkKey, decryptDataset, perBuyerKey } from "./keys";
import { buildTreeFromChunks, getProof, hashLeaf } from "./merkle";
import { buildRecordChunk, joinChunks, parseChunk, recoverRecordSigner, splitDataset } from "./record";
import { pickSampleIndices, revealChunkKeys } from "./sample";

const USAGE = `usage:
  records  <rows.csv> <out.bin> --signer <0xpk> [--timestamp <unix>]   build signed 160-byte chunks, one per line
  commit   <plain.bin> --secret <0x32> --order <0x32> --buyer <0xaddr>  rootPlain, rootCipher, keyCommitment, leaves
  encrypt  <plain.bin> <cipher.bin> --secret --order --buyer            write ciphertext
  sample   --n <count> --count <k> [--random <0xhex>] [--secret --order --buyer]   indices (+ revealed chunk keys)
  decrypt  <cipher.bin> <plain.bin> (--key <0x32> | --chunk-key <0x32> --index <i>)   write plaintext, print records
  prove    <file.bin> --index <i>                                        leaf, root, proof for one chunk`;

const KeyMaterial = z.object({ secret: Bytes32Schema, order: Bytes32Schema, buyer: AddressSchema });
const IntString = z.string().regex(/^\d+$/).transform(Number);

function fail(message: string): never {
  console.error(message);
  console.error(USAGE);
  process.exit(1);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2));
}

async function readChunks(path: string): Promise<Uint8Array[]> {
  return splitDataset(new Uint8Array(await readFile(path)));
}

async function describeChunks(chunks: readonly Uint8Array[]) {
  return Promise.all(
    chunks.map(async (chunk, index) => {
      const r = parseChunk(chunk);
      let signer: Address | "unrecoverable" = "unrecoverable";
      try {
        signer = await recoverRecordSigner(chunk);
      } catch {
        /* leave unrecoverable */
      }
      return { index, timestamp: r.timestamp.toString(), row: r.row, signer, leaf: hashLeaf(chunk) };
    }),
  );
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    signer: { type: "string" },
    timestamp: { type: "string" },
    secret: { type: "string" },
    order: { type: "string" },
    buyer: { type: "string" },
    n: { type: "string" },
    count: { type: "string" },
    random: { type: "string" },
    key: { type: "string" },
    "chunk-key": { type: "string" },
    index: { type: "string" },
  },
});

const [command, ...args] = positionals;

switch (command) {
  case "records": {
    const [input, output] = args;
    if (!input || !output || !values.signer) fail("records needs <rows.csv> <out.bin> --signer");
    const signer = Bytes32Schema.parse(values.signer);
    const timestamp = BigInt(values.timestamp ?? Math.floor(Date.now() / 1000));
    const rows = (await readFile(input, "utf8")).split(/\r?\n/).filter((l) => l.length > 0);
    const chunks = await Promise.all(rows.map((row) => buildRecordChunk({ row, timestamp }, signer)));
    await writeFile(output, joinChunks(chunks));
    print({ wrote: output, chunks: chunks.length, records: await describeChunks(chunks) });
    break;
  }
  case "commit": {
    const [input] = args;
    if (!input) fail("commit needs <plain.bin>");
    const km = KeyMaterial.parse(values);
    const c = commitDataset({ plainChunks: await readChunks(input), sellerSecret: km.secret, orderId: km.order, buyer: km.buyer });
    print({
      leafCount: c.leafCount,
      rootPlain: c.rootPlain,
      rootCipher: c.rootCipher,
      keyCommitment: c.keyCommitment,
      perBuyerKey: c.perBuyerKey,
      plainLeaves: c.plainLeaves,
      cipherLeaves: c.cipherLeaves,
    });
    break;
  }
  case "encrypt": {
    const [input, output] = args;
    if (!input || !output) fail("encrypt needs <plain.bin> <cipher.bin>");
    const km = KeyMaterial.parse(values);
    const c = commitDataset({ plainChunks: await readChunks(input), sellerSecret: km.secret, orderId: km.order, buyer: km.buyer });
    await writeFile(output, joinChunks(c.cipherChunks));
    print({ wrote: output, leafCount: c.leafCount, rootCipher: c.rootCipher, keyCommitment: c.keyCommitment });
    break;
  }
  case "sample": {
    if (!values.n || !values.count) fail("sample needs --n and --count");
    const n = IntString.parse(values.n);
    const count = IntString.parse(values.count);
    const random: Hex = values.random ? HexSchema.parse(values.random) : toHexString(crypto.getRandomValues(new Uint8Array(32)));
    const indices = pickSampleIndices(n, count, random);
    const km = KeyMaterial.safeParse(values);
    print({
      randomBytes: random,
      indices,
      ...(km.success ? { revealedChunkKeys: revealChunkKeys(perBuyerKey(km.data.secret, km.data.order, km.data.buyer), indices) } : {}),
    });
    break;
  }
  case "decrypt": {
    const [input, output] = args;
    if (!input || !output) fail("decrypt needs <cipher.bin> <plain.bin>");
    const cipherChunks = await readChunks(input);
    let plainChunks: Uint8Array[];
    if (values.key) {
      plainChunks = decryptDataset(cipherChunks, Bytes32Schema.parse(values.key));
    } else if (values["chunk-key"] && values.index) {
      const i = IntString.parse(values.index);
      const chunk = cipherChunks[i];
      if (!chunk) fail(`index ${i} out of range for ${cipherChunks.length} chunks`);
      plainChunks = [decryptChunkWithChunkKey(chunk, Bytes32Schema.parse(values["chunk-key"]))];
    } else {
      fail("decrypt needs --key, or --chunk-key with --index");
    }
    await writeFile(output, joinChunks(plainChunks));
    print({ wrote: output, records: await describeChunks(plainChunks) });
    break;
  }
  case "prove": {
    const [input] = args;
    if (!input || !values.index) fail("prove needs <file.bin> --index");
    const chunks = await readChunks(input);
    const index = IntString.parse(values.index);
    const tree = buildTreeFromChunks(chunks);
    print({ leafCount: chunks.length, index, leaf: tree.leaves[index], root: tree.root, proof: getProof(tree, index) });
    break;
  }
  default:
    fail(command ? `unknown command: ${command}` : "missing command");
}
