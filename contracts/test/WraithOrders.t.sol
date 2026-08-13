// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { WraithOrders } from "../src/WraithOrders.sol";
import { ITeeExtensionRegistry } from "../src/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../src/interfaces/ITeeMachineRegistry.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "insufficient");
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "not allowed");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockExtensionRegistry {
    address public sender;
    uint256 public constant EXT_ID = 0x10000;

    function setSender(address _sender) external {
        sender = _sender;
    }

    function sendInstructions(address[] calldata, ITeeExtensionRegistry.TeeInstructionParams calldata)
        external
        payable
        returns (bytes32)
    {
        return keccak256(abi.encodePacked("instruction", block.timestamp, msg.sender));
    }

    function nextPublicExtensionId() external pure returns (uint256) {
        return EXT_ID + 1;
    }

    function getTeeExtensionInstructionsSender(uint256) external view returns (address) {
        return sender;
    }
}

contract MockMachineRegistry {
    address[] private _active;

    function setActive(address[] memory machines) external {
        _active = machines;
    }

    /// @dev Mirrors the live FlareTeeManager diamond, which returns machine
    /// addresses alongside their proxy URLs.
    function getActiveTeeMachines(uint256) external view returns (address[] memory, string[] memory) {
        return (_active, new string[](_active.length));
    }

    function getRandomTeeIds(uint256, uint256 _count) external pure returns (address[] memory ids) {
        ids = new address[](_count);
        for (uint256 i = 0; i < _count; ++i) {
            ids[i] = address(uint160(0x7EE0 + i));
        }
    }
}

/// @notice Swaps at a fixed 1:2 rate.
contract MockRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256
    ) external returns (uint256[] memory amounts) {
        uint256 out = amountIn * 2;
        require(out >= amountOutMin, "insufficient output");

        MockERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        MockERC20(path[1]).transfer(to, out);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}

