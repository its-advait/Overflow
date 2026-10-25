// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RecourseCrypto} from "../../src/RecourseCrypto.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";

/// Golden vectors shared with packages/recourse-crypto/src/crypto.test.ts.
/// KEY = keccak256("overflow.golden.key"); plaintext chunk i = 160 bytes of value i, n = 5.
contract RecourseCryptoTest is Test {
    bytes32 constant KEY = 0x7821e83d3d34740e94104147499f90f473b3c525dffeb768d2cb03021ba69f1c;
    bytes32 constant K_0 = 0x0e8bdfc41c4e57b98b1162b5a3e6ccd13542c41945893be60b01b9ca28d735e2;
    bytes32 constant K_2 = 0xffb85269e2a5e166b761e710605369fe02aa8321734697e4b8ee0a55ba31de8f;
    bytes32 constant KS_0_0 = 0x537a0d443f3dcb55490250890b4fab7903389a09f2797b00ee02d7277b4914f6;
    bytes32 constant KS_0_4 = 0xb6722df19f1c806db82af3fd7966eb2e8882c01f06768814c12cc4e96150d5ef;
    bytes32 constant KEY_COMMITMENT = 0xc6ef49f0220a08b0ff4bd81c6ca6f40627f458d9fe7d2216bb86e2ddad5ff75c;
    bytes32 constant ROOT_PLAIN = 0xc868e8c578f523e327492fff75bcd28af5755fdfc5d284c604e5a2b379f96698;
    bytes32 constant ROOT_CIPHER = 0x52ef6ce6cf44eb9574b9c2cc8ab71078a0ddb6c9939fc9fccccee581eebfa6e7;
    bytes32 constant CIPHER_LEAF_0 = 0x68c431737433b99e5f795d359831f8a900048fb4a706655cfd5b01d4c772e185;
    bytes32 constant DERIVED = 0x29ea90fe0aa3eb42a3ec85afc9666785d44c522ac8383e9b1d994161f0c8f233;
    bytes constant C_0 =
        hex"537a0d443f3dcb55490250890b4fab7903389a09f2797b00ee02d7277b4914f6a812229f0e5914a4871c5be13a148b4b6bc44b2fb45c97bdf0fe455209001ef80b0f606f570deefc4db93bb777a38dd1ce3f5f7330f47d62888087f46297f1f46ebcb28f5d03492ba72b93ebf1e0c87f0d7a316cb017893b4634507b91df356bb6722df19f1c806db82af3fd7966eb2e8882c01f06768814c12cc4e96150d5ef";
    bytes constant C_2 =
        hex"666b7e5683e24c7edcc69a0b418fd5bcf9bec77d3facfba8f461974882c1c11f7115855335b68c982f158274b9e43119df36a19b75653bbffff7632f259f00ec5a6e9406aeece8346f7f574a098658342bafe7440ac317e55779449e7fc3c3ea1df4efb268c4b3d81fe2817ace1f2fedda6975dab01ade620e1a275b4f1377804863e74851b40a462aa4c1e8e05f2fd2c4cb5236c897ca929ae4f7e8b27f9818";

    function _chunk(uint8 b) internal pure returns (bytes memory c) {
        c = new bytes(160);
        for (uint256 k; k < 160; k++) {
            c[k] = bytes1(b);
        }
    }

    function _root(bytes32[] memory level) internal pure returns (bytes32) {
        while (level.length > 1) {
            bytes32[] memory nxt = new bytes32[]((level.length + 1) / 2);
            for (uint256 j; j < level.length; j += 2) {
                nxt[j / 2] = j + 1 < level.length ? MerkleLib.node(level[j], level[j + 1]) : level[j];
            }
            level = nxt;
        }
        return level[0];
    }

    function test_goldenKeysAndKeystream() public pure {
        assertEq(KEY, keccak256("overflow.golden.key"));
        assertEq(RecourseCrypto.chunkKey(KEY, 0), K_0, "k_0");
        assertEq(RecourseCrypto.chunkKey(KEY, 2), K_2, "k_2");
        assertEq(RecourseCrypto.keystreamBlock(K_0, 0), KS_0_0, "ks_0_0");
        assertEq(RecourseCrypto.keystreamBlock(K_0, 4), KS_0_4, "ks_0_4");
        assertEq(RecourseCrypto.keyCommitment(KEY), KEY_COMMITMENT, "keyCommitment");
        assertEq(
            RecourseCrypto.deriveKey(
                keccak256("secret"), keccak256("order"), 0x1111111111111111111111111111111111111111
            ),
            DERIVED,
            "deriveKey"
        );
    }

    function test_goldenCiphertext() public pure {
        assertEq(RecourseCrypto.xorChunk(K_0, _chunk(0)), C_0, "c_0 (zero plaintext = raw keystream)");
        assertEq(RecourseCrypto.xorChunk(RecourseCrypto.chunkKey(KEY, 2), _chunk(2)), C_2, "c_2");
        assertEq(RecourseCrypto.xorChunk(K_0, C_0), _chunk(0), "decrypt c_0");
        assertEq(RecourseCrypto.xorChunk(K_2, C_2), _chunk(2), "decrypt c_2");
        assertEq(MerkleLib.leaf(C_0), CIPHER_LEAF_0, "cipher leaf 0");
    }

    function test_goldenRoots() public pure {
        bytes32[] memory plain = new bytes32[](5);
        bytes32[] memory cipher = new bytes32[](5);
        for (uint256 i; i < 5; i++) {
            bytes memory p = _chunk(uint8(i));
            plain[i] = MerkleLib.leaf(p);
            cipher[i] = MerkleLib.leaf(RecourseCrypto.xorChunk(RecourseCrypto.chunkKey(KEY, i), p));
        }
        assertEq(_root(plain), ROOT_PLAIN, "rootPlain");
        assertEq(_root(cipher), ROOT_CIPHER, "rootCipher");
    }

    function test_xorRoundTrip(bytes32 key, uint256 i, bytes memory chunk) public pure {
        vm.assume(chunk.length == 160);
        bytes32 ki = RecourseCrypto.chunkKey(key, i);
        bytes memory c = RecourseCrypto.xorChunk(ki, chunk);
        assertEq(RecourseCrypto.xorChunk(ki, c), chunk);
    }

    function test_xorRejectsWrongLength() public {
        vm.expectRevert(RecourseCrypto.BadChunkLength.selector);
        this.xorExt(K_0, new bytes(159));
    }

    function xorExt(bytes32 k, bytes memory c) external pure returns (bytes memory) {
        return RecourseCrypto.xorChunk(k, c);
    }

    function test_chunkKeysAreIndependent() public pure {
        assertTrue(RecourseCrypto.chunkKey(KEY, 0) != RecourseCrypto.chunkKey(KEY, 1));
        assertTrue(RecourseCrypto.keystreamBlock(K_0, 0) != RecourseCrypto.keystreamBlock(K_0, 1));
    }
}
