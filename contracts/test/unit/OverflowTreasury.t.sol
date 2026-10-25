// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TreasuryBaseTest} from "./TreasuryBase.t.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {OverflowTreasury} from "../../src/OverflowTreasury.sol";

/// @notice Leash's LeashWallet unit suite, ported to OverflowTreasury on Circle's real USDC v2.2.
contract OverflowTreasuryTest is TreasuryBaseTest {
    uint256 constant C1 = 0xC1; // child 1 key
    uint256 constant C2 = 0xC2; // child 2 key
    uint256 constant G1 = 0x61; // grandchild key

    string constant USDC_INVALID_SIG = "FiatTokenV2: invalid signature";
    string constant USDC_NONCE_USED = "FiatTokenV2: authorization is used or canceled";
    string constant USDC_BLACKLISTED = "Blacklistable: account is blacklisted";

    // ============================================================ constants / setup

    function test_typehash_constant() public view {
        assertEq(
            TWA_TYPEHASH,
            keccak256(
                "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        assertEq(treasury.TWA_TYPEHASH(), TWA_TYPEHASH);
        assertEq(treasury.APPROVAL_SALT(), keccak256("overflow.approval.v1"));
        assertEq(treasury.MAX_DEPTH(), 2);
    }

    function test_constructor_and_root() public view {
        assertEq(treasury.TOKEN(), address(usdc));
        assertEq(treasury.owner(), owner);
        assertEq(treasury.nodeCount(), 1);
        assertEq(treasury.nodeOfKey(rootKey), 1);
        IOverflowTreasury.Node memory n = treasury.getNode(1);
        assertEq(n.key, rootKey);
        assertEq(n.parent, 0);
        assertEq(n.depth, 0);
        assertEq(n.cap, U);
        assertEq(n.maxPerCall, U / 10);
        assertEq(n.expiry, rootExpiry);
        assertTrue(treasury.allowlist(payeeA));
    }

    function test_delegation_domain_separator() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Overflow"),
                keccak256("1"),
                block.chainid,
                address(treasury)
            )
        );
        assertEq(treasury.DELEGATION_DOMAIN_SEPARATOR(), expected);
    }

    // ============================================================ happy paths

    function test_depth1_root_pays() public {
        Auth memory a = _auth(rootPk, payeeA, 2 * U / 100);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit IOverflowTreasury.Paid(1, payeeA, a.value, a.nonce);
        _settle(a);
        assertEq(usdc.balanceOf(payeeA), a.value);
        assertEq(usdc.balanceOf(address(treasury)), 5 * U - a.value);
        assertEq(treasury.getNode(1).spent, a.value);
        assertEq(treasury.remaining(1), U - a.value);
        assertTrue(usdc.authorizationState(address(treasury), a.nonce));
    }

    function test_depth2_child_pays_increments_both() public {
        uint256 c = _child(rootPk, 1, C1, U / 4, U / 10);
        assertEq(c, 2);
        assertEq(treasury.getNode(2).depth, 1);
        _pay(C1, payeeB, 5 * U / 100);
        assertEq(treasury.getNode(2).spent, 5 * U / 100);
        assertEq(treasury.getNode(1).spent, 5 * U / 100);
        assertEq(usdc.balanceOf(payeeB), 5 * U / 100);
    }

    function test_depth3_grandchild_pays_increments_all_three() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        uint256 g = _child(C1, 2, G1, U / 10, U / 20);
        assertEq(g, 3);
        assertEq(treasury.getNode(3).depth, 2);
        assertEq(treasury.getNode(3).parent, 2);
        _pay(G1, payeeA, 2 * U / 100);
        assertEq(treasury.getNode(3).spent, 2 * U / 100);
        assertEq(treasury.getNode(2).spent, 2 * U / 100);
        assertEq(treasury.getNode(1).spent, 2 * U / 100);
        assertEq(treasury.remaining(3), U / 10 - 2 * U / 100);
    }

    function test_remaining_is_min_over_ancestors() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(rootPk, 1, C2, U / 4, U / 10);
        vm.prank(owner);
        treasury.raiseCap(1, 3 * U / 10); // root cap 0.30
        _pay(C1, payeeA, U / 10);
        _pay(C1, payeeA, U / 10); // root spent 0.20
        assertEq(treasury.remaining(3), U / 10); // child2 has 0.25 left but root only 0.10
        assertEq(treasury.remaining(99), 0);
    }

    function test_event_NodeCreated() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectEmit(true, true, false, true, address(treasury));
        emit IOverflowTreasury.NodeCreated(2, 1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        treasury.createChild(c, sig);
    }

    // ============================================================ settle errors

    function test_UnknownAgent() public {
        uint256 pk = 0xBAD;
        _expectPayRevert(pk, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.UnknownAgent.selector, vm.addr(pk)));
    }

    function test_PayeeNotAllowed_global() public {
        _expectPayRevert(rootPk, attacker, 1, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0));
    }

    function test_PayeeNotAllowed_node_level() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        c.restricted = true;
        c.payees = new address[](1);
        c.payees[0] = payeeA;
        _createChild(rootPk, c);
        assertTrue(treasury.nodeAllow(2, payeeA));
        assertFalse(treasury.nodeAllow(2, payeeB));
        _pay(C1, payeeA, U / 100);
        _expectPayRevert(C1, payeeB, U / 100, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 2));
    }

    function test_PayeeNotAllowed_inherited_from_restricted_ancestor() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        c.restricted = true;
        c.payees = new address[](1);
        c.payees[0] = payeeA;
        _createChild(rootPk, c);
        _child(C1, 2, G1, U / 10, U / 20); // unrestricted grandchild
        _expectPayRevert(G1, payeeB, U / 100, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 2));
    }

    function test_OverPerCall_root() public {
        _expectPayRevert(rootPk, payeeA, U / 10 + 1, abi.encodeWithSelector(IOverflowTreasury.OverPerCall.selector, 1));
    }

    function test_OverPerCall_child() public {
        _child(rootPk, 1, C1, U / 4, U / 20);
        _expectPayRevert(C1, payeeA, U / 20 + 1, abi.encodeWithSelector(IOverflowTreasury.OverPerCall.selector, 2));
    }

    function test_OverBudget_child() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _pay(C1, payeeA, U / 10);
        _pay(C1, payeeA, U / 10);
        _expectPayRevert(C1, payeeA, U / 10, abi.encodeWithSelector(IOverflowTreasury.OverBudget.selector, 2));
        assertEq(treasury.getNode(2).spent, 2 * U / 10); // failed call charged nothing
        assertEq(treasury.getNode(1).spent, 2 * U / 10);
    }

    function test_sibling_spend_hits_parent_OverBudget() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(rootPk, 1, C2, U / 4, U / 10);
        vm.prank(owner);
        treasury.raiseCap(1, 3 * U / 10); // root cap 0.30
        _pay(C1, payeeA, U / 10);
        _pay(C1, payeeA, U / 10);
        _pay(C2, payeeA, U / 10); // root now 0.30/0.30, child2 0.10/0.25
        _expectPayRevert(C2, payeeA, U / 20, abi.encodeWithSelector(IOverflowTreasury.OverBudget.selector, 1));
    }

    function test_raiseCap_unblocks_OverBudget_node() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _pay(C1, payeeA, U / 10);
        _pay(C1, payeeA, U / 10);
        _expectPayRevert(C1, payeeA, U / 10, abi.encodeWithSelector(IOverflowTreasury.OverBudget.selector, 2));
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.CapRaised(2, U / 4, 4 * U / 10);
        vm.prank(owner);
        treasury.raiseCap(2, 4 * U / 10);
        _pay(C1, payeeA, U / 10);
        assertEq(treasury.getNode(2).spent, 3 * U / 10);
    }

    function test_Expired_root() public {
        vm.warp(rootExpiry); // block.timestamp >= expiry
        _expectPayRevert(rootPk, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Expired.selector, 1));
    }

    function test_Expired_child() public {
        _createChild(rootPk, _params(1, vm.addr(C1), U / 4, U / 10, block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        _expectPayRevert(C1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Expired.selector, 2));
        _pay(rootPk, payeeA, 1); // root still alive
    }

    function test_Paused_by_owner_blocks_subtree_then_unpause() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.NodePaused(1, owner);
        vm.prank(owner);
        treasury.pause(1);
        _expectPayRevert(rootPk, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 1));
        _expectPayRevert(C1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 1));
        vm.expectEmit(true, false, false, false, address(treasury));
        emit IOverflowTreasury.NodeUnpaused(1);
        vm.prank(owner);
        treasury.unpause(1);
        _pay(C1, payeeA, 1);
    }

    /// Owner pauses the middle node: its grandchild is blocked, the root is not.
    function test_pause_middle_node_blocks_grandchild() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(C1, 2, G1, U / 10, U / 20);
        vm.prank(owner);
        treasury.pause(2);
        _expectPayRevert(G1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 2));
        _expectPayRevert(C1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 2));
        _pay(rootPk, payeeA, 1);
        assertEq(treasury.getNode(3).spent, 0);
    }

    function test_BelowFloor() public {
        vm.prank(owner);
        treasury.setFloor(5 * U);
        assertEq(treasury.floor(), 5 * U);
        _expectPayRevert(rootPk, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.BelowFloor.selector));
        vm.prank(owner);
        treasury.setFloor(5 * U - 1);
        _pay(rootPk, payeeA, 1);
    }

    function test_settle_replay_reverts() public {
        Auth memory a = _auth(rootPk, payeeA, U / 100);
        _settle(a);
        vm.expectRevert(bytes(USDC_NONCE_USED));
        _settle(a);
        assertEq(treasury.getNode(1).spent, U / 100); // the failed replay charged nothing
        assertEq(usdc.balanceOf(payeeA), U / 100);
    }

    /// The same signature sent straight to USDC fails (no transient flag), then settles through the treasury.
    function test_direct_to_token_bypass_reverts() public {
        Auth memory a = _auth(rootPk, payeeA, U / 100);
        vm.expectRevert(bytes(USDC_INVALID_SIG));
        _directToUsdc(attacker, a);
        assertEq(usdc.balanceOf(payeeA), 0);
        assertFalse(usdc.authorizationState(address(treasury), a.nonce));

        _settle(a); // same sig works through the treasury
        assertEq(usdc.balanceOf(payeeA), U / 100);
        assertTrue(usdc.authorizationState(address(treasury), a.nonce));

        // and cannot be pushed direct afterwards either (nonce consumed)
        vm.expectRevert(bytes(USDC_NONCE_USED));
        _directToUsdc(attacker, a);
    }

    /// USDC blacklists the payee: the token call reverts and nothing was charged.
    function test_blacklisted_payee_reverts_no_partial_charge() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        vm.prank(usdcOwner); // blacklister role on the test USDC
        usdc.blacklist(payeeA);

        Auth memory a = _auth(C1, payeeA, U / 100);
        uint256 before = usdc.balanceOf(address(treasury));
        vm.expectRevert(bytes(USDC_BLACKLISTED));
        _settle(a);

        assertEq(treasury.getNode(2).spent, 0);
        assertEq(treasury.getNode(1).spent, 0);
        assertEq(usdc.balanceOf(address(treasury)), before);
        assertEq(usdc.balanceOf(payeeA), 0);
        assertFalse(usdc.authorizationState(address(treasury), a.nonce));

        _pay(C1, payeeB, U / 100); // other payees unaffected
    }

    function test_malformed_signature_reverts() public {
        Auth memory a = _auth(rootPk, payeeA, U / 100);
        a.sig = hex"1234";
        vm.expectRevert();
        _settle(a);
    }

    // ============================================================ isValidSignature

    /// The gate is closed outside settle(): for USDC itself and for any other caller, before and after a payment.
    function test_gate_closed_outside_settle_for_usdc_and_others() public {
        Auth memory a = _auth(rootPk, payeeA, U / 100);
        bytes32 d = _twaDigest(address(treasury), a);
        vm.prank(address(usdc));
        assertEq(treasury.isValidSignature(d, a.sig), bytes4(0xffffffff));
        vm.prank(attacker);
        assertEq(treasury.isValidSignature(d, a.sig), bytes4(0xffffffff));
        assertEq(treasury.isValidSignature(d, a.sig), bytes4(0xffffffff));
        vm.prank(owner);
        assertEq(treasury.isValidSignature(d, a.sig), bytes4(0xffffffff));

        _settle(a);

        vm.prank(address(usdc));
        assertEq(treasury.isValidSignature(d, a.sig), bytes4(0xffffffff)); // flag cleared
        vm.prank(attacker);
        assertEq(treasury.isValidSignature(d, a.sig), bytes4(0xffffffff));
    }

    /// Inside settle: the flag is visible only to the token and only for the exact digest.
    /// ProbeToken is a labeled stand-in token: it exists only to observe the gate's answers mid-call.
    function test_isValidSignature_inside_settle_scoped_to_token_and_digest() public {
        ProbeToken probe = new ProbeToken();
        OverflowTreasury t = new OverflowTreasury(address(probe), owner);
        vm.startPrank(owner);
        t.setAllow(payeeA, true);
        t.createRoot(rootKey, U, U / 10, rootExpiry);
        vm.stopPrank();

        uint256 va = block.timestamp - 5;
        uint256 vb = block.timestamp + 120;
        bytes32 nonce = keccak256("probe");
        bytes32 sh = keccak256(abi.encode(TWA_TYPEHASH, address(t), payeeA, uint256(1), va, vb, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", probe.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(rootPk, digest);
        t.settle(payeeA, 1, va, vb, nonce, abi.encodePacked(r, s, v));

        assertEq(probe.rightDigest(), bytes4(0x1626ba7e));
        assertEq(probe.wrongDigest(), bytes4(0xffffffff));
        assertEq(probe.thirdParty(), bytes4(0xffffffff));
        vm.prank(address(probe));
        assertEq(t.isValidSignature(digest, ""), bytes4(0xffffffff)); // cleared after settle
    }

    // ============================================================ delegation errors

    function test_TooDeep() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(C1, 2, G1, U / 10, U / 20);
        IOverflowTreasury.ChildParams memory c = _params(3, vm.addr(0x99), U / 100, U / 100, rootExpiry);
        bytes memory sig = _signChild(G1, c);
        vm.expectRevert(IOverflowTreasury.TooDeep.selector);
        treasury.createChild(c, sig);
    }

    function test_ChildExceedsParent_cap() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U + 1, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectRevert(IOverflowTreasury.ChildExceedsParent.selector);
        treasury.createChild(c, sig);
    }

    function test_ChildExceedsParent_maxPerCall() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10 + 1, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectRevert(IOverflowTreasury.ChildExceedsParent.selector);
        treasury.createChild(c, sig);
    }

    function test_ChildExceedsParent_expiry() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry + 1);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectRevert(IOverflowTreasury.ChildExceedsParent.selector);
        treasury.createChild(c, sig);
    }

    /// A restricted parent's child may only list payees the parent allows.
    function test_ChildExceedsParent_restricted_parent_payee_subset() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        c.restricted = true;
        c.payees = new address[](1);
        c.payees[0] = payeeA;
        _createChild(rootPk, c);

        IOverflowTreasury.ChildParams memory g = _params(2, vm.addr(G1), U / 10, U / 20, rootExpiry);
        g.restricted = true;
        g.payees = new address[](2);
        g.payees[0] = payeeA;
        g.payees[1] = payeeB; // parent does not allow payeeB
        bytes memory sig = _signChild(C1, g);
        vm.expectRevert(IOverflowTreasury.ChildExceedsParent.selector);
        treasury.createChild(g, sig);

        // subset is fine
        g.payees = new address[](1);
        g.payees[0] = payeeA;
        _createChild(C1, g);
        assertTrue(treasury.nodeAllow(3, payeeA));
        assertFalse(treasury.nodeAllow(3, payeeB));
        _pay(G1, payeeA, U / 100);
        _expectPayRevert(G1, payeeB, U / 100, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 3));
    }

    function test_BadDelegation_replay() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        treasury.createChild(c, sig);
        assertTrue(treasury.usedDelegation(_childStructHash(c)));
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.createChild(c, sig);
    }

    function test_BadDelegation_expired_deadline() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.warp(c.deadline + 1);
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.createChild(c, sig);
    }

    function test_BadDelegation_wrong_signer() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        // sibling-level key (child 2) signs a delegation claiming parent = root
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C2), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(C1, c);
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.createChild(c, sig);
    }

    function test_BadDelegation_tampered_params() public {
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        c.cap = U / 2; // relayer bumps the cap
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.createChild(c, sig);
    }

    function test_BadDelegation_unknown_parent() public {
        IOverflowTreasury.ChildParams memory c = _params(7, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.createChild(c, sig);
    }

    function test_createChild_paused_parent_reverts() public {
        vm.prank(owner);
        treasury.pause(1);
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 1));
        treasury.createChild(c, sig);
    }

    function test_KeyInUse_child_reuse() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(C1), U / 4, U / 10, rootExpiry);
        bytes memory sig = _signChild(rootPk, c);
        vm.expectRevert(IOverflowTreasury.KeyInUse.selector);
        treasury.createChild(c, sig);
    }

    function test_KeyInUse_child_bad_keys() public {
        address[4] memory bad = [address(0), owner, address(treasury), rootKey];
        for (uint256 i; i < bad.length; ++i) {
            IOverflowTreasury.ChildParams memory c = _params(1, bad[i], U / 4, U / 10, rootExpiry);
            bytes memory sig = _signChild(rootPk, c);
            vm.expectRevert(IOverflowTreasury.KeyInUse.selector);
            treasury.createChild(c, sig);
        }
    }

    function test_KeyInUse_createRoot() public {
        address[4] memory bad = [address(0), owner, address(treasury), rootKey];
        for (uint256 i; i < bad.length; ++i) {
            vm.prank(owner);
            vm.expectRevert(IOverflowTreasury.KeyInUse.selector);
            treasury.createRoot(bad[i], U, U / 10, rootExpiry);
        }
    }

    // ============================================================ pauseChild

    /// Pausing a node by signed PauseChild blocks the node and its grandchildren; the root is unaffected.
    function test_pauseChild_by_strict_ancestor_blocks_subtree() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(C1, 2, G1, U / 10, U / 20);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _pauseSig(rootPk, 2, 1, deadline);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.NodePaused(2, rootKey);
        treasury.pauseChild(2, 1, deadline, sig);
        assertTrue(treasury.getNode(2).paused);
        _expectPayRevert(C1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 2));
        _expectPayRevert(G1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 2));
        _pay(rootPk, payeeA, 1); // root unaffected

        // replay
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.pauseChild(2, 1, deadline, sig);
    }

    function test_pauseChild_by_grandparent() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(C1, 2, G1, U / 10, U / 20);
        uint256 deadline = block.timestamp + 60;
        treasury.pauseChild(3, 5, deadline, _pauseSig(rootPk, 3, 5, deadline));
        _expectPayRevert(G1, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.Paused.selector, 3));
        _pay(C1, payeeA, 1);
    }

    function test_NotAncestor_sibling() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        _child(rootPk, 1, C2, U / 4, U / 10);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _pauseSig(C2, 2, 1, deadline);
        vm.expectRevert(IOverflowTreasury.NotAncestor.selector);
        treasury.pauseChild(2, 1, deadline, sig);
    }

    function test_NotAncestor_child_pausing_parent_and_self() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        uint256 deadline = block.timestamp + 60;
        bytes memory up = _pauseSig(C1, 1, 1, deadline);
        vm.expectRevert(IOverflowTreasury.NotAncestor.selector);
        treasury.pauseChild(1, 1, deadline, up);
        bytes memory self_ = _pauseSig(C1, 2, 2, deadline);
        vm.expectRevert(IOverflowTreasury.NotAncestor.selector);
        treasury.pauseChild(2, 2, deadline, self_);
    }

    function test_NotAncestor_unknown_signer_and_target() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _pauseSig(0xBAD, 2, 1, deadline);
        vm.expectRevert(IOverflowTreasury.NotAncestor.selector);
        treasury.pauseChild(2, 1, deadline, sig);
        sig = _pauseSig(rootPk, 42, 1, deadline);
        vm.expectRevert(IOverflowTreasury.NotAncestor.selector);
        treasury.pauseChild(42, 1, deadline, sig);
    }

    function test_pauseChild_expired_deadline() public {
        _child(rootPk, 1, C1, U / 4, U / 10);
        uint256 deadline = block.timestamp + 60;
        bytes memory sig = _pauseSig(rootPk, 2, 1, deadline);
        vm.warp(deadline + 1);
        vm.expectRevert(IOverflowTreasury.BadDelegation.selector);
        treasury.pauseChild(2, 1, deadline, sig);
    }

    // ============================================================ owner-only

    function test_NotOwner_all_owner_functions() public {
        vm.startPrank(attacker);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.createRoot(attacker, U, U, rootExpiry);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.pause(1);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.unpause(1);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.raiseCap(1, 10 * U);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.setAllow(attacker, true);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.setFloor(0);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.withdraw(attacker, 1);
        vm.stopPrank();
        // a node key is not the owner either
        vm.prank(rootKey);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.unpause(1);
    }

    function test_owner_setAllow_event_and_withdraw() public {
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.AllowSet(payeeA, false);
        vm.prank(owner);
        treasury.setAllow(payeeA, false);
        assertFalse(treasury.allowlist(payeeA));
        _expectPayRevert(rootPk, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0));

        vm.prank(owner);
        treasury.withdraw(owner, 2 * U);
        assertEq(usdc.balanceOf(owner), 2 * U);
        assertEq(usdc.balanceOf(address(treasury)), 3 * U);
    }

    function test_owner_ops_unknown_node_revert() public {
        vm.startPrank(owner);
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.UnknownAgent.selector, address(0)));
        treasury.pause(9);
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.UnknownAgent.selector, address(0)));
        treasury.raiseCap(0, U);
        vm.stopPrank();
    }
}

/// SIMULATED stand-in token (test only): probes the treasury's ERC-1271 answers during settle().
contract ProbeToken {
    bytes4 public rightDigest;
    bytes4 public wrongDigest;
    bytes4 public thirdParty;
    Caller immutable caller = new Caller();

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return keccak256("probe-domain");
    }

    function balanceOf(address) external pure returns (uint256) {
        return type(uint128).max;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata sig
    ) external {
        bytes32 sh = keccak256(
            abi.encode(
                0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 d = keccak256(abi.encodePacked("\x19\x01", keccak256("probe-domain"), sh));
        rightDigest = OverflowTreasury(from).isValidSignature(d, sig);
        wrongDigest = OverflowTreasury(from).isValidSignature(keccak256(abi.encode(d)), sig);
        thirdParty = caller.ask(from, d);
    }
}

contract Caller {
    function ask(address t, bytes32 d) external view returns (bytes4) {
        return OverflowTreasury(t).isValidSignature(d, "");
    }
}
