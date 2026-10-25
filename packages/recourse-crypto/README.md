# @overflow/recourse-crypto

Everything a seller needs to commit to and encrypt a dataset, and everything a buyer needs to verify a sample, decrypt, and build a complaint for `OverflowEscrow`. The Solidity escrow mirrors this code; `test/vectors.json` (copied to `contracts/test/fixtures/recourse-vectors.json`) keeps the two identical.

Spec: `docs/SPEC.md`, "Recourse: delivery-backed escrow" (Delivery cryptography, Sampling before buying, Complaints).

Rules: viem only for hashing and signing; `Uint8Array` and `0x` hex strings everywhere, never `Buffer` in the public interface; every hash is over fixed-width bytes, never JSON.

## Record format (contract with Solidity)

One record per chunk. Sizes are fixed; anything else is rejected.

| Field | Bytes | Content |
| --- | --- | --- |
| chunk | 160 | `payload (95) ‖ signature (65)` |
| payload | 95 | `timestamp (8) ‖ data (87)` |
| timestamp | 8 | unix seconds, uint64 big-endian, at payload offset 0 (`RecourseCrypto.recordTimestamp` reads `payload[:8]`) |
| data | 87 | one UTF-8 CSV row, right-padded with `0x00`; rows longer than 87 bytes and rows containing NUL are rejected |
| signature | 65 | `r ‖ s ‖ v`, `v ∈ {27, 28}`, ECDSA over `keccak256(payload)` with **no** EIP-191 prefix (viem `sign({ hash })`, RFC 6979 deterministic) |

Solidity check for a record (`OverflowEscrow.complainPromise`): `ecrecover(keccak256(payload), v, r, s) == sourceKey` and `uint64(bytes8(payload[:8])) >= minTimestamp`. There is no version byte: the manifest's `recordFormat` field describes the layout instead.

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

- `leaf = keccak256(0x00 ‖ chunk)`; the chunk must be exactly 160 bytes, anything else is rejected.
- `parent = keccak256(0x01 ‖ left ‖ right)` in index order.
- A level with an odd count carries its last node up **unchanged** (no duplication).
- `proof` = sibling hashes bottom-up. A level where the node is the carried odd node contributes **no** element, so proof lengths vary by index (7 chunks: index 6 has 2 elements, every other index has 3).
- `rootPlain` is built over plaintext chunks, `rootCipher` over ciphertext chunks; both trees have the same shape.

Leaves and internal nodes live in separate hash domains (`0x00` vs `0x01` prefix), and every verifier knows `chunkCount` from the escrow terms or manifest, so the proof length is pinned per index. Together these close the internal-node-as-leaf second preimage: a shorter proof that presents an internal node as a leaf is rejected on length, and no 160-byte chunk can hash into the node domain. `merkle.test.ts` keeps the attack and shows it failing.

`expectedProofLength(index, chunkCount)` and `verifyProof({ root, leaf, index, proof, chunkCount })`, pseudo-Solidity:

```
function expectedProofLength(uint256 index, uint256 chunkCount) pure returns (uint256 len) {
  uint256 n = chunkCount; uint256 idx = index;
  while (n > 1) { if ((idx ^ 1) < n) len++; idx >>= 1; n = (n + 1) / 2; }
}

function verify(bytes32 root, bytes32 leaf, uint256 index, bytes32[] proof, uint256 chunkCount) pure returns (bool) {
  if (index >= chunkCount || proof.length != expectedProofLength(index, chunkCount)) return false;
  bytes32 node = leaf; uint256 n = chunkCount; uint256 idx = index; uint256 p = 0;
  while (n > 1) {
    if ((idx ^ 1) < n) {                       // sibling exists; otherwise the node is carried up unchanged
      bytes32 sib = proof[p++];
      node = idx & 1 == 1 ? keccak256(abi.encodePacked(bytes1(0x01), sib, node))
                          : keccak256(abi.encodePacked(bytes1(0x01), node, sib));
    }
    idx >>= 1; n = (n + 1) / 2;
  }
  return node == root;
}
```

The escrow must take `chunkCount` from its stored terms (or the manifest it committed to), never from the complainant.

API: `hashLeaf`, `hashPair`, `buildTree`, `buildTreeFromChunks`, `getProof`, `expectedProofLength`, `computeRootFromProof`, `verifyProof`, `LEAF_PREFIX`, `NODE_PREFIX`.

## Seller commitment

