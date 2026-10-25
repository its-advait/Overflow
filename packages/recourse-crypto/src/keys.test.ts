import { concat, keccak256, toHex } from "viem";
import { describe, expect, it } from "vitest";
import { toHexString } from "./bytes";
import {
  BLOCKS_PER_CHUNK,
  applyChunkKey,
  chunkKey,
  decryptChunk,
  decryptChunkWithChunkKey,
  decryptDataset,
  encryptChunk,
  encryptDataset,
  keyCommitment,
  keystream,
  keystreamBlock,
  perBuyerKey,
} from "./keys";
import { simulatedBytes32 } from "./vectors";

const secret = simulatedBytes32("k-secret");
const orderId = simulatedBytes32("k-order");
const buyer = "0x595b4704F8d39F861B253CeF5Bd02B3B3fE57d34" as const;
const b32 = (n: number) => toHex(n, { size: 32 });

describe("keys", () => {
  it("perBuyerKey = keccak256(sellerSecret || orderId || buyer) packed", () => {
    expect(perBuyerKey(secret, orderId, buyer)).toBe(keccak256(concat([secret, orderId, buyer])));
    expect(perBuyerKey(secret, orderId, buyer)).not.toBe(perBuyerKey(secret, orderId, "0x0000000000000000000000000000000000000001"));
    expect(perBuyerKey(secret, orderId, buyer)).not.toBe(perBuyerKey(secret, simulatedBytes32("other"), buyer));
  });

  it("chunkKey and keystream blocks pack a uint256 index", () => {
    const k = perBuyerKey(secret, orderId, buyer);
    expect(chunkKey(k, 3)).toBe(keccak256(concat([k, b32(3)])));
    expect(chunkKey(k, 3n)).toBe(chunkKey(k, 3));
    expect(keystreamBlock(chunkKey(k, 3), 4)).toBe(keccak256(concat([chunkKey(k, 3), b32(4)])));
    expect(() => chunkKey(k, -1)).toThrow();
  });

  it("a 160-byte keystream is blocks 0..4 concatenated", () => {
    const ck = chunkKey(perBuyerKey(secret, orderId, buyer), 0);
    const ks = keystream(ck);
    expect(BLOCKS_PER_CHUNK).toBe(5);
    expect(ks.length).toBe(160);
    expect(toHexString(ks)).toBe(concat([0, 1, 2, 3, 4].map((j) => keystreamBlock(ck, j))));
    expect(keystream(ck, 33).length).toBe(33);
  });

  it("keyCommitment = keccak256(k)", () => {
    const k = perBuyerKey(secret, orderId, buyer);
    expect(keyCommitment(k)).toBe(keccak256(k));
  });

  it("encrypt/decrypt round-trip, by index or by revealed chunk key", () => {
    const k = perBuyerKey(secret, orderId, buyer);
    const plain = new Uint8Array(160).map((_, i) => i * 7 & 0xff);
    const cipher = encryptChunk(plain, k, 2);
    expect(cipher).not.toEqual(plain);
    expect(decryptChunk(cipher, k, 2)).toEqual(plain);
    expect(decryptChunkWithChunkKey(cipher, chunkKey(k, 2))).toEqual(plain);
    expect(decryptChunk(cipher, k, 1)).not.toEqual(plain);
    expect(applyChunkKey(applyChunkKey(plain, chunkKey(k, 9)), chunkKey(k, 9))).toEqual(plain);
  });

  it("dataset helpers encrypt each chunk under its own index", () => {
    const k = perBuyerKey(secret, orderId, buyer);
    const chunks = [0, 1, 2].map((n) => new Uint8Array(160).fill(n + 1));
    const cipher = encryptDataset(chunks, k);
    expect(cipher.map((c, i) => toHexString(c))).toEqual(chunks.map((p, i) => toHexString(encryptChunk(p, k, i))));
    expect(decryptDataset(cipher, k)).toEqual(chunks);
  });

  it("rejects chunks that are not 160 bytes", () => {
    expect(() => encryptChunk(new Uint8Array(159), perBuyerKey(secret, orderId, buyer), 0)).toThrow(/160 bytes/);
  });
});
