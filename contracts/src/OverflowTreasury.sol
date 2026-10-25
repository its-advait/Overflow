// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOverflowTreasury} from "./IOverflowTreasury.sol";
import {IOverflowEscrow} from "./IOverflowEscrow.sol";
import {IOverflowEscrowFactory} from "./IOverflowEscrowFactory.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal surface of USDC (FiatTokenV2_2) used by OverflowTreasury.
interface IUSDC {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function balanceOf(address account) external view returns (uint256);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    /// @dev bytes-signature overload, selector 0xcf092995 (ecrecover first, then ERC-1271 fallback).
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

/// @title OverflowTreasury
/// @notice Holds USDC for a tree of AI agent nodes. Agents sign standard EIP-3009 authorizations with
/// from = this treasury; settle() enforces the whole ancestor chain's rules, then flags the exact digest in
/// EIP-1153 transient storage so USDC's ERC-1271 callback accepts it only for the duration of that call.
/// @dev Ported from Leash's LeashWallet. Behavior unchanged except: constructor(token, owner), TOKEN naming,
/// delegation domain "Overflow"/"1", and the checks factored into _authorize().
contract OverflowTreasury is IOverflowTreasury, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)")
    bytes32 public constant TWA_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;

    bytes32 public constant CREATE_CHILD_TYPEHASH = keccak256(
        "CreateChild(uint256 parentId,address key,uint256 cap,uint256 maxPerCall,uint256 expiry,bool restricted,bytes32 payeesHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant PAUSE_CHILD_TYPEHASH =
        keccak256("PauseChild(uint256 target,uint256 nonce,uint256 deadline)");

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Overflow");
    bytes32 private constant VERSION_HASH = keccak256("1");

    /// Salt for the transient approval slot: slot = keccak256(abi.encode(APPROVAL_SALT, digest)).
    bytes32 public constant APPROVAL_SALT = keccak256("overflow.approval.v1");

    uint256 public constant MAX_DEPTH = 2;

    bytes4 private constant MAGIC_1271 = 0x1626ba7e;
    bytes4 private constant INVALID_1271 = 0xffffffff;

    // ---------------------------------------------------------------- storage

    address public immutable TOKEN;
    address public immutable owner;

    uint256 public floor;
    /// Factory whose escrows are valid payees (zero = escrows disabled).
    address public escrowFactory;
    /// Sum of live reservations; the floor check counts it so reserved USDC is never promised twice.
    uint256 public reservedTotal;
    /// Max seconds a reservation's validBefore may lie in the future (default 10 minutes).
    uint256 public reservationWindow = 600;
    uint256 private _nodeCount;

    mapping(bytes32 digest => Reservation) private _reservations;

    mapping(uint256 => Node) private _nodes;
    mapping(address key => uint256) public nodeOfKey;
    mapping(address payee => bool) public allowlist;
    mapping(uint256 id => mapping(address payee => bool)) public nodeAllow;
    mapping(bytes32 structHash => bool) public usedDelegation;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token, address owner_) {
        TOKEN = token;
        owner = owner_;
    }

    // ---------------------------------------------------------------- payments

    /// @inheritdoc IOverflowTreasury
    /// @dev Check order is normative (docs/SPEC.md "settle() check order"): do not reorder.
    function settle(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        // 1. Exact digest USDC will compute for this authorization (from = this treasury).
        bytes32 digest = _twaDigest(to, value, validAfter, validBefore, nonce);

        // 2. Signer (OZ ECDSA: low-s enforced, reverts on malformed sigs).
        address signer = ECDSA.recoverCalldata(digest, signature);

        // 3-6. Policy checks and charge; any revert leaves no partial charge.
        uint256 id = _authorize(to, value, digest, signer);

        // 7. Approve exactly this digest for the duration of the token call only.
        bytes32 slot = _approvalSlot(digest);
        assembly ("memory-safe") {
            tstore(slot, 1)
        }
        IUSDC(TOKEN).transferWithAuthorization(address(this), to, value, validAfter, validBefore, nonce, signature);
        assembly ("memory-safe") {
            tstore(slot, 0)
        }

        // 8.
        emit Paid(id, to, value, nonce);
    }

    /// @inheritdoc IOverflowTreasury
    /// @dev Same checks and charges as settle() (steps 1-6), but the token call is left to a third party. The
    /// stored reservation makes isValidSignature accept exactly this digest until validBefore.
    function reserve(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant returns (bytes32 digest) {
        digest = _twaDigest(to, value, validAfter, validBefore, nonce);
        address signer = ECDSA.recoverCalldata(digest, signature);
        if (validBefore > block.timestamp + reservationWindow) revert ReservationTooLong();
        if (_reservations[digest].validBefore != 0) revert ReservationActive();

        uint256 id = _authorize(to, value, digest, signer);

        _reservations[digest] = Reservation({nodeId: id, value: value, validBefore: validBefore, nonce: nonce});
        reservedTotal += value;
        emit Reserved(digest, id, to, value, validBefore, nonce);
    }

    /// @inheritdoc IOverflowTreasury
    /// @dev If USDC never consumed the nonce, the money never moved, so the charge is reversed up the chain.
    /// This is the only path that restores an agent's allowance (escrow refunds restore USDC, not allowance).
    function release(bytes32 digest) external nonReentrant {
        Reservation memory r = _reservations[digest];
        if (r.validBefore == 0) revert NoReservation();
        if (block.timestamp < r.validBefore) revert ReservationLive();

        bool refunded = !IUSDC(TOKEN).authorizationState(address(this), r.nonce);
        if (refunded) {
            uint256 n = r.nodeId;
            while (n != 0) {
                Node storage node = _nodes[n];
                node.spent -= r.value;
                n = node.parent;
            }
        }
        reservedTotal -= r.value;
        delete _reservations[digest];
        emit ReservationReleased(digest, refunded);
    }

    /// @notice ERC-1271. Valid ONLY when called by USDC, and only for a digest flagged inside settle() or
    /// held by a live reservation. View + TLOAD/SLOAD only (TSTORE is illegal under STATICCALL). The treasury
    /// therefore can never sign permits or anything else it has not checked and charged.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        signature; // unused: USDC already verified the agent's ECDSA sig; we gate on the flagged digest only
        if (msg.sender != TOKEN) return INVALID_1271;
        bytes32 slot = _approvalSlot(digest);
        uint256 flag;
        assembly ("memory-safe") {
            flag := tload(slot)
        }
        if (flag == 1) return MAGIC_1271;
        Reservation storage r = _reservations[digest];
        if (r.validBefore != 0 && block.timestamp < r.validBefore) return MAGIC_1271;
        return INVALID_1271;
    }

    /// @dev Steps 3 to 6 of settle(): signer -> node, global allowlist, walk to the root checking and charging
    /// every ancestor, then the balance floor. Returns the signer's node id. `digest` is accepted so the
    /// reservation path (P1.5) can reuse these checks against the same authorization digest.
    function _authorize(address to, uint256 value, bytes32 digest, address signer) internal returns (uint256 id) {
        digest; // reserved for reservations; the checks below do not depend on it

        // 3. Signer must be a known node key.
        id = nodeOfKey[signer];
        if (id == 0) revert UnknownAgent(signer);

        // 4. Payee: global allowlist, or a factory escrow bought by this treasury with an unflagged seller and
        //    the exact order amount. Flagged sellers revert on both paths. `payee` is what restricted nodes
        //    are checked against in step 5: the direct payee, or the escrow's seller.
        address payee = to;
        if (allowlist[to]) {
            if (escrowFactory != address(0) && IOverflowEscrowFactory(escrowFactory).provenCheats(to) != 0) {
                revert PayeeFlagged(to);
            }
        } else {
            if (escrowFactory == address(0) || !IOverflowEscrowFactory(escrowFactory).isEscrow(to)) {
                revert PayeeNotAllowed(0);
            }
            IOverflowEscrow escrow = IOverflowEscrow(to);
            if (escrow.buyer() != address(this)) revert PayeeNotAllowed(0);
            payee = escrow.seller();
            if (IOverflowEscrowFactory(escrowFactory).provenCheats(payee) != 0) revert PayeeFlagged(payee);
            uint256 amount = escrow.amount();
            if (value != amount) revert EscrowAmountMismatch(to, amount, value);
        }

        // 5. Check and charge every node from the signer up to the root.
        uint256 n = id;
        while (n != 0) {
            Node storage node = _nodes[n];
            if (node.paused) revert Paused(n);
            if (block.timestamp >= node.expiry) revert Expired(n);
            if (value > node.maxPerCall) revert OverPerCall(n);
            if (node.restricted && !nodeAllow[n][payee]) revert PayeeNotAllowed(n);
            if (node.spent + value > node.cap) revert OverBudget(n);
            node.spent += value;
            n = node.parent;
        }

        // 6. Balance floor, counting USDC already promised to live reservations.
        if (IUSDC(TOKEN).balanceOf(address(this)) < value + floor + reservedTotal) revert BelowFloor();
    }

    // ---------------------------------------------------------------- tree

    /// @inheritdoc IOverflowTreasury
    function createRoot(address key, uint256 cap, uint256 maxPerCall, uint256 expiry)
        external
        onlyOwner
        returns (uint256 id)
    {
        _checkKey(key);
        id = ++_nodeCount;
        _nodes[id] = Node({
            key: key,
            parent: 0,
            depth: 0,
            cap: cap,
            spent: 0,
            maxPerCall: maxPerCall,
            expiry: expiry,
            paused: false,
            restricted: false
        });
        nodeOfKey[key] = id;
        emit NodeCreated(id, 0, key, cap, maxPerCall, expiry);
    }

    /// @inheritdoc IOverflowTreasury
    function createChild(ChildParams calldata c, bytes calldata parentSig) external returns (uint256 id) {
        if (block.timestamp > c.deadline) revert BadDelegation();
        uint256 pid = c.parentId;
        if (pid == 0 || pid > _nodeCount) revert BadDelegation();

        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_CHILD_TYPEHASH,
                pid,
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
        if (usedDelegation[structHash]) revert BadDelegation();

        Node storage parent = _nodes[pid];
        address signer = ECDSA.recoverCalldata(_delegationDigest(structHash), parentSig);
        if (signer != parent.key) revert BadDelegation();

        if (parent.paused) revert Paused(pid);
        if (block.timestamp >= parent.expiry) revert Expired(pid);
        if (parent.depth + 1 > MAX_DEPTH) revert TooDeep();
        if (c.cap > parent.cap || c.maxPerCall > parent.maxPerCall || c.expiry > parent.expiry) {
            revert ChildExceedsParent();
        }
        _checkKey(c.key);

        usedDelegation[structHash] = true;

        id = ++_nodeCount;
        _nodes[id] = Node({
            key: c.key,
            parent: pid,
            depth: parent.depth + 1,
            cap: c.cap,
            spent: 0,
            maxPerCall: c.maxPerCall,
            expiry: c.expiry,
            paused: false,
            restricted: c.restricted
        });
        nodeOfKey[c.key] = id;

        bool parentRestricted = parent.restricted;
        for (uint256 i = 0; i < c.payees.length; ++i) {
            address p = c.payees[i];
            // A restricted parent's child may only list payees the parent allows.
            if (parentRestricted && !nodeAllow[pid][p]) revert ChildExceedsParent();
            nodeAllow[id][p] = true;
        }

        emit NodeCreated(id, pid, c.key, c.cap, c.maxPerCall, c.expiry);
    }

    /// @inheritdoc IOverflowTreasury
    function pauseChild(uint256 target, uint256 nonce, uint256 deadline, bytes calldata ancestorSig) external {
        if (block.timestamp > deadline) revert BadDelegation();
        if (target == 0 || target > _nodeCount) revert NotAncestor();

        bytes32 structHash = keccak256(abi.encode(PAUSE_CHILD_TYPEHASH, target, nonce, deadline));
        if (usedDelegation[structHash]) revert BadDelegation();

        address signer = ECDSA.recoverCalldata(_delegationDigest(structHash), ancestorSig);
        uint256 signerId = nodeOfKey[signer];
        if (signerId == 0) revert NotAncestor();

        // signer must be a STRICT ancestor of target
        uint256 n = _nodes[target].parent;
        while (n != 0 && n != signerId) {
            n = _nodes[n].parent;
        }
        if (n == 0) revert NotAncestor();

        usedDelegation[structHash] = true;
        _nodes[target].paused = true;
        emit NodePaused(target, signer);
    }

    // ---------------------------------------------------------------- owner

    function pause(uint256 id) external onlyOwner {
        _checkExists(id);
        _nodes[id].paused = true;
        emit NodePaused(id, msg.sender);
    }

    function unpause(uint256 id) external onlyOwner {
        _checkExists(id);
        _nodes[id].paused = false;
        emit NodeUnpaused(id);
    }

    function raiseCap(uint256 id, uint256 newCap) external onlyOwner {
        _checkExists(id);
        uint256 oldCap = _nodes[id].cap;
        _nodes[id].cap = newCap;
        emit CapRaised(id, oldCap, newCap);
    }

    function setAllow(address payee, bool allowed) external onlyOwner {
        allowlist[payee] = allowed;
        emit AllowSet(payee, allowed);
    }

    function setFloor(uint256 newFloor) external onlyOwner {
        floor = newFloor;
    }

    /// @inheritdoc IOverflowTreasury
    function setEscrowFactory(address factory) external onlyOwner {
        escrowFactory = factory;
        emit EscrowFactorySet(factory);
    }

    /// @inheritdoc IOverflowTreasury
    function setReservationWindow(uint256 secondsMax) external onlyOwner {
        reservationWindow = secondsMax;
        emit ReservationWindowSet(secondsMax);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        IERC20(TOKEN).safeTransfer(to, amount);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IOverflowTreasury
    function getReservation(bytes32 digest) external view returns (Reservation memory) {
        return _reservations[digest];
    }

    function getNode(uint256 id) external view returns (Node memory) {
        return _nodes[id];
    }

    /// @notice min over self and every ancestor of (cap - spent), saturating at 0. 0 for unknown ids.
    function remaining(uint256 id) external view returns (uint256) {
        if (id == 0 || id > _nodeCount) return 0;
        uint256 r = type(uint256).max;
        uint256 n = id;
        while (n != 0) {
            Node storage node = _nodes[n];
            uint256 left = node.cap > node.spent ? node.cap - node.spent : 0;
            if (left < r) r = left;
            n = node.parent;
        }
        return r;
    }

    function nodeCount() external view returns (uint256) {
        return _nodeCount;
    }

    function DELEGATION_DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    // ---------------------------------------------------------------- internal

    /// EIP-712 digest USDC computes for TransferWithAuthorization with from = this treasury.
    function _twaDigest(address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        private
        view
        returns (bytes32)
    {
        bytes32 structHash =
            keccak256(abi.encode(TWA_TYPEHASH, address(this), to, value, validAfter, validBefore, nonce));
        return keccak256(abi.encodePacked("\x19\x01", IUSDC(TOKEN).DOMAIN_SEPARATOR(), structHash));
    }

    function _approvalSlot(bytes32 digest) private pure returns (bytes32) {
        return keccak256(abi.encode(APPROVAL_SALT, digest));
    }

    function _delegationDigest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DELEGATION_DOMAIN_SEPARATOR(), structHash));
    }

    /// Key hygiene: not zero, not owner, not this treasury, not already a node key.
    function _checkKey(address key) private view {
        if (key == address(0) || key == owner || key == address(this) || nodeOfKey[key] != 0) revert KeyInUse();
    }

    function _checkExists(uint256 id) private view {
        if (id == 0 || id > _nodeCount) revert UnknownAgent(address(0));
    }
}
