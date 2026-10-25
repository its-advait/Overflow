// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBaseTest} from "../escrow/EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {IOverflowEscrowFactory} from "../../src/IOverflowEscrowFactory.sol";

/// The treasury pays factory escrows as payees (spec "settle() check order" step 4, "The escrow address is the order").
contract TreasuryEscrowPayeeTest is EscrowBaseTest {
    uint256 seller2Pk = 0x5E11E42;
    address seller2;
    IOverflowEscrow.OrderTerms t;
    OverflowEscrow e;

    function setUp() public override {
        super.setUp();
        seller2 = vm.addr(seller2Pk);
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
        t = _terms(AMOUNT, BOND, 4);
        e = _create(t);
        // no setAllow(e): the escrow qualifies through the factory
    }

    function _termsFor(address seller_, address buyer_, uint256 amount, bytes32 tag)
        internal
        view
        returns (IOverflowEscrow.OrderTerms memory x)
    {
        x = _terms(amount, 0, 2);
        x.seller = seller_;
        x.buyer = buyer_;
        x.orderId = keccak256(abi.encode("order", seller_, buyer_, amount, tag));
    }

    function _flag(address seller_) internal {
        vm.prank(address(e)); // any factory escrow may record a cheat
        factory.recordCheat(seller_);
        assertEq(factory.provenCheats(seller_), 1);
    }

    // ------------------------------------------------------------ owner

    function test_setEscrowFactory_ownerOnly_emits() public {
        vm.prank(attacker);
        vm.expectRevert(IOverflowTreasury.NotOwner.selector);
        treasury.setEscrowFactory(address(1));

        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.EscrowFactorySet(address(0));
        vm.prank(owner);
        treasury.setEscrowFactory(address(0));
        assertEq(treasury.escrowFactory(), address(0));
    }

    function test_escrowPayee_requiresFactorySet() public {
        vm.prank(owner);
        treasury.setEscrowFactory(address(0));
        _expectPayRevert(
            rootPk, address(e), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0)
        );
    }

    // ------------------------------------------------------------ happy path

    function test_agentFundsEscrowThroughSettle() public {
        assertFalse(treasury.allowlist(address(e)));
        uint256 before = _bal(address(treasury));
        vm.expectEmit(true, true, false, false, address(treasury));
        emit IOverflowTreasury.Paid(1, address(e), AMOUNT, bytes32(0));
        _pay(rootPk, address(e), AMOUNT);
        assertEq(_bal(address(e)), AMOUNT);
        assertEq(_bal(address(treasury)), before - AMOUNT);
        assertEq(treasury.getNode(1).spent, AMOUNT);
        _payBond(e, t);
        e.markFunded();
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Funded));
    }

    function test_directAllowlistedPayeeStillWorks() public {
        _pay(rootPk, payeeA, U / 100);
        assertEq(_bal(payeeA), U / 100);
    }

    // ------------------------------------------------------------ rejections

    function test_wrongAmountReverts() public {
        _expectPayRevert(
            rootPk,
            address(e),
            AMOUNT - 1,
            abi.encodeWithSelector(IOverflowTreasury.EscrowAmountMismatch.selector, address(e), AMOUNT, AMOUNT - 1)
        );
        _expectPayRevert(
            rootPk,
            address(e),
            AMOUNT + 1,
            abi.encodeWithSelector(IOverflowTreasury.EscrowAmountMismatch.selector, address(e), AMOUNT, AMOUNT + 1)
        );
        assertEq(treasury.getNode(1).spent, 0);
    }

    function test_escrowWithDifferentBuyerReverts() public {
        OverflowEscrow other = _create(_termsFor(seller, attacker, AMOUNT, "other-buyer"));
        assertTrue(factory.isEscrow(address(other)));
        _expectPayRevert(
            rootPk, address(other), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0)
        );
    }

    function test_nonEscrowUnlistedPayeeReverts() public {
        _expectPayRevert(rootPk, attacker, 1, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, 0));
    }

    function test_flaggedSeller_escrowPathReverts() public {
        // an order opened before the flag is blocked at payment time; a new one cannot be created at all
        OverflowEscrow earlier = _create(_termsFor(seller, address(treasury), AMOUNT, "earlier"));
        _flag(seller);
        _expectPayRevert(
            rootPk, address(e), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
        _expectPayRevert(
            rootPk, address(earlier), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
        IOverflowEscrow.OrderTerms memory again = _termsFor(seller, address(treasury), AMOUNT, "again");
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrowFactory.SellerFlagged.selector, seller));
        factory.create(again);
    }

    /// Found by TreasuryInvariant: a settled or refunded escrow has no sweep, so paying it would strand USDC and
    /// burn the agent's allowance for nothing.
    function test_closedEscrow_isNotAPayee() public {
        // refunded after a missed reveal
        OverflowEscrow r = _create(_termsFor(seller, address(treasury), AMOUNT, "to be refunded"));
        _pay(rootPk, address(r), AMOUNT);
        r.markFunded();
        vm.warp(r.terms().revealDeadline);
        r.claimTimeoutRefund();
        uint256 spent = treasury.getNode(1).spent;
        _expectPayRevert(
            rootPk, address(r), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.EscrowClosed.selector, address(r))
        );
        Auth memory a = _auth(rootPk, address(r), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.EscrowClosed.selector, address(r)));
        treasury.reserve(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
        assertEq(treasury.getNode(1).spent, spent, "nothing charged");
        assertEq(_bal(address(r)), 0);
        // an open order (Created or Funded) is still payable
        _pay(rootPk, address(e), AMOUNT);
    }

    function test_flaggedSeller_directPathReverts() public {
        vm.prank(owner);
        treasury.setAllow(seller, true);
        _pay(rootPk, seller, U / 100); // fine before the flag
        _flag(seller);
        _expectPayRevert(
            rootPk, seller, U / 100, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
        assertEq(treasury.getNode(1).spent, U / 100);
    }

    function test_flaggedSeller_otherSellersUnaffected() public {
        _flag(seller);
        OverflowEscrow e2 = _create(_termsFor(seller2, address(treasury), AMOUNT, "s2"));
        _pay(rootPk, address(e2), AMOUNT);
        assertEq(_bal(address(e2)), AMOUNT);
    }

    // ------------------------------------------------------------ restricted nodes

    function test_restrictedNode_paysOnlyEscrowsOfAllowedSellers() public {
        uint256 childPk = 0xC41D;
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(childPk), U / 4, U / 10, rootExpiry);
        c.restricted = true;
        c.payees = new address[](1);
        c.payees[0] = seller; // the SELLER is allowed, not the escrow address
        uint256 childId = _createChild(rootPk, c);
        assertTrue(treasury.nodeAllow(childId, seller));
        assertFalse(treasury.nodeAllow(childId, address(e)));

        _pay(childPk, address(e), AMOUNT);
        assertEq(_bal(address(e)), AMOUNT);
        assertEq(treasury.getNode(childId).spent, AMOUNT);

        OverflowEscrow e2 = _create(_termsFor(seller2, address(treasury), AMOUNT, "s2"));
        _expectPayRevert(
            childPk, address(e2), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, childId)
        );
        // the restriction also applies when an unrestricted grandchild pays
        uint256 gPk = 0x6C;
        _child(childPk, childId, gPk, U / 10, U / 20);
        _expectPayRevert(
            gPk, address(e2), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, childId)
        );
    }

    function test_restrictedNode_directSellerPaymentUsesSameAllow() public {
        uint256 childPk = 0xC41D;
        IOverflowTreasury.ChildParams memory c = _params(1, vm.addr(childPk), U / 4, U / 10, rootExpiry);
        c.restricted = true;
        c.payees = new address[](1);
        c.payees[0] = payeeA;
        uint256 childId = _createChild(rootPk, c);
        _expectPayRevert(
            childPk, address(e), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeNotAllowed.selector, childId)
        );
        _pay(childPk, payeeA, U / 100);
    }
}