`commitDataset({ plainChunks, sellerSecret, orderId, buyer })` returns `rootPlain`, `rootCipher`, `keyCommitment`, `chunkCount`, plus `perBuyerKey`, both chunk arrays, both leaf arrays and both trees. The seller publishes the three roots in the escrow terms and the full list of plain leaves plus `chunkCount` in the manifest. Buyers run `verifyCiphertext(cipherChunks, rootCipher, chunkCount)` and `verifyPlainLeaves(plainLeaves, rootPlain, chunkCount)` before funding; both require exactly `chunkCount` entries.

## Manifest

One manifest per dataset (`data/datasets/<productId>/manifest.json`, schema `DatasetManifestSchema`): `simulated: true`, `productId`, `title`, `header` (CSV header line), `fields`, `granularity`, `chunkCount`, `rootPlain`, every `plainLeaf`, `sourceKey`, `minTimestamp`, `manifestHash`, `recordFormat`. `rootPlain` is buyer-independent, so the manifest is shared by every order; `rootCipher` and `keyCommitment` stay in the per-order terms.

```
manifestHash = keccak256(abi.encode(bytes32 rootPlain, uint256 chunkCount, address sourceKey, uint64 minTimestamp, bytes32 headerHash))
headerHash   = keccak256(bytes(header))
```

Fixed ABI fields, never JSON. API: `MANIFEST_HASH_ABI`, `computeManifestHash`, `headerHash`, `verifyManifest` (leaves Merkle to `rootPlain` and the hash recomputes; returns `schema`, `root-mismatch` or `hash-mismatch` otherwise), `RECORD_FORMAT`.

## Sampling

- `pickSampleIndices(n, count, randomBytes)`: unique indices, `candidate_j = keccak256(randomBytes ‖ uint256 j) mod n`, skipping repeats, in draw order.
- `revealChunkKeys(k, indices)` (seller): `k_i` for the sampled indices only.
- `verifySample(cipherChunk, chunkKey, plainLeaf, { index, cipherProof, plainProof, rootCipher, rootPlain, chunkCount })` (buyer): the cipher chunk proves under `rootCipher`, the plain leaf proves under `rootPlain` (both shape-pinned by `chunkCount`), and `hashLeaf(cipherChunk XOR keystream(k_i)) == plainLeaf`. Returns the decrypted chunk for Oracle to judge, or a reason (`cipher-proof`, `plain-proof`, `decrypt-mismatch`).

## Complaints

Builders return exactly the escrow's calldata and throw `ComplaintNotWarrantedError` if the contract would revert. An allegation alone never refunds.

- `buildMismatchComplaint({ index, cipherChunks, plainLeaves, revealedKey, rootCipher?, rootPlain? })` → `{ i, cipherChunk, cipherProof, plainLeaf, plainProof }` for `complainMismatch(uint256 i, bytes cipherChunk, bytes32[] cipherProof, bytes32 plainLeaf, bytes32[] plainProof)`. Warranted when `hashLeaf(decrypt(c_i, chunkKey(k, i))) != plainLeaf_i`.
- `buildPromiseComplaint({ index, plainChunks, sourceKey, minTimestamp, rootPlain? })` → `{ i, plainChunk, plainProof, verdict }` for `complainPromise(uint256 i, bytes plainChunk, bytes32[] plainProof)`. Warranted when the record's signer is not `sourceKey` or its timestamp is below `minTimestamp`.
- `checkMismatch(index, cipherChunk, revealedKey, plainLeaf)` is the contract's derivation, exposed for the UI.

## Golden vectors

`pnpm --filter @overflow/recourse-crypto vectors` regenerates `test/vectors.json` and `contracts/test/fixtures/recourse-vectors.json`. Everything in the file is **SIMULATED**: keys are `keccak256("overflow.simulated.<label>")` and never hold funds; the dataset is seven synthetic EV-registration CSV rows.

The file holds the seller secret, orderId, buyer, `k`, `keyCommitment`, both roots, and for every chunk: row, timestamp, payload, signature, plaintext, plain leaf, `k_i`, 160-byte keystream, ciphertext, cipher leaf, both proofs (index 6 is the odd-level case), and `chunkCount`. Plus one sample draw with revealed chunk keys, one swapped chunk with ready-made `complainMismatch` arguments, and one wrong-source record with ready-made `complainPromise` arguments. `vectors.test.ts` fails if regeneration changes a byte or the fixture copy drifts.

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
