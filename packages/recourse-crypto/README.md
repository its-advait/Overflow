# @overflow/recourse-crypto

Everything a seller needs to commit to and encrypt a dataset, and everything a buyer needs to verify a sample, decrypt, and build a complaint for `OverflowEscrow`. The Solidity escrow mirrors this code; `test/vectors.json` (copied to `contracts/test/fixtures/recourse-vectors.json`) keeps the two identical.

Spec: `docs/SPEC.md`, "Recourse: delivery-backed escrow" (Delivery cryptography, Sampling before buying, Complaints).

Rules: viem only for hashing and signing; `Uint8Array` and `0x` hex strings everywhere, never `Buffer` in the public interface; every hash is over fixed-width bytes, never JSON.

## Record format (contract with Solidity)

One record per chunk. Sizes are fixed; anything else is rejected.

| Field | Bytes | Content |
| --- | --- | --- |
| chunk | 160 | `payload (95) ‖ signature (65)` |
| payload | 95 | `version (1) ‖ timestamp (8) ‖ data (86)` |
| version | 1 | `0x01` |
| timestamp | 8 | unix seconds, uint64 big-endian |
| data | 86 | one UTF-8 CSV row, right-padded with `0x00`; rows longer than 86 bytes and rows containing NUL are rejected |
| signature | 65 | `r ‖ s ‖ v`, `v ∈ {27, 28}`, ECDSA over `keccak256(payload)` with **no** EIP-191 prefix (viem `sign({ hash })`, RFC 6979 deterministic) |

Solidity check for a record: `ecrecover(keccak256(payload), v, r, s) == sourceKey` and `uint64(bytes8(payload[1:9])) >= minTimestamp`.

API: `encodePayload`, `decodePayload`, `payloadHash`, `signPayload`, `buildRecordChunk`, `splitChunk`, `parseChunk`, `recoverRecordSigner`, `verifyRecordPromise`, `splitDataset`, `joinChunks`.

## Keys and encryption

```
k        = perBuyerKey(sellerSecret, orderId, buyer) = keccak256(abi.encodePacked(bytes32 sellerSecret, bytes32 orderId, address buyer))
k_i      = chunkKey(k, i)                            = keccak256(abi.encodePacked(bytes32 k, uint256 i))
block_j  = keystreamBlock(k_i, j)                    = keccak256(abi.encodePacked(bytes32 k_i, uint256 j))
c_i      = p_i XOR (block_0 ‖ block_1 ‖ block_2 ‖ block_3 ‖ block_4)      (160 bytes = 5 blocks)
keyCommitment = keccak256(k)
```

Encrypt and decrypt are the same XOR. A revealed `k_i` exposes nothing about `k` or other chunks. `k` is fresh per order and buyer because the onchain reveal makes it public.

API: `perBuyerKey`, `chunkKey`, `keystreamBlock`, `keystream`, `applyChunkKey`, `encryptChunk`, `decryptChunk`, `decryptChunkWithChunkKey`, `keyCommitment`, `encryptDataset`, `decryptDataset`.

## Merkle trees

- `leaf = keccak256(chunk bytes)`.
- `parent = keccak256(abi.encodePacked(left, right))` in index order.
- A level with an odd count carries its last node up **unchanged** (no duplication).
- `proof` = sibling hashes bottom-up. A level where the node is the carried odd node contributes **no** element, so proof lengths vary by index (7 leaves: index 6 has 2 elements, every other index has 3).
- `rootPlain` is built over plaintext chunks, `rootCipher` over ciphertext chunks; both trees have the same shape.

`verifyProof({ root, leaf, index, proof, leafCount? })`:

Without `leafCount`, the verifier recovers the shape from the proof: depth `D = max(bitLength(index), proof.length)`, and the `D - proof.length` carried levels are the topmost even-position levels of the path (a node that is last at one level stays last above it). Pseudo-Solidity:

```
depth  = max(bitLength(index), proof.length)
carry  = depth - proof.length
mask   = 0
for level = depth-1 downto 0:  if carry > 0 and (index >> level) & 1 == 0: mask |= 1 << level; carry--
require(carry == 0)
node = leaf; p = 0
for level = 0 .. depth-1:
  if mask & (1 << level): continue                      // carried, unchanged
  sib = proof[p++]
  node = (index >> level) & 1 ? keccak256(sib ‖ node) : keccak256(node ‖ sib)
return node == root
```

