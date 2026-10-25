// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice One escrow per order (docs/SPEC.md "Recourse: delivery-backed escrow", tier 1).
/// Deployed as a CREATE2 minimal clone by OverflowEscrowFactory; terms are fixed at initialization.
interface IOverflowEscrow {
    /// Field order is normative: termsHash = keccak256(abi.encode(token, amount, bond, manifestHash, rootPlain,
    /// rootCipher, keyCommitment, revealDeadline, challengeWindow, sourceKey, minTimestamp, chunkCount)),
    /// mirrored by TERMS_HASH_ABI in packages/schemas/src/hashing.ts.
    struct OrderTerms {
        bytes32 orderId;
        address buyer; // the OverflowTreasury
        address seller;
        address token; // USDC
        uint256 amount; // atomic units
        uint256 bond; // seller bond, may be 0 in tier 1
        bytes32 termsHash;
        bytes32 manifestHash;
        bytes32 rootPlain; // Merkle root of leaf(p_i), see MerkleLib
        bytes32 rootCipher; // Merkle root of leaf(c_i)
        bytes32 keyCommitment; // keccak256(key)
        uint64 revealDeadline; // unix seconds; reveal must happen strictly before
        uint64 challengeWindow; // seconds after the reveal
        address sourceKey; // tier 3
        uint64 minTimestamp; // tier 3
        uint32 chunkCount; // number of 160-byte records
    }

    enum Status {
        Created,
        Funded,
        Revealed,
        Settled,
        Refunded
    }

    error NotFactory();
    error AlreadyInitialized();
    error BadStatus(Status current);
    error NotSeller();
    error RevealWindowClosed();
    error RevealWindowOpen();
    error BadKey();
    error ChallengeOpen();
    error ChallengeClosed();
    error NotBuyerNode(address signer);
    error Underfunded(uint256 balance, uint256 required);
    error ChunkOutOfRange();
    error BadChunkLength();
    error BadProofLength(uint256 expected, uint256 actual);
    error BadProof();
    error NotImplemented();

    event OrderFunded(uint256 balance);
    event KeyRevealed(bytes32 key, uint64 challengeEnd);
    event Accepted(address signer, uint256 nodeId);
    event PaidOut(address seller, uint256 amount, uint256 bond);
    event Refunded(string reason);

    function initialize(OrderTerms calldata t) external; // factory only, once

    function markFunded() external;
    function revealKey(bytes32 key) external; // seller
    function accept(bytes calldata buyerNodeSig) external; // treasury node signs Accept(orderId)
    function finalizePayout() external;
    function claimTimeoutRefund() external;
    function complainMismatch(
        uint256 i,
        bytes calldata cipherChunk,
        bytes32[] calldata cipherProof,
        bytes32 plainLeaf,
        bytes32[] calldata plainProof
    ) external;
    function complainPromise(uint256 i, bytes calldata plainChunk, bytes32[] calldata plainProof) external;

    function terms() external view returns (OrderTerms memory);
    function buyer() external view returns (address);
    function seller() external view returns (address);
    function amount() external view returns (uint256);
    function status() external view returns (Status);
    function challengeEnd() external view returns (uint64);
    function revealedKey() external view returns (bytes32);
    function FACTORY() external view returns (address);
    function ACCEPT_TYPEHASH() external view returns (bytes32);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function acceptDigest() external view returns (bytes32);
    function expectedProofLength(uint256 i, uint256 n) external pure returns (uint256);
}
