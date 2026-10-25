// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";

/// Exposes the calldata-taking library functions.
contract MerkleHarness {
    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leafHash, uint256 i, uint256 n)
        external
        pure
        returns (bool)
    {
        return MerkleLib.verify(proof, root, leafHash, i, n);
    }

    function expectedProofLength(uint256 i, uint256 n) external pure returns (uint256) {
        return MerkleLib.expectedProofLength(i, n);
    }
}

/// Golden vectors shared with packages/recourse-crypto/src/merkle.test.ts. Chunk i = 160 bytes of value i.
contract MerkleLibTest is Test {
    MerkleHarness h;

    bytes32 constant ROOT_1 = 0x01334b96c6f1baee2e4eea04c858b9f670100aac3847505fa578f145b2cfb669;
    bytes32 constant ROOT_2 = 0x35816244a3b343235ece3093efe230765f217779788eae17382d79e0275a0a9f;
    bytes32 constant ROOT_3 = 0x41183bd7bd4cd42181a0e17c2750a530bc699570381715729f238718ce69fd35;
    bytes32 constant ROOT_4 = 0x7b4dfbe77f6de75e64a4844facba6bc69464bc2df3edf2ed8336dcc16ea6b3bf;
    bytes32 constant ROOT_5 = 0xc868e8c578f523e327492fff75bcd28af5755fdfc5d284c604e5a2b379f96698;
    bytes32 constant LEAF_1 = 0x72d1821b1b923be327bba73e1c2eecd8bcf0cc0584d9e7a81ab4090dd56544a8;
    bytes32 constant P5_0_1 = 0xd487f67090ce8d4c22b16310c7fcf7ae0a0c0da15b2411aa449038e107eef490;
    bytes32 constant P5_0_2 = 0x3e551ca2641a5d487c28194e13249c293551a561c1f6da270d9e06a5e23423a9;

    function setUp() public {
        h = new MerkleHarness();
    }

    function _chunk(uint8 b) internal pure returns (bytes memory c) {
        c = new bytes(160);
        for (uint256 k; k < 160; k++) {
            c[k] = bytes1(b);
        }
    }

    function _leaves(uint256 n) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](n);
        for (uint256 i; i < n; i++) {
            l[i] = MerkleLib.leaf(_chunk(uint8(i)));
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

    function test_goldenRoots() public pure {
        assertEq(_root(_leaves(1)), ROOT_1, "n=1");
        assertEq(_root(_leaves(2)), ROOT_2, "n=2");
        assertEq(_root(_leaves(3)), ROOT_3, "n=3");
        assertEq(_root(_leaves(4)), ROOT_4, "n=4");
        assertEq(_root(_leaves(5)), ROOT_5, "n=5");
        assertEq(MerkleLib.leaf(_chunk(1)), LEAF_1, "leaf1");
        assertEq(MerkleLib.node(MerkleLib.leaf(_chunk(0)), LEAF_1), ROOT_2, "node01");
    }

    function test_goldenProof_n5() public view {
        bytes32[] memory l = _leaves(5);
        bytes32[] memory p0 = _proof(l, 0);
        assertEq(p0.length, 3);
        assertEq(p0[0], LEAF_1);
        assertEq(p0[1], P5_0_1);
        assertEq(p0[2], P5_0_2);
        assertTrue(h.verify(p0, ROOT_5, l[0], 0, 5));
        bytes32[] memory p4 = _proof(l, 4);
        assertEq(p4.length, 1);
        assertEq(p4[0], ROOT_4, "leaf 4 pairs with the root of the first four");
        assertTrue(h.verify(p4, ROOT_5, l[4], 4, 5));
    }

    function test_expectedProofLengthTable() public {
        uint8[8][8] memory table = [
            [0, 0, 0, 0, 0, 0, 0, 0],
            [1, 1, 0, 0, 0, 0, 0, 0],
            [2, 2, 1, 0, 0, 0, 0, 0],
            [2, 2, 2, 2, 0, 0, 0, 0],
            [3, 3, 3, 3, 1, 0, 0, 0],
            [3, 3, 3, 3, 2, 2, 0, 0],
            [3, 3, 3, 3, 3, 3, 2, 0],
            [3, 3, 3, 3, 3, 3, 3, 3]
        ];
        for (uint256 n = 1; n <= 8; n++) {
            for (uint256 i; i < n; i++) {
                assertEq(h.expectedProofLength(i, n), table[n - 1][i]);
            }
        }
        vm.expectRevert(MerkleLib.IndexOutOfRange.selector);
        h.expectedProofLength(3, 3);
    }

    function test_roundTrip_allIndices() public view {
        for (uint256 n = 1; n <= 9; n++) {
            bytes32[] memory l = _leaves(n);
            bytes32 root = _root(l);
            for (uint256 i; i < n; i++) {
                bytes32[] memory p = _proof(l, i);
                assertEq(p.length, h.expectedProofLength(i, n));
                assertTrue(h.verify(p, root, l[i], i, n));
                if (n > 1) {
                    assertFalse(h.verify(p, root, l[(i + 1) % n], i, n), "wrong leaf");
                    assertFalse(h.verify(p, root, l[i], (i + 1) % n, n), "wrong index");
                }
            }
        }
    }

    function test_domainSeparation() public pure {
        bytes memory c = _chunk(7);
        assertTrue(MerkleLib.leaf(c) != keccak256(c), "leaf prefix");
        bytes32 a = keccak256("a");
        bytes32 b = keccak256("b");
        assertTrue(MerkleLib.node(a, b) != keccak256(abi.encodePacked(a, b)), "node prefix");
        assertTrue(MerkleLib.node(a, b) != MerkleLib.node(b, a), "ordered");
        // An internal node cannot be re-read as a leaf: leaf(preimage) carries 0x00, node carries 0x01.
        assertTrue(MerkleLib.leaf(abi.encodePacked(a, b)) != MerkleLib.node(a, b));
    }

    function test_verify_rejectsExtraOrMissingElements() public view {
        bytes32[] memory l = _leaves(4);
        bytes32 root = _root(l);
        bytes32[] memory p = _proof(l, 0);
        bytes32[] memory shorter = new bytes32[](1);
        shorter[0] = p[0];
        assertFalse(h.verify(shorter, root, l[0], 0, 4));
        bytes32[] memory longer = new bytes32[](3);
        longer[0] = p[0];
        longer[1] = p[1];
        assertFalse(h.verify(longer, root, l[0], 0, 4));
        assertFalse(h.verify(p, root, l[0], 4, 4), "index out of range");
    }
}
