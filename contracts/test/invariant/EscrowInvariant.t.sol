// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {EscrowBaseTest} from "../escrow/EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IUSDC, UsdcV22} from "../usdc/UsdcV22.sol";

/// Drives one escrow through every public action in random order; reverts are swallowed.
contract EscrowHandler is Test {
    IUSDC immutable usdc;
    address immutable usdcOwner;
    OverflowEscrow immutable e;
    address immutable seller;
    uint256 immutable rootPk;
    bytes32 immutable key;

    uint256 public minted; // total USDC ever sent to the escrow
    uint256 public late; // arrived after the terminal state and not yet swept
    uint256 public terminalTransitions;
    IOverflowEscrow.Status public lastStatus;

    constructor(
        IUSDC usdc_,
        address usdcOwner_,
        OverflowEscrow e_,
        address seller_,
        uint256 rootPk_,
        bytes32 key_,
        uint256 minted_
    ) {
        usdc = usdc_;
        usdcOwner = usdcOwner_;
        e = e_;
        seller = seller_;
        rootPk = rootPk_;
        key = key_;
        minted = minted_;
        lastStatus = e_.status();
    }

    function _terminal(IOverflowEscrow.Status s) internal pure returns (bool) {
        return s == IOverflowEscrow.Status.Settled || s == IOverflowEscrow.Status.Refunded;
    }

    function _track() internal {
        IOverflowEscrow.Status s = e.status();
        if (s != lastStatus) {
            if (_terminal(s)) terminalTransitions++;
            lastStatus = s;
        }
    }

    function markFunded() external {
        try e.markFunded() {} catch {}
        _track();
    }

    function reveal(bool correct) external {
        vm.prank(seller);
        try e.revealKey(correct ? key : keccak256("wrong")) {} catch {}
        _track();
    }

    function accept(bool asNode) external {
        uint256 pk = asNode ? rootPk : uint256(0xBAD);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.acceptDigest());
        try e.accept(abi.encodePacked(r, s, v)) {} catch {}
        _track();
    }

    function finalize() external {
        try e.finalizePayout() {} catch {}
        _track();
    }

    function timeoutRefund() external {
        try e.claimTimeoutRefund() {} catch {}
        _track();
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 3 hours));
    }

    /// Extra USDC while the order is live: surplus that the payout or refund returns to the buyer.
    function topUp(uint256 amt) external {
        if (_terminal(e.status())) return;
        amt = bound(amt, 1, 1e6);
        UsdcV22.mint(usdc, usdcOwner, address(e), amt);
        minted += amt;
    }

    /// USDC arriving after the terminal state (stands in for a reservation USDC executes late): only sweep() may
    /// move it, and only to the buyer.
    function lateArrival(uint256 amt) external {
        if (!_terminal(e.status())) return;
        amt = bound(amt, 1, 1e6);
        UsdcV22.mint(usdc, usdcOwner, address(e), amt);
        minted += amt;
        late += amt;
    }

    function sweep() external {
        try e.sweep() returns (uint256 s) {
            late -= s;
        } catch {}
        _track();
    }
}

contract EscrowInvariantTest is EscrowBaseTest {
    EscrowHandler handler;
    OverflowEscrow e;
    uint256 treasuryStart;
    uint256 sellerStart;

    function setUp() public override {
        super.setUp();
        IOverflowEscrow.OrderTerms memory t = _terms(AMOUNT, BOND, 4);
        e = _create(t);
        // price + bond minted to the escrow so markFunded can succeed; everything else is up to the handler
        UsdcV22.mint(usdc, usdcOwner, address(e), AMOUNT + BOND);
        treasuryStart = _bal(address(treasury));
        sellerStart = _bal(seller);
        handler = new EscrowHandler(usdc, usdcOwner, e, seller, rootPk, KEY, AMOUNT + BOND);
        targetContract(address(handler));
    }

    function _terminal(IOverflowEscrow.Status s) internal pure returns (bool) {
        return s == IOverflowEscrow.Status.Settled || s == IOverflowEscrow.Status.Refunded;
    }

    /// At most one terminal transition ever, and a terminal status never changes.
    function invariant_atMostOneTerminalState() public view {
        assertLe(handler.terminalTransitions(), 1);
        if (_terminal(handler.lastStatus())) assertEq(uint256(e.status()), uint256(handler.lastStatus()));
    }

    /// Once settled or refunded the escrow holds only what arrived afterwards and has not been swept yet; a sweep
    /// takes all of it, so the balance is zero whenever nothing is pending.
    function invariant_zeroBalanceAfterTerminal() public view {
        if (_terminal(e.status())) assertEq(_bal(address(e)), handler.late());
        else assertEq(handler.late(), 0);
    }

    /// Funds only ever move to the seller or the buyer (treasury): nothing leaks anywhere else.
    function invariant_fundsOnlyToSellerOrBuyer() public view {
        uint256 held = _bal(address(e)) + (_bal(seller) - sellerStart) + (_bal(address(treasury)) - treasuryStart);
        assertEq(held, handler.minted());
        if (e.status() == IOverflowEscrow.Status.Settled) assertEq(_bal(seller) - sellerStart, AMOUNT + BOND);
        if (e.status() == IOverflowEscrow.Status.Refunded) assertEq(_bal(seller), sellerStart);
    }
}
