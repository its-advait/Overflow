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

    // ------------------------------------------------------------ late arrivals after the order closed

    /// The treasury approved a reservation while the order was open; the facilitator executes it only after the
    /// escrow settled through a second payment. settle() refuses the closed escrow (EscrowClosed) but USDC still
    /// honours the reserved authorization, so the USDC lands in the closed escrow. sweep() returns exactly that
    /// amount to the treasury: the seller keeps only the original payout, the caller gets nothing, the agent's
    /// allowance stays charged, and neither a replay nor a repeat sweep moves anything.
    function test_lateReservation_afterSettled_sweptToTreasury() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _escrow();
        uint256 treasuryStart = _bal(address(treasury));
        Auth memory late = _auth(rootPk, address(e), AMOUNT);
        bytes32 digest = _reserve(late); // approved and charged now, executed later
        _pay(rootPk, address(e), AMOUNT); // a second authorization funds the order through settle()
        _payBond(e, t);
        e.markFunded();
        _reveal(e);
        e.accept(_acceptSig(rootPk, e));
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled));
        assertEq(_bal(seller), AMOUNT + BOND);
        assertEq(_bal(address(e)), 0);
        assertEq(treasury.getNode(1).spent, 2 * AMOUNT, "both authorizations charged");

        // a tampered copy of the authorization is not a reservation: USDC rejects it (checked before the nonce is spent)
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(
            address(treasury), late.to, late.value + 1, late.validAfter, late.validBefore, late.nonce, late.sig
        );

        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.EscrowClosed.selector, address(e)));
        _settle(late); // the treasury refuses the closed escrow ...
        _directToUsdc(facilitator, late); // ... but USDC executes the reserved EIP-3009 authorization
        assertEq(_bal(address(e)), AMOUNT, "late arrival stranded in the closed escrow");
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled), "still settled");

        // the seller relays the sweep and gains nothing: the recipient is the buyer, fixed at creation
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.Swept(address(treasury), AMOUNT);
        vm.prank(seller);
        uint256 swept = e.sweep();
        assertEq(swept, AMOUNT);
        assertEq(_bal(address(e)), 0);
        assertEq(_bal(seller), AMOUNT + BOND, "seller keeps only the original payout");
        assertEq(_bal(address(treasury)), treasuryStart - AMOUNT, "one price paid, the late one back");
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled));
        assertEq(treasury.getNode(1).spent, 2 * AMOUNT, "sweep restores USDC, never allowance");

        vm.expectRevert(IOverflowEscrow.NothingToSweep.selector);
        e.sweep(); // nothing left: a repeat cannot pay twice
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        usdc.transferWithAuthorization(
            address(treasury), late.to, late.value, late.validAfter, late.validBefore, late.nonce, late.sig
        );
        vm.warp(late.validBefore);
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, 2 * AMOUNT, "consumed nonce: release refunds no allowance");
        assertEq(treasury.reservedTotal(), 0);
    }

    /// Reserved while open, refunded on the seller's missed reveal, executed afterwards: a stranger sweeps the
    /// exact late amount back to the treasury and the order stays closed.
    function test_lateReservation_afterTimeoutRefund_sweptToTreasury() public {
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
        IOverflowEscrow.OrderTerms memory t = _terms(AMOUNT, BOND, 4);
        t.revealDeadline = uint64(block.timestamp + 5 minutes); // inside the 600 s reservation window
        t.termsHash = factory.termsHashOf(t);
        OverflowEscrow e = _create(t);
        uint256 treasuryStart = _bal(address(treasury));
        Auth memory late = _authWindow(rootPk, address(e), AMOUNT, block.timestamp + 9 minutes);
        bytes32 digest = _reserve(late);

        vm.warp(t.revealDeadline); // nobody funded, the seller never revealed
        e.claimTimeoutRefund();
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertEq(_bal(address(e)), 0);

        _directToUsdc(facilitator, late); // executed after the refund, still before validBefore
        assertEq(_bal(address(e)), AMOUNT);
        assertEq(_bal(address(treasury)), treasuryStart - AMOUNT);

        vm.prank(attacker);
        assertEq(e.sweep(), AMOUNT);
        assertEq(_bal(attacker), 0, "the caller gets nothing");
        assertEq(_bal(seller), 0, "the seller gets nothing");
        assertEq(_bal(address(treasury)), treasuryStart, "exact late amount back");
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Refunded));
        e.markFunded(); // not revived
        vm.warp(late.validBefore);
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, AMOUNT, "the money moved: allowance stays charged");
    }

    /// USDC refuses the transfer to the buyer (paused, or the treasury blacklisted): sweep reverts with USDC's
    /// reason, the terminal status and the balance are untouched, and the funds are recovered once USDC allows it.
    function test_lateReservation_rejectedTransfer_staysRecoverable() public {
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
        IOverflowEscrow.OrderTerms memory t = _terms(AMOUNT, 0, 4);
        t.revealDeadline = uint64(block.timestamp + 5 minutes);
        t.termsHash = factory.termsHashOf(t);
        OverflowEscrow e = _create(t);
        Auth memory late = _authWindow(rootPk, address(e), AMOUNT, block.timestamp + 9 minutes);
        _reserve(late);
        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund();
        _directToUsdc(facilitator, late);
        assertEq(_bal(address(e)), AMOUNT);

        vm.prank(usdcOwner);
        usdc.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        e.sweep();
        vm.prank(usdcOwner);
        usdc.unpause();

        vm.prank(usdcOwner);
        usdc.blacklist(address(treasury));
        vm.expectRevert(bytes("Blacklistable: account is blacklisted"));
        e.sweep();
        assertEq(_bal(address(e)), AMOUNT, "nothing moved");
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded), "nothing changed");

        vm.prank(usdcOwner);
        usdc.unBlacklist(address(treasury));
        uint256 before = _bal(address(treasury));
        assertEq(e.sweep(), AMOUNT);
        assertEq(_bal(address(treasury)), before + AMOUNT);
        assertEq(_bal(address(e)), 0);
    }
}