**Second-preimage caveat.** Without the leaf count, a bare 32-byte "leaf" that is really an internal node verifies with a shorter proof. Leaves that are hashes of real 160-byte chunks are immune, so `cipherChunk` in `complainMismatch` and `plainChunk` in `complainPromise` are safe. The bare `plainLeaf` in `complainMismatch` is not: the contract must either know the chunk count (recommended: store `chunkCount` in the order terms or manifest and check `proof.length == expectedProofLength(chunkCount, i)`) or require `cipherProof.length == plainProof.length`, which pins the plain proof to the chunk-backed cipher proof. Pass `leafCount` in TypeScript whenever you have it.

API: `hashLeaf`, `hashPair`, `buildTree`, `buildTreeFromChunks`, `getProof`, `expectedProofLength`, `computeRootFromProof`, `verifyProof`.

## Seller commitment

`commitDataset({ plainChunks, sellerSecret, orderId, buyer })` returns `rootPlain`, `rootCipher`, `keyCommitment`, `leafCount`, plus `perBuyerKey`, both chunk arrays, both leaf arrays and both trees. The seller publishes the three roots in the escrow terms and the full list of plain leaves plus `leafCount` in the manifest. Buyers run `verifyCiphertext(cipherChunks, rootCipher)` and `verifyPlainLeaves(plainLeaves, rootPlain)` before funding.

## Sampling

- `pickSampleIndices(n, count, randomBytes)`: unique indices, `candidate_j = keccak256(randomBytes ‖ uint256 j) mod n`, skipping repeats, in draw order.
- `revealChunkKeys(k, indices)` (seller): `k_i` for the sampled indices only.
- `verifySample(cipherChunk, chunkKey, plainLeaf, { index, cipherProof, plainProof, rootCipher, rootPlain, leafCount })` (buyer): the cipher chunk proves under `rootCipher`, the plain leaf proves under `rootPlain`, and `keccak256(cipherChunk XOR keystream(k_i)) == plainLeaf`. Returns the decrypted chunk for Oracle to judge, or a reason (`cipher-proof`, `plain-proof`, `decrypt-mismatch`).

## Complaints

Builders return exactly the escrow's calldata and throw `ComplaintNotWarrantedError` if the contract would revert. An allegation alone never refunds.

- `buildMismatchComplaint({ index, cipherChunks, plainLeaves, revealedKey, rootCipher?, rootPlain? })` → `{ i, cipherChunk, cipherProof, plainLeaf, plainProof }` for `complainMismatch(uint256 i, bytes cipherChunk, bytes32[] cipherProof, bytes32 plainLeaf, bytes32[] plainProof)`. Warranted when `keccak256(decrypt(c_i, chunkKey(k, i))) != plainLeaf_i`.
- `buildPromiseComplaint({ index, plainChunks, sourceKey, minTimestamp, rootPlain? })` → `{ i, plainChunk, plainProof, verdict }` for `complainPromise(uint256 i, bytes plainChunk, bytes32[] plainProof)`. Warranted when the record's signer is not `sourceKey` or its timestamp is below `minTimestamp`.
- `checkMismatch(index, cipherChunk, revealedKey, plainLeaf)` is the contract's derivation, exposed for the UI.

## Golden vectors

`pnpm --filter @overflow/recourse-crypto vectors` regenerates `test/vectors.json` and `contracts/test/fixtures/recourse-vectors.json`. Everything in the file is **SIMULATED**: keys are `keccak256("overflow.simulated.<label>")` and never hold funds; the dataset is seven synthetic EV-registration CSV rows.

The file holds the seller secret, orderId, buyer, `k`, `keyCommitment`, both roots, and for every chunk: row, timestamp, payload, signature, plaintext, plain leaf, `k_i`, 160-byte keystream, ciphertext, cipher leaf, both proofs (index 6 is the odd-level case). Plus one sample draw with revealed chunk keys, one swapped chunk with ready-made `complainMismatch` arguments, and one wrong-source record with ready-made `complainPromise` arguments. `vectors.test.ts` fails if regeneration changes a byte or the fixture copy drifts.

## CLI

```
pnpm --filter @overflow/recourse-crypto cli -- records  rows.csv plain.bin --signer 0x<pk> [--timestamp <unix>]
pnpm --filter @overflow/recourse-crypto cli -- commit   plain.bin --secret 0x<32> --order 0x<32> --buyer 0x<addr>
pnpm --filter @overflow/recourse-crypto cli -- encrypt  plain.bin cipher.bin --secret ... --order ... --buyer ...
pnpm --filter @overflow/recourse-crypto cli -- sample   --n 7 --count 3 [--random 0x<hex>] [--secret ... --order ... --buyer ...]
pnpm --filter @overflow/recourse-crypto cli -- decrypt  cipher.bin plain.bin (--key 0x<32> | --chunk-key 0x<32> --index <i>)
pnpm --filter @overflow/recourse-crypto cli -- prove    plain.bin --index <i>
```

Binary files are raw concatenations of 160-byte chunks. Output is JSON.
