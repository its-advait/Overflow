// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBaseTest} from "../escrow/EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";

/// reserve()/release(): a third-party facilitator submits the agent's authorization straight to USDC after the
/// treasury has checked and charged it (docs/SPEC.md "reserve() and release()"). Real USDC v2.2.
contract ReservationsTest is EscrowBaseTest {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;
    address facilitator = makeAddr("coinbaseFacilitator");

    function _authWindow(uint256 pk, address to, uint256 value, uint256 validBefore) internal returns (Auth memory a) {
        a = _auth(pk, to, value);
        a.validBefore = validBefore;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, _twaDigest(address(treasury), a));
        a.sig = abi.encodePacked(r, s, v);
    }

    function _reserve(Auth memory a) internal returns (bytes32) {
        return treasury.reserve(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
    }

    function _expectReserveRevert(Auth memory a, bytes memory err) internal {
        vm.expectRevert(err);
        _reserve(a);
    }

    function _isValid(bytes32 digest, bytes memory sig, address caller) internal returns (bytes4) {
        vm.prank(caller);
        return treasury.isValidSignature(digest, sig);
    }

    // ------------------------------------------------------------ core flow

    function test_reserve_thenThirdPartySubmitsToUsdc() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        bytes32 expectedDigest = _twaDigest(address(treasury), a);
        vm.expectEmit(true, true, true, true, address(treasury));
        emit IOverflowTreasury.Reserved(expectedDigest, 1, payeeA, U / 20, a.validBefore, a.nonce);
        vm.prank(facilitator); // anyone may reserve; the signature is the agent's
        bytes32 digest = _reserve(a);
        assertEq(digest, expectedDigest);

        assertEq(treasury.getNode(1).spent, U / 20, "charged at reserve time");
        assertEq(treasury.reservedTotal(), U / 20);
        IOverflowTreasury.Reservation memory r = treasury.getReservation(digest);
        assertEq(r.nodeId, 1);
        assertEq(r.value, U / 20);
        assertEq(r.validBefore, a.validBefore);
        assertEq(r.nonce, a.nonce);
        assertEq(_isValid(digest, a.sig, address(usdc)), MAGIC, "live reservation valid for USDC");
        assertEq(_isValid(digest, a.sig, facilitator), INVALID, "only for USDC");

        uint256 before = _bal(address(treasury));
        _directToUsdc(facilitator, a); // straight to USDC, no settle()
        assertEq(_bal(payeeA), U / 20);
        assertEq(_bal(address(treasury)), before - U / 20);
        assertTrue(usdc.authorizationState(address(treasury), a.nonce));

        // replay of the same authorization is refused by USDC's own nonce
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.transferWithAuthorization(address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
    }

    function test_withoutReserve_directSubmissionFails() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
        assertEq(_bal(payeeA), 0);
        assertEq(treasury.getNode(1).spent, 0);

        _reserve(a);
        _directToUsdc(facilitator, a); // same signature now settles
        assertEq(_bal(payeeA), U / 20);
    }

    function test_usedReservation_releasesWithoutRefund() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        bytes32 digest = _reserve(a);
        _directToUsdc(facilitator, a);
        vm.warp(a.validBefore);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.ReservationReleased(digest, false);
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, U / 20, "money moved: allowance stays charged");
        assertEq(treasury.reservedTotal(), 0);
        assertEq(treasury.getReservation(digest).validBefore, 0, "deleted");
    }

    function test_expiredReservation_cannotBeUsed_andReleaseRefunds() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        bytes32 digest = _reserve(a);
        vm.warp(a.validBefore); // USDC requires block.timestamp < validBefore
        assertEq(_isValid(digest, a.sig, address(usdc)), INVALID, "gate closed at validBefore");
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is expired"));
        usdc.transferWithAuthorization(address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.ReservationReleased(digest, true);
        vm.prank(facilitator);
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, 0, "budget restored");
        assertEq(treasury.remaining(1), U);
        assertEq(treasury.reservedTotal(), 0);
        assertEq(_bal(payeeA), 0);
    }

    function test_release_refundsWholeAncestorChain() public {
        uint256 C1 = 0xC1;
        uint256 G1 = 0x61;
        uint256 childId = _child(rootPk, 1, C1, U / 4, U / 10);
        uint256 grandId = _child(C1, childId, G1, U / 10, U / 20);
        Auth memory a = _auth(G1, payeeA, U / 20);
        bytes32 digest = _reserve(a);
        assertEq(treasury.getNode(grandId).spent, U / 20);
        assertEq(treasury.getNode(childId).spent, U / 20);
        assertEq(treasury.getNode(1).spent, U / 20);
        vm.warp(a.validBefore);
        treasury.release(digest);
        assertEq(treasury.getNode(grandId).spent, 0);
        assertEq(treasury.getNode(childId).spent, 0);
        assertEq(treasury.getNode(1).spent, 0);
    }

    // ------------------------------------------------------------ guards

    function test_release_beforeValidBeforeReverts_andUnknownReverts() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        bytes32 digest = _reserve(a);
        vm.warp(a.validBefore - 1);
        vm.expectRevert(IOverflowTreasury.ReservationLive.selector);
        treasury.release(digest);
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.release(keccak256("nothing"));
        vm.warp(a.validBefore);
        treasury.release(digest);
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.release(digest); // no double release / double refund
    }

    function test_reserve_duplicateReverts() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        _reserve(a);
        _expectReserveRevert(a, abi.encodeWithSelector(IOverflowTreasury.ReservationActive.selector));
        assertEq(treasury.getNode(1).spent, U / 20, "charged once");
        // and settle() of a reserved digest cannot double-charge either: USDC consumes the nonce once
        _settle(a);
        assertEq(_bal(payeeA), U / 20);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        _settle(a);
    }

    function test_reserve_tooLongReverts_ownerCanWiden() public {
        Auth memory a = _authWindow(rootPk, payeeA, U / 20, block.timestamp + 601);
        _expectReserveRevert(a, abi.encodeWithSelector(IOverflowTreasury.ReservationTooLong.selector));
        Auth memory ok = _authWindow(rootPk, payeeA, U / 20, block.timestamp + 600);
        _reserve(ok);

        vm.prank(attacker);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.setReservationWindow(1200);
        vm.expectEmit(false, false, false, true, address(treasury));
        emit IOverflowTreasury.ReservationWindowSet(1200);
        vm.prank(owner);
        treasury.setReservationWindow(1200);
        assertEq(treasury.reservationWindow(), 1200);
        _reserve(_authWindow(rootPk, payeeA, U / 20, block.timestamp + 601));
    }

    function test_reserve_runsEveryPolicyCheck() public {
        _expectReserveRevert(
            _auth(rootPk, attacker, U / 20), abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0)
        );
        _expectReserveRevert(
            _auth(0xBAD, payeeA, U / 20),
            abi.encodeWithSelector(IOverflowTreasury.UnknownAgent.selector, vm.addr(0xBAD))
        );
        _expectReserveRevert(
            _auth(rootPk, payeeA, U / 10 + 1), abi.encodeWithSelector(IOverflowTreasury.OverPerCall.selector, 1)
        );
        uint256 C1 = 0xC1;
        uint256 childId = _child(rootPk, 1, C1, U / 10, U / 10);
        _reserve(_auth(C1, payeeA, U / 10));
        _expectReserveRevert(
            _auth(C1, payeeA, U / 10), abi.encodeWithSelector(IOverflowTreasury.OverBudget.selector, childId)
        );
        assertEq(treasury.remaining(childId), 0, "reservation consumed the child's allowance");
        vm.prank(owner);
        treasury.pause(childId);
        _expectReserveRevert(_auth(C1, payeeA, 1), abi.encodeWithSelector(IOverflowTreasury.Paused.selector, childId));
    }

    function test_floorCountsReservedTotal() public {
        // balance 5 USDC, floor 4.85: one 0.1 reservation fits, a second payment of any kind does not
        vm.prank(owner);
        treasury.setFloor(485 * U / 100);
        Auth memory first = _auth(rootPk, payeeA, U / 10);
        _reserve(first);
        _expectReserveRevert(
            _auth(rootPk, payeeA, U / 10), abi.encodeWithSelector(IOverflowTreasury.BelowFloor.selector)
        );
        _expectPayRevert(rootPk, payeeB, U / 10, abi.encodeWithSelector(IOverflowTreasury.BelowFloor.selector));
        // once the unused reservation is released the room comes back
        vm.warp(first.validBefore);
        treasury.release(_twaDigest(address(treasury), first));
        _pay(rootPk, payeeB, U / 10);
        assertEq(_bal(payeeB), U / 10);
    }

    function test_isValidSignature_reservationBranch_isViewAndTokenOnly() public {
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        bytes32 digest = _twaDigest(address(treasury), a);
        assertEq(_isValid(digest, a.sig, address(usdc)), INVALID, "nothing reserved yet");
        _reserve(a);
        assertEq(_isValid(digest, a.sig, address(usdc)), MAGIC);
        assertEq(_isValid(digest, a.sig, attacker), INVALID);
        assertEq(_isValid(keccak256("other digest"), a.sig, address(usdc)), INVALID, "exact digest only");
    }

    // ------------------------------------------------------------ escrow integration (P1.5 x P1.6)

    function _escrow() internal returns (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) {
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
        t = _terms(AMOUNT, BOND, 4);
        e = _create(t);
    }

    /// Coinbase's facilitator funds the escrow with the agent's authorization; the seller delivers; a node accepts.
    function test_reserve_fundsEscrow_viaFacilitator_thenAccept() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _escrow();
        Auth memory a = _auth(rootPk, address(e), AMOUNT); // `to` = escrow binds order, amount, seller, terms
        bytes32 digest = _reserve(a);
        assertEq(treasury.getNode(1).spent, AMOUNT);

        _directToUsdc(facilitator, a);
        assertEq(_bal(address(e)), AMOUNT);
        _payBond(e, t);
        e.markFunded();
        _reveal(e);
        e.accept(_acceptSig(rootPk, e));
        assertEq(_bal(seller), AMOUNT + BOND);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled));

        vm.warp(a.validBefore);
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, AMOUNT, "paid: allowance stays charged");
        assertEq(treasury.reservedTotal(), 0);
    }

    function test_reserve_escrowWrongAmountReverts() public {
        (OverflowEscrow e,) = _escrow();
        _expectReserveRevert(
            _auth(rootPk, address(e), AMOUNT - 1),
            abi.encodeWithSelector(IOverflowTreasury.EscrowAmountMismatch.selector, address(e), AMOUNT, AMOUNT - 1)
        );
        // a different buyer's escrow is not a payee for this treasury
        IOverflowEscrow.OrderTerms memory x = _terms(AMOUNT, 0, 2);
        x.buyer = attacker;
        x.orderId = keccak256("other buyer");
        OverflowEscrow other = _create(x);
        _expectReserveRevert(
            _auth(rootPk, address(other), AMOUNT), abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0)
        );
    }

    /// Funded through a reservation, the seller never reveals: the timeout refund restores the treasury's USDC
    /// but not the agent's allowance; the used reservation releases without a refund.
    function test_reserve_fundsEscrow_sellerSilent_timeoutRefund() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _escrow();
        uint256 before = _bal(address(treasury));
        Auth memory a = _auth(rootPk, address(e), AMOUNT);
        bytes32 digest = _reserve(a);
        _directToUsdc(facilitator, a);
        _payBond(e, t);
        e.markFunded();

        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund();
        assertEq(_bal(address(treasury)), before + BOND, "price back plus the seller's bond");
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));

        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, AMOUNT, "refund restores USDC, not allowance");
        assertEq(treasury.reservedTotal(), 0);
    }

    /// The facilitator never submits: the escrow is never funded, release() gives the agent its budget back,
    /// and the empty escrow can still be closed by the timeout path.
    function test_reserve_fundingNeverHappens_releaseRestoresBudget() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _escrow();
        Auth memory a = _auth(rootPk, address(e), AMOUNT);
        bytes32 digest = _reserve(a);
        assertEq(treasury.remaining(1), U - AMOUNT);

        vm.warp(a.validBefore);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.Underfunded.selector, 0, AMOUNT + BOND));
        e.markFunded();
        treasury.release(digest);
        assertEq(treasury.remaining(1), U, "budget restored");
        assertEq(treasury.getReservation(digest).validBefore, 0);

        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund();
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertEq(_bal(address(e)), 0);
    }

    /// A reservation for one escrow cannot fund another: USDC checks `to` inside the signed digest.
    function test_reserve_boundToEscrowAddress() public {
        (OverflowEscrow e,) = _escrow();
        IOverflowEscrow.OrderTerms memory x = _terms(AMOUNT, BOND, 2);
        x.orderId = keccak256("second order");
        OverflowEscrow e2 = _create(x);
        Auth memory a = _auth(rootPk, address(e), AMOUNT);
        _reserve(a);
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(
            address(treasury), address(e2), a.value, a.validAfter, a.validBefore, a.nonce, a.sig
        );
        assertEq(_bal(address(e2)), 0);
    }
}
