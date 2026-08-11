// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.7.6 <0.9;

// Minimal local interface, mirroring the Flare FCC example contracts.
// TODO: replace with the package import once flare-smart-contracts-v2 is published.
//
// NOTE: this interface exposes only `getRandomTeeIds`, which selects machines at
// random. It is deliberately NOT a membership query, so a contract cannot ask
// "is this address a registered TEE for my extension?". WraithOrders therefore
// verifies signatures against an owner-curated allowlist (see `setTeeAddress`).
interface ITeeMachineRegistry {
    function getRandomTeeIds(uint256 _extensionId, uint256 _count) external view returns (address[] memory);
}
