// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TreasuryBaseTest} from "../unit/TreasuryBase.t.sol";
import {OverflowEscrowFactory} from "../../src/OverflowEscrowFactory.sol";
import {OverflowEscrow} from "../../src/OverflowEscrow.sol";
import {IOverflowEscrow} from "../../src/IOverflowEscrow.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";
import {RecourseCrypto} from "../../src/RecourseCrypto.sol";
import {UsdcV22} from "../usdc/UsdcV22.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Escrow harness on top of the treasury harness (real USDC v2.2, treasury with root node 1).
/// Plaintext chunk i is 160 bytes of value i; ciphertext c_i = p_i XOR keystream(KEY, i) (honest seller).
abstract contract EscrowBaseTest is TreasuryBaseTest {
    bytes32 constant KEY = keccak256("overflow.test.delivery.key");
    uint256 constant AMOUNT = 5e4; // 0.05 USDC, within the root's 0.10 maxPerCall
    uint256 constant BOND = 1e4; // 0.01 USDC

    uint256 sellerPk = 0x5E11E4;
    address seller;
    OverflowEscrowFactory factory;

    function setUp() public virtual override {
        super.setUp();
        seller = vm.addr(sellerPk);
        factory = new OverflowEscrowFactory();
    }

    // ------------------------------------------------------------ merkle helpers

    function _chunk(uint8 b) internal pure returns (bytes memory c) {
        c = new bytes(160);
        for (uint256 k; k < 160; k++) {
            c[k] = bytes1(b);
        }
    }

    function _leaves(uint256 n, uint8 offset) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            l[i] = MerkleLib.leaf(_chunk(uint8(i) + offset));
        }
    }

    function _plain(uint256 i) internal pure returns (bytes memory) {
        return _chunk(uint8(i));
    }

    /// Honest ciphertext of plaintext chunk i under KEY.
    function _cipher(uint256 i) internal pure returns (bytes memory) {
        return RecourseCrypto.xorChunk(RecourseCrypto.chunkKey(KEY, i), _plain(i));
    }

    function _cipherLeaves(uint256 n) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            l[i] = MerkleLib.leaf(_cipher(i));
        }
    }

    function _next(bytes32[] memory level) internal pure returns (bytes32[] memory nxt) {
        nxt = new bytes32[]((level.length + 1) / 2);
        for (uint256 j; j < level.length; j += 2) {
            nxt[j / 2] = j + 1 < level.length ? MerkleLib.node(level[j], level[j + 1]) : level[j];
        }
    }

    function _root(bytes32[] memory level) internal pure returns (bytes32) {
        while (level.length > 1) {
            level = _next(level);
        }
        return level[0];
    }

    function _proof(bytes32[] memory level, uint256 i) internal pure returns (bytes32[] memory proof) {
        bytes32[] memory tmp = new bytes32[](64);
        uint256 p;
        while (level.length > 1) {
            uint256 sib = i ^ 1;
            if (sib < level.length) tmp[p++] = level[sib];
            level = _next(level);
            i >>= 1;
        }
        proof = new bytes32[](p);
        for (uint256 k; k < p; k++) {
            proof[k] = tmp[k];
        }
    }

    // ------------------------------------------------------------ order helpers

    function _terms(uint256 amount, uint256 bond, uint32 n)
        internal
        view
        returns (IOverflowEscrow.OrderTerms memory t)
    {
        t.orderId = keccak256(abi.encode("order", amount, bond, n));
        t.buyer = address(treasury);
        t.seller = seller;
        t.token = address(usdc);
        t.amount = amount;
        t.bond = bond;
        t.manifestHash = keccak256("manifest");
        t.rootPlain = _root(_leaves(n, 0));
        t.rootCipher = _root(_cipherLeaves(n));
        t.keyCommitment = keccak256(abi.encodePacked(KEY));
        t.revealDeadline = uint64(block.timestamp + 1 hours);
        t.challengeWindow = 30 minutes;
        t.chunkCount = n;
        t.termsHash = factory.termsHashOf(t);
    }

    function _create(IOverflowEscrow.OrderTerms memory t) internal returns (OverflowEscrow) {
        return OverflowEscrow(factory.create(t));
    }

    /// Price minted straight to the escrow (labels: test shortcut), bond paid by the seller.
    function _fundViaMint(OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) internal {
        UsdcV22.mint(usdc, usdcOwner, address(e), t.amount);
        _payBond(e, t);
        e.markFunded();
    }

    /// Price paid by the treasury through settle() (the escrow is the x402 payTo), bond paid by the seller.
    function _fundViaTreasury(OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) internal {
        vm.prank(owner);
        treasury.setAllow(address(e), true);
        _pay(rootPk, address(e), t.amount);
        _payBond(e, t);
        e.markFunded();
    }

    function _payBond(OverflowEscrow e, IOverflowEscrow.OrderTerms memory t) internal {
        if (t.bond == 0) return;
        UsdcV22.mint(usdc, usdcOwner, seller, t.bond);
        vm.prank(seller);
        IERC20(address(usdc)).transfer(address(e), t.bond);
    }

    function _reveal(OverflowEscrow e) internal {
        vm.prank(seller);
        e.revealKey(KEY);
    }

    function _acceptSig(uint256 pk, OverflowEscrow e) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, e.acceptDigest());
        return abi.encodePacked(r, s, v);
    }

    function _bal(address a) internal view returns (uint256) {
        return usdc.balanceOf(a);
    }

    function _err(bytes4 sel) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(sel);
    }

    function _badStatus(IOverflowEscrow.Status s) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IOverflowEscrow.BadStatus.selector, s);
    }
}