contract WraithOrdersTest is Test {
    WraithOrders internal wraith;
    MockERC20 internal fxrp;
    MockERC20 internal usdt;
    MockExtensionRegistry internal extRegistry;
    MockMachineRegistry internal machineRegistry;
    MockRouter internal router;

    uint256 internal constant TEE_PK = 0xA11CE;
    address internal teeAddr;

    address internal alice = address(0xA1);

    string internal constant TAG = "submit";
    uint64 internal constant EXPIRY = 1_000_000;
    uint256 internal constant ESCROW = 100 ether;

    function setUp() public {
        vm.warp(1000);

        teeAddr = vm.addr(TEE_PK);

        fxrp = new MockERC20();
        usdt = new MockERC20();
        extRegistry = new MockExtensionRegistry();
        machineRegistry = new MockMachineRegistry();
        router = new MockRouter();

        wraith = new WraithOrders(ITeeExtensionRegistry(address(extRegistry)), ITeeMachineRegistry(address(machineRegistry)));

        extRegistry.setSender(address(wraith));
        wraith.setExtensionId();
        wraith.setRouter(address(router));

        // The TEE's authority comes from the machine registry, not from anything
        // the owner sets — there is no allowlist to add it to.
        address[] memory active = new address[](1);
        active[0] = teeAddr;
        machineRegistry.setActive(active);

        fxrp.mint(alice, ESCROW);
        usdt.mint(address(router), 1000 ether);
    }

    // --- helpers ---

    function _createOrder() internal returns (uint256 orderId) {
        vm.startPrank(alice);
        fxrp.approve(address(wraith), ESCROW);
        orderId = wraith.createOrder(hex"deadbeef", address(fxrp), ESCROW, EXPIRY);
        vm.stopPrank();
    }

    function _swapResult(uint256 orderId, address target) internal view returns (bytes memory) {
        return abi.encode(orderId, target, wraith.ACTION_SWAP(), uint256(150 ether), address(usdt), "", uint256(0));
    }

    /// @dev Mirrors what the TEE node signs: an EIP-191 personal-sign over a
    /// chain-scoped, domain-separated wrapper around ActionResult.Hash().
    function _sign(uint256 pk, bytes memory data, bytes32 actionId, uint8 status) internal view returns (bytes memory) {
        bytes32 resultHash = keccak256(abi.encodePacked(keccak256(data), actionId, keccak256(bytes(TAG)), status));
        bytes32 payloadHash = keccak256(abi.encode(bytes32("TEE_ACTION_RESULT"), block.chainid, resultHash));
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payloadHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    // --- tests ---

    function test_CreateOrderEscrowsAndKeepsTermsOpaque() public {
        uint256 orderId = _createOrder();

        assertEq(fxrp.balanceOf(address(wraith)), ESCROW, "escrow not held");
        assertEq(fxrp.balanceOf(alice), 0, "escrow not pulled");

        (address o,, uint256 amountIn,,,, bytes memory encrypted) = wraith.getOrder(orderId);
        assertEq(o, alice);
        assertEq(amountIn, ESCROW);
        // The only thing on-chain is ciphertext. Nothing reveals the trigger price.
        assertEq(encrypted, hex"deadbeef");
    }

    function test_ExecuteSwapWithValidTeeSignature() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));

        assertEq(usdt.balanceOf(alice), 200 ether, "proceeds not delivered to owner");
        (,,,, bool executed,,) = wraith.getOrder(orderId);
        assertTrue(executed, "order not marked executed");
    }

    function test_RevertWhen_SignerIsNotRegisteredTee() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        uint256 impostorPk = 0xBAD;
        vm.expectRevert("signer is not an active TEE");
        wraith.execute(data, actionId, TAG, 1, _sign(impostorPk, data, actionId, 1));
    }

    /// @notice A TEE that the registry has retired can no longer settle orders,
    /// with no action required from the contract owner.
    function test_RevertWhen_TeeIsNoLongerActiveInRegistry() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        machineRegistry.setActive(new address[](0));

        vm.expectRevert("signer is not an active TEE");
        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));
    }

    /// @notice Authority is the registry's to grant. The owner cannot mint it.
    function test_OwnerCannotAuthorizeAnArbitrarySigner() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        uint256 ownerPickedPk = 0xC0FFEE;

        // Even the owner acting deliberately cannot make this signature valid,
        // because no owner-controlled allowlist exists.
        vm.prank(wraith.owner());
        vm.expectRevert("signer is not an active TEE");
        wraith.execute(data, actionId, TAG, 1, _sign(ownerPickedPk, data, actionId, 1));
    }

    /// @notice Any machine the registry lists is accepted, not just the first.
    function test_AcceptsAnySignerListedByTheRegistry() public {
        uint256 secondPk = 0xB0B5;
        address[] memory active = new address[](2);
        active[0] = address(0xDEAD);
        active[1] = vm.addr(secondPk);
        machineRegistry.setActive(active);

        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-2");

        wraith.execute(data, actionId, TAG, 1, _sign(secondPk, data, actionId, 1));

        assertEq(usdt.balanceOf(alice), 200 ether, "registry-listed TEE could not settle");
    }

    function test_RevertWhen_ActionIdIsReplayed() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");
        bytes memory sig = _sign(TEE_PK, data, actionId, 1);

        wraith.execute(data, actionId, TAG, 1, sig);

        vm.expectRevert("action already used");
        wraith.execute(data, actionId, TAG, 1, sig);
    }

    function test_RevertWhen_ResultTargetsAnotherContract() public {
        uint256 orderId = _createOrder();
        // Same TEE, same order, but addressed to a different Wraith deployment.
        bytes memory data = _swapResult(orderId, address(0xDEAD));
        bytes32 actionId = keccak256("action-1");

        vm.expectRevert("result not for this contract");
        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));
    }

    function test_RevertWhen_TeeReportsFailure() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        vm.expectRevert("TEE reported failure");
        wraith.execute(data, actionId, TAG, 0, _sign(TEE_PK, data, actionId, 0));
    }

    function test_RevertWhen_OrderExpired() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        vm.warp(EXPIRY + 1);

        vm.expectRevert("expired");
        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));
    }

    function test_CancelRefundsOwner() public {
        uint256 orderId = _createOrder();

        vm.prank(alice);
        wraith.cancel(orderId);

        assertEq(fxrp.balanceOf(alice), ESCROW, "not refunded");
    }

    function test_AnyoneCanCancelExpiredOrderAndOwnerIsRefunded() public {
        uint256 orderId = _createOrder();
        vm.warp(EXPIRY + 1);

        vm.prank(address(0xB0B));
        wraith.cancel(orderId);

        assertEq(fxrp.balanceOf(alice), ESCROW, "owner not refunded");
    }

    function test_RevertWhen_NonOwnerCancelsLiveOrder() public {
        uint256 orderId = _createOrder();

        vm.prank(address(0xB0B));
        vm.expectRevert("not owner and not expired");
        wraith.cancel(orderId);
    }

    function test_TickIsRateLimited() public {
        uint256 orderId = _createOrder();

        wraith.tick{ value: 0 }(orderId);

        vm.expectRevert("ticked too recently");
        wraith.tick{ value: 0 }(orderId);

        vm.warp(block.timestamp + wraith.MIN_TICK_INTERVAL());
        wraith.tick{ value: 0 }(orderId);
    }

    function test_RevertWhen_ExecutingCancelledOrder() public {
        uint256 orderId = _createOrder();
        vm.prank(alice);
        wraith.cancel(orderId);

        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("action-1");

        vm.expectRevert("cancelled");
        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));
    }
}

