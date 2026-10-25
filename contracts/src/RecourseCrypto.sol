// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Delivery keystream (docs/SPEC.md "Delivery cryptography"), mirrored by packages/recourse-crypto/src/crypto.ts.
///   k   = keccak256(sellerSecret || orderId || buyer)      keyCommitment = keccak256(k)
///   k_i = keccak256(k || uint256 i)                        ks_j = keccak256(k_i || uint256 j), 32 bytes
///   c_i = p_i XOR (ks_0 || ... || ks_4)                    records are exactly 160 bytes
/// Merkle rules live in MerkleLib (domain-separated leaves/nodes). Golden vectors: test/escrow/RecourseCrypto.t.sol.
library RecourseCrypto {
    uint256 internal constant CHUNK_SIZE = 160;
    uint256 internal constant BLOCK_SIZE = 32;
    uint256 internal constant BLOCKS_PER_CHUNK = CHUNK_SIZE / BLOCK_SIZE;
    /// Record layout: payload [0, 95) whose first 8 bytes are a big-endian uint64 timestamp, signature [95, 160).
    uint256 internal constant PAYLOAD_SIZE = 95;
    uint256 internal constant SIGNATURE_SIZE = 65;

    error BadChunkLength();

    /// Split a 160-byte record into its payload and 65-byte (r, s, v) signature.
    function splitRecord(bytes calldata record) internal pure returns (bytes calldata payload, bytes calldata sig) {
        if (record.length != CHUNK_SIZE) revert BadChunkLength();
        payload = record[:PAYLOAD_SIZE];
        sig = record[PAYLOAD_SIZE:];
    }

    /// Big-endian uint64 in the first 8 payload bytes.
    function recordTimestamp(bytes calldata payload) internal pure returns (uint64) {
        return uint64(bytes8(payload[:8]));
    }

    /// Hash the source signs: plain keccak256 of the payload (no EIP-191 prefix).
    function payloadHash(bytes calldata payload) internal pure returns (bytes32) {
        return keccak256(payload);
    }

    function deriveKey(bytes32 sellerSecret, bytes32 orderId, address buyer) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(sellerSecret, orderId, buyer));
    }

    function keyCommitment(bytes32 key) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(key));
    }

    function chunkKey(bytes32 key, uint256 i) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(key, i));
    }

    function keystreamBlock(bytes32 chunkKey_, uint256 j) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(chunkKey_, j));
    }

    /// XOR a 160-byte chunk with the keystream of `chunkKey_`. Symmetric: encryption and decryption.
    function xorChunk(bytes32 chunkKey_, bytes memory chunk) internal pure returns (bytes memory out) {
        if (chunk.length != CHUNK_SIZE) revert BadChunkLength();
        out = new bytes(CHUNK_SIZE);
        for (uint256 j; j < BLOCKS_PER_CHUNK; j++) {
            bytes32 ks = keystreamBlock(chunkKey_, j);
            uint256 off = 0x20 + j * BLOCK_SIZE;
            assembly ("memory-safe") {
                mstore(add(out, off), xor(mload(add(chunk, off)), ks))
            }
        }
    }
}
