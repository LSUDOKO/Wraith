// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.27;

import { ITeeExtensionRegistry } from "./interfaces/ITeeExtensionRegistry.sol";
import { ITeeMachineRegistry } from "./interfaces/ITeeMachineRegistry.sol";
import { IERC20, IUniswapV2Router, IAssetManager } from "./interfaces/IWraithExternal.sol";
import { IFdcVerification, IPayment, IWeb2Json } from "./interfaces/IFdc.sol";

/// @title WraithOrders
/// @notice Private conditional orders on Flare. A user escrows an asset and stores
/// their trigger condition on-chain as an ECIES ciphertext that only a Flare
/// Confidential Compute (FCC) TEE extension can read. A keeper periodically pokes
/// the order via `tick()`; the extension decrypts the condition inside the enclave,
/// evaluates it against FTSO prices (and, for cross-chain triggers, FDC-attested
/// events), and returns a signed result **only when the condition fires**.
/// `execute()` verifies that signature and settles.
///
/// The point is that the condition is never public. Conventional on-chain
/// automation publishes the trigger price, which is exactly what makes stop-loss
/// hunting possible.
///
/// Scope: this hides *standing intent*, not the execution transaction. Once a
/// trigger fires, the resulting swap or redemption is an ordinary public
/// transaction. Execution-moment MEV is out of scope.
///
/// This contract doubles as the FCC InstructionSender: it owns the extension
/// registration and routes WRAITH/EVAL_ORDER instructions through the Flare TEE
/// Manager diamond.
///
/// DO NOT MODIFY: the registry wiring in the constructor, setExtensionId(), and
/// _getExtensionId().
contract WraithOrders {
    // --- FCC operation identifiers (must match extension/internal/config/config.go) ---

    /// @notice Operation type for Wraith actions.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_WRAITH = bytes32("WRAITH");

    /// @notice Command asking the TEE to evaluate one order's private condition.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_EVAL_ORDER = bytes32("EVAL_ORDER");

    /// @notice Domain-separation prefix the TEE node signs ActionResult hashes under:
    /// keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, chainId, ActionResult.Hash())),
    /// wrapped with the EIP-191 personal-sign prefix. Must match go-flare-common's
    /// `signing.TEEActionResult`.
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 private constant TEE_ACTION_RESULT_PREFIX = bytes32("TEE_ACTION_RESULT");

    /// @notice First public extension ID; the registry reserves IDs below this.
    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000; // 65536

    /// @notice Minimum spacing between ticks on one order, so a keeper cannot burn
    /// an order owner's instruction fees (or spam the TEE) with a tight loop.
    uint64 public constant MIN_TICK_INTERVAL = 30;

    // --- Actions the TEE may authorize ---

    uint8 public constant ACTION_SWAP = 0;
    uint8 public constant ACTION_REDEEM = 1;
    /// @notice Record a new price peak without settling. Trailing stops need a
    /// high-water mark, and the enclave has no storage of its own to keep it in.
    uint8 public constant ACTION_TRACK = 2;

    // --- Registries ---

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    uint256 private _extensionId;

    // --- Order state ---

    /// @notice A private conditional order. The trigger condition lives only in
    /// `encrypted`; nothing about it is readable on-chain.
    struct Order {
        address owner; // receives proceeds, and refunds on cancel/expiry
        address tokenIn; // escrowed asset (FXRP for the reference flow)
        uint256 amountIn; // escrowed amount at creation, never changes
        /// @notice Escrow not yet spent.
        ///
        /// A TWAP order settles in chunks, so the contract has to account for
        /// what is left rather than treating settlement as all-or-nothing. The
        /// order only closes when this reaches zero.
        uint256 remaining;
        uint64 expiry; // after this, the order can only be cancelled
        uint64 nextTickAt; // rate limit, see MIN_TICK_INTERVAL
        bool executed;
        bool cancelled;
        /// @notice Highest observed price for this order, scaled by 1e18.
        ///
        /// Public on purpose. The peak is derived from FTSO prices, which
        /// anyone can read, so storing it reveals nothing a determined observer
        /// could not already compute. What stays secret is the *trail distance*
        /// — how far below this peak the order fires — which never leaves the
        /// ciphertext.
        uint256 peakE18;
        bytes encrypted; // ECIES ciphertext of the trigger terms — the secret
    }

    /// @notice A gasless order the owner signed off-chain for a relayer to submit.
    struct CreateIntent {
        address owner; // signer, and owner of the resulting order
        address tokenIn;
        uint256 amountIn;
        uint64 expiry;
        uint256 relayerFee; // paid to the submitter in tokenIn
        uint256 deadline; // unix seconds; the intent is dead after this
    }

    /// @notice Message handed to the TEE on each tick.
    struct EvalMessage {
        uint256 orderId;
        address contractAddr; // echoed back so execute() can bind the result
        bytes encrypted; // the ciphertext to decrypt in-enclave
    }

    address public owner;

    /// @notice Router used for the swap action. BlazeSwap on Flare.
    IUniswapV2Router public router;

    /// @notice FAssets AssetManager used for the redeem action.
    IAssetManager public assetManager;

    /// @notice On-chain FDC verifier, resolved from the Flare contract registry
    /// under `FdcVerification`. Required for cross-chain and consensus orders.
    IFdcVerification public fdcVerification;

    /// @notice EIP-712 type hash for a gasless order intent.
    ///
    /// The ciphertext is committed to by hash rather than by value: the intent
    /// must bind the exact sealed terms a relayer submits, but hashing keeps the
    /// signed struct a fixed size.
    bytes32 public constant CREATE_ORDER_TYPEHASH = keccak256(
        "CreateOrder(address owner,bytes32 encryptedHash,address tokenIn,uint256 amountIn,uint64 expiry,uint256 relayerFee,uint256 nonce,uint256 deadline)"
    );

    /// @notice Per-signer counter that makes each gasless intent single-use.
    /// Without it, one signature could be replayed until the signer's whole
    /// balance had been escrowed.
    mapping(address => uint256) public nonces;

    /// @dev There is deliberately no owner-controlled set of accepted signers.
    /// Authority to settle an order comes from `TeeMachineRegistry`, so the
    /// contract owner cannot grant it to an address of their choosing.

    /// @notice Action IDs already settled. Without this a single signed result
    /// could be replayed to execute the same order more than once.
    mapping(bytes32 => bool) public usedActionId;

    Order[] private _orders;

    event OrderCreated(uint256 indexed orderId, address indexed owner, address tokenIn, uint256 amountIn, uint64 expiry);
    event OrderTicked(uint256 indexed orderId, bytes32 instructionId);
    event OrderExecuted(uint256 indexed orderId, uint8 action, uint256 amountIn, uint256 result);
    event OrderCancelled(uint256 indexed orderId, uint256 refunded);
    event PeakTracked(uint256 indexed orderId, uint256 peakE18);
    event RouterSet(address indexed router);
    event AssetManagerSet(address indexed assetManager);
    event FdcVerificationSet(address indexed fdcVerification);
    event OrderRelayed(uint256 indexed orderId, address indexed relayer, uint256 fee);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(ITeeExtensionRegistry _teeExtensionRegistry, ITeeMachineRegistry _teeMachineRegistry) {
        require(address(_teeExtensionRegistry) != address(0), "TeeExtensionRegistry cannot be zero address");
        require(address(_teeMachineRegistry) != address(0), "TeeMachineRegistry cannot be zero address");
        require(address(_teeExtensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_teeMachineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _teeExtensionRegistry;
        TEE_MACHINE_REGISTRY = _teeMachineRegistry;
        owner = msg.sender;
    }

    /// @notice Finds and sets this contract's extension id. Can only be set once.
    /// DO NOT MODIFY this function.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");

        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    // --- Admin ---

    function setRouter(address _router) external onlyOwner {
        require(_router != address(0), "zero router");
        router = IUniswapV2Router(_router);
        emit RouterSet(_router);
    }

    function setAssetManager(address _assetManager) external onlyOwner {
        require(_assetManager != address(0), "zero asset manager");
        assetManager = IAssetManager(_assetManager);
        emit AssetManagerSet(_assetManager);
    }

    function setFdcVerification(address _fdcVerification) external onlyOwner {
        require(_fdcVerification != address(0), "zero fdc verification");
        fdcVerification = IFdcVerification(_fdcVerification);
        emit FdcVerificationSet(_fdcVerification);
    }

    // --- Order lifecycle ---

    /// @notice Create a private conditional order.
    /// @dev Nothing about the trigger is stored in the clear. `_encrypted` is an
    /// ECIES ciphertext encrypted to the extension's public key, which callers
    /// fetch from the extension proxy's `/info` endpoint.
    /// @param _encrypted ECIES ciphertext of the trigger terms.
    /// @param _tokenIn Asset to escrow (FXRP in the reference flow).
    /// @param _amountIn Amount to escrow. Caller must approve first.
    /// @param _expiry Unix seconds after which the order may only be cancelled.
    /// @return orderId The new order's id.
    function createOrder(bytes calldata _encrypted, address _tokenIn, uint256 _amountIn, uint64 _expiry)
        external
        returns (uint256 orderId)
    {
        require(_encrypted.length > 0, "empty ciphertext");
        require(_tokenIn != address(0), "zero token");
        require(_amountIn > 0, "zero amount");
        require(_expiry > block.timestamp, "expiry in the past");

        require(IERC20(_tokenIn).transferFrom(msg.sender, address(this), _amountIn), "escrow transfer failed");

        orderId = _push(msg.sender, _encrypted, _tokenIn, _amountIn, _expiry);
    }

    /// @notice Open an order on behalf of a user who signed for it off-chain.
    ///
    /// @dev This is the gasless path. A user who minted FXRP holds no FLR, so
    /// they cannot pay for the transaction that would escrow it — the asset they
    /// want to protect is exactly the one they cannot act on. Here they sign an
    /// EIP-712 intent (free, no chain interaction) and any relayer submits it,
    /// reimbursing itself with `_relayerFee` **in the escrowed token** rather
    /// than in native gas. The user never needs FLR at any point: settlement is
    /// already permissionless, so `execute()` costs them nothing either.
    ///
    /// Every parameter is covered by the signature, so a relayer cannot raise
    /// its own fee, retarget the escrow, or swap in different sealed terms —
    /// changing any of them simply makes the signature recover to another
    /// address.
    ///
    /// @param _intent What the user signed. Every field is covered by the
    ///                signature.
    /// @param _encrypted The sealed terms, committed to by hash in the intent.
    /// @param _signature 65-byte EIP-712 signature over CREATE_ORDER_TYPEHASH.
    function createOrderFor(CreateIntent calldata _intent, bytes calldata _encrypted, bytes calldata _signature)
        external
        returns (uint256 orderId)
    {
        require(_encrypted.length > 0, "empty ciphertext");
        require(_intent.tokenIn != address(0), "zero token");
        require(_intent.amountIn > 0, "zero amount");
        require(_intent.expiry > block.timestamp, "expiry in the past");
        require(block.timestamp <= _intent.deadline, "intent expired");

        require(_recover(_intentDigest(_intent, keccak256(_encrypted)), _signature) == _intent.owner, "bad intent signature");

        // Consumed before any transfer, so a token with a callback cannot
        // re-enter and spend the same intent twice.
        nonces[_intent.owner] += 1;

        IERC20 token = IERC20(_intent.tokenIn);
        require(
            token.transferFrom(_intent.owner, address(this), _intent.amountIn + _intent.relayerFee),
            "escrow transfer failed"
        );
        if (_intent.relayerFee > 0) {
            require(token.transfer(msg.sender, _intent.relayerFee), "relayer fee failed");
        }

        orderId = _push(_intent.owner, _encrypted, _intent.tokenIn, _intent.amountIn, _intent.expiry);
        emit OrderRelayed(orderId, msg.sender, _intent.relayerFee);
    }

    /// @notice EIP-712 digest a user must sign to authorize a relayed order.
    /// Exposed so a wallet or relayer can verify what it is about to submit.
    function intentDigest(CreateIntent calldata _intent, bytes calldata _encrypted) external view returns (bytes32) {
        return _intentDigest(_intent, keccak256(_encrypted));
    }

    function _intentDigest(CreateIntent calldata _intent, bytes32 _encryptedHash) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CREATE_ORDER_TYPEHASH,
                _intent.owner,
                _encryptedHash,
                _intent.tokenIn,
                _intent.amountIn,
                _intent.expiry,
                _intent.relayerFee,
                nonces[_intent.owner],
                _intent.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice EIP-712 domain separator for gasless intents.
    /// @dev Computed rather than cached so a fork of the chain cannot replay
    /// intents signed for the original.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Wraith"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @dev Shared by the direct and relayed creation paths so the two cannot
    /// drift apart on what an order looks like.
    function _push(address _orderOwner, bytes calldata _encrypted, address _tokenIn, uint256 _amountIn, uint64 _expiry)
        private
        returns (uint256 orderId)
    {
        orderId = _orders.length;
        _orders.push(
            Order({
                owner: _orderOwner,
                tokenIn: _tokenIn,
                amountIn: _amountIn,
                remaining: _amountIn,
                expiry: _expiry,
                nextTickAt: 0,
                executed: false,
                cancelled: false,
                peakE18: 0,
                encrypted: _encrypted
            })
        );

        emit OrderCreated(orderId, _orderOwner, _tokenIn, _amountIn, _expiry);
    }

    /// @notice Ask the TEE to evaluate an order's private condition.
    /// @dev Permissionless — anyone may run a keeper. The keeper learns nothing:
    /// it forwards ciphertext and cannot tell a "not triggered" reply from silence.
    /// Native value is forwarded to the registry as the instruction fee.
    function tick(uint256 _orderId) external payable {
        Order storage o = _prepareTick(_orderId);
        _send(_orderId, abi.encode(_orderId, address(this), o.encrypted, o.peakE18, o.remaining));
    }

    /// @notice Drops per XRP. FDC reports XRPL amounts in drops (1e-6 XRP); the
    /// enclave compares everything at 1e18.
    uint256 private constant XRP_DROPS_TO_E18 = 1e12;

    /// @notice Tick an order with an FDC-attested XRPL payment attached.
    ///
    /// @dev The enclave cannot reach FDC: the TEE-based FDC is a Flare *system*
    /// application with no interface a third-party extension can call. So the
    /// proof is verified here, on-chain, and only the verified reading crosses
    /// into the enclave. By the time the extension sees it, `verified` reflects
    /// a Merkle check against a finalized attestation round rather than the
    /// keeper's word.
    ///
    /// What this leaks is the *observed* fact — that some XRPL payment landed —
    /// which is public on XRPL anyway. What it does not leak is the threshold
    /// that fact is being compared against, which stays in the ciphertext. That
    /// asymmetry is the whole design.
    ///
    /// Note the source travels as the FDC address *hash*, never the r-address:
    /// the address the order watches is part of the secret, and the sealed terms
    /// carry the same hash so the enclave can match them without either side
    /// publishing it.
    function tickAttested(uint256 _orderId, IPayment.Proof calldata _proof) external payable {
        require(address(fdcVerification) != address(0), "FDC verification not set");
        require(fdcVerification.verifyPayment(_proof), "FDC rejected the proof");

        IPayment.ResponseBody calldata body = _proof.data.responseBody;
        require(body.status == 0, "payment did not succeed");
        require(body.receivedAmount >= 0, "negative received amount");

        Order storage o = _prepareTick(_orderId);
        _send(
            _orderId,
            abi.encode(
                _orderId,
                address(this),
                o.encrypted,
                o.peakE18,
                o.remaining,
                uint256(1),
                uint256(body.receivedAmount) * XRP_DROPS_TO_E18,
                uint256(body.blockTimestamp),
                _toHexString(body.sourceAddressHash)
            )
        );
    }

    /// @notice Tick an order with an FDC-attested Web2 reading attached.
    ///
    /// @dev This is the second oracle in a consensus order. The attestation's
    /// `abiEncodedData` is whatever the request's `abiSignature` declared; Wraith
    /// requires `(string source, uint256 valueE18, uint256 timestamp)`, which a
    /// one-line `postProcessJq` produces from most price APIs.
    ///
    /// Requiring two independent sources to agree is what defends a private stop
    /// against the one attack privacy alone does not stop: an adversary who
    /// cannot see the trigger can still walk a single price feed down until
    /// *something* fires. They cannot walk two.
    function tickAttestedWeb2(uint256 _orderId, IWeb2Json.Proof calldata _proof) external payable {
        require(address(fdcVerification) != address(0), "FDC verification not set");
        require(fdcVerification.verifyWeb2Json(_proof), "FDC rejected the proof");

        (string memory source, uint256 valueE18, uint256 observedAt) =
            abi.decode(_proof.data.responseBody.abiEncodedData, (string, uint256, uint256));
        require(bytes(source).length > 0, "attestation names no source");

        Order storage o = _prepareTick(_orderId);
        _send(
            _orderId,
            abi.encode(
                _orderId, address(this), o.encrypted, o.peakE18, o.remaining, uint256(1), valueE18, observedAt, source
            )
        );
    }

    /// @dev The liveness and rate-limit checks every tick shares.
    function _prepareTick(uint256 _orderId) private returns (Order storage o) {
        o = _orders[_orderId];
        require(o.owner != address(0), "no such order");
        require(!o.executed, "already executed");
        require(!o.cancelled, "cancelled");
        require(block.timestamp < o.expiry, "expired");
        require(block.timestamp >= o.nextTickAt, "ticked too recently");

        o.nextTickAt = uint64(block.timestamp) + MIN_TICK_INTERVAL;
    }

    function _send(uint256 _orderId, bytes memory _message) private {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);
        address[] memory cosigners = new address[](0);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_WRAITH,
            opCommand: OP_COMMAND_EVAL_ORDER,
            message: _message,
            cosigners: cosigners,
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        bytes32 instructionId = TEE_EXTENSION_REGISTRY.sendInstructions{ value: msg.value }(teeIds, params);
        emit OrderTicked(_orderId, instructionId);
    }

    /// @dev Lowercase `0x`-prefixed hex of a bytes32, matching `vm.toString`
    /// and JavaScript's `toHex`. The enclave compares sources as strings, so
    /// both sides must agree on this rendering exactly.
    function _toHexString(bytes32 _value) private pure returns (string memory) {
        bytes memory alphabet = "0123456789abcdef";
        bytes memory out = new bytes(66);
        out[0] = "0";
        out[1] = "x";
        for (uint256 i = 0; i < 32; ++i) {
            out[2 + i * 2] = alphabet[uint8(_value[i]) >> 4];
            out[3 + i * 2] = alphabet[uint8(_value[i]) & 0x0f];
        }
        return string(out);
    }

    /// @notice Settle an order using a TEE-signed result proving its condition fired.
    /// @dev The TEE node signs `keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, chainId,
    /// ActionResult.Hash()))` with its registered key under the EIP-191 personal-sign
    /// prefix. We rebuild that hash from the result fields the proxy returned and
    /// require the recovered signer to be an allowlisted TEE address.
    ///
    /// `_resultData` is the exact byte string the TEE returned in `ActionResult.Data`:
    /// `abi.encode(uint256 orderId, address contractAddr, uint8 action,
    /// uint256 minOutOrLots, address tokenOut, string underlyingAddress,
    /// uint256 newPeakE18, uint256 chunkAmount)`.
    ///
    /// `chunkAmount` of zero means "spend the whole remainder", which is what
    /// every single-shot order sends.
    /// - orderId: the order this result authorizes.
    /// - contractAddr: must equal address(this), so a result cannot be replayed
    ///   against a different Wraith deployment.
    /// - action: ACTION_SWAP or ACTION_REDEEM.
    /// - minOutOrLots: swap → minimum acceptable output; redeem → FAssets lot count.
    /// - tokenOut: swap only.
    /// - underlyingAddress: redeem only — the XRPL r-address to receive native XRP.
    ///
    /// @param _resultData Raw `ActionResult.Data` from the extension. Must be the exact
    ///                    bytes the proxy signed — do not re-encode.
    /// @param _actionId `ActionResult.ID`, the instruction id from `tick`. Consumed once.
    /// @param _submissionTag `ActionResult.SubmissionTag` (typically "submit").
    /// @param _status `ActionResult.Status`; only 1 (success) is accepted.
    /// @param _signature 65-byte ECDSA signature from the TEE node.
    function execute(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature
    ) external {
        require(_status == 1, "TEE reported failure");
        require(!usedActionId[_actionId], "action already used");

        _verifyTeeSignature(_resultData, _actionId, _submissionTag, _status, _signature);

        usedActionId[_actionId] = true;

        _settle(_resultData);
    }

    /// @dev Split out of `execute` to keep that function's stack shallow.
    function _verifyTeeSignature(
        bytes calldata _resultData,
        bytes32 _actionId,
        string calldata _submissionTag,
        uint8 _status,
        bytes calldata _signature
    ) private view {
        // Reconstruct ActionResult.Hash() = keccak256(keccak256(data) || id || keccak256(tag) || status).
        bytes32 resultHash =
            keccak256(abi.encodePacked(keccak256(_resultData), _actionId, keccak256(bytes(_submissionTag)), _status));

        // The node signs a domain-separated payload over resultHash, not resultHash itself.
        bytes32 payloadHash = keccak256(abi.encode(TEE_ACTION_RESULT_PREFIX, block.chainid, resultHash));

        address signer = _recover(_ethSigned(payloadHash), _signature);
        require(_isActiveTee(signer), "signer is not an active TEE");
    }

    /// @dev Asks the registry whether this signer is a TEE currently registered
    /// to our extension. Retiring a machine in the registry revokes its ability
    /// to settle immediately, with no action needed here.
    ///
    /// ponytail: linear scan over the active set. Extensions run a handful of
    /// machines, so this is cheaper than maintaining a mirrored mapping; revisit
    /// if the active set ever grows large.
    function _isActiveTee(address _signer) private view returns (bool) {
        (address[] memory machines,) = TEE_MACHINE_REGISTRY.getActiveTeeMachines(_getExtensionId());
        for (uint256 i = 0; i < machines.length; ++i) {
            if (machines[i] == _signer) {
                return true;
            }
        }
        return false;
    }

    /// @dev Decodes an authorized result and performs the action it names.
    function _settle(bytes calldata _resultData) private {
        (
            uint256 orderId,
            address contractAddr,
            uint8 action,
            uint256 minOutOrLots,
            address tokenOut,
            string memory underlyingAddress,
            uint256 newPeakE18,
            uint256 chunkAmount
        ) = abi.decode(_resultData, (uint256, address, uint8, uint256, address, string, uint256, uint256));

        require(contractAddr == address(this), "result not for this contract");

        Order storage o = _orders[orderId];
        require(o.owner != address(0), "no such order");
        require(!o.executed, "already executed");
        require(!o.cancelled, "cancelled");
        require(block.timestamp < o.expiry, "expired");

        // A high-water mark only ever rises. A passing dip must not drag the
        // trail down with it, or the order fires early on noise.
        if (newPeakE18 > o.peakE18) {
            o.peakE18 = newPeakE18;
            emit PeakTracked(orderId, newPeakE18);
        }

        // Tracking is not settlement: the order stays live and keeps watching.
        if (action == ACTION_TRACK) {
            return;
        }

        // Zero means the whole remainder, so single-shot orders are unchanged.
        // A chunk larger than what is left is clamped rather than rejected: the
        // schedule is computed off-chain against a peak that may have moved, and
        // overdrawing must be impossible regardless.
        uint256 spend = chunkAmount == 0 || chunkAmount > o.remaining ? o.remaining : chunkAmount;
        require(spend > 0, "nothing left to spend");

        o.remaining -= spend;
        // The order closes only when the escrow is exhausted, which is what
        // lets a TWAP keep running across many chunks.
        if (o.remaining == 0) {
            o.executed = true;
        }

        uint256 result;
        if (action == ACTION_SWAP) {
            result = _swap(o, tokenOut, minOutOrLots, spend);
        } else if (action == ACTION_REDEEM) {
            result = _redeem(o, minOutOrLots, underlyingAddress, spend);
        } else {
            revert("unknown action");
        }

        emit OrderExecuted(orderId, action, spend, result);
    }

    /// @notice Reclaim escrow. The owner may cancel at any time; anyone may clean up
    /// an expired order, which always refunds the owner.
    function cancel(uint256 _orderId) external {
        Order storage o = _orders[_orderId];
        require(o.owner != address(0), "no such order");
        require(!o.executed, "already executed");
        require(!o.cancelled, "already cancelled");
        require(msg.sender == o.owner || block.timestamp >= o.expiry, "not owner and not expired");

        o.cancelled = true;
        // Only the unspent escrow comes back: earlier chunks already paid out.
        uint256 amount = o.remaining;
        o.remaining = 0;
        require(IERC20(o.tokenIn).transfer(o.owner, amount), "refund failed");

        emit OrderCancelled(_orderId, amount);
    }

    // --- Views ---

    function orderCount() external view returns (uint256) {
        return _orders.length;
    }

    /// @notice Highest price recorded for an order, scaled by 1e18.
    function peakOf(uint256 _orderId) external view returns (uint256) {
        return _orders[_orderId].peakE18;
    }

    /// @notice Escrow not yet spent by a chunked order.
    function remainingOf(uint256 _orderId) external view returns (uint256) {
        return _orders[_orderId].remaining;
    }

    /// @notice Public order metadata. Deliberately does not return the ciphertext's
    /// meaning — only its bytes, which are opaque without the enclave key.
    function getOrder(uint256 _orderId)
        external
        view
        returns (
            address orderOwner,
            address tokenIn,
            uint256 amountIn,
            uint64 expiry,
            bool executed,
            bool cancelled,
            bytes memory encrypted
        )
    {
        Order storage o = _orders[_orderId];
        require(o.owner != address(0), "no such order");
        return (o.owner, o.tokenIn, o.amountIn, o.expiry, o.executed, o.cancelled, o.encrypted);
    }

    function canTick(uint256 _orderId) external view returns (bool) {
        Order storage o = _orders[_orderId];
        return o.owner != address(0) && !o.executed && !o.cancelled && block.timestamp < o.expiry
            && block.timestamp >= o.nextTickAt;
    }

    // --- Internals ---

    function _swap(Order storage _o, address _tokenOut, uint256 _minOut, uint256 _spend) private returns (uint256) {
        require(address(router) != address(0), "router not set");
        require(_tokenOut != address(0), "zero tokenOut");

        address[] memory path = new address[](2);
        path[0] = _o.tokenIn;
        path[1] = _tokenOut;

        require(IERC20(_o.tokenIn).approve(address(router), _spend), "approve failed");

        uint256[] memory amounts =
            router.swapExactTokensForTokens(_spend, _minOut, path, _o.owner, block.timestamp);
        return amounts[amounts.length - 1];
    }

    /// @dev Redemption is lot-granular, so the lot count rarely consumes the whole
    /// escrow exactly. Whatever the AssetManager does not take is returned to the
    /// order owner rather than left stranded in this contract.
    function _redeem(Order storage _o, uint256 _lots, string memory _underlyingAddress, uint256 _spend)
        private
        returns (uint256)
    {
        require(address(assetManager) != address(0), "asset manager not set");
        require(_lots > 0, "zero lots");
        require(bytes(_underlyingAddress).length > 0, "empty underlying address");

        IERC20 token = IERC20(_o.tokenIn);
        uint256 balanceBefore = token.balanceOf(address(this));

        uint256 redeemed = assetManager.redeem(_lots, _underlyingAddress, payable(address(0)));

        uint256 balanceAfter = token.balanceOf(address(this));
        uint256 spent = balanceBefore - balanceAfter;
        if (_spend > spent) {
            require(token.transfer(_o.owner, _spend - spent), "remainder refund failed");
        }

        return redeemed;
    }

    /// @notice Returns the extension ID, reverting if it has not been set.
    /// DO NOT MODIFY this function.
    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID not set.");
        return _extensionId;
    }

    /// @notice EIP-191 personal-sign hash of a 32-byte digest.
    function _ethSigned(bytes32 _hash) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", _hash));
    }

    /// @notice Recover the signer of a 65-byte [r||s||v] secp256k1 signature.
    function _recover(bytes32 _digest, bytes calldata _sig) private pure returns (address) {
        require(_sig.length == 65, "bad signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(_sig.offset)
            s := calldataload(add(_sig.offset, 32))
            v := byte(0, calldataload(add(_sig.offset, 64)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "bad signature v");
        address signer = ecrecover(_digest, v, r, s);
        require(signer != address(0), "invalid signature");
        return signer;
    }
}
