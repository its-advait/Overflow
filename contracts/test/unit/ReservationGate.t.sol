// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBaseTest} from "../escrow/EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {UsdcV22} from "../usdc/UsdcV22.sol";

/// T18: a reservation to a factory escrow stops being valid the moment the order closes. USDC asks the treasury
/// (ERC-1271) at execution time, the treasury reads the escrow's status, and USDC reverts "invalid signature"
/// with the nonce untouched. releaseClosed() then returns the agent's allowance without waiting for validBefore.
/// Real USDC v2.2 throughout; sweep() stays as defense in depth for USDC that arrives from anywhere else.
contract ReservationGateTest is EscrowBaseTest {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;
    address facilitator = makeAddr("coinbaseFacilitator");

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
    }

    function _reserve(Auth memory a) internal returns (bytes32) {
        vm.prank(facilitator);
        return treasury.reserve(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
    }

    function _gate(bytes32 digest, address caller) internal returns (bytes4) {
        vm.prank(caller);
        return treasury.isValidSignature(digest, "");
    }

    function _expectDirectRevert(Auth memory a, string memory reason) internal {
        vm.prank(facilitator);
        vm.expectRevert(bytes(reason));
        usdc.transferWithAuthorization(address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
    }

    function _order(uint32 n, bytes32 salt) internal returns (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) {
        t = _terms(AMOUNT, BOND, n);
        t.orderId = keccak256(abi.encode("gate order", salt));
        t.revealDeadline = uint64(block.timestamp + 5 minutes); // inside the 600 s reservation window
        t.termsHash = factory.termsHashOf(t);
        e = _create(t);
    }

    function _nineMinutes(address to) internal returns (Auth memory a) {
        a = _auth(rootPk, to, AMOUNT);
        a.validBefore = block.timestamp + 9 minutes;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(rootPk, _twaDigest(address(treasury), a));
        a.sig = abi.encodePacked(r, s, v);
    }

    function _settleOrder(OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) internal {
        _payBond(e, t);
        e.markFunded();
        _reveal(e);
        e.accept(_acceptSig(rootPk, e));
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled));
    }

    // ------------------------------------------------------------ closed order: USDC itself refuses

    /// Reserved while open, the order settles through a second authorization, then the facilitator submits the
    /// reserved one: USDC reverts, no USDC moves, the nonce stays unused, and releaseClosed() refunds the charge.
    function test_afterSettled_usdcRejectsReservedAuthorization_releaseClosedRefunds() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(4, "settled");
        uint256 treasuryStart = _bal(address(treasury));
        Auth memory late = _nineMinutes(address(e));
        bytes32 digest = _reserve(late);
        assertEq(_gate(digest, address(usdc)), MAGIC, "open order: live");
        _pay(rootPk, address(e), AMOUNT); // funds the order through settle()
        _settleOrder(e, t);
        assertEq(treasury.getNode(1).spent, 2 * AMOUNT, "both authorizations charged so far");

        assertEq(_gate(digest, address(usdc)), INVALID, "closed order: gate shut although validBefore is ahead");
        assertEq(_gate(digest, facilitator), INVALID);
        _expectDirectRevert(late, "FiatTokenV2: invalid signature");
        assertFalse(usdc.authorizationState(address(treasury), late.nonce), "nonce unused");
        assertEq(_bal(address(e)), 0, "nothing stranded");
        assertEq(_bal(address(treasury)), treasuryStart - AMOUNT, "one price paid");
        assertEq(_bal(seller), AMOUNT + BOND);

        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.EscrowClosed.selector, address(e)));
        treasury.settle(late.to, late.value, late.validAfter, late.validBefore, late.nonce, late.sig);

        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.ReservationReleased(digest, true);
        vm.prank(attacker); // anyone
        treasury.releaseClosed(digest);
        assertEq(treasury.getNode(1).spent, AMOUNT, "the unexecuted reservation's charge is back");
        assertEq(treasury.remaining(1), U - AMOUNT);
        assertEq(treasury.reservedTotal(), 0);
        assertEq(treasury.getReservation(digest).validBefore, 0, "deleted");

        // exactly once: neither path can release or refund it again
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.releaseClosed(digest);
        vm.warp(late.validBefore);
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, AMOUNT);
        vm.expectRevert(IOverflowEscrow.NothingToSweep.selector);
        e.sweep();
    }

    function test_afterTimeoutRefund_usdcRejectsReservedAuthorization_releaseClosedRefunds() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(4, "refunded");
        uint256 treasuryStart = _bal(address(treasury));
        Auth memory late = _nineMinutes(address(e));
        bytes32 digest = _reserve(late);
        vm.warp(t.revealDeadline); // nobody funded, the seller never revealed
        e.claimTimeoutRefund();
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertLt(block.timestamp, late.validBefore, "the reservation itself is still inside its window");

        assertEq(_gate(digest, address(usdc)), INVALID);
        _expectDirectRevert(late, "FiatTokenV2: invalid signature");
        assertFalse(usdc.authorizationState(address(treasury), late.nonce));
        assertEq(_bal(address(e)), 0);
        assertEq(_bal(address(treasury)), treasuryStart);

        treasury.releaseClosed(digest);
        assertEq(treasury.getNode(1).spent, 0, "budget restored before validBefore");
        assertEq(treasury.reservedTotal(), 0);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Refunded));
        e.markFunded(); // not revived
    }

    // ------------------------------------------------------------ ordering, race and replay

    /// Two reservations for one order. The first executes while the order is open (legitimate), the order closes
    /// in the same block, and the second is refused in that same block. Used nonce: release() without refund;
    /// unused nonce: releaseClosed() with refund. Replay of the executed one is refused by USDC's nonce.
    function test_sameBlock_executeThenClose_ok_closeThenExecute_rejected() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(4, "race");
        Auth memory first = _nineMinutes(address(e));
        Auth memory second = _nineMinutes(address(e));
        bytes32 d1 = _reserve(first);
        bytes32 d2 = _reserve(second);
        assertEq(treasury.getNode(1).spent, 2 * AMOUNT);

        _directToUsdc(facilitator, first); // legitimate: the order is open
        assertEq(_bal(address(e)), AMOUNT);
        _settleOrder(e, t); // closes in the same block
        assertEq(_bal(seller), AMOUNT + BOND);

        _expectDirectRevert(second, "FiatTokenV2: invalid signature"); // same block, after closure
        assertEq(_bal(address(e)), 0);
        _expectDirectRevert(first, "FiatTokenV2: authorization is used or canceled"); // replay
        assertTrue(usdc.authorizationState(address(treasury), first.nonce));
        assertFalse(usdc.authorizationState(address(treasury), second.nonce));

        vm.expectRevert(IOverflowTreasury.AuthorizationUsed.selector);
        treasury.releaseClosed(d1); // the money moved: no early refund
        treasury.releaseClosed(d2);
        assertEq(treasury.getNode(1).spent, AMOUNT, "only the executed payment stays charged");
        assertEq(treasury.reservedTotal(), AMOUNT, "the executed reservation is still booked until release()");

        vm.warp(first.validBefore);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.ReservationReleased(d1, false);
        treasury.release(d1);
        assertEq(treasury.getNode(1).spent, AMOUNT);
        assertEq(treasury.reservedTotal(), 0);
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.release(d2);
    }

    /// The gate follows the order through every open status and shuts at the terminal one; it never opens for
    /// anyone but USDC.
    function test_gateTracksEscrowStatus_andStaysTokenOnly() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(4, "status walk");
        Auth memory a = _nineMinutes(address(e));
        bytes32 digest = _reserve(a);
        assertEq(_gate(digest, address(usdc)), MAGIC, "Created");
        _pay(rootPk, address(e), AMOUNT);
        _payBond(e, t);
        e.markFunded();
        assertEq(_gate(digest, address(usdc)), MAGIC, "Funded");
        _reveal(e);
        assertEq(_gate(digest, address(usdc)), MAGIC, "Revealed");
        assertEq(_gate(digest, attacker), INVALID, "never for a non-token caller");
        e.accept(_acceptSig(rootPk, e));
        assertEq(_gate(digest, address(usdc)), INVALID, "Settled");
        assertEq(_gate(keccak256("other"), address(usdc)), INVALID, "unknown digest");
    }

    // ------------------------------------------------------------ expiry

    function test_expiredReservationToOpenEscrow_usdcRejects_releaseRefunds_releaseClosedRefuses() public {
        (OverflowEscrow e,) = _order(4, "expiry");
        Auth memory a = _nineMinutes(address(e));
        bytes32 digest = _reserve(a);
        vm.warp(a.validBefore);
        assertEq(_gate(digest, address(usdc)), INVALID, "expired");
        _expectDirectRevert(a, "FiatTokenV2: authorization is expired");
        assertFalse(usdc.authorizationState(address(treasury), a.nonce));
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.EscrowStillOpen.selector, address(e)));
        treasury.releaseClosed(digest); // the order is open: only the ordinary release applies
        treasury.release(digest);
        assertEq(treasury.getNode(1).spent, 0);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Created), "order untouched");
    }

    // ------------------------------------------------------------ releaseClosed guards

    function test_releaseClosed_guards() public {
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.releaseClosed(keccak256("nothing"));

        // a direct payee has no order that could close
        Auth memory direct = _auth(rootPk, payeeA, U / 20);
        bytes32 dd = _reserve(direct);
        vm.expectRevert(IOverflowTreasury.NotEscrowReservation.selector);
        treasury.releaseClosed(dd);
        assertEq(treasury.getReservation(dd).to, payeeA);
        assertFalse(treasury.getReservation(dd).toIsEscrow);

        // an open order in every non-terminal status
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(4, "guards");
        Auth memory a = _nineMinutes(address(e));
        bytes32 digest = _reserve(a);
        assertTrue(treasury.getReservation(digest).toIsEscrow);
        bytes memory open = abi.encodeWithSelector(IOverflowTreasury.EscrowStillOpen.selector, address(e));
        vm.expectRevert(open);
        treasury.releaseClosed(digest);
        _pay(rootPk, address(e), AMOUNT);
        _payBond(e, t);
        e.markFunded();
        vm.expectRevert(open);
        treasury.releaseClosed(digest);
        _reveal(e);
        vm.expectRevert(open);
        treasury.releaseClosed(digest);
        e.accept(_acceptSig(rootPk, e));
        treasury.releaseClosed(digest); // closed now
        assertEq(treasury.getNode(1).spent, AMOUNT + U / 20, "only the settle and the direct reservation remain");
    }

    /// The floor counts live reservations; releaseClosed() frees that room immediately.
    function test_releaseClosed_freesFloorRoom() public {
        (OverflowEscrow e,) = _order(4, "floor");
        uint256 newFloor = _bal(address(treasury)) - AMOUNT; // room for exactly one payment
        vm.prank(owner);
        treasury.setFloor(newFloor);
        Auth memory a = _nineMinutes(address(e));
        bytes32 digest = _reserve(a);
        _expectPayRevert(rootPk, payeeA, 1, abi.encodeWithSelector(IOverflowTreasury.BelowFloor.selector));
        vm.warp(e.terms().revealDeadline);
        e.claimTimeoutRefund();
        treasury.releaseClosed(digest);
        _pay(rootPk, payeeA, AMOUNT);
        assertEq(_bal(payeeA), AMOUNT);
    }

    // ------------------------------------------------------------ defense in depth

    /// With the treasury path shut, USDC can still reach a closed escrow from outside (anyone's plain transfer):
    /// sweep() returns it to the buyer treasury, even if USDC rejects the first attempt.
    function test_sweep_recoversExternalArrival_afterUsdcRejectsOnce() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(4, "external");
        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund();
        UsdcV22.mint(usdc, usdcOwner, attacker, AMOUNT);
        vm.prank(attacker);
        usdc.transfer(address(e), AMOUNT); // external late arrival (not a treasury authorization)
        vm.prank(usdcOwner);
        usdc.pause();
        vm.expectRevert(bytes("Pausable: paused"));
        e.sweep();
        vm.prank(usdcOwner);
        usdc.unpause();
        uint256 before = _bal(address(treasury));
        assertEq(e.sweep(), AMOUNT);
        assertEq(_bal(address(treasury)), before + AMOUNT);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
    }
}
