// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.7.6 <0.9;

// Minimal local interface, mirroring the Flare FCC example contracts.
// TODO: replace with the package import once flare-smart-contracts-v2 is published.
interface ITeeMachineRegistry {
    /// @notice Picks machines at random to route an instruction to.
    function getRandomTeeIds(uint256 _extensionId, uint256 _count) external view returns (address[] memory);

    /// @notice Every TEE machine currently registered to an extension, with the
    /// proxy URL of each.
    /// @dev This is the authority on which signers may settle an order. The
    /// scaffold's own `extension-post-setup.sh` reads the TEE signing address
    /// from here, and the signature is live on the Coston2 FlareTeeManager
    /// diamond at 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE.
    function getActiveTeeMachines(uint256 _extensionId)
        external
        view
        returns (address[] memory _machines, string[] memory _urls);
}
