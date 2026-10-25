// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOverflowEscrow} from "./IOverflowEscrow.sol";
import {IOverflowTreasury} from "./IOverflowTreasury.sol";
import {IOverflowEscrowFactory} from "./IOverflowEscrowFactory.sol";
import {MerkleLib} from "./MerkleLib.sol";
import {RecourseCrypto} from "./RecourseCrypto.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SafeERC20, IERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title OverflowEscrow (tier 1)
/// @notice Holds one order's USDC. The seller is paid after a valid key reveal plus either a buyer-node accept
/// or a quiet challenge window; a missed reveal refunds the buyer (the treasury). Exactly one terminal state.
/// @dev Clone implementation: FACTORY is immutable (shared by every clone through the code); the implementation
/// itself is marked initialized in the constructor so only clones can be initialized, and only by the factory.
/// Tier 2 (complainMismatch) refunds on a proven ciphertext/plaintext mismatch; tier 3 (complainPromise) refunds when
/// a committed record breaks the source-signature or minimum-timestamp promise. Both record the seller's cheat.
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

    // ---------------------------------------------------------------- complaints

    /// @notice Tier 2: prove ciphertext chunk `i` does not decrypt to the committed plaintext leaf. Both proofs
    /// must verify (exact length, domain-separated hashing); then k_i is derived from the revealed key, `cipherChunk`
    /// is decrypted and compared. A mismatch refunds the whole balance (price + bond) to the buyer, records the
    /// seller's cheat on the factory and closes the escrow. A matching chunk reverts ChunkMatches.
    function complainMismatch(
        uint256 i,
        bytes calldata cipherChunk,
        bytes32[] calldata cipherProof,
        bytes32 plainLeaf,
        bytes32[] calldata plainProof
    ) external nonReentrant {
        _checkComplaintWindow();
        uint256 n = _t.chunkCount;
        if (i >= n) revert ChunkOutOfRange();
        if (cipherChunk.length != CHUNK_SIZE) revert BadChunkLength();
        _checkProofLength(cipherProof, i, n);
        _checkProofLength(plainProof, i, n);
        if (!MerkleLib.verify(cipherProof, _t.rootCipher, MerkleLib.leaf(cipherChunk), i, n)) revert BadProof();
        if (!MerkleLib.verify(plainProof, _t.rootPlain, plainLeaf, i, n)) revert BadProof();

        bytes memory plaintext = RecourseCrypto.xorChunk(RecourseCrypto.chunkKey(revealedKey, i), cipherChunk);
        if (MerkleLib.leaf(plaintext) == plainLeaf) revert ChunkMatches();

        _proveCheat(i, "mismatch");
    }

    /// @notice Tier 3: prove a committed plaintext record breaks the seller's promise. The record is verified
    /// under rootPlain, split into a 95-byte payload and a 65-byte signature; the cheat is proven when the
    /// signature does not recover to `terms.sourceKey` (when a source was promised) or the payload's uint64
    /// timestamp is below `terms.minTimestamp` (when one was promised). Refunds price + bond to the buyer.
    function complainPromise(uint256 i, bytes calldata plainChunk, bytes32[] calldata plainProof)
        external
        nonReentrant
    {
        _checkComplaintWindow();
        uint256 n = _t.chunkCount;
        if (i >= n) revert ChunkOutOfRange();
        if (plainChunk.length != CHUNK_SIZE) revert BadChunkLength();
        _checkProofLength(plainProof, i, n);
        if (!MerkleLib.verify(plainProof, _t.rootPlain, MerkleLib.leaf(plainChunk), i, n)) revert BadProof();

        address sourceKey = _t.sourceKey;
        uint64 minTimestamp = _t.minTimestamp;
        if (sourceKey == address(0) && minTimestamp == 0) revert NoPromise();

        (bytes calldata payload, bytes calldata sig) = RecourseCrypto.splitRecord(plainChunk);
        bool broken;
        if (sourceKey != address(0)) {
            (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(RecourseCrypto.payloadHash(payload), sig);
            broken = err != ECDSA.RecoverError.NoError || recovered != sourceKey;
        }
        if (!broken && minTimestamp != 0) {
            broken = RecourseCrypto.recordTimestamp(payload) < minTimestamp;
        }
        if (!broken) revert PromiseKept();

        _proveCheat(i, "promise");
    }

    /// Shared tail of a proven complaint: close first, then record the cheat and sweep price + bond to the buyer.
    function _proveCheat(uint256 i, string memory reason) internal {
        address seller_ = _t.seller;
        status = Status.Refunded;
        emit CheatProven(seller_, i);
        IOverflowEscrowFactory(FACTORY).recordCheat(seller_);
        _sweepToBuyer();
        emit Refunded(reason);
    }

    // ---------------------------------------------------------------- late arrivals

    /// @notice Recover USDC that landed after the order closed: a reservation the treasury approved while the order
    /// was open can still be executed by USDC later, and `EscrowClosed` cannot revoke an authorization USDC already
    /// holds. Permissionless, and the recipient is always `terms.buyer` (the treasury): never the caller, the seller
    /// or an owner. Nothing else changes: the terminal status, the terms, the revealed key and the original payout or
    /// refund stay as they were, and the agent's spent allowance is not restored (docs/SPEC.md: refunds restore
    /// treasury USDC, not allowance).
    /// @dev Reverts `BadStatus` before a terminal state (an open order's balance belongs to `_payout`/`_refund`) and
    /// `NothingToSweep` on a zero balance, so a repeated call cannot pay twice. A transfer USDC rejects (blacklist,
    /// pause) reverts through SafeERC20 and leaves the balance in place for a later call. `nonReentrant` matches the
    /// other transferring entry points even though USDC does not call back.
    function sweep() external nonReentrant returns (uint256 swept) {
        if (status != Status.Settled && status != Status.Refunded) revert BadStatus(status);
        IERC20 token = IERC20(_t.token);
        swept = token.balanceOf(address(this));
        if (swept == 0) revert NothingToSweep();
        address buyer_ = _t.buyer;
        token.safeTransfer(buyer_, swept);
        emit Swept(buyer_, swept);
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
        _sweepToBuyer();
        emit Refunded(reason);
    }

    function _sweepToBuyer() internal {
        IERC20 token = IERC20(_t.token);
        uint256 bal = token.balanceOf(address(this));
        if (bal > 0) token.safeTransfer(_t.buyer, bal);
    }
}
