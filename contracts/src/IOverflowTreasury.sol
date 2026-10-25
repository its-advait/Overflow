// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice External interface of OverflowTreasury (LeashWallet ported; see docs/SPEC.md "Security core").
/// Node ids start at 1. Node id 0 means "none" (root parent) and "global" in PayeeNotAllowed(0).
/// Delegations are EIP-712 signed under {name "Overflow", version "1", chainId, verifyingContract = this}.
interface IOverflowTreasury {
    struct Node {
        address key;
        uint256 parent; // 0 for root
        uint256 depth; // root 0, child 1, grandchild 2
        uint256 cap; // token atomic units
        uint256 spent;
        uint256 maxPerCall;
        uint256 expiry; // unix seconds; Expired when block.timestamp >= expiry
        bool paused;
        bool restricted; // if true, payee must also be in nodeAllow[id]
    }

    /// Signed (EIP-712) by the PARENT node's key. Relayed by anyone (the service's /delegate).
    /// Typed struct: CreateChild(uint256 parentId,address key,uint256 cap,uint256 maxPerCall,uint256 expiry,bool restricted,bytes32 payeesHash,uint256 nonce,uint256 deadline)
    /// payeesHash = keccak256(abi.encodePacked(payees)) == viem keccak256(encodePacked(["address[]"], [payees]))
    struct ChildParams {
        uint256 parentId;
        address key;
        uint256 cap;
        uint256 maxPerCall;
        uint256 expiry;
        bool restricted;
        address[] payees;
        uint256 nonce;
        uint256 deadline;
    }

    // PauseChild(uint256 target,uint256 nonce,uint256 deadline) signed by a STRICT ANCESTOR node key of target.

    /// A payment that passed every settle() check and was charged, but is submitted to USDC by a third party
    /// (e.g. Coinbase's facilitator). isValidSignature accepts its digest while block.timestamp < validBefore.
    struct Reservation {
        uint256 nodeId;
        uint256 value;
        uint256 validBefore;
        bytes32 nonce;
    }

    error UnknownAgent(address signer);
    error PayeeNotAllowed(uint256 node);
    error OverPerCall(uint256 node);
    error OverBudget(uint256 node);
    error Expired(uint256 node);
    error Paused(uint256 node);
    error BelowFloor();
    error TooDeep();
    error ChildExceedsParent();
    error BadDelegation();
    error KeyInUse();
    error NotAncestor();
    error NotOwner();
    error PayeeFlagged(address seller);
    error EscrowAmountMismatch(address escrow, uint256 expected, uint256 actual);
    error EscrowClosed(address escrow); // settled or refunded: paying it would strand USDC
    error ReservationTooLong();
    error ReservationActive();
    error NoReservation();
    error ReservationLive();

    event NodeCreated(
        uint256 indexed id, uint256 indexed parent, address key, uint256 cap, uint256 maxPerCall, uint256 expiry
    );
    event Paid(uint256 indexed id, address indexed to, uint256 value, bytes32 nonce);
    event NodePaused(uint256 indexed id, address by);
    event NodeUnpaused(uint256 indexed id);
    event CapRaised(uint256 indexed id, uint256 oldCap, uint256 newCap);
    event AllowSet(address indexed payee, bool allowed);
    event EscrowFactorySet(address indexed factory);
    event Reserved(
        bytes32 indexed digest,
        uint256 indexed id,
        address indexed to,
        uint256 value,
        uint256 validBefore,
        bytes32 nonce
    );
    event ReservationReleased(bytes32 indexed digest, bool refunded);
    event ReservationWindowSet(uint256 secondsMax);

    // payments
    function settle(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
    function reserve(
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external returns (bytes32 digest);
    function release(bytes32 digest) external; // anyone, after validBefore
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4);

    // tree
    function createRoot(address key, uint256 cap, uint256 maxPerCall, uint256 expiry) external returns (uint256 id); // owner
    function createChild(ChildParams calldata c, bytes calldata parentSig) external returns (uint256 id); // anyone relays
    function pauseChild(uint256 target, uint256 nonce, uint256 deadline, bytes calldata ancestorSig) external; // anyone relays

    // owner
    function pause(uint256 id) external;
    function unpause(uint256 id) external;
    function raiseCap(uint256 id, uint256 newCap) external;
    function setAllow(address payee, bool allowed) external;
    function setFloor(uint256 newFloor) external;
    function withdraw(address to, uint256 amount) external;
    function setEscrowFactory(address factory) external;
    function setReservationWindow(uint256 secondsMax) external;

    // views
    function getNode(uint256 id) external view returns (Node memory);
    function remaining(uint256 id) external view returns (uint256); // min over self+ancestors of cap - spent
    function nodeCount() external view returns (uint256);
    function nodeOfKey(address key) external view returns (uint256);
    function allowlist(address payee) external view returns (bool);
    function nodeAllow(uint256 id, address payee) external view returns (bool);
    function usedDelegation(bytes32 structHash) external view returns (bool);
    function floor() external view returns (uint256);
    function escrowFactory() external view returns (address);
    function reservedTotal() external view returns (uint256);
    function reservationWindow() external view returns (uint256);
    function getReservation(bytes32 digest) external view returns (Reservation memory);
    function owner() external view returns (address);
    function TOKEN() external view returns (address);
    function DELEGATION_DOMAIN_SEPARATOR() external view returns (bytes32);
}
