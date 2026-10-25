// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOverflowEscrow} from "./IOverflowEscrow.sol";

interface IOverflowEscrowFactory {
    error BadTerms();
    error BadTermsHash(bytes32 expected, bytes32 actual);
    error OrderExists(address escrow);
    error NotEscrow();

    event OrderCreated(
        address indexed escrow,
        bytes32 indexed orderId,
        address indexed buyer,
        address seller,
        uint256 amount,
        bytes32 termsHash
    );
    event CheatRecorded(address indexed seller, address indexed escrow);

    function create(IOverflowEscrow.OrderTerms calldata t) external returns (address escrow);
    function predict(bytes32 orderId, bytes32 termsHash) external view returns (address);
    function termsHashOf(IOverflowEscrow.OrderTerms calldata t) external pure returns (bytes32);
    function isEscrow(address a) external view returns (bool);
    function provenCheats(address seller) external view returns (uint256);
    function recordCheat(address seller) external; // callable only by its own escrows
    function implementation() external view returns (address);
}
