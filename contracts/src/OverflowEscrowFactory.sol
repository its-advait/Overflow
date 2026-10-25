// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOverflowEscrow} from "./IOverflowEscrow.sol";
import {IOverflowEscrowFactory} from "./IOverflowEscrowFactory.sol";
import {OverflowEscrow} from "./OverflowEscrow.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";

/// @title OverflowEscrowFactory
/// @notice Deploys one OverflowEscrow clone per order at a CREATE2 address derived from (orderId, termsHash),
/// so the escrow address is the order. Also keeps the cross-treasury cheater count (tier 3).
contract OverflowEscrowFactory is IOverflowEscrowFactory {
    address public immutable implementation;

    mapping(address escrow => bool) public isEscrow;
    mapping(address seller => uint256) public provenCheats;

    constructor() {
        implementation = address(new OverflowEscrow(address(this)));
    }

    function create(IOverflowEscrow.OrderTerms calldata t) external returns (address escrow) {
        if (
            t.buyer == address(0) || t.seller == address(0) || t.token == address(0) || t.amount == 0
                || t.chunkCount == 0 || t.revealDeadline <= block.timestamp
        ) revert BadTerms();
        bytes32 expected = termsHashOf(t);
        if (t.termsHash != expected) revert BadTermsHash(expected, t.termsHash);

        bytes32 salt = _salt(t.orderId, t.termsHash);
        address predicted = Clones.predictDeterministicAddress(implementation, salt, address(this));
        if (isEscrow[predicted]) revert OrderExists(predicted);

        escrow = Clones.cloneDeterministic(implementation, salt);
        isEscrow[escrow] = true;
        OverflowEscrow(escrow).initialize(t);
        emit OrderCreated(escrow, t.orderId, t.buyer, t.seller, t.amount, t.termsHash);
    }

    function predict(bytes32 orderId, bytes32 termsHash) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(orderId, termsHash), address(this));
    }

    /// Normative field order; mirrored by TERMS_HASH_ABI in packages/schemas/src/hashing.ts.
    function termsHashOf(IOverflowEscrow.OrderTerms calldata t) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                t.token,
                t.amount,
                t.bond,
                t.manifestHash,
                t.rootPlain,
                t.rootCipher,
                t.keyCommitment,
                t.revealDeadline,
                t.challengeWindow,
                t.sourceKey,
                t.minTimestamp,
                t.chunkCount
            )
        );
    }

    function recordCheat(address seller) external {
        if (!isEscrow[msg.sender]) revert NotEscrow();
        provenCheats[seller] += 1;
        emit CheatRecorded(seller, msg.sender);
    }

    function _salt(bytes32 orderId, bytes32 termsHash) internal pure returns (bytes32) {
        return keccak256(abi.encode(orderId, termsHash));
    }
}
