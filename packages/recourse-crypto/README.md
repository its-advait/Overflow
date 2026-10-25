# @overflow/recourse-crypto

Delivery cryptography for Recourse (docs/SPEC.md "Delivery cryptography" and "Complaints"). Every rule here is
mirrored byte for byte by `contracts/src/MerkleLib.sol` and `contracts/src/RecourseCrypto.sol`; golden vectors in
`src/merkle.test.ts`, `src/crypto.test.ts`, `contracts/test/escrow/MerkleLib.t.sol` and
`contracts/test/escrow/RecourseCrypto.t.sol` pin identical outputs on both sides. Never hash JSON.

## Records and chunks

- A delivery is split into `chunkCount` records of exactly **160 bytes** (`CHUNK_SIZE`). `OrderTerms.chunkCount`
  (`uint32`) is part of `termsHash`.
- Record layout: bytes `[0, 95)` payload, bytes `[95, 160)` a 65-byte secp256k1 signature `(r, s, v)` over
  `keccak256(payload)` by the promised `sourceKey` (tier 3). The first 8 bytes of the payload are the record's
  big-endian `uint64` timestamp (checked against `minTimestamp` in tier 3). Tier 2 treats the record as opaque bytes.

## Keys and keystream

| Quantity | Definition |
| --- | --- |
| per-buyer key `k` | `keccak256(abi.encodePacked(bytes32 sellerSecret, bytes32 orderId, address buyer))` |
| `keyCommitment` | `keccak256(k)` |
| chunk key `k_i` | `keccak256(abi.encodePacked(k, uint256 i))` |
| keystream block `j` | `keccak256(abi.encodePacked(k_i, uint256 j))`, 32 bytes, `j = 0..4` |
| ciphertext `c_i` | `p_i XOR (ks_0 || ks_1 || ks_2 || ks_3 || ks_4)` (XOR is its own inverse) |

A revealed `k` decrypts every chunk of that sale only; `k_i` exposes nothing about `k` or other chunks, so sampling
reveals individual `k_i`.

## Merkle trees (domain separated, index ordered)

- `leaf(data) = keccak256(0x00 || data)`; `node(l, r) = keccak256(0x01 || l || r)`.
- Levels are built left to right. When a level has an odd count, the **unpaired last node is promoted unhashed** to
  the next level. Proof length therefore depends on the index: `expectedProofLength(i, n)` (for n = 5: 3,3,3,3,1).
- `rootPlain = root(leaf(p_i))`, `rootCipher = root(leaf(c_i))`. A proof for index `i` is verified by consuming its
  elements bottom-up, sibling on the left when the current index is odd; verification fails unless every element is
  consumed. The contract additionally requires `proof.length == expectedProofLength(i, chunkCount)` and
  `chunk.length == 160`, so an internal node can never be presented as a leaf.

## Complaint (tier 3, `complainPromise`)

Buyer submits `(i, p_i, plainProof)`. The contract verifies the record under `rootPlain`, splits it into payload and
signature (`splitRecord`), and refunds price + bond when `ecrecover(keccak256(payload)) != sourceKey` (if a source
was promised) or the payload's uint64 timestamp is below `minTimestamp` (if one was promised). A malformed signature
counts as a wrong source. Terms that promise neither revert `NoPromise`; a record that keeps the promise reverts
`PromiseKept`. Offchain mirror: `promiseBroken`. Every proven cheat (tier 2 or 3) increments `provenCheats[seller]`
on the factory; the factory then refuses `create()` for that seller and the treasury refuses to pay them.

## Complaint (tier 2, `complainMismatch`)

Buyer submits `(i, c_i, cipherProof, leaf(p_i), plainProof)` while the escrow is `Revealed` and inside the challenge
window. The contract verifies both proofs, derives `k_i` from the revealed key, decrypts `c_i`, and refunds the whole
escrow balance to the buyer when `leaf(decrypt(c_i)) != leaf(p_i)`, recording the seller's cheat on the factory.
A matching chunk reverts `ChunkMatches`.
