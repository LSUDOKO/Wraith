// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import { Script, console } from "forge-std/Script.sol";
import { WraithOrders } from "../src/WraithOrders.sol";
import { ITeeExtensionRegistry } from "../src/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../src/interfaces/ITeeMachineRegistry.sol";

/// @notice Deploys WraithOrders against the Coston2 FCC registries.
///
/// Registry addresses come from the environment because FCC is pre-release and
/// its registry addresses on Coston2 still change between deployments — they are
/// read from the scaffold's config/coston2/deployed-addresses.json, not from the
/// FlareContractRegistry yet.
///
/// Usage:
///   export TEE_EXTENSION_REGISTRY=0x...   # from deployed-addresses.json
///   export TEE_MACHINE_REGISTRY=0x...
///   export BLAZESWAP_ROUTER=0x...         # optional, enables the swap action
///   export FXRP_ASSET_MANAGER=0x...       # optional, enables the redeem action
///   forge script script/Deploy.s.sol --rpc-url $COSTON2_RPC --broadcast \
///     --private-key $DEPLOYER_KEY
///
/// After deployment, register the extension (scripts/pre-build.sh in the
/// scaffold), then call setExtensionId() and setTeeAddress() — see the runbook
/// in docs/DEPLOY.md.
contract Deploy is Script {
    function run() external {
        address extRegistry = vm.envAddress("TEE_EXTENSION_REGISTRY");
        address machineRegistry = vm.envAddress("TEE_MACHINE_REGISTRY");
        address router = vm.envOr("BLAZESWAP_ROUTER", address(0));
        address assetManager = vm.envOr("FXRP_ASSET_MANAGER", address(0));

        vm.startBroadcast();

        WraithOrders wraith =
            new WraithOrders(ITeeExtensionRegistry(extRegistry), ITeeMachineRegistry(machineRegistry));

        if (router != address(0)) {
            wraith.setRouter(router);
        }
        if (assetManager != address(0)) {
            wraith.setAssetManager(assetManager);
        }

        vm.stopBroadcast();

        console.log("WraithOrders deployed at:", address(wraith));
        console.log("Next steps:");
        console.log("  1. Register the extension (scaffold pre-build.sh) with this address as sender");
        console.log("  2. Call setExtensionId() once registration is confirmed");
        console.log("  3. Call setTeeAddress(<tee>, true) with the registered TEE signer");
    }
}
