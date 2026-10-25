import { keccak256, stringToBytes, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  BLOCKS_PER_CHUNK,
  CHUNK_SIZE,
  buildPayload,
  buildRecord,
  payloadHash,
  promiseBroken,
  splitRecord,
  chunkKey,
  chunkMatches,
  commitDelivery,
  decryptChunk,
  deriveKey,
  encryptChunk,
  hashLeaf,
  keystreamBlock,
  merkleProof,
  merkleRoot,
  recordTimestamp,
  verifyProof,
} from "./index";

// Golden vectors shared with contracts/test/escrow/RecourseCrypto.t.sol.
const KEY = keccak256(stringToBytes("overflow.golden.key"));
const chunk = (b: number): Hex => toHex(new Uint8Array(CHUNK_SIZE).fill(b));
const plain = [0, 1, 2, 3, 4].map(chunk);

const V = {
  KEY: "0x7821e83d3d34740e94104147499f90f473b3c525dffeb768d2cb03021ba69f1c",
  K_0: "0x0e8bdfc41c4e57b98b1162b5a3e6ccd13542c41945893be60b01b9ca28d735e2",
  K_2: "0xffb85269e2a5e166b761e710605369fe02aa8321734697e4b8ee0a55ba31de8f",
  KS_0_0: "0x537a0d443f3dcb55490250890b4fab7903389a09f2797b00ee02d7277b4914f6",
  KS_0_4: "0xb6722df19f1c806db82af3fd7966eb2e8882c01f06768814c12cc4e96150d5ef",
  KEY_COMMITMENT: "0xc6ef49f0220a08b0ff4bd81c6ca6f40627f458d9fe7d2216bb86e2ddad5ff75c",
  ROOT_PLAIN: "0xc868e8c578f523e327492fff75bcd28af5755fdfc5d284c604e5a2b379f96698",
  ROOT_CIPHER: "0x52ef6ce6cf44eb9574b9c2cc8ab71078a0ddb6c9939fc9fccccee581eebfa6e7",
  CIPHER_LEAF_0: "0x68c431737433b99e5f795d359831f8a900048fb4a706655cfd5b01d4c772e185",
  DERIVED: "0x29ea90fe0aa3eb42a3ec85afc9666785d44c522ac8383e9b1d994161f0c8f233",
  C_0: "0x537a0d443f3dcb55490250890b4fab7903389a09f2797b00ee02d7277b4914f6a812229f0e5914a4871c5be13a148b4b6bc44b2fb45c97bdf0fe455209001ef80b0f606f570deefc4db93bb777a38dd1ce3f5f7330f47d62888087f46297f1f46ebcb28f5d03492ba72b93ebf1e0c87f0d7a316cb017893b4634507b91df356bb6722df19f1c806db82af3fd7966eb2e8882c01f06768814c12cc4e96150d5ef",
  C_2: "0x666b7e5683e24c7edcc69a0b418fd5bcf9bec77d3facfba8f461974882c1c11f7115855335b68c982f158274b9e43119df36a19b75653bbffff7632f259f00ec5a6e9406aeece8346f7f574a098658342bafe7440ac317e55779449e7fc3c3ea1df4efb268c4b3d81fe2817ace1f2fedda6975dab01ade620e1a275b4f1377804863e74851b40a462aa4c1e8e05f2fd2c4cb5236c897ca929ae4f7e8b27f9818",
} as const;

describe("recourse crypto golden vectors (match RecourseCrypto.sol)", () => {
  it("keys, keystream and commitment", () => {
    expect(KEY).toBe(V.KEY);
    expect(chunkKey(KEY, 0)).toBe(V.K_0);
    expect(chunkKey(KEY, 2)).toBe(V.K_2);
    expect(keystreamBlock(V.K_0, 0)).toBe(V.KS_0_0);
    expect(keystreamBlock(V.K_0, 4)).toBe(V.KS_0_4);
    expect(deriveKey(keccak256(stringToBytes("secret")), keccak256(stringToBytes("order")), "0x1111111111111111111111111111111111111111")).toBe(V.DERIVED);
  });

  it("ciphertext and roots", () => {
    expect(encryptChunk(KEY, 0, plain[0] as Hex)).toBe(V.C_0);
    expect(encryptChunk(KEY, 2, plain[2] as Hex)).toBe(V.C_2);
    expect(decryptChunk(KEY, 0, V.C_0)).toBe(plain[0]);
    expect(decryptChunk(KEY, 2, V.C_2)).toBe(plain[2]);
    const c = commitDelivery(KEY, plain);
    expect(c.keyCommitment).toBe(V.KEY_COMMITMENT);
    expect(c.rootPlain).toBe(V.ROOT_PLAIN);
    expect(c.rootCipher).toBe(V.ROOT_CIPHER);
    expect(c.cipherLeaves[0]).toBe(V.CIPHER_LEAF_0);
    expect(c.cipherChunks[0]).toBe(V.C_0);
    expect(c.chunkCount).toBe(5);
  });
});

