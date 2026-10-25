// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {UsdcV22} from "../usdc/UsdcV22.sol";
import {EscrowBaseTest} from "../escrow/EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";

/// One warm call per operation, measured with forge gas snapshots (execution gas of the external call; the 21k
/// intrinsic cost and calldata are excluded). `pnpm contracts:gas` runs this and writes docs/gas.md from
/// contracts/snapshots/GasReportTest.json.
contract GasReportTest is EscrowBaseTest {
    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
    }

    function test_gasReport() public {
        // treasury: settle to an allowlisted payee from the root node
        Auth memory a = _auth(rootPk, payeeA, U / 20);
        vm.startSnapshotGas("settle");
        _settle(a);
        vm.stopSnapshotGas();

        // treasury: reserve, then release after the window (refund path walks the node chain)
        Auth memory r = _auth(rootPk, payeeA, U / 20);
        vm.startSnapshotGas("reserve");
        bytes32 digest = treasury.reserve(r.to, r.value, r.validAfter, r.validBefore, r.nonce, r.sig);
        vm.stopSnapshotGas();
        vm.warp(r.validBefore);
        vm.startSnapshotGas("release");
        treasury.release(digest);
        vm.stopSnapshotGas();

        // escrow: create, fund (treasury settle to the escrow + markFunded), reveal, accept
        IOverflowEscrow.OrderTerms memory t = _terms(AMOUNT, BOND, 4);
        vm.startSnapshotGas("escrowCreate");
        OverflowEscrow e = _create(t);
        vm.stopSnapshotGas();
        _payBond(e, t);
        Auth memory f = _auth(rootPk, address(e), t.amount);
        vm.startSnapshotGas("fundSettleToEscrow");
        _settle(f);
        vm.stopSnapshotGas();
        vm.startSnapshotGas("fundMarkFunded");
        e.markFunded();
        vm.stopSnapshotGas();
        vm.startSnapshotGas("reveal");
        vm.prank(seller);
        e.revealKey(KEY);
        vm.stopSnapshotGas();
        bytes memory sig = _acceptSig(rootPk, e);
        vm.startSnapshotGas("accept");
        e.accept(sig);
        vm.stopSnapshotGas();

        // escrow: refund after a missed reveal
        IOverflowEscrow.OrderTerms memory t2 = _terms(AMOUNT, BOND, 4);
        t2.orderId = keccak256("gas refund order");
        t2.termsHash = factory.termsHashOf(t2);
        OverflowEscrow e2 = _create(t2);
        _fundViaTreasury(e2, t2);
        vm.warp(t2.revealDeadline);
        vm.startSnapshotGas("refund");
        e2.claimTimeoutRefund();
        vm.stopSnapshotGas();

        // escrow: sweep of USDC that arrived after the order closed (test shortcut mint stands in for an external transfer)
        UsdcV22.mint(usdc, usdcOwner, address(e2), AMOUNT);
        vm.startSnapshotGas("sweep");
        e2.sweep();
        vm.stopSnapshotGas();

        // treasury: reserve to an open order, the order closes, releaseClosed refunds before validBefore
        IOverflowEscrow.OrderTerms memory t3 = _terms(AMOUNT, BOND, 4);
        t3.orderId = keccak256("gas releaseClosed order");
        t3.termsHash = factory.termsHashOf(t3);
        OverflowEscrow e3 = _create(t3);
        Auth memory rc = _auth(rootPk, address(e3), AMOUNT);
        vm.startSnapshotGas("reserveToEscrow");
        bytes32 closedDigest = treasury.reserve(rc.to, rc.value, rc.validAfter, rc.validBefore, rc.nonce, rc.sig);
        vm.stopSnapshotGas();
        vm.warp(t3.revealDeadline);
        e3.claimTimeoutRefund();
        vm.startSnapshotGas("releaseClosed");
        treasury.releaseClosed(closedDigest);
        vm.stopSnapshotGas();
    }
}
