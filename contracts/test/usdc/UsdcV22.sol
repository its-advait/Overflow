// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice The subset of Circle's FiatTokenV2_2 surface the Overflow tests use.
interface IUSDC {
    function initialize(
        string memory tokenName,
        string memory tokenSymbol,
        string memory tokenCurrency,
        uint8 tokenDecimals,
        address newMasterMinter,
        address newPauser,
        address newBlacklister,
        address newOwner
    ) external;
    function initializeV2(string calldata newName) external;
    function initializeV2_1(address lostAndFound) external;
    function initializeV2_2(address[] calldata accountsToBlacklist, string calldata newSymbol) external;
    function configureMinter(address minter, uint256 minterAllowedAmount) external returns (bool);
    function mint(address to, uint256 amount) external returns (bool);
    function blacklist(address account) external;
    function unBlacklist(address account) external;
    function pause() external;
    function unpause() external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
    /// @dev The bytes-signature overload (selector 0xcf092995). Contract signers go through ERC-1271.
    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes memory signature
    ) external;
}

/// @notice Deploys Circle's real, compiled USDC v2.2 (test/fixtures/usdc-v2_2) behind its real
///         proxy, initialized like Base Sepolia USDC: name "USDC", version "2", 6 decimals.
/// @dev    Test-only. Fixtures are produced by script/build-usdc-fixture.sh.
library UsdcV22 {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @dev Address FiatTokenV2_2.linked.hex was linked against; the library runtime is etched here.
    address internal constant SIGNATURE_CHECKER = 0x00000000000000000000000000000000005157c0;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    string private constant FIXTURE_DIR = "/test/fixtures/usdc-v2_2/";

    struct Deployment {
        IUSDC usdc; // the proxy
        address implementation;
        address proxyAdmin;
        address owner; // owner, masterMinter, pauser, blacklister, lostAndFound and sole minter
    }

    /// @notice Deploy and fully initialize USDC. Must be called from a test contract that is
    ///         neither `proxyAdmin` nor `tokenOwner`: the proxy admin cannot call through the proxy.
    function deploy(address proxyAdmin, address tokenOwner) internal returns (IUSDC) {
        return deployFull(proxyAdmin, tokenOwner).usdc;
    }

    function deployFull(address proxyAdmin, address tokenOwner) internal returns (Deployment memory d) {
        require(proxyAdmin != address(this), "UsdcV22: caller cannot be proxy admin");
        require(proxyAdmin != tokenOwner, "UsdcV22: proxy admin must differ from owner");

        // SignatureChecker: deploy from creation code, then etch its runtime at the linked address.
        address checker = _create(_load("SignatureChecker.hex"));
        vm.etch(SIGNATURE_CHECKER, checker.code);

        d.implementation = _create(_load("FiatTokenV2_2.linked.hex"));

        // FiatTokenProxy(address implementation); the admin is the deployer.
        vm.prank(proxyAdmin);
        address proxy = _create(bytes.concat(_load("FiatTokenProxy.hex"), abi.encode(d.implementation)));
        d.usdc = IUSDC(proxy);
        d.proxyAdmin = proxyAdmin;
        d.owner = tokenOwner;

        // Initializer chain, called from the test contract (anyone but the proxy admin may call).
        d.usdc.initialize("USDC", "USDC", "USD", 6, tokenOwner, tokenOwner, tokenOwner, tokenOwner);
        d.usdc.initializeV2("USDC");
        d.usdc.initializeV2_1(tokenOwner);
        d.usdc.initializeV2_2(new address[](0), "USDC");

        vm.prank(tokenOwner); // masterMinter
        d.usdc.configureMinter(tokenOwner, type(uint256).max);
    }

    function mint(IUSDC usdc, address tokenOwner, address to, uint256 amount) internal {
        vm.prank(tokenOwner);
        usdc.mint(to, amount);
    }

    /// @notice EIP-712 digest USDC checks for the bytes-signature transferWithAuthorization.
    function transferWithAuthorizationDigest(
        IUSDC usdc,
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce)
        );
        return keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash));
    }

    function _load(string memory file) private view returns (bytes memory) {
        string memory path = string.concat(vm.projectRoot(), FIXTURE_DIR, file);
        return vm.parseBytes(vm.trim(vm.readFile(path)));
    }

    function _create(bytes memory creationCode) private returns (address deployed) {
        assembly ("memory-safe") {
            deployed := create(0, add(creationCode, 0x20), mload(creationCode))
        }
        require(deployed != address(0), "UsdcV22: create failed");
    }
}
