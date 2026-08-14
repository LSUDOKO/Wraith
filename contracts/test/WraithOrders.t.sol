// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import { Test } from "forge-std/Test.sol";
import { WraithOrders } from "../src/WraithOrders.sol";
import { ITeeExtensionRegistry } from "../src/interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "../src/interfaces/ITeeMachineRegistry.sol";
import { IPayment, IWeb2Json } from "../src/interfaces/IFdc.sol";

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
        virtual
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

    function setUp() public virtual {
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

// --- Stealth TWAP: partial fills ---
//
// A large order executed in one shot moves the market and announces its size.
// TWAP splits it into chunks. The contract's job is only to account for what
// remains; the schedule itself is derived inside the enclave from a sealed
// seed, so no one can see the shape of the execution in advance.

contract WraithPartialFillTest is WraithOrdersTest {
    function _chunkResult(uint256 orderId, address target, uint256 chunk, uint256 minOut)
        internal
        view
        returns (bytes memory)
    {
        return abi.encode(
            orderId, target, wraith.ACTION_SWAP(), minOut, address(usdt), "", uint256(0), chunk
        );
    }

    function test_PartialFillLeavesTheOrderLive() public {
        uint256 orderId = _createOrder();
        // A quarter of the 100 ether escrow.
        bytes memory data = _chunkResult(orderId, address(wraith), 25 ether, 40 ether);
        bytes32 actionId = keccak256("chunk-1");

        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));

        assertEq(wraith.remainingOf(orderId), 75 ether, "remaining not decremented");
        (,,,, bool executed,,) = wraith.getOrder(orderId);
        assertFalse(executed, "a partial fill must not close the order");
        assertEq(usdt.balanceOf(alice), 50 ether, "chunk proceeds not delivered");
    }

    function test_FinalChunkClosesTheOrder() public {
        uint256 orderId = _createOrder();

        uint256[2] memory chunks = [uint256(60 ether), uint256(40 ether)];
        for (uint256 i = 0; i < chunks.length; i++) {
            bytes memory data = _chunkResult(orderId, address(wraith), chunks[i], 1);
            bytes32 actionId = keccak256(abi.encodePacked("chunk", i));
            wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));
        }

        assertEq(wraith.remainingOf(orderId), 0, "escrow not fully drawn down");
        (,,,, bool executed,,) = wraith.getOrder(orderId);
        assertTrue(executed, "the last chunk must close the order");
    }

    /// @notice A chunk larger than what is left must not overdraw the escrow —
    /// otherwise one bad result drains another order's funds.
    function test_ChunkIsClampedToWhatRemains() public {
        uint256 orderId = _createOrder();

        bytes memory first = _chunkResult(orderId, address(wraith), 90 ether, 1);
        bytes32 firstId = keccak256("chunk-1");
        wraith.execute(first, firstId, TAG, 1, _sign(TEE_PK, first, firstId, 1));

        // Asks for 50 when only 10 is left.
        bytes memory greedy = _chunkResult(orderId, address(wraith), 50 ether, 1);
        bytes32 greedyId = keccak256("chunk-2");
        wraith.execute(greedy, greedyId, TAG, 1, _sign(TEE_PK, greedy, greedyId, 1));

        assertEq(wraith.remainingOf(orderId), 0, "clamped chunk should finish the order");
        assertEq(fxrp.balanceOf(address(wraith)), 0, "contract must not hold leftover escrow");
    }

    /// @notice Zero means "spend what is left", which keeps every existing
    /// single-shot order working unchanged.
    function test_ZeroChunkSpendsTheWholeRemainder() public {
        uint256 orderId = _createOrder();
        bytes memory data = _swapResult(orderId, address(wraith));
        bytes32 actionId = keccak256("all-in");

        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));

        assertEq(wraith.remainingOf(orderId), 0, "a zero chunk must spend everything");
        assertEq(usdt.balanceOf(alice), 200 ether, "full proceeds not delivered");
    }

    function test_CancelRefundsOnlyWhatIsLeft() public {
        uint256 orderId = _createOrder();

        bytes memory data = _chunkResult(orderId, address(wraith), 30 ether, 1);
        bytes32 actionId = keccak256("chunk-1");
        wraith.execute(data, actionId, TAG, 1, _sign(TEE_PK, data, actionId, 1));

        vm.prank(alice);
        wraith.cancel(orderId);

        // 70 of the original 100 was never spent.
        assertEq(fxrp.balanceOf(alice), 70 ether, "refund must cover only the unspent escrow");
    }
}

