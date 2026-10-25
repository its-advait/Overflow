// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Domain-separated, index-ordered Merkle tree over chunk records.
/// leaf = keccak256(0x00 || data), node = keccak256(0x01 || left || right). Levels are built left to right;
/// an unpaired last node is promoted unhashed to the next level, so proof length depends on the index.
/// Mirrored by packages/recourse-crypto/src/merkle.ts; golden vectors keep both identical.
library MerkleLib {
    error IndexOutOfRange();

    function leaf(bytes memory data) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x00), data));
    }

    function node(bytes32 left, bytes32 right) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(bytes1(0x01), left, right));
    }

    /// Number of sibling hashes a proof for leaf `i` of an `n`-leaf tree must contain.
    function expectedProofLength(uint256 i, uint256 n) internal pure returns (uint256 len) {
        if (i >= n) revert IndexOutOfRange();
        uint256 width = n;
        uint256 idx = i;
        while (width > 1) {
            if (!(idx == width - 1 && width % 2 == 1)) len++;
            idx >>= 1;
            width = (width + 1) >> 1;
        }
    }

    /// True iff `proof` (exactly consumed) lifts `leafHash` at index `i` of an `n`-leaf tree to `root`.
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leafHash, uint256 i, uint256 n)
        internal
        pure
        returns (bool)
    {
        if (i >= n) return false;
        bytes32 h = leafHash;
        uint256 width = n;
        uint256 idx = i;
        uint256 p;
        while (width > 1) {
            if (!(idx == width - 1 && width % 2 == 1)) {
                if (p >= proof.length) return false;
                bytes32 sibling = proof[p++];
                h = idx % 2 == 0 ? node(h, sibling) : node(sibling, h);
            }
            idx >>= 1;
            width = (width + 1) >> 1;
        }
        return p == proof.length && h == root;
    }
}
