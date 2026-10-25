// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OverflowTreasury} from "../../src/OverflowTreasury.sol";

/// Golden vectors shared with packages/payment-client/src/typed-data.test.ts: the TS digests must equal what USDC
/// (TransferWithAuthorization, live Base Sepolia domain) and OverflowTreasury (CreateChild / PauseChild) compute.
contract TypedDataVectorsTest is Test {
    bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant TWA_TYPEHASH = 0x7c7c6cdb67a18743f49ec6fa9b35f50d52ed05cbed4cc592e13b44501c1a2267;
    bytes32 constant CREATE_CHILD_TYPEHASH = keccak256(
        "CreateChild(uint256 parentId,address key,uint256 cap,uint256 maxPerCall,uint256 expiry,bool restricted,bytes32 payeesHash,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant PAUSE_CHILD_TYPEHASH = keccak256("PauseChild(uint256 target,uint256 nonce,uint256 deadline)");
    address constant USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    address constant TREASURY = 0xd3A74fA991CA0B5627d30EF27dC699C134848291;
    uint256 constant BASE_SEPOLIA = 84532;

    bytes32 constant USDC_SEP = 0x71f17a3b2ff373b803d70a5a07c046c1a2bc8e89c09ef722fcb047abe94c9818;
    bytes32 constant AUTH_DIGEST = 0xa3f48a6a5246ed982e588ec8c6c82ad870fd6bf59527923cfe81d9e0072ab185;
    bytes32 constant PAYEES_HASH = 0xa80d18648e85a4cbf5f5bdbd1d95c6b800466af832d6e4435a6b6debe458122d;
    bytes32 constant CHILD_DIGEST = 0x85e21bc13253f2d4774b66478096c12606d1375c8c82532ad6f7629942872867;
    bytes32 constant PAUSE_DIGEST = 0x199b55db57c8e334a5d2ce35f8197bea0c4528e9b3297d3ccf583bef6aa6d0fe;
    bytes32 constant DELEG_SEP = 0x70a93dac43b2061c8fc826a973d59b1a987c11fb52c32c9cb24a3d9629e5f364;

    function _sep(string memory name, string memory version, uint256 chainId, address c)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), chainId, c)
        );
    }

    function test_usdcDomainSeparator() public pure {
        assertEq(_sep("USDC", "2", BASE_SEPOLIA, USDC), USDC_SEP);
    }

    function test_authorizationDigest() public pure {
        bytes32 sh = keccak256(
            abi.encode(
                TWA_TYPEHASH,
                TREASURY,
                0x1111111111111111111111111111111111111111,
                uint256(50000),
                uint256(1791699995),
                uint256(1791700120),
                bytes32(hex"abababababababababababababababababababababababababababababababab")
            )
        );
        assertEq(keccak256(abi.encodePacked("\x19\x01", USDC_SEP, sh)), AUTH_DIGEST);
    }

    function test_delegationDigests() public pure {
        assertEq(_sep("Overflow", "1", BASE_SEPOLIA, TREASURY), DELEG_SEP);
        address[] memory payees = new address[](2);
        payees[0] = 0x3333333333333333333333333333333333333333;
        payees[1] = 0x4444444444444444444444444444444444444444;
        assertEq(keccak256(abi.encodePacked(payees)), PAYEES_HASH);
        bytes32 child = keccak256(
            abi.encode(
                CREATE_CHILD_TYPEHASH,
                uint256(1),
                0x2222222222222222222222222222222222222222,
                uint256(1_000_000),
                uint256(100_000),
                uint256(1791786400),
                true,
                PAYEES_HASH,
                uint256(7),
                uint256(1791700300)
            )
        );
        assertEq(keccak256(abi.encodePacked("\x19\x01", DELEG_SEP, child)), CHILD_DIGEST);
        bytes32 pause = keccak256(abi.encode(PAUSE_CHILD_TYPEHASH, uint256(3), uint256(9), uint256(1791700300)));
        assertEq(keccak256(abi.encodePacked("\x19\x01", DELEG_SEP, pause)), PAUSE_DIGEST);
    }

    /// The treasury's own separator follows the same formula (so the TS mirror tracks any deployed address).
    function test_treasurySeparatorMatchesFormula() public {
        vm.chainId(BASE_SEPOLIA);
        OverflowTreasury t = new OverflowTreasury(USDC, address(this));
        assertEq(t.DELEGATION_DOMAIN_SEPARATOR(), _sep("Overflow", "1", BASE_SEPOLIA, address(t)));
    }
}
