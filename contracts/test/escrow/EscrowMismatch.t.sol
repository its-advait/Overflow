// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EscrowBaseTest} from "./EscrowBase.t.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";
import {RecourseCrypto} from "../../src/RecourseCrypto.sol";

/// Tier 2: a buyer proves ciphertext chunk i does not decrypt to the committed plaintext and is refunded.
contract EscrowMismatchTest is EscrowBaseTest {
    uint32 constant N = 4;
    uint256 constant BAD = 2; // the chunk the cheating seller swaps

    bytes32[] plainLeaves;
    bytes32[] cheatCipherLeaves;
    bytes cheatCipher; // ciphertext the seller actually serves for chunk BAD (encrypts junk, not p_BAD)

    IOverflowEscrow.OrderTerms t;
    OverflowEscrow e;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));

        plainLeaves = _leaves(N, 0);
        cheatCipher = RecourseCrypto.xorChunk(RecourseCrypto.chunkKey(KEY, BAD), _chunk(0xEE));
        cheatCipherLeaves = _cipherLeaves(N);
        cheatCipherLeaves[BAD] = MerkleLib.leaf(cheatCipher);

        // seller commits honest plaintext hashes but ciphertext whose chunk BAD decrypts to junk
        t = _terms(AMOUNT, BOND, N);
        t.rootCipher = _root(cheatCipherLeaves);
        t.orderId = keccak256("cheating order");
        t.termsHash = factory.termsHashOf(t);
        e = _create(t);
    }

    function _fundedAndRevealed() internal {
        _fundViaTreasury(e, t); // real path: the treasury pays the escrow through settle()
        _reveal(e);
    }

    function _complainBad() internal {
        e.complainMismatch(BAD, cheatCipher, _proof(cheatCipherLeaves, BAD), plainLeaves[BAD], _proof(plainLeaves, BAD));
    }

    function test_swappedChunk_refundsBuyerAndFlagsSeller() public {
        uint256 treasuryBefore = _bal(address(treasury));
        _fundedAndRevealed();
        assertEq(_bal(address(treasury)), treasuryBefore - AMOUNT);
        assertEq(_bal(address(e)), AMOUNT + BOND);

        vm.expectEmit(true, false, false, true, address(e));
        emit IOverflowEscrow.CheatProven(seller, BAD);
        vm.expectEmit(false, false, false, true, address(e));
        emit IOverflowEscrow.Refunded("mismatch");
        vm.prank(attacker); // anyone can relay the proof; the proof is what counts
        _complainBad();

        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertEq(_bal(address(e)), 0);
        assertEq(_bal(address(treasury)), treasuryBefore + BOND, "price back plus the seller's bond");
        assertEq(_bal(seller), 0);
        assertEq(factory.provenCheats(seller), 1);
        assertEq(treasury.getNode(1).spent, AMOUNT, "refund restores USDC, not the agent's allowance");
    }

    function test_correctChunkComplaint_reverts() public {
        _fundedAndRevealed();
        // chunk 1 of the cheating seller is honest
        vm.expectRevert(IOverflowEscrow.ChunkMatches.selector);
        e.complainMismatch(1, _cipher(1), _proof(cheatCipherLeaves, 1), plainLeaves[1], _proof(plainLeaves, 1));
        // an entirely honest escrow: every chunk matches
        IOverflowEscrow.OrderTerms memory ht = _terms(AMOUNT, 0, N);
        OverflowEscrow honest = _create(ht);
        _fundViaMint(honest, ht);
        _reveal(honest);
        bytes32[] memory cl = _cipherLeaves(N);
        for (uint256 i; i < N; i++) {
            vm.expectRevert(IOverflowEscrow.ChunkMatches.selector);
            honest.complainMismatch(i, _cipher(i), _proof(cl, i), plainLeaves[i], _proof(plainLeaves, i));
        }
        assertEq(factory.provenCheats(seller), 0);
    }

    function test_complaint_outsideWindow_reverts() public {
        _fundViaTreasury(e, t);
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadStatus.selector, IOverflowEscrow.Status.Funded));
        _complainBad();
        _reveal(e);
        vm.warp(e.challengeEnd());
        vm.expectRevert(IOverflowEscrow.ChallengeClosed.selector);
        _complainBad();
        // an unchallenged cheat pays out: the window is the buyer's responsibility
        e.finalizePayout();
        assertEq(_bal(seller), AMOUNT + BOND);
        assertEq(factory.provenCheats(seller), 0);
    }

    function test_complaint_afterRefund_reverts() public {
        _fundedAndRevealed();
        _complainBad();
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadStatus.selector, IOverflowEscrow.Status.Refunded));
        _complainBad();
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadStatus.selector, IOverflowEscrow.Status.Refunded));
        e.finalizePayout();
        assertEq(factory.provenCheats(seller), 1, "flagged once");
    }

    function test_tamperedCipherChunk_reverts() public {
        _fundedAndRevealed();
        bytes memory forged = _chunk(0xAB); // not in the committed cipher tree
        vm.expectRevert(IOverflowEscrow.BadProof.selector);
        e.complainMismatch(BAD, forged, _proof(cheatCipherLeaves, BAD), plainLeaves[BAD], _proof(plainLeaves, BAD));
        // a plain leaf that is not in the plain tree
        vm.expectRevert(IOverflowEscrow.BadProof.selector);
        e.complainMismatch(BAD, cheatCipher, _proof(cheatCipherLeaves, BAD), keccak256("x"), _proof(plainLeaves, BAD));
    }

    /// Internal-node-as-leaf with real commitments: node(leaf0, leaf1) with a one-element proof is refused by the
    /// exact-length rule; padded to two elements it fails the domain-separated hash check.
    function test_internalNodeAsLeaf_reverts() public {
        _fundedAndRevealed();
        bytes32 node01 = MerkleLib.node(plainLeaves[0], plainLeaves[1]);
        bytes32 node23 = MerkleLib.node(plainLeaves[2], plainLeaves[3]);
        assertEq(MerkleLib.node(node01, node23), t.rootPlain);
        bytes32[] memory one = new bytes32[](1);
        one[0] = node23;
        vm.expectRevert(abi.encodeWithSelector(IOverflowEscrow.BadProofLength.selector, 2, 1));
        e.complainMismatch(0, _cipher(0), _proof(cheatCipherLeaves, 0), node01, one);
        bytes32[] memory two = new bytes32[](2);
        two[0] = node23;
        vm.expectRevert(IOverflowEscrow.BadProof.selector);
        e.complainMismatch(0, _cipher(0), _proof(cheatCipherLeaves, 0), node01, two);
    }

    function test_flaggedSeller_blockedByTreasury() public {
        // an order opened before the proof exists; after the proof no node may pay it
        IOverflowEscrow.OrderTerms memory t2 = _terms(AMOUNT, 0, 2);
        t2.orderId = keccak256("second order");
        t2.termsHash = factory.termsHashOf(t2);
        OverflowEscrow e2 = _create(t2);

        _fundedAndRevealed();
        _complainBad();
        assertEq(factory.provenCheats(seller), 1);
        _expectPayRevert(
            rootPk, address(e2), AMOUNT, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
        Auth memory a = _auth(rootPk, address(e2), AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller));
        treasury.reserve(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);

        // nor directly, even if allowlisted
        vm.prank(owner);
        treasury.setAllow(seller, true);
        _expectPayRevert(
            rootPk, seller, U / 100, abi.encodeWithSelector(IOverflowTreasury.PayeeFlagged.selector, seller)
        );
        assertEq(treasury.getNode(1).spent, AMOUNT, "no new charge");
    }

    /// A reservation approved while the order was open cannot execute after the cheat refund: USDC refuses it (the
    /// gate reads the Refunded status), the flagged seller receives nothing, the refund is unchanged, and
    /// releaseClosed() returns the reservation's charge.
    function test_closedEscrow_afterCheatRefund_usdcRejectsReservedAuthorization() public {
        Auth memory late = _auth(rootPk, address(e), AMOUNT);
        bytes32 digest = treasury.reserve(late.to, late.value, late.validAfter, late.validBefore, late.nonce, late.sig);
        uint256 treasuryBefore = _bal(address(treasury));
        _fundedAndRevealed();
        vm.prank(attacker);
        _complainBad();
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        assertEq(_bal(address(treasury)), treasuryBefore + BOND);
        assertEq(factory.provenCheats(seller), 1);

        vm.prank(attacker);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        usdc.transferWithAuthorization(
            address(treasury), late.to, late.value, late.validAfter, late.validBefore, late.nonce, late.sig
        );
        assertEq(_bal(address(e)), 0, "nothing stranded");
        assertEq(_bal(address(treasury)), treasuryBefore + BOND, "refund untouched");
        assertEq(_bal(seller), 0, "flagged seller gets nothing");
        assertFalse(usdc.authorizationState(address(treasury), late.nonce));

        treasury.releaseClosed(digest);
        assertEq(treasury.getNode(1).spent, AMOUNT, "only the funding authorization stays charged");
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
    }
}