describe("recourse crypto properties", () => {
  it("xor round-trips and is keyed per chunk", () => {
    for (let i = 0; i < 5; i++) {
      const c = encryptChunk(KEY, i, plain[i] as Hex);
      expect(c).not.toBe(plain[i]);
      expect(decryptChunk(KEY, i, c)).toBe(plain[i]);
      if (i > 0) expect(decryptChunk(KEY, i - 1, c)).not.toBe(plain[i]);
    }
    expect(BLOCKS_PER_CHUNK).toBe(5);
  });

  it("rejects chunks that are not 160 bytes", () => {
    expect(() => encryptChunk(KEY, 0, toHex(new Uint8Array(159)))).toThrow();
    expect(() => encryptChunk(KEY, 0, toHex(new Uint8Array(161)))).toThrow();
    expect(() => chunkKey("0x1234", 0)).toThrow();
  });

  it("complaint data for a swapped chunk verifies under both roots and fails to match", () => {
    const honest = commitDelivery(KEY, plain);
    const junkCipher = encryptChunk(KEY, 2, chunk(0xee));
    const cheatCipherLeaves = [...honest.cipherLeaves];
    cheatCipherLeaves[2] = hashLeaf(junkCipher);
    const cheatRoot = merkleRoot(cheatCipherLeaves);
    const cipherProof = merkleProof(cheatCipherLeaves, 2);
    const plainProof = merkleProof(honest.plainLeaves, 2);
    expect(verifyProof(cipherProof, cheatRoot, hashLeaf(junkCipher), 2, 5)).toBe(true);
    expect(verifyProof(plainProof, honest.rootPlain, honest.plainLeaves[2] as Hex, 2, 5)).toBe(true);
    expect(chunkMatches(KEY, 2, junkCipher, honest.plainLeaves[2] as Hex)).toBe(false);
    expect(chunkMatches(KEY, 1, honest.cipherChunks[1] as Hex, honest.plainLeaves[1] as Hex)).toBe(true);
  });

  it("reads the big-endian uint64 record timestamp from the first 8 bytes", () => {
    const rec = new Uint8Array(CHUNK_SIZE);
    rec.set([0, 0, 0, 0, 0x6a, 0x12, 0x34, 0x56], 0);
    expect(recordTimestamp(toHex(rec))).toBe(0x6a123456n);
  });

  it("records split into payload and signature", () => {
    const payload = buildPayload(1_790_000_000n, toHex(new Uint8Array(87).fill(7)));
    const sig = toHex(new Uint8Array(65).fill(9));
    const rec = buildRecord(payload, sig);
    expect(hexToLen(rec)).toBe(CHUNK_SIZE);
    expect(splitRecord(rec)).toEqual({ payload, signature: sig });
    expect(recordTimestamp(rec)).toBe(1_790_000_000n);
    expect(() => buildPayload(1n, toHex(new Uint8Array(86)))).toThrow();
  });
});

describe("promise check (mirrors complainPromise)", () => {
  const source = privateKeyToAccount(`0x${"50c4ce".padStart(64, "0")}`);
  const stranger = privateKeyToAccount(`0x${"bad".padStart(64, "0")}`);
  const minTs = 1_790_000_000n;
  const data = toHex(new Uint8Array(87).fill(1));

  async function record(ts: bigint, signer: typeof source): Promise<Hex> {
    const payload = buildPayload(ts, data);
    const signature = await signer.sign({ hash: payloadHash(payload) });
    return buildRecord(payload, signature);
  }

  it("keeps the promise for a fresh, source-signed record", async () => {
    expect(await promiseBroken(await record(minTs + 1n, source), source.address, minTs)).toBe(false);
  });
  it("breaks on a wrong signer, a stale timestamp or a malformed signature", async () => {
    expect(await promiseBroken(await record(minTs + 1n, stranger), source.address, minTs)).toBe(true);
    expect(await promiseBroken(await record(minTs - 1n, source), source.address, minTs)).toBe(true);
    const garbage = buildRecord(buildPayload(minTs, data), toHex(new Uint8Array(65)));
    expect(await promiseBroken(garbage, source.address, 0n)).toBe(true);
  });
  it("ignores the signer when no source was promised, and rejects an empty promise", async () => {
    expect(await promiseBroken(await record(minTs + 1n, stranger), null, minTs)).toBe(false);
    await expect(promiseBroken(await record(minTs, source), null, 0n)).rejects.toThrow();
  });
});

const hexToLen = (h: Hex): number => (h.length - 2) / 2;
