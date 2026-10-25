// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {OverflowTreasury} from "../src/OverflowTreasury.sol";
import {IOverflowTreasury} from "../src/IOverflowTreasury.sol";
import {OverflowEscrowFactory} from "../src/OverflowEscrowFactory.sol";

/// @notice Deploy OverflowTreasury and OverflowEscrowFactory (which deploys the OverflowEscrow implementation) on
/// Base Sepolia, wire the factory into the treasury and, when the owner is the deployer, create the root node.
/// The signer comes from the CLI (`--account <keystore> --password-file <path>`); no key is read here.
///
/// Env (all addresses, no keys):
///   TOKEN_ADDRESS        USDC (default Base Sepolia USDC)
///   OWNER_ADDRESS        treasury owner: the controller's Coinbase Wallet, or the deployer for local dev
///   AGENT_ROOT_ADDRESS   root node key (required when the owner is the deployer; otherwise used for calldata)
///   ROOT_CAP             atomic USDC, default 50 USDC (the demo mission budget)
///   ROOT_MAX_PER_CALL    atomic USDC, default 15 USDC (above the 12 USDC fused purchase in the demo)
///   ROOT_EXPIRY          unix seconds, default now + 7 days
///   DEMO_PAYEE_ADDRESS   optional: a payee to allowlist for the facilitator demo (owner == deployer only)
///
/// Dry run:  forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_SEPOLIA_RPC_URL --sender $DEPLOYER_ADDRESS
/// Live:     pnpm contracts:deploy   (scripts/deploy.sh adds --broadcast --verify and exports addresses/ABIs)
contract Deploy is Script {
    address constant USDC_BASE_SEPOLIA = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;
    uint256 constant DEFAULT_ROOT_CAP = 50_000_000; // 50 USDC
    uint256 constant DEFAULT_ROOT_MAX_PER_CALL = 15_000_000; // 15 USDC

    function run() external returns (OverflowTreasury treasury) {
        require(block.chainid == 84532, "Deploy: not Base Sepolia");

        address token = vm.envOr("TOKEN_ADDRESS", USDC_BASE_SEPOLIA);
        address owner = vm.envAddress("OWNER_ADDRESS");
        address rootKey = vm.envOr("AGENT_ROOT_ADDRESS", address(0));
        uint256 rootCap = vm.envOr("ROOT_CAP", DEFAULT_ROOT_CAP);
        uint256 rootMaxPerCall = vm.envOr("ROOT_MAX_PER_CALL", DEFAULT_ROOT_MAX_PER_CALL);
        uint256 rootExpiry = vm.envOr("ROOT_EXPIRY", block.timestamp + 7 days);
        require(rootExpiry > block.timestamp, "Deploy: ROOT_EXPIRY in the past");
        require(rootMaxPerCall <= rootCap, "Deploy: ROOT_MAX_PER_CALL above ROOT_CAP");

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();

        treasury = new OverflowTreasury(token, owner);
        console2.log("OverflowTreasury", address(treasury));
        console2.log("  TOKEN", token);
        console2.log("  owner", owner);
        console2.log("  deployer", deployer);

        OverflowEscrowFactory factory = new OverflowEscrowFactory();
        console2.log("OverflowEscrowFactory", address(factory));
        console2.log("  OverflowEscrow implementation", factory.implementation());

        address demoPayee = vm.envOr("DEMO_PAYEE_ADDRESS", address(0));
        if (owner == deployer) {
            treasury.setEscrowFactory(address(factory));
            if (demoPayee != address(0)) {
                treasury.setAllow(demoPayee, true);
                console2.log("allowlisted demo payee", demoPayee);
            }
            require(rootKey != address(0), "Deploy: AGENT_ROOT_ADDRESS required when owner is the deployer");
            uint256 rootId = treasury.createRoot(rootKey, rootCap, rootMaxPerCall, rootExpiry);
            console2.log("root node id", rootId);
        }
        vm.stopBroadcast();

        if (owner != deployer) {
            // The controller approves this in Coinbase Wallet (send_calls): to = treasury, value = 0, data below.
            console2.log("Owner is not the deployer. createRoot calldata for the controller to approve:");
            console2.log("  to", address(treasury));
            console2.logBytes(
                abi.encodeCall(IOverflowTreasury.createRoot, (rootKey, rootCap, rootMaxPerCall, rootExpiry))
            );
            console2.log("setEscrowFactory calldata:");
            console2.logBytes(abi.encodeCall(IOverflowTreasury.setEscrowFactory, (address(factory))));
        }
        console2.log("root key", rootKey);
        console2.log("root cap (atomic)", rootCap);
        console2.log("root maxPerCall (atomic)", rootMaxPerCall);
        console2.log("root expiry (unix)", rootExpiry);
    }
}
