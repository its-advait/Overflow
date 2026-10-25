// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IUSDC, UsdcV22} from "./UsdcV22.sol";

/// @notice ERC-1271 signer that answers "valid" only when called by one specific address.
/// @dev    USDC's SignatureChecker reaches the signer through a staticcall, so the wallet cannot
///         write msg.sender to storage or emit it. Gating on the expected caller makes the caller
///         observable from outside: the transfer succeeds iff msg.sender == expectedCaller.
contract CallerGatedWallet {
    bytes4 private constant MAGIC = 0x1626ba7e; // bytes4(keccak256("isValidSignature(bytes32,bytes)"))
    address public immutable expectedCaller;

    constructor(address expectedCaller_) {
        expectedCaller = expectedCaller_;
    }

    function isValidSignature(bytes32, bytes memory) external view returns (bytes4) {
        return msg.sender == expectedCaller ? MAGIC : bytes4(0xffffffff);
    }
}

contract UsdcRealTest is Test {
    UsdcV22.Deployment internal d;
    IUSDC internal usdc;
    address internal proxyAdmin = makeAddr("proxyAdmin");
    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public {
        d = UsdcV22.deployFull(proxyAdmin, owner);
        usdc = d.usdc;
    }

    function test_metadataMatchesBaseSepoliaUsdc() public view {
        assertEq(usdc.name(), "USDC");
        assertEq(usdc.version(), "2");
        assertEq(usdc.decimals(), 6);
    }

    function test_domainSeparator() public view {
        bytes32 expected = keccak256(
            abi.encode(
                UsdcV22.EIP712_DOMAIN_TYPEHASH,
                keccak256("USDC"),
                keccak256("2"),
                block.chainid,
                address(usdc)
            )
        );
        assertEq(usdc.DOMAIN_SEPARATOR(), expected);
    }

    function test_signatureCheckerIsEtchedAtLinkedAddress() public view {
        assertGt(UsdcV22.SIGNATURE_CHECKER.code.length, 0);
        assertTrue(address(usdc) != d.implementation);
    }

    function test_mint() public {
        UsdcV22.mint(usdc, owner, alice, 1_000_000);
        assertEq(usdc.balanceOf(alice), 1_000_000);
    }

    function test_proxyAdminCannotCallThroughProxy() public {
        vm.prank(proxyAdmin);
        vm.expectRevert("Cannot call fallback function from the proxy admin");
        usdc.name();
    }

    /// @notice During transferWithAuthorization the ERC-1271 call's msg.sender is the USDC proxy.
    function test_erc1271CallerIsUsdcProxy() public {
        CallerGatedWallet wallet = new CallerGatedWallet(address(usdc));
        UsdcV22.mint(usdc, owner, address(wallet), 10_000_000);
        bytes32 nonce = keccak256("order-1");

        usdc.transferWithAuthorization(address(wallet), bob, 5_000_000, 0, type(uint256).max, nonce, hex"");

        assertEq(usdc.balanceOf(bob), 5_000_000);
        assertEq(usdc.balanceOf(address(wallet)), 5_000_000);
        assertTrue(usdc.authorizationState(address(wallet), nonce));
    }

    /// @notice Negative control: a wallet that only trusts the implementation address is rejected,
    ///         so the positive test above really depends on msg.sender being the proxy.
    function test_erc1271CallerIsNotImplementation() public {
        CallerGatedWallet wallet = new CallerGatedWallet(d.implementation);
        UsdcV22.mint(usdc, owner, address(wallet), 10_000_000);
        bytes32 nonce = keccak256("order-2");

        vm.expectRevert("FiatTokenV2: invalid signature");
        usdc.transferWithAuthorization(address(wallet), bob, 5_000_000, 0, type(uint256).max, nonce, hex"");

        assertEq(usdc.balanceOf(bob), 0);
        assertFalse(usdc.authorizationState(address(wallet), nonce));
    }

    function test_erc1271ReplayRejected() public {
        CallerGatedWallet wallet = new CallerGatedWallet(address(usdc));
        UsdcV22.mint(usdc, owner, address(wallet), 10_000_000);
        bytes32 nonce = keccak256("order-3");

        usdc.transferWithAuthorization(address(wallet), bob, 1_000_000, 0, type(uint256).max, nonce, hex"");
        vm.expectRevert("FiatTokenV2: authorization is used or canceled");
        usdc.transferWithAuthorization(address(wallet), bob, 1_000_000, 0, type(uint256).max, nonce, hex"");
    }
}