/// @notice Stands in for the on-chain FDC verifier. A real proof is a Merkle
/// branch against a finalized round; here the answer is set directly, so tests
/// can exercise both the accepting and the rejecting path.
contract MockFdcVerification {
    bool public answer = true;

    function setAnswer(bool _answer) external {
        answer = _answer;
    }

    function verifyPayment(IPayment.Proof calldata) external view returns (bool) {
        return answer;
    }

    function verifyWeb2Json(IWeb2Json.Proof calldata) external view returns (bool) {
        return answer;
    }
}

/// @notice Records the message handed to the TEE so tests can assert on what
/// the enclave will actually see.
contract RecordingExtensionRegistry is MockExtensionRegistry {
    bytes public lastMessage;

    function sendInstructions(address[] calldata, ITeeExtensionRegistry.TeeInstructionParams calldata _params)
        external
        payable
        override
        returns (bytes32)
    {
        lastMessage = _params.message;
        return keccak256(abi.encodePacked("instruction", block.timestamp, msg.sender));
    }
}

contract WraithAttestedTickTest is WraithOrdersTest {
    MockFdcVerification internal fdc;
    RecordingExtensionRegistry internal recorder;
    WraithOrders internal attested;

    bytes32 internal constant SOURCE_HASH = keccak256("rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe");

    function setUp() public override {
        super.setUp();

        fdc = new MockFdcVerification();
        recorder = new RecordingExtensionRegistry();
        attested =
            new WraithOrders(ITeeExtensionRegistry(address(recorder)), ITeeMachineRegistry(address(machineRegistry)));
        recorder.setSender(address(attested));
        attested.setExtensionId();
        attested.setFdcVerification(address(fdc));

        // A separate funder, so the inherited base-suite balance assertions
        // still describe a wallet holding exactly one escrow.
        fxrp.mint(bob, ESCROW);
    }

    address internal bob = address(0xB0B);

    function _order() internal returns (uint256 orderId) {
        vm.startPrank(bob);
        fxrp.approve(address(attested), ESCROW);
        orderId = attested.createOrder(hex"deadbeef", address(fxrp), ESCROW, EXPIRY);
        vm.stopPrank();
    }

    function _paymentProof(int256 receivedDrops, uint64 ts) internal pure returns (IPayment.Proof memory p) {
        p.data.responseBody.sourceAddressHash = SOURCE_HASH;
        p.data.responseBody.receivedAmount = receivedDrops;
        p.data.responseBody.blockTimestamp = ts;
        p.data.responseBody.status = 0;
    }

    function test_AttestedTickCarriesTheVerifiedReadingToTheEnclave() public {
        uint256 orderId = _order();

        // 3 XRP, in drops.
        attested.tickAttested(orderId, _paymentProof(3_000_000, uint64(block.timestamp)));

        (,,,,, uint256 verified, uint256 amountE18, uint256 at, string memory source) = abi.decode(
            recorder.lastMessage(), (uint256, address, bytes, uint256, uint256, uint256, uint256, uint256, string)
        );

        assertEq(verified, 1, "attestation not marked verified");
        assertEq(amountE18, 3 ether, "drops not scaled to 1e18");
        assertEq(at, block.timestamp, "attestation timestamp lost");
        assertEq(source, vm.toString(SOURCE_HASH), "source hash not relayed");
    }

    /// @dev The whole point of verifying on-chain is that the keeper cannot
    /// assert a fact the FDC never attested.
    function test_RevertWhen_ProofDoesNotVerify() public {
        uint256 orderId = _order();
        fdc.setAnswer(false);

        vm.expectRevert("FDC rejected the proof");
        attested.tickAttested(orderId, _paymentProof(3_000_000, uint64(block.timestamp)));
    }

    function test_RevertWhen_PaymentFailedOnTheSourceChain() public {
        uint256 orderId = _order();
        IPayment.Proof memory p = _paymentProof(3_000_000, uint64(block.timestamp));
        p.data.responseBody.status = 1; // failed by sender

        vm.expectRevert("payment did not succeed");
        attested.tickAttested(orderId, p);
    }

    function test_RevertWhen_NoVerifierIsConfigured() public {
        uint256 orderId = _createOrder(); // the base fixture, which has no verifier
        vm.expectRevert("FDC verification not set");
        wraith.tickAttested(orderId, _paymentProof(3_000_000, uint64(block.timestamp)));
    }

    function _web2Proof(uint256 value, uint256 decimals) internal view returns (IWeb2Json.Proof memory p) {
        p.data.responseBody.abiEncodedData =
            abi.encode("coingecko:flare", value, decimals, uint256(block.timestamp));
    }

    /// @dev The attested reading arrives at whatever scale the source reports,
    /// because the jq subset FDC allows has no `floor` — so an attestation
    /// cannot round a price to 1e18 itself without risking float truncation.
    /// Normalizing here is both exact and the shape FTSO already uses.
    function test_Web2JsonTickNormalizesTheReadingTo1e18() public {
        uint256 orderId = _order();

        // FLR at $0.00600315, as CoinGecko reports it scaled by 1e8.
        attested.tickAttestedWeb2(orderId, _web2Proof(600_315, 8));

        (,,,,, uint256 verified, uint256 amountE18, uint256 at, string memory source) = abi.decode(
            recorder.lastMessage(), (uint256, address, bytes, uint256, uint256, uint256, uint256, uint256, string)
        );

        assertEq(verified, 1);
        assertEq(amountE18, 6_003_150_000_000_000, "reading not scaled to 1e18");
        assertEq(at, block.timestamp);
        assertEq(source, "coingecko:flare");
    }

    function test_Web2JsonTickAcceptsAReadingAlreadyAt1e18() public {
        uint256 orderId = _order();
        attested.tickAttestedWeb2(orderId, _web2Proof(2.5 ether, 18));

        (,,,,,, uint256 amountE18,,) = abi.decode(
            recorder.lastMessage(), (uint256, address, bytes, uint256, uint256, uint256, uint256, uint256, string)
        );
        assertEq(amountE18, 2.5 ether);
    }

    /// @dev Scaling up from more than 18 decimals is not a rounding problem, it
    /// is a malformed attestation — and silently truncating it would hand the
    /// enclave a price that is wrong by orders of magnitude.
    function test_RevertWhen_ReadingClaimsMoreThan18Decimals() public {
        uint256 orderId = _order();
        vm.expectRevert("attested decimals out of range");
        attested.tickAttestedWeb2(orderId, _web2Proof(1, 19));
    }

    /// @dev An attested tick is still a tick: it must not become a way around
    /// the rate limit that protects the order owner's instruction fees.
    function test_AttestedTickIsRateLimitedLikeAPlainTick() public {
        uint256 orderId = _order();
        attested.tickAttested(orderId, _paymentProof(3_000_000, uint64(block.timestamp)));

        vm.expectRevert("ticked too recently");
        attested.tickAttested(orderId, _paymentProof(3_000_000, uint64(block.timestamp)));
    }
}

