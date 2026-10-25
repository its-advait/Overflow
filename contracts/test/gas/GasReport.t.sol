// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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
    }
}
