// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOverflowEscrow} from "./IOverflowEscrow.sol";
import {IOverflowTreasury} from "./IOverflowTreasury.sol";
import {MerkleLib} from "./MerkleLib.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title OverflowEscrow (tier 1)
/// @notice Holds one order's USDC. The seller is paid after a valid key reveal plus either a buyer-node accept
/// or a quiet challenge window; a missed reveal refunds the buyer (the treasury). Exactly one terminal state.
/// @dev Clone implementation: FACTORY is immutable (shared by every clone through the code); the implementation
/// itself is marked initialized in the constructor so only clones can be initialized, and only by the factory.
/// Tier 2/3 complaints are stubs: they enforce every structural check, then revert NotImplemented.
contract OverflowEscrow is IOverflowEscrow, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    bytes32 public constant ACCEPT_TYPEHASH = keccak256("Accept(bytes32 orderId)");
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("OverflowEscrow");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 public constant CHUNK_SIZE = 160;

    address public immutable FACTORY;

    OrderTerms private _t;
    Status public status;
    uint64 public challengeEnd;
    bytes32 public revealedKey;
    bool private _initialized;

    constructor(address factory) {
        FACTORY = factory;
        _initialized = true; // the implementation is never an order
    }

    // ---------------------------------------------------------------- init

    function initialize(OrderTerms calldata t) external {
        if (msg.sender != FACTORY) revert NotFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;
        _t = t;
    }

    // ---------------------------------------------------------------- lifecycle

    function markFunded() external {
        if (status != Status.Created) revert BadStatus(status);
        uint256 bal = IERC20(_t.token).balanceOf(address(this));
        uint256 required = _t.amount + _t.bond;
        if (bal < required) revert Underfunded(bal, required);
        status = Status.Funded;
        emit OrderFunded(bal);
    }

    function revealKey(bytes32 key) external {
        if (msg.sender != _t.seller) revert NotSeller();
        if (status != Status.Funded) revert BadStatus(status);
        if (block.timestamp >= _t.revealDeadline) revert RevealWindowClosed();
        if (keccak256(abi.encodePacked(key)) != _t.keyCommitment) revert BadKey();
        revealedKey = key;
        uint64 end = uint64(block.timestamp) + _t.challengeWindow;
        challengeEnd = end;
        status = Status.Revealed;
        emit KeyRevealed(key, end);
    }

    function accept(bytes calldata buyerNodeSig) external nonReentrant {
        if (status != Status.Revealed) revert BadStatus(status);
        address signer = ECDSA.recoverCalldata(acceptDigest(), buyerNodeSig);
        uint256 nodeId = IOverflowTreasury(_t.buyer).nodeOfKey(signer);
        if (nodeId == 0) revert NotBuyerNode(signer);
        emit Accepted(signer, nodeId);
        _payout();
    }

    function finalizePayout() external nonReentrant {
        if (status != Status.Revealed) revert BadStatus(status);
        if (block.timestamp < challengeEnd) revert ChallengeOpen();
        _payout();
    }

    function claimTimeoutRefund() external nonReentrant {
        if (status != Status.Created && status != Status.Funded) revert BadStatus(status);
        if (block.timestamp < _t.revealDeadline) revert RevealWindowOpen();
        _refund("timeout");
    }

    // ---------------------------------------------------------------- complaints (tier 2/3 stubs)

    /// @dev Tier 2 fills in decryption and the refund. Every structural check is already enforced here.
    function complainMismatch(
        uint256 i,
        bytes calldata cipherChunk,
        bytes32[] calldata cipherProof,
        bytes32 plainLeaf,
        bytes32[] calldata plainProof
    ) external view {
        _checkComplaintWindow();
        uint256 n = _t.chunkCount;
        if (i >= n) revert ChunkOutOfRange();
        if (cipherChunk.length != CHUNK_SIZE) revert BadChunkLength();
        _checkProofLength(cipherProof, i, n);
        _checkProofLength(plainProof, i, n);
        if (!MerkleLib.verify(cipherProof, _t.rootCipher, MerkleLib.leaf(cipherChunk), i, n)) revert BadProof();
        if (!MerkleLib.verify(plainProof, _t.rootPlain, plainLeaf, i, n)) revert BadProof();
        revert NotImplemented();
    }

    /// @dev Tier 3 fills in the source-signature and timestamp checks and the refund.
    function complainPromise(uint256 i, bytes calldata plainChunk, bytes32[] calldata plainProof) external view {
        _checkComplaintWindow();
        uint256 n = _t.chunkCount;
        if (i >= n) revert ChunkOutOfRange();
        if (plainChunk.length != CHUNK_SIZE) revert BadChunkLength();
        _checkProofLength(plainProof, i, n);
        if (!MerkleLib.verify(plainProof, _t.rootPlain, MerkleLib.leaf(plainChunk), i, n)) revert BadProof();
        revert NotImplemented();
    }

    // ---------------------------------------------------------------- views

    function terms() external view returns (OrderTerms memory) {
        return _t;
    }

    function buyer() external view returns (address) {
        return _t.buyer;
    }

    function seller() external view returns (address) {
        return _t.seller;
    }

    function amount() external view returns (uint256) {
        return _t.amount;
    }

    /// EIP-712 domain of this clone: {OverflowEscrow, 1, chainId, this}. Binds Accept to the escrow address.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function acceptDigest() public view returns (bytes32) {
        return
            keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(ACCEPT_TYPEHASH, _t.orderId)))
            );
    }

    function expectedProofLength(uint256 i, uint256 n) external pure returns (uint256) {
        return MerkleLib.expectedProofLength(i, n);
    }

    // ---------------------------------------------------------------- internals

    function _checkComplaintWindow() internal view {
        if (status != Status.Revealed) revert BadStatus(status);
        if (block.timestamp >= challengeEnd) revert ChallengeClosed();
    }

    function _checkProofLength(bytes32[] calldata proof, uint256 i, uint256 n) internal pure {
        uint256 expected = MerkleLib.expectedProofLength(i, n);
        if (proof.length != expected) revert BadProofLength(expected, proof.length);
    }

    /// Effects first, then transfers. Seller gets amount + bond; any surplus returns to the buyer so the
    /// escrow holds exactly zero afterwards.
    function _payout() internal {
        status = Status.Settled;
        IERC20 token = IERC20(_t.token);
        uint256 bal = token.balanceOf(address(this));
        uint256 toSeller = _t.amount + _t.bond;
        token.safeTransfer(_t.seller, toSeller);
        if (bal > toSeller) token.safeTransfer(_t.buyer, bal - toSeller);
        emit PaidOut(_t.seller, _t.amount, _t.bond);
    }

    /// Whole balance (price, bond and any surplus) returns to the buyer.
    function _refund(string memory reason) internal {
        status = Status.Refunded;
        IERC20 token = IERC20(_t.token);
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(_t.buyer, bal);
        emit Refunded(reason);
    }
}