contract WraithGaslessTest is WraithOrdersTest {
    uint256 internal constant USER_PK = 0xBEEF;
    address internal user;
    address internal relayer = address(0xDEAD01);

    uint256 internal constant FEE = 1 ether;

    function setUp() public override {
        super.setUp();
        user = vm.addr(USER_PK);
        fxrp.mint(user, ESCROW + FEE);
        vm.prank(user);
        fxrp.approve(address(wraith), type(uint256).max);
    }

    function _intent(address who, uint256 fee, uint256 deadline)
        internal
        view
        returns (WraithOrders.CreateIntent memory)
    {
        return WraithOrders.CreateIntent({
            owner: who,
            tokenIn: address(fxrp),
            amountIn: ESCROW,
            expiry: EXPIRY,
            relayerFee: fee,
            deadline: deadline
        });
    }

    function _signIntent(uint256 pk, WraithOrders.CreateIntent memory intent) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                wraith.CREATE_ORDER_TYPEHASH(),
                intent.owner,
                keccak256(hex"deadbeef"),
                intent.tokenIn,
                intent.amountIn,
                intent.expiry,
                intent.relayerFee,
                wraith.nonces(intent.owner),
                intent.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", wraith.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// @dev The point of the whole mechanism: a user holding FXRP but no FLR
    /// can still open an order.
    function test_RelayerOpensAnOrderForAUserWithNoGas() public {
        WraithOrders.CreateIntent memory intent = _intent(user, FEE, block.timestamp + 3600);
        bytes memory sig = _signIntent(USER_PK, intent);

        vm.prank(relayer);
        uint256 orderId = wraith.createOrderFor(intent, hex"deadbeef", sig);

        (address o,, uint256 amountIn,,,,) = wraith.getOrder(orderId);
        assertEq(o, user, "order not owned by the signer");
        assertEq(amountIn, ESCROW);
        assertEq(fxrp.balanceOf(relayer), FEE, "relayer not reimbursed");
        assertEq(fxrp.balanceOf(address(wraith)), ESCROW, "escrow wrong");
    }

    function test_RevertWhen_SignatureIsFromSomeoneElse() public {
        WraithOrders.CreateIntent memory intent = _intent(user, FEE, block.timestamp + 3600);
        bytes memory sig = _signIntent(TEE_PK, intent);

        vm.prank(relayer);
        vm.expectRevert("bad intent signature");
        wraith.createOrderFor(intent, hex"deadbeef", sig);
    }

    /// @dev Without a nonce a relayer could replay one signature until the
    /// user's whole balance was escrowed.
    function test_RevertWhen_IntentIsReplayed() public {
        WraithOrders.CreateIntent memory intent = _intent(user, FEE, block.timestamp + 3600);
        bytes memory sig = _signIntent(USER_PK, intent);

        vm.startPrank(relayer);
        wraith.createOrderFor(intent, hex"deadbeef", sig);
        vm.expectRevert("bad intent signature");
        wraith.createOrderFor(intent, hex"deadbeef", sig);
        vm.stopPrank();
    }

    function test_RevertWhen_IntentHasExpired() public {
        WraithOrders.CreateIntent memory intent = _intent(user, FEE, block.timestamp - 1);
        bytes memory sig = _signIntent(USER_PK, intent);

        vm.prank(relayer);
        vm.expectRevert("intent expired");
        wraith.createOrderFor(intent, hex"deadbeef", sig);
    }

    /// @dev A relayer must not be able to raise its own fee after the fact.
    function test_RevertWhen_RelayerInflatesTheFee() public {
        WraithOrders.CreateIntent memory intent = _intent(user, FEE, block.timestamp + 3600);
        bytes memory sig = _signIntent(USER_PK, intent);

        intent.relayerFee = FEE * 10;
        vm.prank(relayer);
        vm.expectRevert("bad intent signature");
        wraith.createOrderFor(intent, hex"deadbeef", sig);
    }
}
