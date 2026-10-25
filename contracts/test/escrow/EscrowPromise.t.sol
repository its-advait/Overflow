// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IOverflowEscrowFactory} from "../../src/IOverflowEscrowFactory.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";
import {RecourseCrypto} from "../../src/RecourseCrypto.sol";

/// Tier 3: signed-record promises (source key, minimum timestamp), bond flows and cheater flags.
contract EscrowPromiseTest is EscrowBaseTest {
    uint32 constant N = 4;
    uint256 sourcePk = 0x50C4CE;
    address source;
    uint64 constant MIN_TS = 1_790_000_000;

    bytes[] records; // honest records unless a test swaps one
    bytes32[] plainLeaves;
    bytes32[] cipherLeaves;

    function setUp() public override {
        super.setUp();
        source = vm.addr(sourcePk);
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
    }

    // ------------------------------------------------------------ record helpers

    /// 160-byte record: payload = uint64 ts || 87 bytes of `fill`, then a 65-byte (r, s, v) signature by `pk`.
    function _record(uint64 ts, uint8 fill, uint256 pk) internal pure returns (bytes memory) {
        bytes memory data = new bytes(87);
        for (uint256 k; k < 87; k++) {
            data[k] = bytes1(fill);
        }
        bytes memory payload = abi.encodePacked(ts, data);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(payload));
        bytes memory rec = abi.encodePacked(payload, r, s, v);
        assert(rec.length == 160);
        return rec;
    }

    function _commit(bytes[] memory recs) internal {
        records = recs;
        plainLeaves = new bytes32[](recs.length);
        cipherLeaves = new bytes32[](recs.length);
        for (uint256 i; i < recs.length; i++) {
            plainLeaves[i] = MerkleLib.leaf(recs[i]);
            cipherLeaves[i] = MerkleLib.leaf(RecourseCrypto.xorChunk(RecourseCrypto.chunkKey(KEY, i), recs[i]));
        }
    }

    function _honest() internal pure returns (bytes[] memory recs) {
        recs = new bytes[](N);
        for (uint256 i; i < N; i++) {
            recs[i] = _record(MIN_TS + uint64(i) * 3600, uint8(i + 1), 0x50C4CE);
        }
    }

    function _order(bytes[] memory recs, address sourceKey, uint64 minTs, bytes32 tag)
        internal
        returns (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t)
    {
        _commit(recs);
        t = _terms(AMOUNT, BOND, N);
        t.rootPlain = _root(plainLeaves);
        t.rootCipher = _root(cipherLeaves);
        t.sourceKey = sourceKey;
        t.minTimestamp = minTs;
        t.orderId = keccak256(abi.encode("promise order", tag));
        t.termsHash = factory.termsHashOf(t);
        e = _create(t);
    }

    function _live(OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) internal {
        _fundViaTreasury(e, t);
        _reveal(e);
    }

    function _complain(OverflowEscrow e, uint256 i) internal {
        e.complainPromise(i, records[i], _proof(plainLeaves, i));
    }

    function _expectCheat(OverflowEscrow e, uint256 i) internal {
        vm.expectEmit(true, false, false, true, address(e));
        emit IOverflowEscrow.CheatProven(seller, i);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.Refunded("promise");
    }

    // ------------------------------------------------------------ promises

    function test_wrongSourceRecord_refunds() public {
        bytes[] memory recs = _honest();
        recs[1] = _record(MIN_TS + 3600, 2, 0xBAD); // same payload shape, signed by someone else
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, source, MIN_TS, "wrong-source");
        uint256 treasuryBefore = _bal(address(treasury));
        _live(e, t);

        _expectCheat(e, 1);
        vm.prank(attacker); // anyone relays
        _complain(e, 1);

        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertEq(_bal(address(treasury)), treasuryBefore + BOND, "price back plus the bond");
        assertEq(_bal(address(e)), 0);
        assertEq(factory.provenCheats(seller), 1);
        assertEq(treasury.getNode(1).spent, AMOUNT, "allowance stays charged");
    }

    function test_staleRecord_refunds() public {
        bytes[] memory recs = _honest();
        recs[3] = _record(MIN_TS - 1, 4, 0x50C4CE); // genuine source signature, timestamp below the promise
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, source, MIN_TS, "stale");
        _live(e, t);
        _expectCheat(e, 3);
        _complain(e, 3);
        assertEq(factory.provenCheats(seller), 1);
        assertEq(_bal(address(e)), 0);
    }

    function test_malformedSignature_countsAsWrongSource() public {
        bytes[] memory recs = _honest();
        bytes memory payload = new bytes(95);
        recs[0] = abi.encodePacked(payload, new bytes(65)); // zero signature -> ECDSA error
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, source, 0, "malformed");
        _live(e, t);
        _expectCheat(e, 0);
        _complain(e, 0);
    }

    function test_validRecordComplaint_reverts() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(_honest(), source, MIN_TS, "honest");
        _live(e, t);
        for (uint256 i; i < N; i++) {
            vm.expectRevert(IOverflowEscrow.PromiseKept.selector);
            _complain(e, i);
        }
        assertEq(factory.provenCheats(seller), 0);
        // a record that is not in the tree cannot be used either
        bytes memory forged = _record(MIN_TS - 1, 9, 0xBAD);
        vm.expectRevert(IOverflowEscrow.BadProof.selector);
        e.complainPromise(0, forged, _proof(plainLeaves, 0));
    }

    function test_onlyTimestampPromise_ignoresSigner() public {
        bytes[] memory recs = _honest();
        recs[2] = _record(MIN_TS + 1, 3, 0xBAD); // unsigned by the source, but no source was promised
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, address(0), MIN_TS, "ts-only");
        _live(e, t);
        vm.expectRevert(IOverflowEscrow.PromiseKept.selector);
        _complain(e, 2);
    }

    function test_noPromise_reverts() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(_honest(), address(0), 0, "none");
        _live(e, t);
        vm.expectRevert(IOverflowEscrow.NoPromise.selector);
        _complain(e, 0);
    }

    function test_complaint_outsideWindow_reverts() public {
        bytes[] memory recs = _honest();
        recs[1] = _record(MIN_TS, 2, 0xBAD);
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, source, MIN_TS, "late");
        _fundViaTreasury(e, t);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadStatus.selector, IOverflowEscrow.Status.Funded));
        _complain(e, 1);
        _reveal(e);
        vm.warp(e.challengeEnd());
        vm.expectRevert(IOverflowEscrow.ChallengeClosed.selector);
        _complain(e, 1);
    }

    // ------------------------------------------------------------ bonds

    function test_bond_returnsToSellerOnPayout() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(_honest(), source, MIN_TS, "payout");
        _live(e, t);
        assertEq(_bal(seller), 0, "bond staked");
        assertEq(_bal(address(e)), AMOUNT + BOND);
        e.accept(_acceptSig(rootPk, e));
        assertEq(_bal(seller), AMOUNT + BOND, "price plus bond back");
        assertEq(_bal(address(e)), 0);
    }

    function test_bond_goesToBuyerOnCheat() public {
        bytes[] memory recs = _honest();
        recs[0] = _record(MIN_TS, 1, 0xBAD);
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, source, MIN_TS, "cheat-bond");
        uint256 before = _bal(address(treasury));
        _live(e, t);
        _complain(e, 0);
        assertEq(_bal(address(treasury)), before + BOND);
        assertEq(_bal(seller), 0);
    }

    function test_bond_goesToBuyerOnGhost() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(_honest(), source, MIN_TS, "ghost");
        uint256 before = _bal(address(treasury));
        _fundViaTreasury(e, t); // seller never reveals
        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund();
        assertEq(_bal(address(treasury)), before + BOND, "price back plus the forfeited bond");
        assertEq(_bal(seller), 0);
        assertEq(factory.provenCheats(seller), 0, "ghosting forfeits the bond but is not a proven cheat");
    }

    function test_markFunded_requiresBondToo() public {
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(_honest(), source, MIN_TS, "underbond");
        vm.prank(owner);
        treasury.setAllow(address(e), true);
        _pay(rootPk, address(e), t.amount); // price only
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.Underfunded.selector, AMOUNT, AMOUNT + BOND));
        e.markFunded();
        _payBond(e, t);
        e.markFunded();
    }

    // ------------------------------------------------------------ flags

    function test_flaggedSeller_cannotCreateOrBePaid() public {
        bytes[] memory recs = _honest();
        recs[0] = _record(MIN_TS, 1, 0xBAD);
        (OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) = _order(recs, source, MIN_TS, "flag");
        // an order opened before the proof
        IOverflowEscrow.OrderTerms memory open_ = _terms(AMOUNT, 0, 2);
        open_.orderId = keccak256("opened earlier");
        open_.termsHash = factory.termsHashOf(open_);
        OverflowEscrow earlier = _create(open_);

        _live(e, t);
        _complain(e, 0);
        assertEq(factory.provenCheats(seller), 1);

        IOverflowEscrow.OrderTerms memory next = _terms(AMOUNT, 0, 2);
        next.orderId = keccak256("after the flag");
        next.termsHash = factory.termsHashOf(next);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrowFactory.SellerFlagged.selector, seller));
        factory.create(next);
        assertEq(factory.predict(next.orderId, next.termsHash).code.length, 0);

        _expectPayRevert(
            rootPk, address(earlier), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
        vm.prank(owner);
        treasury.setAllow(seller, true);
        _expectPayRevert(
            rootPk, seller, U / 100, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
    }

    function test_cheatCountAccumulatesAcrossOrders() public {
        bytes[] memory recs = _honest();
        recs[0] = _record(MIN_TS, 1, 0xBAD);
        (OverflowEscrow e1, IOverflowEscrow.OrderTerms memory t1) = _order(recs, source, MIN_TS, "one");
        (OverflowEscrow e2, IOverflowEscrow.OrderTerms memory t2) = _order(recs, source, MIN_TS, "two");
        _live(e1, t1);
        _complain(e1, 0);
        _commit(recs);
        _live(e2, t2);
        _complain(e2, 0);
        assertEq(factory.provenCheats(seller), 2);
    }
}
