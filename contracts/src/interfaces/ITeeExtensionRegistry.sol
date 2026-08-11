// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.7.6 <0.9;

// Minimal local interface, mirroring the Flare FCC example contracts.
// TODO: replace with the package import once flare-smart-contracts-v2 is published:
//   import { ITeeExtensionRegistry } from "flare-smart-contracts-v2/contracts/userInterfaces/tee/ITeeExtensionRegistry.sol";
interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    function sendInstructions(
        address[] calldata _teeIds,
        TeeInstructionParams calldata _instructionParams
    ) external payable returns (bytes32 _instructionId);

    function nextPublicExtensionId() external view returns (uint256);

    function getTeeExtensionInstructionsSender(uint256 _extensionId) external view returns (address);
}
