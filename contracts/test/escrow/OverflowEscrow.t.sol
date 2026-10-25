// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IOverflowEscrowFactory} from "../../src/IOverflowEscrowFactory.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";
import {UsdcV22} from "../usdc/UsdcV22.sol";

contract OverflowEscrowTest is EscrowBaseTest {
    IOverflowEscrow.OrderTerms t;
    OverflowEscrow e;

    function setUp() public override {
        super.setUp();
        t = _terms(AMOUNT, BOND, 4);
        e = _create(t);
    }

    // ------------------------------------------------------------ factory

    function test_create_predictedEqualsCreated() public view {
        assertEq(address(e), factory.predict(t.orderId, t.termsHash));
        assertTrue(factory.isEscrow(address(e)));
        assertFalse(factory.isEscrow(address(this)));
        assertEq(e.FACTORY(), address(factory));
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Created));
        IOverflowEscrow.OrderTerms memory stored = e.terms();
        assertEq(keccak256(abi.encode(stored)), keccak256(abi.encode(t)));
    }

    function test_create_emitsOrderCreated() public {
        IOverflowEscrow.OrderTerms memory t2 = _terms(AMOUNT, 0, 2);
        address predicted = factory.predict(t2.orderId, t2.termsHash);
        vm.expectEmit(true, true, true, true, address(factory));
        emit IOverflowEscrowFactory.OrderCreated(predicted, t2.orderId, address(treasury), seller, AMOUNT, t2.termsHash);
        assertEq(factory.create(t2), predicted);
    }

    function test_create_duplicateReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrowFactory.OrderExists.selector, address(e)));
        factory.create(t);
    }

    function test_create_badTermsHashReverts() public {
        IOverflowEscrow.OrderTerms memory bad = _terms(AMOUNT, BOND, 2);
        bytes32 expected = bad.termsHash;
        bad.termsHash = bytes32(uint256(1));
        vm.expectRevert(
            abi.encodeWithSelector(IOverflowEscrowFactory.BadTermsHash.selector, expected, bytes32(uint256(1)))
        );
        factory.create(bad);
    }

    function test_create_chunkCountChangesTermsHash() public view {
        IOverflowEscrow.OrderTerms memory a = _terms(AMOUNT, BOND, 2);
        bytes32 before = factory.termsHashOf(a);
        a.chunkCount = 3;
        assertTrue(before != factory.termsHashOf(a));
    }

    function test_create_badTermsRevert() public {
        IOverflowEscrow.OrderTerms memory bad = _terms(AMOUNT, BOND, 2);
        bad.amount = 0;
        bad.termsHash = factory.termsHashOf(bad);
        vm.expectRevert(_err(IOverflowEscrowFactory.BadTerms.selector));
        factory.create(bad);

        bad = _terms(AMOUNT, BOND, 2);
        bad.chunkCount = 0;
        bad.termsHash = factory.termsHashOf(bad);
        vm.expectRevert(_err(IOverflowEscrowFactory.BadTerms.selector));
        factory.create(bad);

        bad = _terms(AMOUNT, BOND, 2);
        bad.revealDeadline = uint64(block.timestamp);
        bad.termsHash = factory.termsHashOf(bad);
        vm.expectRevert(_err(IOverflowEscrowFactory.BadTerms.selector));
        factory.create(bad);
    }

    function test_initialize_againReverts() public {
        vm.prank(address(factory));
        vm.expectRevert(_err(IOverflowEscrow.AlreadyInitialized.selector));
        e.initialize(t);

        vm.prank(attacker);
        vm.expectRevert(_err(IOverflowEscrow.NotFactory.selector));
        e.initialize(t);
    }

    function test_implementation_cannotBeInitialized() public {
        OverflowEscrow impl = OverflowEscrow(factory.implementation());
        vm.prank(address(factory));
        vm.expectRevert(_err(IOverflowEscrow.AlreadyInitialized.selector));
        impl.initialize(t);
    }

    function test_recordCheat_onlyEscrows() public {
        vm.expectRevert(_err(IOverflowEscrowFactory.NotEscrow.selector));
        factory.recordCheat(seller);
        assertEq(factory.provenCheats(seller), 0);

        vm.prank(address(e));
        factory.recordCheat(seller);
        assertEq(factory.provenCheats(seller), 1);
    }

    // ------------------------------------------------------------ funding

    function test_markFunded_underfundedReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.Underfunded.selector, 0, AMOUNT + BOND));
        e.markFunded();
    }

    function test_markFunded_viaTreasurySettle() public {
        uint256 before = _bal(address(treasury));
        vm.prank(owner);
        treasury.setAllow(address(e), true);
        vm.expectEmit(true, true, false, false, address(treasury)); // Paid(id, to, ...) nonce is random
        emit IOverflowTreasury.Paid(1, address(e), AMOUNT, bytes32(0));
        _pay(rootPk, address(e), t.amount);
        _payBond(e, t);
        e.markFunded();
        assertEq(_bal(address(treasury)), before - AMOUNT);
        assertEq(_bal(address(e)), AMOUNT + BOND);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Funded));
        assertEq(treasury.getNode(1).spent, AMOUNT);
    }

    function test_markFunded_twiceReverts() public {
        _fundViaMint(e, t);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Funded));
        e.markFunded();
    }

    // ------------------------------------------------------------ reveal

    function test_reveal_setsChallengeWindow() public {
        _fundViaMint(e, t);
        uint64 end = uint64(block.timestamp + 30 minutes);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.KeyRevealed(KEY, end);
        _reveal(e);
        assertEq(e.revealedKey(), KEY);
        assertEq(e.challengeEnd(), end);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Revealed));
    }

    function test_reveal_afterDeadlineReverts() public {
        _fundViaMint(e, t);
        vm.warp(t.revealDeadline);
        vm.prank(seller);
        vm.expectRevert(_err(IOverflowEscrow.RevealWindowClosed.selector));
        e.revealKey(KEY);
    }

    function test_reveal_wrongKeyReverts() public {
        _fundViaMint(e, t);
        vm.prank(seller);
        vm.expectRevert(_err(IOverflowEscrow.BadKey.selector));
        e.revealKey(keccak256("wrong"));
    }

    function test_reveal_nonSellerReverts() public {
        _fundViaMint(e, t);
        vm.prank(attacker);
        vm.expectRevert(_err(IOverflowEscrow.NotSeller.selector));
        e.revealKey(KEY);
    }

    function test_reveal_beforeFundedReverts() public {
        vm.prank(seller);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Created));
        e.revealKey(KEY);
    }

    function test_reveal_twiceReverts() public {
        _fundViaMint(e, t);
        _reveal(e);
        vm.prank(seller);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Revealed));
        e.revealKey(KEY);
    }

    // ------------------------------------------------------------ payout

    function test_payout_viaAccept() public {
        _fundViaMint(e, t);
        _reveal(e);
        bytes memory sig = _acceptSig(rootPk, e);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.Accepted(rootKey, 1);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.PaidOut(seller, AMOUNT, BOND);
        e.accept(sig); // anyone relays
        assertEq(_bal(seller), AMOUNT + BOND);
        assertEq(_bal(address(e)), 0);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled));
    }

    function test_payout_viaAccept_childNode() public {
        uint256 childPk = 0xC41D;
        uint256 childId = _child(rootPk, 1, childPk, U / 4, U / 10);
        _fundViaMint(e, t);
        _reveal(e);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.Accepted(vm.addr(childPk), childId);
        e.accept(_acceptSig(childPk, e));
        assertEq(_bal(seller), AMOUNT + BOND);
    }

    function test_accept_nonNodeReverts() public {
        _fundViaMint(e, t);
        _reveal(e);
        uint256 strangerPk = 0xBAD;
        bytes memory sig = _acceptSig(strangerPk, e);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.NotBuyerNode.selector, vm.addr(strangerPk)));
        e.accept(sig);
        assertEq(_bal(seller), 0);
    }

    function test_accept_signatureForAnotherEscrowReverts() public {
        OverflowEscrow other = _create(_terms(AMOUNT, 0, 2));
        _fundViaMint(e, t);
        _reveal(e);
        bytes memory sig = _acceptSig(rootPk, other); // valid root signature, wrong escrow domain
        vm.expectRevert(); // recovers to some non-node address -> NotBuyerNode
        e.accept(sig);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Revealed));
    }

    function test_accept_beforeRevealReverts() public {
        _fundViaMint(e, t);
        bytes memory sig = _acceptSig(rootPk, e);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Funded));
        e.accept(sig);
    }

    function test_payout_viaFinalize() public {
        _fundViaMint(e, t);
        _reveal(e);
        vm.warp(e.challengeEnd());
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.PaidOut(seller, AMOUNT, BOND);
        e.finalizePayout();
        assertEq(_bal(seller), AMOUNT + BOND);
        assertEq(_bal(address(e)), 0);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Settled));
    }

    function test_finalize_beforeWindowClosesReverts() public {
        _fundViaMint(e, t);
        _reveal(e);
        vm.warp(e.challengeEnd() - 1);
        vm.expectRevert(_err(IOverflowEscrow.ChallengeOpen.selector));
        e.finalizePayout();
    }

    function test_finalize_twiceReverts() public {
        _fundViaMint(e, t);
        _reveal(e);
        vm.warp(e.challengeEnd());
        e.finalizePayout();
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Settled));
        e.finalizePayout();
        bytes memory sig = _acceptSig(rootPk, e);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Settled));
        e.accept(sig);
    }

    function test_payout_surplusReturnsToBuyer() public {
        _fundViaMint(e, t);
        UsdcV22.mint(usdc, usdcOwner, address(e), 777);
        _reveal(e);
        uint256 treasuryBefore = _bal(address(treasury));
        e.accept(_acceptSig(rootPk, e));
        assertEq(_bal(seller), AMOUNT + BOND);
        assertEq(_bal(address(treasury)), treasuryBefore + 777);
        assertEq(_bal(address(e)), 0);
    }

    // ------------------------------------------------------------ refund

    function test_timeoutRefund_restoresTreasuryUsdc() public {
        uint256 before = _bal(address(treasury));
        _fundViaTreasury(e, t);
        assertEq(_bal(address(treasury)), before - AMOUNT);
        vm.warp(t.revealDeadline);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.Refunded("timeout");
        e.claimTimeoutRefund();
        // price and the seller's bond both return to the buyer; the agent's spent allowance stays charged
        assertEq(_bal(address(treasury)), before + BOND);
        assertEq(_bal(seller), 0);
        assertEq(_bal(address(e)), 0);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertEq(treasury.getNode(1).spent, AMOUNT);
    }

    function test_timeoutRefund_beforeDeadlineReverts() public {
        _fundViaMint(e, t);
        vm.warp(t.revealDeadline - 1);
        vm.expectRevert(_err(IOverflowEscrow.RevealWindowOpen.selector));
        e.claimTimeoutRefund();
    }

    function test_timeoutRefund_twiceReverts() public {
        _fundViaMint(e, t);
        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund();
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Refunded));
        e.claimTimeoutRefund();
    }

    function test_timeoutRefund_fromCreatedWithPartialFunding() public {
        UsdcV22.mint(usdc, usdcOwner, address(e), AMOUNT / 2);
        vm.warp(t.revealDeadline);
        uint256 before = _bal(address(treasury));
        e.claimTimeoutRefund();
        assertEq(_bal(address(treasury)), before + AMOUNT / 2);
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
    }

    function test_timeoutRefund_afterRevealReverts() public {
        _fundViaMint(e, t);
        _reveal(e);
        vm.warp(t.revealDeadline + 1 days);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Revealed));
        e.claimTimeoutRefund();
    }

    function test_terminalStatesAreExclusive() public {
        _fundViaMint(e, t);
        _reveal(e);
        e.accept(_acceptSig(rootPk, e));
        vm.warp(t.revealDeadline + 1 days);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Settled));
        e.claimTimeoutRefund();

        OverflowEscrow e2 = _create(_terms(AMOUNT, BOND, 2));
        IOverflowEscrow.OrderTerms memory t2 = e2.terms();
        _fundViaMint(e2, t2);
        vm.warp(t2.revealDeadline);
        e2.claimTimeoutRefund();
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Refunded));
        e2.finalizePayout();
        vm.prank(seller);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Refunded));
        e2.revealKey(KEY);
    }

    // ------------------------------------------------------------ complaint structure (mismatch logic: EscrowMismatch.t.sol)

    function _revealed() internal {
        _fundViaMint(e, t);
        _reveal(e);
    }

    function test_complaint_wellFormed_honestSeller() public {
        _revealed();
        bytes32[] memory plain = _leaves(4, 0);
        bytes32[] memory cipher = _cipherLeaves(4);
        // tier 2: a correct chunk is not a cheat
        vm.expectRevert(_err(IOverflowEscrow.ChunkMatches.selector));
        e.complainMismatch(1, _cipher(1), _proof(cipher, 1), plain[1], _proof(plain, 1));
        // tier 3 still a stub
        vm.expectRevert(_err(IOverflowEscrow.NotImplemented.selector));
        e.complainPromise(2, _chunk(2), _proof(plain, 2));
    }

    function test_complaint_outsideWindowReverts() public {
        bytes32[] memory plain = _leaves(4, 0);
        vm.expectRevert(_badStatus(IOverflowEscrow.Status.Created));
        e.complainPromise(0, _chunk(0), _proof(plain, 0));
        _revealed();
        vm.warp(e.challengeEnd());
        vm.expectRevert(_err(IOverflowEscrow.ChallengeClosed.selector));
        e.complainPromise(0, _chunk(0), _proof(plain, 0));
    }

    function test_complaint_indexOutOfRangeReverts() public {
        _revealed();
        bytes32[] memory plain = _leaves(4, 0);
        vm.expectRevert(_err(IOverflowEscrow.ChunkOutOfRange.selector));
        e.complainPromise(4, _chunk(0), _proof(plain, 0));
        vm.expectRevert(_err(IOverflowEscrow.ChunkOutOfRange.selector));
        e.complainMismatch(4, _cipher(0), _proof(plain, 0), plain[0], _proof(plain, 0));
    }

    function test_complaint_badChunkLengthReverts() public {
        _revealed();
        bytes32[] memory plain = _leaves(4, 0);
        bytes memory short_ = new bytes(159);
        vm.expectRevert(_err(IOverflowEscrow.BadChunkLength.selector));
        e.complainPromise(0, short_, _proof(plain, 0));
        bytes memory long_ = new bytes(161);
        vm.expectRevert(_err(IOverflowEscrow.BadChunkLength.selector));
        e.complainMismatch(0, long_, _proof(plain, 0), plain[0], _proof(plain, 0));
    }

    function test_complaint_badProofLengthReverts() public {
        _revealed();
        bytes32[] memory plain = _leaves(4, 0);
        bytes32[] memory one = new bytes32[](1);
        one[0] = plain[1];
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadProofLength.selector, 2, 1));
        e.complainPromise(0, _chunk(0), one);
        bytes32[] memory three = new bytes32[](3);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadProofLength.selector, 2, 3));
        e.complainMismatch(0, _cipher(0), _proof(_cipherLeaves(4), 0), plain[0], three);
    }

    function test_complaint_wrongProofElementReverts() public {
        _revealed();
        bytes32[] memory plain = _leaves(4, 0);
        bytes32[] memory proof = _proof(plain, 0);
        proof[1] = keccak256("tampered");
        vm.expectRevert(_err(IOverflowEscrow.BadProof.selector));
        e.complainPromise(0, _chunk(0), proof);
        // chunk that is not in the tree
        vm.expectRevert(_err(IOverflowEscrow.BadProof.selector));
        e.complainPromise(0, _chunk(9), _proof(plain, 0));
    }

    /// Internal-node-as-leaf: an attacker presents node(leaf0, leaf1) as the leaf for index 0 with the
    /// one-element proof [node(leaf2, leaf3)]. Without domain separation and exact proof lengths this
    /// would verify against the root. Here it fails the length check, and a padded version fails the hash.
    function test_complaint_internalNodeAsLeafReverts() public {
        _revealed();
        bytes32[] memory plain = _leaves(4, 0);
        bytes32 node01 = MerkleLib.node(plain[0], plain[1]);
        bytes32 node23 = MerkleLib.node(plain[2], plain[3]);
        assertEq(MerkleLib.node(node01, node23), t.rootPlain, "tree shape");

        bytes32[] memory shortProof = new bytes32[](1);
        shortProof[0] = node23;
        bytes32[] memory cipherProof = _proof(_cipherLeaves(4), 0);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadProofLength.selector, 2, 1));
        e.complainMismatch(0, _cipher(0), cipherProof, node01, shortProof);

        bytes32[] memory padded = new bytes32[](2);
        padded[0] = node23;
        padded[1] = bytes32(0);
        vm.expectRevert(_err(IOverflowEscrow.BadProof.selector));
        e.complainMismatch(0, _cipher(0), cipherProof, node01, padded);

        // The 32-byte internal node can never pose as a 160-byte chunk either.
        vm.expectRevert(_err(IOverflowEscrow.BadChunkLength.selector));
        e.complainPromise(0, abi.encodePacked(node01), shortProof);
    }

    // ------------------------------------------------------------ misc

    function test_domainSeparatorBindsEscrow() public {
        OverflowEscrow other = _create(_terms(AMOUNT, 0, 2));
        assertTrue(e.DOMAIN_SEPARATOR() != other.DOMAIN_SEPARATOR());
        assertTrue(e.acceptDigest() != other.acceptDigest());
    }
}
