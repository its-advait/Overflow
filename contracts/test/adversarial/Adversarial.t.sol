// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OverflowTreasury} from "../../src/OverflowTreasury.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {IUSDC, UsdcV22} from "../usdc/UsdcV22.sol";

/// @notice Leash's protocol-auditor adversarial tests, ported to OverflowTreasury on Circle's real USDC v2.2.
/// Self-contained: does not import test/unit/TreasuryBase.t.sol.
contract AdversarialTest is Test {
    bytes32 constant TWA = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 constant CC = keccak256(
        "CreateChild(uint256 parentId,address key,uint256 cap,uint256 maxPerCall,uint256 expiry,bool restricted,bytes32 payeesHash,uint256 nonce,uint256 deadline)"
    );
    uint256 constant U = 1e6;

    IUSDC usdc;
    OverflowTreasury w;
    address usdcOwner = makeAddr("usdcOwner");
    address owner = makeAddr("owner");
    address payA = makeAddr("payA");
    address payB = makeAddr("payB");
    uint256 rootPk = 0xA11CE;
    uint256 s1Pk = 0xB0B;
    uint256 victimPk = 0xC0FFEE;
    uint256 n;

    function setUp() public {
        vm.warp(1_791_700_000);
        usdc = UsdcV22.deploy(makeAddr("usdcProxyAdmin"), usdcOwner);
        w = new OverflowTreasury(address(usdc), owner);
        UsdcV22.mint(usdc, usdcOwner, address(w), 5 * U);
        vm.startPrank(owner);
        w.setAllow(payA, true);
        w.setAllow(payB, true);
        w.createRoot(vm.addr(rootPk), U, U / 10, block.timestamp + 1 days);
        vm.stopPrank();
    }

    function _child(uint256 parentPk, uint256 pid, address key, bool restricted, address[] memory payees)
        internal
        returns (uint256)
    {
        IOverflowTreasury.ChildParams memory c = IOverflowTreasury.ChildParams({
            parentId: pid,
            key: key,
            cap: U / 4,
            maxPerCall: U / 10,
            expiry: block.timestamp + 1 hours,
            restricted: restricted,
            payees: payees,
            nonce: ++n,
            deadline: block.timestamp + 600
        });
        bytes32 sh = keccak256(
            abi.encode(
                CC,
                c.parentId,
                c.key,
                c.cap,
                c.maxPerCall,
                c.expiry,
                c.restricted,
                keccak256(abi.encodePacked(c.payees)),
                c.nonce,
                c.deadline
            )
        );
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", w.DELEGATION_DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(parentPk, d);
        return w.createChild(c, abi.encodePacked(r, s, v));
    }

    function _sig(uint256 pk, address to, uint256 value, bytes32 nonce) internal view returns (bytes memory) {
        bytes32 sh =
            keccak256(abi.encode(TWA, address(w), to, value, block.timestamp - 5, block.timestamp + 120, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh)));
        return abi.encodePacked(r, s, v);
    }

    /// Same tx: after settle() returns, the transient flag must be gone. A multicall attacker that settles a
    /// cheap payment cannot then reuse the open 1271 window for another digest or the same digest.
    function test_flagClearedWithinSameTx() public {
        bytes32 nonce = keccak256("a");
        bytes memory sig = _sig(rootPk, payA, U / 20, nonce);
        w.settle(payA, U / 20, block.timestamp - 5, block.timestamp + 120, nonce, sig);
        bytes32 sh =
            keccak256(abi.encode(TWA, address(w), payA, U / 20, block.timestamp - 5, block.timestamp + 120, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
        vm.prank(address(usdc));
        assertEq(w.isValidSignature(digest, sig), bytes4(0xffffffff));
        // a second, never-settled authorization sent straight to the token in the same tx still fails
        bytes32 nonce2 = keccak256("b");
        bytes memory sig2 = _sig(rootPk, payB, U / 20, nonce2);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(
            address(w), payB, U / 20, block.timestamp - 5, block.timestamp + 120, nonce2, sig2
        );
        assertEq(usdc.balanceOf(payB), 0);
    }

    /// Restricted grandparent blocks a grandchild's payment even when the middle node is unrestricted.
    function test_restrictedAncestorEnforcedThroughUnrestrictedMiddle() public {
        address[] memory onlyA = new address[](1);
        onlyA[0] = payA;
        uint256 c1 = _child(rootPk, 1, vm.addr(s1Pk), true, onlyA);
        uint256 gPk = 0xD00D;
        address[] memory none = new address[](0);
        _child(s1Pk, c1, vm.addr(gPk), false, none);
        bytes32 nonce = keccak256("g");
        bytes memory sig = _sig(gPk, payB, U / 20, nonce);
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, c1));
        w.settle(payB, U / 20, block.timestamp - 5, block.timestamp + 120, nonce, sig);
    }

    /// NIT (design, carried from Leash): createChild has no proof-of-possession for c.key. A hostile sibling
    /// that learns a key the parent intends to delegate can register it under its own subtree first; the
    /// honest delegation then reverts KeyInUse (griefing; spend stays bounded by the hostile sibling's budget).
    function test_keyCapture_bySibling_griefsHonestDelegation() public {
        address[] memory none = new address[](0);
        uint256 s1 = _child(rootPk, 1, vm.addr(s1Pk), false, none);
        address victim = vm.addr(victimPk);
        uint256 captured = _child(s1Pk, s1, victim, false, none); // hostile s1 grabs the key
        assertEq(w.nodeOfKey(victim), captured);
        vm.expectRevert(IOverflowTreasury.KeyInUse.selector);
        this.extChild(rootPk, 1, victim); // root's honest delegation of the same key now fails
    }

    function extChild(uint256 parentPk, uint256 pid, address key) external {
        address[] memory none = new address[](0);
        _child(parentPk, pid, key, false, none);
    }
}
