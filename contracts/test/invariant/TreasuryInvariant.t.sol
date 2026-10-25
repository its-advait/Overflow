// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {EscrowBaseTest} from "../escrow/EscrowBase.t.sol";
import {OverflowTreasury} from "../../src/OverflowTreasury.sol";
import {IOverflowTreasury} from "../../src/IOverflowTreasury.sol";
import {OverflowEscrowFactory} from "../../src/OverflowEscrowFactory.sol";
import {IOverflowEscrowFactory} from "../../src/IOverflowEscrowFactory.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {IUSDC, UsdcV22} from "../usdc/UsdcV22.sol";

/// Random walk over the treasury and its escrows: settle, reserve, execute/release reservations, pause, delegate,
/// create and fund escrows, drive them to payout or refund, and flag sellers. Reverts are swallowed; the handler
/// keeps ghost totals the invariants compare against.
contract TreasuryHandler is Test {
    bytes32 constant TWA_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 constant CREATE_CHILD_TYPEHASH = keccak256(
        "CreateChild(uint256 parentId,address key,uint256 cap,uint256 maxPerCall,uint256 expiry,bool restricted,bytes32 payeesHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant PAUSE_CHILD_TYPEHASH = keccak256("PauseChild(uint256 target,uint256 nonce,uint256 deadline)");
    uint256 constant MAX_NODES = 10;
    uint256 constant MAX_ESCROWS = 12;

    OverflowTreasury immutable treasury;
    OverflowEscrowFactory immutable factory;
    IUSDC immutable usdc;
    address immutable usdcOwner;
    address immutable owner;
    address immutable facilitator = makeAddr("facilitator");
    bytes32 immutable key;

    address[] public payees; // globally allowlisted direct payees
    address[] public sellers; // SIMULATED sellers (test addresses)
    mapping(uint256 nodeId => uint256 pk) public pkOf;
    uint256 nonceCounter;

    struct Res {
        bytes32 digest;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes sig;
        bool executed;
        bool released;
    }

    Res[] public reservations;
    OverflowEscrow[] public escrows;
    mapping(address escrow => IOverflowEscrow.Status) public lastStatus;
    mapping(address escrow => uint256) public terminalTransitions;

    // ghosts
    uint256 public executedPending; // USDC already pulled by facilitators for reservations not yet released
    mapping(address escrow => uint256) public lateDeposits; // reservation executed after the order closed (see PROGRESS)
    uint256 public paidToFlagged; // treasury authorizations that benefited a flagged seller (must stay 0)
    uint256 public settles;
    uint256 public reserves;
    uint256 public escrowsFunded;
    uint256 public sweeps;
    bool public sweptMoreThanLate; // a sweep moved USDC that no late reservation explains (must stay false)

    constructor(
        OverflowTreasury treasury_,
        OverflowEscrowFactory factory_,
        IUSDC usdc_,
        address usdcOwner_,
        address owner_,
        uint256 rootPk,
        bytes32 key_,
        address[] memory payees_
    ) {
        treasury = treasury_;
        factory = factory_;
        usdc = usdc_;
        usdcOwner = usdcOwner_;
        owner = owner_;
        key = key_;
        payees = payees_;
        pkOf[1] = rootPk;
        for (uint256 i; i < 3; i++) {
            sellers.push(makeAddr(string(abi.encodePacked("simulatedSeller", bytes1(uint8(0x30 + i))))));
        }
    }

    // ------------------------------------------------------------ helpers

    function _node(uint256 seed) internal view returns (uint256 id) {
        return bound(seed, 1, treasury.nodeCount());
    }

    function _flaggedBeneficiary(address to) internal view returns (bool) {
        address seller = factory.isEscrow(to) ? OverflowEscrow(to).seller() : to;
        return factory.provenCheats(seller) != 0;
    }

    function _twaDigest(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 sh = keccak256(abi.encode(TWA_TYPEHASH, address(treasury), to, value, validAfter, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), sh));
    }

    function _sign(uint256 pk, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Payee for an authorization: a direct allowlisted payee, an escrow (value forced to its amount) or a seller
    /// address directly (never allowlisted; must revert).
    function _target(uint256 seed, uint256 valueSeed) internal view returns (address to, uint256 value) {
        uint256 kind = seed % 8;
        if (kind <= 4 || escrows.length == 0) {
            to = payees[(seed / 8) % payees.length];
            value = bound(valueSeed, 1, 1.05e5); // root maxPerCall is 1e5: a few must revert OverPerCall
        } else if (kind <= 6) {
            OverflowEscrow e = escrows[(seed / 8) % escrows.length];
            to = address(e);
            value = e.amount();
        } else {
            to = sellers[(seed / 8) % sellers.length]; // never allowlisted: must revert
            value = bound(valueSeed, 1, 1.05e5);
        }
    }

    function _track(OverflowEscrow e) internal {
        IOverflowEscrow.Status s = e.status();
        if (s != lastStatus[address(e)]) {
            if (s == IOverflowEscrow.Status.Settled || s == IOverflowEscrow.Status.Refunded) {
                terminalTransitions[address(e)]++;
            }
            lastStatus[address(e)] = s;
        }
    }

    // ------------------------------------------------------------ treasury actions

    function settle(uint256 nodeSeed, uint256 targetSeed, uint256 valueSeed) external {
        uint256 id = _node(nodeSeed);
        (address to, uint256 value) = _target(targetSeed, valueSeed);
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 120;
        bytes32 nonce = keccak256(abi.encode("inv settle", ++nonceCounter));
        bytes memory sig = _sign(pkOf[id], _twaDigest(to, value, validAfter, validBefore, nonce));
        bool flagged = _flaggedBeneficiary(to);
        try treasury.settle(to, value, validAfter, validBefore, nonce, sig) {
            settles++;
            if (flagged) paidToFlagged++;
        } catch {}
    }

    function reserve(uint256 nodeSeed, uint256 targetSeed, uint256 valueSeed, uint256 windowSeed) external {
        uint256 id = _node(nodeSeed);
        (address to, uint256 value) = _target(targetSeed, valueSeed);
        Res memory r;
        r.to = to;
        r.value = value;
        r.validAfter = block.timestamp - 1;
        r.validBefore = block.timestamp + bound(windowSeed, 1, 700); // 600 is the window; longer must revert
        r.nonce = keccak256(abi.encode("inv reserve", ++nonceCounter));
        r.sig = _sign(pkOf[id], _twaDigest(to, value, r.validAfter, r.validBefore, r.nonce));
        bool flagged = _flaggedBeneficiary(to);
        vm.prank(facilitator);
        try treasury.reserve(to, value, r.validAfter, r.validBefore, r.nonce, r.sig) returns (bytes32 digest) {
            r.digest = digest;
            reservations.push(r);
            reserves++;
            if (flagged) paidToFlagged++;
        } catch {}
    }

    /// The facilitator submits a reserved authorization straight to USDC; the ERC-1271 gate decides.
    function executeReservation(uint256 seed) external {
        if (reservations.length == 0) return;
        Res storage r = reservations[seed % reservations.length];
        if (r.executed) return;
        vm.prank(facilitator);
        try usdc.transferWithAuthorization(
            address(treasury), r.to, r.value, r.validAfter, r.validBefore, r.nonce, r.sig
        ) {
            r.executed = true;
            if (!r.released) executedPending += r.value;
            if (factory.isEscrow(r.to)) {
                IOverflowEscrow.Status st = OverflowEscrow(r.to).status();
                if (st == IOverflowEscrow.Status.Settled || st == IOverflowEscrow.Status.Refunded) {
                    lateDeposits[r.to] += r.value; // approved while open, executed after the order closed
                }
            }
        } catch {}
    }

    function release(uint256 seed) external {
        if (reservations.length == 0) return;
        Res storage r = reservations[seed % reservations.length];
        if (r.released) return;
        try treasury.release(r.digest) {
            r.released = true;
            if (r.executed) executedPending -= r.value;
        } catch {}
    }

    function warp(uint256 dt) external {
        vm.warp(block.timestamp + bound(dt, 1, 20 minutes));
    }

    /// Owner pauses rarely (a paused root starves every other action) and unpauses often.
    function ownerPause(uint256 nodeSeed, uint256 onSeed) external {
        uint256 id = _node(nodeSeed);
        vm.prank(owner);
        if (onSeed % 5 == 0) treasury.pause(id);
        else treasury.unpause(id);
    }

    /// The root key pauses a descendant (root is a strict ancestor of every other node). Rare, like ownerPause.
    function pauseChild(uint256 targetSeed) external {
        if (targetSeed % 5 != 0) return;
        uint256 target = _node(targetSeed / 5);
        uint256 nonce = ++nonceCounter;
        uint256 deadline = block.timestamp + 60;
        bytes32 sh = keccak256(abi.encode(PAUSE_CHILD_TYPEHASH, target, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", treasury.DELEGATION_DOMAIN_SEPARATOR(), sh));
        try treasury.pauseChild(target, nonce, deadline, _sign(pkOf[1], digest)) {} catch {}
    }

    function delegate(uint256 parentSeed, uint256 capSeed, uint256 mpcSeed, bool restricted) external {
        if (treasury.nodeCount() >= MAX_NODES) return;
        uint256 pid = _node(parentSeed);
        IOverflowTreasury.Node memory p = treasury.getNode(pid);
        IOverflowTreasury.ChildParams memory c;
        c.parentId = pid;
        uint256 childPk = 0xC0DE00 + treasury.nodeCount() + 1;
        c.key = vm.addr(childPk);
        c.cap = bound(capSeed, 0, p.cap + p.cap / 10); // sometimes exceeds the parent: must revert
        c.maxPerCall = bound(mpcSeed, 0, p.maxPerCall + 1);
        c.expiry = p.expiry;
        c.restricted = restricted;
        c.payees = new address[](restricted ? 1 : 0);
        if (restricted) c.payees[0] = payees[0];
        c.nonce = ++nonceCounter;
        c.deadline = block.timestamp + 60;
        bytes32 sh = keccak256(
            abi.encode(
                CREATE_CHILD_TYPEHASH,
                c.parentId,
                c.key,
                c.cap,
                c.maxPerCall,
                c.expiry,
                c.restricted,
                keccak256(abi.encodePacked(c.payees)),
                c.nonce,
                c.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", treasury.DELEGATION_DOMAIN_SEPARATOR(), sh));
        try treasury.createChild(c, _sign(pkOf[pid], digest)) returns (uint256 id) {
            pkOf[id] = childPk;
        } catch {}
    }

    function fundTreasury(uint256 amt) external {
        UsdcV22.mint(usdc, usdcOwner, address(treasury), bound(amt, 1, 1e6));
    }

    // ------------------------------------------------------------ escrow actions

    function createEscrow(uint256 sellerSeed, uint256 amountSeed, uint256 bondSeed, uint256 windowSeed) external {
        if (escrows.length >= MAX_ESCROWS) return;
        IOverflowEscrow.OrderTerms memory t;
        t.orderId = keccak256(abi.encode("inv order", escrows.length, ++nonceCounter));
        t.buyer = address(treasury);
        t.seller = sellers[sellerSeed % sellers.length];
        t.token = address(usdc);
        t.amount = bound(amountSeed, 1, 1.2e5); // root maxPerCall is 1e5: some orders are unpayable
        t.bond = bound(bondSeed, 0, 2e4);
        t.manifestHash = keccak256("inv manifest");
        t.rootPlain = keccak256("inv rootPlain");
        t.rootCipher = keccak256("inv rootCipher");
        t.keyCommitment = keccak256(abi.encodePacked(key));
        t.revealDeadline = uint64(block.timestamp + bound(windowSeed, 5 minutes, 2 hours));
        t.challengeWindow = uint64(bound(windowSeed >> 8, 1 minutes, 30 minutes));
        t.chunkCount = 1;
        t.termsHash = factory.termsHashOf(t);
        try factory.create(t) returns (address e) {
            escrows.push(OverflowEscrow(e));
            if (t.bond > 0) UsdcV22.mint(usdc, usdcOwner, e, t.bond); // the seller stakes the bond
        } catch {}
    }

    function _escrow(uint256 seed) internal view returns (OverflowEscrow e, bool ok) {
        if (escrows.length == 0) return (e, false);
        return (escrows[seed % escrows.length], true);
    }

    function markFunded(uint256 seed) external {
        (OverflowEscrow e, bool ok) = _escrow(seed);
        if (!ok) return;
        try e.markFunded() {
            escrowsFunded++;
        } catch {}
        _track(e);
    }

    function reveal(uint256 seed, bool correct) external {
        (OverflowEscrow e, bool ok) = _escrow(seed);
        if (!ok) return;
        vm.prank(e.seller());
        try e.revealKey(correct ? key : keccak256("wrong")) {} catch {}
        _track(e);
    }

    function accept(uint256 seed, uint256 nodeSeed) external {
        (OverflowEscrow e, bool ok) = _escrow(seed);
        if (!ok) return;
        uint256 pk = pkOf[_node(nodeSeed)];
        try e.accept(_sign(pk, e.acceptDigest())) {} catch {}
        _track(e);
    }

    function finalize(uint256 seed) external {
        (OverflowEscrow e, bool ok) = _escrow(seed);
        if (!ok) return;
        try e.finalizePayout() {} catch {}
        _track(e);
    }

    function timeoutRefund(uint256 seed) external {
        (OverflowEscrow e, bool ok) = _escrow(seed);
        if (!ok) return;
        try e.claimTimeoutRefund() {} catch {}
        _track(e);
    }

    /// Anyone returns USDC that reached a closed escrow (a late-executed reservation) to the treasury.
    function sweepEscrow(uint256 seed) external {
        (OverflowEscrow e, bool ok) = _escrow(seed);
        if (!ok) return;
        try e.sweep() returns (uint256 s) {
            sweeps++;
            if (s > lateDeposits[address(e)]) sweptMoreThanLate = true;
            else lateDeposits[address(e)] -= s;
        } catch {}
        _track(e);
    }

    /// SIMULATED proven cheat: an existing escrow records a cheat against a seller, standing in for a successful
    /// complainMismatch/complainPromise (those paths are proven in EscrowMismatch/EscrowPromise tests).
    function flagSeller(uint256 seed) external {
        if (escrows.length == 0 || seed % 3 != 0) return;
        address seller = sellers[seed % sellers.length];
        vm.prank(address(escrows[(seed >> 8) % escrows.length]));
        factory.recordCheat(seller);
    }

    // ------------------------------------------------------------ views for invariants

    function reservationCount() external view returns (uint256) {
        return reservations.length;
    }

    function escrowCount() external view returns (uint256) {
        return escrows.length;
    }

    function sellerCount() external view returns (uint256) {
        return sellers.length;
    }
}

contract TreasuryInvariantTest is EscrowBaseTest {
    bytes4 constant MAGIC = 0x1626ba7e;
    bytes4 constant INVALID = 0xffffffff;

    TreasuryHandler handler;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        treasury.setEscrowFactory(address(factory));
        treasury.setFloor(U / 2);
        treasury.raiseCap(1, 20 * U); // the base harness's 1 USDC root cap would exhaust within a dozen payments
        vm.stopPrank();
        UsdcV22.mint(usdc, usdcOwner, address(treasury), 45 * U); // 50 USDC total
        address[] memory payees = new address[](2);
        payees[0] = payeeA;
        payees[1] = payeeB;
        handler = new TreasuryHandler(treasury, factory, usdc, usdcOwner, owner, rootPk, KEY, payees);
        targetContract(address(handler));
    }

    /// Coverage evidence after each run (visible with -vv): the handler must actually move money, not just revert.
    function afterInvariant() public view {
        console2.log(
            "settles/reserves/escrowsFunded/nodes/escrows/reservations",
            handler.settles(),
            handler.reserves(),
            handler.escrowsFunded()
        );
        console2.log(
            "nodes/escrows/reservations", treasury.nodeCount(), handler.escrowCount(), handler.reservationCount()
        );
    }

    /// Coverage guard, not an invariant: a deterministic 400-step walk must reach the interesting states, so a
    /// handler that silently degenerates into reverts cannot make the invariants pass vacuously.
    function test_handlerCoverage() public {
        for (uint256 i; i < 400; i++) {
            uint256 s = uint256(keccak256(abi.encode("coverage walk", i)));
            uint256 a = s % 16;
            if (a == 0) {
                handler.settle(s >> 8, s >> 16, s >> 24);
            } else if (a == 1) {
                handler.reserve(s >> 8, s >> 16, s >> 24, s >> 32);
            } else if (a == 2) {
                handler.executeReservation(s >> 8);
            } else if (a == 3) {
                handler.release(s >> 8);
            } else if (a == 4) {
                handler.warp(s >> 8);
            } else if (a == 5) {
                handler.ownerPause(s >> 8, s >> 16);
            } else if (a == 6) {
                handler.pauseChild(s >> 8);
            } else if (a == 7) {
                handler.delegate(s >> 8, s >> 16, s >> 24, (s >> 32) % 2 == 0);
            } else if (a == 8) {
                handler.fundTreasury(s >> 8);
            } else if (a == 9) {
                handler.createEscrow(s >> 8, s >> 16, s >> 24, s >> 32);
            } else if (a == 10) {
                handler.markFunded(s >> 8);
            } else if (a == 11) {
                handler.reveal(s >> 8, (s >> 16) % 3 != 0);
            } else if (a == 12) {
                handler.accept(s >> 8, s >> 16);
            } else if (a == 13) {
                handler.finalize(s >> 8);
            } else if (a == 14) {
                handler.timeoutRefund(s >> 8);
            } else {
                handler.flagSeller(s >> 8);
                handler.sweepEscrow(s >> 16);
            }
        }
        assertGt(handler.settles(), 8, "settles");
        assertGt(handler.reserves(), 3, "reserves");
        assertGt(handler.escrowsFunded(), 1, "escrows funded by the treasury");
        assertGt(treasury.nodeCount(), 2, "delegations");
        assertGt(handler.reservationCount(), 0);
        uint256 terminal;
        for (uint256 i; i < handler.escrowCount(); i++) {
            IOverflowEscrow.Status st = handler.escrows(i).status();
            if (st == IOverflowEscrow.Status.Settled || st == IOverflowEscrow.Status.Refunded) terminal++;
        }
        assertGt(terminal, 0, "some escrow reached a terminal state");
        uint256 flagged;
        for (uint256 i; i < handler.sellerCount(); i++) {
            if (factory.provenCheats(handler.sellers(i)) != 0) flagged++;
        }
        assertGt(flagged, 0, "some seller flagged");
        // and the invariants hold at the end of the walk
        invariant_spentWithinCapAndCoversChildren();
        invariant_balanceCoversFloorAndReservations();
        invariant_reservedTotalMatchesLiveReservations();
        invariant_gateOpensOnlyForUsdc();
        invariant_escrowsAtMostOneTerminal();
        invariant_flaggedSellersNeverPaid();
    }

    /// spent <= cap on every node, and a node's spent covers the sum of its children's spent (children charge
    /// every ancestor).
    function invariant_spentWithinCapAndCoversChildren() public view {
        uint256 n = treasury.nodeCount();
        uint256[] memory childSum = new uint256[](n + 1);
        for (uint256 id = 1; id <= n; id++) {
            IOverflowTreasury.Node memory node = treasury.getNode(id);
            assertLe(node.spent, node.cap, "spent <= cap");
            if (node.parent != 0) childSum[node.parent] += node.spent;
        }
        for (uint256 id = 1; id <= n; id++) {
            assertGe(treasury.getNode(id).spent, childSum[id], "spent >= children's spent");
        }
    }

    /// Treasury USDC never dips below floor + reservedTotal, counting reserved funds a facilitator has already
    /// pulled but not yet released (they stay in reservedTotal until release()).
    function invariant_balanceCoversFloorAndReservations() public view {
        assertGe(
            usdc.balanceOf(address(treasury)) + handler.executedPending(),
            treasury.floor() + treasury.reservedTotal(),
            "balance >= floor + reservedTotal"
        );
    }

    /// reservedTotal is exactly the sum of stored, unreleased reservations.
    function invariant_reservedTotalMatchesLiveReservations() public view {
        uint256 sum;
        for (uint256 i; i < handler.reservationCount(); i++) {
            (,, uint256 value,,,,,, bool released) = handler.reservations(i);
            if (!released) sum += value;
        }
        assertEq(treasury.reservedTotal(), sum);
    }

    /// The ERC-1271 gate answers MAGIC only to USDC, only for a live reservation digest; never to anyone else and
    /// never for an unknown digest.
    function invariant_gateOpensOnlyForUsdc() public {
        for (uint256 i; i < handler.reservationCount(); i++) {
            (bytes32 digest,,,, uint256 validBefore,,,, bool released) = handler.reservations(i);
            bool live = !released && block.timestamp < validBefore;
            vm.prank(address(usdc));
            assertEq(treasury.isValidSignature(digest, ""), live ? MAGIC : INVALID, "USDC");
            vm.prank(attacker);
            assertEq(treasury.isValidSignature(digest, ""), INVALID, "non-token caller");
        }
        vm.prank(address(usdc));
        assertEq(treasury.isValidSignature(keccak256(abi.encode(block.timestamp)), ""), INVALID, "unknown digest");
    }

    /// Every escrow reaches at most one terminal state, holds zero USDC afterwards (the treasury refuses closed
    /// escrows as payees; a pre-approved reservation executed late is the one tracked exception), and a terminal
    /// status is final.
    function invariant_escrowsAtMostOneTerminal() public view {
        for (uint256 i; i < handler.escrowCount(); i++) {
            OverflowEscrow e = handler.escrows(i);
            assertLe(handler.terminalTransitions(address(e)), 1, "one terminal transition");
            IOverflowEscrow.Status s = e.status();
            if (s == IOverflowEscrow.Status.Settled || s == IOverflowEscrow.Status.Refunded) {
                assertEq(uint256(handler.lastStatus(address(e))), uint256(s), "terminal is final");
                // only a reservation approved while the order was open and executed after it closed may land here,
                // and sweep() returns exactly that to the treasury
                assertEq(_bal(address(e)), handler.lateDeposits(address(e)), "zero balance after terminal");
                assertFalse(handler.sweptMoreThanLate(), "sweep moved only late deposits");
            }
        }
    }

    /// The treasury never authorizes a payment (settle or reserve) that benefits a flagged seller, directly or via
    /// one of their escrows; the factory refuses new orders for them.
    function invariant_flaggedSellersNeverPaid() public {
        assertEq(handler.paidToFlagged(), 0, "no authorization for a flagged seller");
        for (uint256 i; i < handler.sellerCount(); i++) {
            address s = handler.sellers(i);
            if (factory.provenCheats(s) == 0) continue;
            IOverflowEscrow.OrderTerms memory t = _terms(AMOUNT, 0, 1);
            t.seller = s;
            t.orderId = keccak256(abi.encode("flagged probe", s, block.timestamp));
            t.termsHash = factory.termsHashOf(t);
            vm.expectRevert(abi.encodeWithSelector(IOverflowEscrowFactory.SellerFlagged.selector, s));
            factory.create(t);
        }
    }
}
