// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MerkleLib} from "../../src/MerkleLib.sol";
import {RecourseCrypto} from "../../src/RecourseCrypto.sol";

/// Exposes the calldata-only library functions to the test.
contract RecordReader {
    function timestampOf(bytes calldata record) external pure returns (uint64) {
        (bytes calldata payload,) = RecourseCrypto.splitRecord(record);
        return RecourseCrypto.recordTimestamp(payload);
    }

    function signerOf(bytes calldata record) external pure returns (address) {
        (bytes calldata payload, bytes calldata sig) = RecourseCrypto.splitRecord(record);
        return ECDSA.recover(RecourseCrypto.payloadHash(payload), sig);
    }

    function verify(bytes32[] calldata proof, bytes32 root, bytes32 leafHash, uint256 i, uint256 n)
        external
        pure
        returns (bool)
    {
        return MerkleLib.verify(proof, root, leafHash, i, n);
    }
}

/// The shared TypeScript fixture (packages/recourse-crypto `pnpm vectors`) must be readable by the contract's record
/// parser: timestamp in payload bytes [0, 8), signature recovering to the source, leaves proving under rootPlain.
/// This is the layout data/ datasets are generated in, so a promise complaint over them works on chain.
contract RecourseVectorsTest is Test {
    string constant FIXTURE = "test/fixtures/recourse-vectors.json";
    RecordReader reader;
    string json;

    function setUp() public {
        reader = new RecordReader();
        json = vm.readFile(FIXTURE);
    }

    function _record(string memory path) internal view returns (bytes memory) {
        return vm.parseJsonBytes(json, path);
    }

    function test_fixtureLayoutMatchesContract() public view {
        assertEq(vm.parseJsonUint(json, ".record.chunkBytes"), 160, "chunkBytes");
        assertEq(vm.parseJsonUint(json, ".record.payloadBytes"), 95, "payloadBytes");
        assertEq(vm.parseJsonUint(json, ".record.timestampBytes"), 8, "timestampBytes");
        assertEq(vm.parseJsonUint(json, ".record.dataBytes"), 87, "dataBytes");
        assertEq(vm.parseJsonUint(json, ".record.signatureBytes"), 65, "signatureBytes");
    }

    function test_everyChunk_timestampSignerAndProof() public view {
        uint256 n = vm.parseJsonUint(json, ".chunkCount");
        bytes32 root = vm.parseJsonBytes32(json, ".rootPlain");
        address source = vm.parseJsonAddress(json, ".sourceSigner.address");
        for (uint256 i; i < n; i++) {
            string memory p = string.concat(".chunks[", vm.toString(i), "]");
            bytes memory rec = _record(string.concat(p, ".plain"));
            uint256 ts = vm.parseUint(vm.parseJsonString(json, string.concat(p, ".timestamp")));
            assertEq(uint256(reader.timestampOf(rec)), ts, "timestamp read from payload[:8]");
            assertEq(reader.signerOf(rec), source, "source signature over keccak256(payload)");
            bytes32 leaf = MerkleLib.leaf(rec);
            assertEq(leaf, vm.parseJsonBytes32(json, string.concat(p, ".plainLeaf")), "plain leaf");
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(p, ".plainProof"));
            assertTrue(reader.verify(proof, root, leaf, i, n), "plain proof");
        }
    }

    function test_wrongSourceRecord_isTheComplaintCase() public view {
        bytes memory rec = _record(".wrongSourceRecord.plain");
        address promised = vm.parseJsonAddress(json, ".wrongSourceRecord.promise.sourceKey");
        address recovered = vm.parseJsonAddress(json, ".wrongSourceRecord.recoveredSigner");
        assertEq(reader.signerOf(rec), recovered, "impostor recovers");
        assertTrue(recovered != promised, "impostor is not the promised source");
        uint256 minTs = vm.parseUint(vm.parseJsonString(json, ".wrongSourceRecord.promise.minTimestamp"));
        assertGe(uint256(reader.timestampOf(rec)), minTs, "only the signer breaks this promise");
    }
}
