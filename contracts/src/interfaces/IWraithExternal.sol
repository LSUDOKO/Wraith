// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0 <0.9;

/// @notice Minimal ERC-20 surface used for escrow and settlement.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Uniswap V2 router surface. On Flare this is BlazeSwap.
interface IUniswapV2Router {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

/// @notice FAssets AssetManager surface used for FXRP redemption.
/// @dev Redemption is lot-granular: `_lots` is a lot count, not a token amount.
interface IAssetManager {
    function redeem(
        uint256 _lots,
        string memory _redeemerUnderlyingAddressString,
        address payable _executor
    ) external payable returns (uint256);

    function fAsset() external view returns (address);
}
