// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OverflowTreasury} from "../../src/OverflowTreasury.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {OverflowEscrowFactory} from "../../src/OverflowEscrowFactory.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IUSDC} from "../usdc/UsdcV22.sol";

/// Live Base Sepolia USDC (0x036C...) through a freshly deployed treasury on a fork. Skipped unless the chain id
/// is 84532. Run: pnpm contracts:fork (needs BASE_SEPOLIA_RPC_URL). Balances come from deal(), never from a key.
contract UsdcGateForkTest is Test {
    IUSDC constant USDC = IUSDC(0x036CbD53842c5426634e7929541eC2318f3dCF7e);
    bytes32 constant EXPECTED_DOMAIN_SEPARATOR = 0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818;
    bytes32 constant TWA_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;
    uint256 constant U = 1e6;

    OverflowTreasury treasury;
    address owner = makeAddr("owner");
    address payee = makeAddr("payee");
    address attacker = makeAddr("attacker");
    address facilitator = makeAddr("facilitator");
    uint256 rootPk = 0xA11CE;
    uint256 nonceCounter;

    struct Auth {
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes sig;
    }

    function setUp() public {
        if (block.chainid != 84532) {
            vm.skip(true);
            return;
        }
        treasury = new OverflowTreasury(address(USDC), owner);
        deal(address(USDC), address(treasury), 5 * U);
        vm.startPrank(owner);
        treasury.setAllow(payee, true);
        treasury.createRoot(vm.addr(rootPk), 1 * U, U / 10, block.timestamp + 1 days);
        vm.stopPrank();
    }

    function _auth(address to, uint256 value, uint256 validBefore) internal returns (Auth memory a) {
        a.to = to;
        a.value = value;
        a.validAfter = block.timestamp - 5;
        a.validBefore = validBefore;
        a.nonce = keccak256(abi.encode("fork nonce", ++nonceCounter, block.timestamp));
        bytes32 sh =
            keccak256(abi.encode(TWA_TYPEHASH, address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(rootPk, digest);
        a.sig = abi.encodePacked(r, s, v);
    }

    function _settle(Auth memory a) internal {
        treasury.settle(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
    }

    function _direct(address sender, Auth memory a) internal {
        vm.prank(sender);
        USDC.transferWithAuthorization(address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
    }

    function test_fork_domain() public view {
        assertEq(USDC.name(), "USDC");
        assertEq(USDC.version(), "2");
        assertEq(USDC.decimals(), 6);
        assertEq(USDC.DOMAIN_SEPARATOR(), EXPECTED_DOMAIN_SEPARATOR);
        assertEq(treasury.TOKEN(), address(USDC));
    }

    function test_fork_settleMovesBalances() public {
        Auth memory a = _auth(payee, U / 20, block.timestamp + 120);
        uint256 before = USDC.balanceOf(address(treasury));
        vm.expectEmit(true, true, false, true, address(treasury));
        emit IOverflowTreasury.Paid(1, payee, U / 20, a.nonce);
        _settle(a);
        assertEq(USDC.balanceOf(address(treasury)), before - U / 20);
        assertEq(USDC.balanceOf(payee), U / 20);
        assertEq(treasury.getNode(1).spent, U / 20);
        assertTrue(USDC.authorizationState(address(treasury), a.nonce));
    }

    function test_fork_directBypassReverts() public {
        Auth memory a = _auth(payee, U / 20, block.timestamp + 120);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _direct(attacker, a);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        _direct(payee, a);
        assertEq(USDC.balanceOf(payee), 0);
        assertEq(treasury.getNode(1).spent, 0, "nothing charged");
    }

    function test_fork_replayRevertsWithoutDoubleCharge() public {
        Auth memory a = _auth(payee, U / 20, block.timestamp + 120);
        _settle(a);
        uint256 spent = treasury.getNode(1).spent;
        uint256 bal = USDC.balanceOf(address(treasury));
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        _settle(a);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        _direct(attacker, a);
        assertEq(treasury.getNode(1).spent, spent, "the failed replay left no charge");
        assertEq(USDC.balanceOf(address(treasury)), bal);
    }

    function test_fork_gateClosedOutsideSettle() public {
        Auth memory a = _auth(payee, U / 20, block.timestamp + 120);
        bytes32 sh =
            keccak256(abi.encode(TWA_TYPEHASH, address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", USDC.DOMAIN_SEPARATOR(), sh));
        vm.prank(address(USDC));
        assertEq(treasury.isValidSignature(digest, a.sig), INVALID, "USDC asking outside settle");
        vm.prank(attacker);
        assertEq(treasury.isValidSignature(digest, a.sig), INVALID, "anyone else");
        // a settle of a different authorization does not leave the gate open afterwards
        _settle(_auth(payee, U / 50, block.timestamp + 120));
        vm.prank(address(USDC));
        assertEq(treasury.isValidSignature(digest, a.sig), INVALID, "closed again after settle");
    }

    function test_fork_reservationLetsThirdPartySettle() public {
        Auth memory a = _auth(payee, U / 20, block.timestamp + 300);
        vm.prank(facilitator);
        bytes32 digest = treasury.reserve(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
        assertEq(treasury.reservedTotal(), U / 20);
        assertEq(treasury.getNode(1).spent, U / 20, "charged at reservation time");
        vm.prank(address(USDC));
        assertEq(treasury.isValidSignature(digest, a.sig), MAGIC, "live reservation");
        vm.prank(facilitator);
        assertEq(treasury.isValidSignature(digest, a.sig), INVALID, "only USDC may ask");

        uint256 before = USDC.balanceOf(address(treasury));
        _direct(facilitator, a); // the facilitator submits the agent's authorization straight to live USDC
        assertEq(USDC.balanceOf(address(treasury)), before - U / 20);
        assertEq(USDC.balanceOf(payee), U / 20);

        vm.warp(a.validBefore);
        vm.expectEmit(true, false, false, true, address(treasury));
        emit IOverflowTreasury.ReservationReleased(digest, false);
        treasury.release(digest);
        assertEq(treasury.reservedTotal(), 0);
        assertEq(treasury.getNode(1).spent, U / 20, "executed reservation stays charged");
    }

    /// A reservation approved for an open order, submitted to live USDC only after the order closed: USDC asks the
    /// treasury, the treasury reads the closed status, USDC reverts "invalid signature" and the nonce stays unused.
    /// releaseClosed() refunds the charge at once; sweep() still recovers USDC that arrives from outside.
    function test_fork_closedEscrow_usdcRejectsReservedAuthorization() public {
        OverflowEscrowFactory factory = new OverflowEscrowFactory();
        vm.prank(owner);
        treasury.setEscrowFactory(address(factory));
        IOverflowEscrow.OrderTerms memory t;
        t.orderId = keccak256("fork late order");
        t.buyer = address(treasury);
        t.seller = makeAddr("simulatedSeller");
        t.token = address(USDC);
        t.amount = U / 20;
        t.manifestHash = keccak256("manifest");
        t.rootPlain = keccak256("rootPlain");
        t.rootCipher = keccak256("rootCipher");
        t.keyCommitment = keccak256("key");
        t.revealDeadline = uint64(block.timestamp + 120);
        t.challengeWindow = 60;
        t.chunkCount = 1;
        t.termsHash = factory.termsHashOf(t);
        OverflowEscrow e = OverflowEscrow(factory.create(t));

        Auth memory a = _auth(address(e), U / 20, block.timestamp + 300);
        vm.prank(facilitator);
        bytes32 digest = treasury.reserve(a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
        assertTrue(treasury.getReservation(digest).toIsEscrow);
        vm.prank(address(USDC));
        assertEq(treasury.isValidSignature(digest, a.sig), MAGIC, "open order");
        vm.warp(t.revealDeadline);
        e.claimTimeoutRefund(); // nobody funded, nobody revealed
        assertEq(uint256(e.status()), uint256(IOverflowEscrow.Status.Refunded));
        vm.prank(address(USDC));
        assertEq(treasury.isValidSignature(digest, a.sig), INVALID, "closed order, validBefore still ahead");

        uint256 before = USDC.balanceOf(address(treasury));
        vm.prank(facilitator);
        vm.expectRevert(bytes("FiatTokenV2: invalid signature"));
        USDC.transferWithAuthorization(address(treasury), a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.sig);
        assertFalse(USDC.authorizationState(address(treasury), a.nonce), "nonce unused");
        assertEq(USDC.balanceOf(address(e)), 0, "nothing stranded");
        assertEq(USDC.balanceOf(address(treasury)), before);

        vm.prank(attacker);
        treasury.releaseClosed(digest);
        assertEq(treasury.getNode(1).spent, 0, "allowance back before validBefore");
        assertEq(treasury.reservedTotal(), 0);
        vm.expectRevert(IOverflowTreasury.NoReservation.selector);
        treasury.releaseClosed(digest);

        // defense in depth: an external transfer into the closed escrow is still sweepable
        deal(address(USDC), address(e), U / 50);
        assertEq(e.sweep(), U / 50);
        assertEq(USDC.balanceOf(address(treasury)), before + U / 50);
    }
}