// --- Trailing stops: on-chain peak tracking ---
//
// A trailing stop needs to remember the highest price seen. The enclave has no
// sealed storage, so the peak lives on-chain instead. That is safe precisely
// because the peak is derived from public FTSO prices — it reveals nothing a
// determined observer could not already compute. The secret is the trail
// distance, which stays inside the ciphertext.

contract WraithTrailingTest is WraithOrdersTest {
    function _trackResult(uint256 orderId, address target, uint256 newPeak) internal view returns (bytes memory) {
        return abi.encode(orderId, target, wraith.ACTION_TRACK(), uint256(0), address(0), "", newPeak);
    }

    function test_TrackResultRecordsPeakWithoutSettling() public {
        uint256 orderId = _createOrder();
        bytes memory data = _trackResult(orderId, address(wraith), 3 ether);
        bytes32 actionId = keccak256("track-1");

        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));

        assertEq(wraith.peakOf(orderId), 3 ether, "peak not recorded");

        (,,,, bool executed,,) = wraith.getOrder(orderId);
        assertFalse(executed, "a peak update must not settle the order");
    }

    /// @notice The peak is a high-water mark. A lower reading must never lower
    /// it, or a passing dip would drag the trail down and fire early.
    function test_PeakOnlyRatchetsUpward() public {
        uint256 orderId = _createOrder();

        bytes memory high = _trackResult(orderId, address(wraith), 5 ether);
        bytes32 idHigh = keccak256("track-high");
        wraith.execute(high, idHigh, TAG, 1, _sign(TEE_PK, high, idHigh, 1));

        bytes memory low = _trackResult(orderId, address(wraith), 2 ether);
        bytes32 idLow = keccak256("track-low");
        wraith.execute(low, idLow, TAG, 1, _sign(TEE_PK, low, idLow, 1));

        assertEq(wraith.peakOf(orderId), 5 ether, "a dip must not lower the peak");
    }

    function test_RevertWhen_TrackResultIsNotSignedByATee() public {
        uint256 orderId = _createOrder();
        bytes memory data = _trackResult(orderId, address(wraith), 9 ether);
        bytes32 actionId = keccak256("track-1");

        vm.expectRevert("signer is not an active TEE");
        wraith.execute(data, actionId, TAG, 1, _sign(0xBAD, data, actionId, 1));
    }

    /// @notice Settlement still works alongside tracking, and carries its own
    /// peak so the final tick does not need a separate update.
    function test_SettlementStillExecutesAndCanCarryAPeak() public {
        uint256 orderId = _createOrder();
        bytes memory data =
            abi.encode(orderId, address(wraith), wraith.ACTION_SWAP(), uint256(150 ether), address(usdt), "", uint256(7 ether));
        bytes32 actionId = keccak256("settle-1");

        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));

        assertEq(usdt.balanceOf(alice), 200 ether, "proceeds not delivered");
        assertEq(wraith.peakOf(orderId), 7 ether, "peak from the settling tick not recorded");
    }

    function test_RevertWhen_TrackingAnAlreadyExecutedOrder() public {
        uint256 orderId = _createOrder();
        bytes memory settle =
            abi.encode(orderId, address(wraith), wraith.ACTION_SWAP(), uint256(150 ether), address(usdt), "", uint256(0));
        bytes32 settleId = keccak256("settle-1");
        wraith.execute(settle, settleId, TAG, 1, _sign(TEE_PK, settle, settleId, 1));

        bytes memory track = _trackResult(orderId, address(wraith), 9 ether);
        bytes32 trackId = keccak256("track-after");

        vm.expectRevert("already executed");
        wraith.execute(track, trackId, TAG, 1, _sign(TEE_PK, track, trackId, 1));
    }
}
