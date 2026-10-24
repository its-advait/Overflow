// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Toolchain smoke test: solc 0.8.28, cancun, forge-std and OpenZeppelin 5 resolve.
contract ScaffoldTest is Test {
    function test_toolchain() public pure {
        assertTrue(true);
        assertEq(type(IERC20).interfaceId != bytes4(0), true);
    }

    /// @dev cancun is required for transient storage (tstore/tload).
    function test_transientStorageAvailable() public {
        bytes32 slot = keccak256("overflow.scaffold");
        uint256 v;
        assembly {
            tstore(slot, 42)
            v := tload(slot)
        }
        assertEq(v, 42);
    }
}
