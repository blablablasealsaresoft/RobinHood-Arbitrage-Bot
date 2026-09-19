// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V4 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}

interface IERC1271V4 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

abstract contract SequencerAuthV4 {
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;
    uint256 private constant SECP256K1N_DIV_2 =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public owner;
    address public pendingOwner;
    bool public paused;
    uint256 private _entered;

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address initialOwner) {
        require(initialOwner != address(0), "zero owner");
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "paused");
        _;
    }

    modifier whenPaused() {
        require(paused, "not paused");
        _;
    }

    modifier nonReentrant() {
        require(_entered == 0, "reentrant");
        _entered = 1;
        _;
        _entered = 0;
    }

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "zero owner");
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address old = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    function _setPaused(bool value) internal {
        paused = value;
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20V4.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        if (!_tryApprove(token, spender, amount)) {
            require(_tryApprove(token, spender, 0), "approve reset failed");
            require(_tryApprove(token, spender, amount), "approve failed");
        }
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20V4.approve, (spender, amount)));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    function _isValidSigner(address signer, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (signer.code.length != 0) {
            (bool ok, bytes memory ret) = signer.staticcall(
                abi.encodeCall(IERC1271V4.isValidSignature, (digest, sig))
            );
            return ok && ret.length >= 32 && bytes4(ret) == ERC1271_MAGIC;
        }
        if (sig.length != 65) return false;
        bytes32 r;
        bytes32 ss;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            ss := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (uint256(ss) > SECP256K1N_DIV_2) return false;
        if (v != 27 && v != 28) return false;
        return ecrecover(digest, v, r, ss) == signer;
    }
}

abstract contract EIP712LiteV4 {
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private immutable _nameHash;
    bytes32 private immutable _versionHash;

    constructor(string memory name_, string memory version_) {
        _nameHash = keccak256(bytes(name_));
        _versionHash = keccak256(bytes(version_));
    }

    function _domainSeparatorV4() internal view returns (bytes32) {
        return keccak256(abi.encode(
            DOMAIN_TYPEHASH, _nameHash, _versionHash, block.chainid, address(this)
        ));
    }

    function _hashTypedDataV4(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparatorV4(), structHash));
    }
}

interface IArbSysSequencerV4 {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32);
}

interface IMorphoFlashLoanV4 {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface ISequencerSwapAdapterV4 {
    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata data
    ) external returns (uint256 amountOut);
}

/// @title SequencerFlashArbExecutorV4
/// @notice Single-strategy Robinhood Chain executor for sequencer-native next-block flash arbitrage.
/// @dev The feed is treated as a soft-confirmed block signal, not a pre-execution mempool.
///      The engine binds each intent to (anchorBlock, anchorBlockHash), then races into the next block.
///      minProfit may be zero for aggressive positive-after-gas off-chain gating, but the route must
///      still preserve the full flash-loan principal or the whole transaction reverts.
contract SequencerFlashArbExecutorV4 is SequencerAuthV4, EIP712LiteV4 {

    uint256 public constant ROBINHOOD_CHAIN_ID = 4663;
    IArbSysSequencerV4 private constant ARBSYS = IArbSysSequencerV4(address(0x64));
    uint256 public constant MAX_LEGS = 6;
    uint256 public constant MAX_STATE_CHECKS = 8;
    uint256 public constant MAX_LEG_DATA_BYTES = 16_384;
    uint256 public constant MAX_CHECK_DATA_BYTES = 4_096;
    uint32 public constant MAX_STATE_CHECK_GAS = 500_000;
    uint64 public constant ABSOLUTE_MAX_ANCHOR_DELAY = 8;

    bytes32 public constant FLASH_ARB_INTENT_TYPEHASH = keccak256(
        "FlashArbIntent(address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 nonce,uint64 anchorBlock,bytes32 anchorBlockHash,uint64 validUntilBlock,uint64 validUntilTimestamp,uint256 maxGasPrice,bytes32 legsHash,bytes32 checksHash)"
    );

    struct Leg {
        address adapter;
        address tokenIn;
        address tokenOut;
        uint256 minOut;
        bytes data;
    }

    struct StateCheck {
        uint8 mode;
        address target;
        uint32 gasLimit;
        bytes callData;
        bytes32 expectedReturnHash;
    }

    struct FlashArbIntent {
        address settlementToken;
        uint256 borrowAmount;
        uint256 minProfit;
        uint256 nonce;
        uint64 anchorBlock;
        bytes32 anchorBlockHash;
        uint64 validUntilBlock;
        uint64 validUntilTimestamp;
        uint256 maxGasPrice;
        bytes32 legsHash;
        bytes32 checksHash;
    }

    struct CallbackPayload {
        bytes32 intentDigest;
        address settlementToken;
        uint256 borrowAmount;
        uint256 minProfit;
        Leg[] legs;
    }

    IMorphoFlashLoanV4 public immutable morpho;

    address public strategySigner;
    address public treasury;
    uint64 public maxAnchorDelay;

    mapping(address => bool) public relayer;
    mapping(address => bool) public approvedAdapter;
    mapping(address => uint256) public borrowCap;

    mapping(uint256 => uint256) private _nonceBitmap;

    bool private _flashActive;
    bytes32 private _activePayloadHash;
    bytes32 private _activeIntentDigest;

    error WrongChain(uint256 actual, uint256 expected);
    error ZeroAddress();
    error UnauthorizedRelayer();
    error UnauthorizedSigner();
    error AdapterNotApproved(address adapter);
    error SettlementNotConfigured(address token);
    error BorrowCapExceeded(address token, uint256 amount, uint256 cap);
    error InvalidAnchorWindow();
    error AnchorNotReached(uint256 currentBlock, uint256 anchorBlock);
    error AnchorExpired(uint256 currentBlock, uint256 lastValidBlock);
    error AnchorHashMismatch(bytes32 actual, bytes32 expected);
    error IntentExpired();
    error GasPriceTooHigh(uint256 actual, uint256 maximum);
    error NonceAlreadyUsed(uint256 nonce);
    error RouteHashMismatch();
    error ChecksHashMismatch();
    error InvalidRoute();
    error TooManyLegs(uint256 supplied, uint256 maximum);
    error TooManyStateChecks(uint256 supplied, uint256 maximum);
    error CalldataTooLarge();
    error StateCheckFailed(uint256 index, address target);
    error StateMismatch(uint256 index, address target, bytes32 actualHash, bytes32 expectedHash);
    error FlashAlreadyActive();
    error NoActiveFlash();
    error OnlyMorpho();
    error CallbackMismatch();
    error InsufficientOutput(uint256 actual, uint256 minimum);
    error InsufficientProfit(uint256 actual, uint256 minimum);
    error BalanceInvariant();
    error InvalidConfiguration();

    event StrategySignerSet(address indexed signer);
    event TreasurySet(address indexed treasury);
    event RelayerSet(address indexed account, bool allowed);
    event AdapterSet(address indexed adapter, bool approved);
    event BorrowCapSet(address indexed settlementToken, uint256 cap);
    event MaxAnchorDelaySet(uint64 blocks_);
    event NoncesCancelled(uint256 indexed word, uint256 mask);
    event PauseSet(bool paused);
    event FlashArbExecuted(
        bytes32 indexed intentDigest,
        uint64 indexed anchorBlock,
        bytes32 indexed anchorBlockHash,
        address settlementToken,
        uint256 borrowAmount,
        uint256 profit,
        uint256 executionBlock
    );

    constructor(
        address initialOwner,
        address strategySigner_,
        address treasury_,
        address morpho_,
        uint64 maxAnchorDelay_
    ) SequencerAuthV4(initialOwner) EIP712LiteV4("RobinhoodSequencerFlashArb", "4") {
        if (block.chainid != ROBINHOOD_CHAIN_ID) revert WrongChain(block.chainid, ROBINHOOD_CHAIN_ID);
        if (
            initialOwner == address(0) ||
            strategySigner_ == address(0) ||
            treasury_ == address(0) ||
            morpho_ == address(0)
        ) revert ZeroAddress();
        if (morpho_.code.length == 0) revert InvalidConfiguration();
        if (maxAnchorDelay_ == 0 || maxAnchorDelay_ > ABSOLUTE_MAX_ANCHOR_DELAY) revert InvalidConfiguration();

        strategySigner = strategySigner_;
        treasury = treasury_;
        morpho = IMorphoFlashLoanV4(morpho_);
        maxAnchorDelay = maxAnchorDelay_;

        emit StrategySignerSet(strategySigner_);
        emit TreasurySet(treasury_);
        emit MaxAnchorDelaySet(maxAnchorDelay_);
    }

    modifier onlyRelayer() {
        if (!relayer[msg.sender]) revert UnauthorizedRelayer();
        _;
    }

    function setStrategySigner(address signer) external onlyOwner {
        if (signer == address(0)) revert ZeroAddress();
        strategySigner = signer;
        emit StrategySignerSet(signer);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setRelayer(address account, bool allowed) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        relayer[account] = allowed;
        emit RelayerSet(account, allowed);
    }

    function setAdapter(address adapter, bool approved) external onlyOwner {
        if (adapter == address(0)) revert ZeroAddress();
        if (approved && adapter.code.length == 0) revert InvalidConfiguration();
        approvedAdapter[adapter] = approved;
        emit AdapterSet(adapter, approved);
    }

    function setBorrowCap(address settlementToken, uint256 cap) external onlyOwner {
        if (settlementToken == address(0)) revert ZeroAddress();
        borrowCap[settlementToken] = cap;
        emit BorrowCapSet(settlementToken, cap);
    }

    function setMaxAnchorDelay(uint64 blocks_) external onlyOwner {
        if (blocks_ == 0 || blocks_ > ABSOLUTE_MAX_ANCHOR_DELAY) revert InvalidConfiguration();
        maxAnchorDelay = blocks_;
        emit MaxAnchorDelaySet(blocks_);
    }

    function setPaused(bool value) external onlyOwner {
        _setPaused(value);
        emit PauseSet(value);
    }

    function cancelNonceWord(uint256 word, uint256 mask) external onlyOwner {
        _nonceBitmap[word] |= mask;
        emit NoncesCancelled(word, mask);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner whenPaused {
        if (to == address(0)) revert ZeroAddress();
        _safeTransfer(token, to, amount);
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function isNonceUsed(uint256 nonce) public view returns (bool) {
        uint256 word = nonce >> 8;
        uint256 mask = uint256(1) << (nonce & 0xff);
        return (_nonceBitmap[word] & mask) != 0;
    }

    function hashLegs(Leg[] calldata legs) external pure returns (bytes32) {
        return keccak256(abi.encode(legs));
    }

    function hashChecks(StateCheck[] calldata checks) external pure returns (bytes32) {
        return keccak256(abi.encode(checks));
    }

    function intentDigest(FlashArbIntent calldata intent) external view returns (bytes32) {
        return _intentDigest(intent);
    }

    function executeFlashArb(
        FlashArbIntent calldata intent,
        Leg[] calldata legs,
        StateCheck[] calldata checks,
        bytes calldata signature
    ) external onlyRelayer whenNotPaused nonReentrant returns (uint256 profit) {
        _validateIntent(intent);
        _validateRouteAndHashes(intent, legs, checks);

        bytes32 digest = _intentDigest(intent);
        if (!_isValidSigner(strategySigner, digest, signature)) revert UnauthorizedSigner();
        _useNonce(intent.nonce);

        _runStateChecks(checks);

        IERC20V4 settlement = IERC20V4(intent.settlementToken);
        uint256 beforeBalance = settlement.balanceOf(address(this));

        CallbackPayload memory payload = CallbackPayload({
            intentDigest: digest,
            settlementToken: intent.settlementToken,
            borrowAmount: intent.borrowAmount,
            minProfit: intent.minProfit,
            legs: legs
        });
        bytes memory callbackData = abi.encode(payload);

        if (_flashActive) revert FlashAlreadyActive();
        _flashActive = true;
        _activeIntentDigest = digest;
        _activePayloadHash = keccak256(callbackData);

        morpho.flashLoan(intent.settlementToken, intent.borrowAmount, callbackData);

        _flashActive = false;
        _activeIntentDigest = bytes32(0);
        _activePayloadHash = bytes32(0);

        _forceApprove(intent.settlementToken, address(morpho), 0);

        uint256 afterBalance = settlement.balanceOf(address(this));
        if (afterBalance < beforeBalance) revert BalanceInvariant();

        profit = afterBalance - beforeBalance;
        if (profit < intent.minProfit) revert InsufficientProfit(profit, intent.minProfit);

        if (profit != 0) _safeTransfer(intent.settlementToken, treasury, profit);

        emit FlashArbExecuted(
            digest,
            intent.anchorBlock,
            intent.anchorBlockHash,
            intent.settlementToken,
            intent.borrowAmount,
            profit,
            ARBSYS.arbBlockNumber()
        );
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        if (msg.sender != address(morpho)) revert OnlyMorpho();
        if (!_flashActive) revert NoActiveFlash();
        if (keccak256(data) != _activePayloadHash) revert CallbackMismatch();

        CallbackPayload memory payload = abi.decode(data, (CallbackPayload));
        if (payload.intentDigest != _activeIntentDigest) revert CallbackMismatch();
        if (assets != payload.borrowAmount) revert CallbackMismatch();

        IERC20V4 settlement = IERC20V4(payload.settlementToken);
        uint256 withLoan = settlement.balanceOf(address(this));
        if (withLoan < assets) revert BalanceInvariant();
        uint256 baseline = withLoan - assets;

        uint256 amount = assets;
        uint256 n = payload.legs.length;

        for (uint256 i; i < n; ++i) {
            Leg memory leg = payload.legs[i];
            IERC20V4 outToken = IERC20V4(leg.tokenOut);
            uint256 beforeOut = outToken.balanceOf(address(this));

            _safeTransfer(leg.tokenIn, leg.adapter, amount);
            ISequencerSwapAdapterV4(leg.adapter).swapExactInput(
                leg.tokenIn,
                leg.tokenOut,
                amount,
                leg.minOut,
                leg.data
            );

            uint256 afterOut = outToken.balanceOf(address(this));
            if (afterOut < beforeOut) revert BalanceInvariant();

            amount = afterOut - beforeOut;
            if (amount < leg.minOut) revert InsufficientOutput(amount, leg.minOut);
        }

        uint256 afterRoute = settlement.balanceOf(address(this));
        uint256 principalFloor = baseline + assets;
        if (afterRoute < principalFloor) revert InsufficientProfit(0, payload.minProfit);

        uint256 realizedProfit = afterRoute - principalFloor;
        if (realizedProfit < payload.minProfit) {
            revert InsufficientProfit(realizedProfit, payload.minProfit);
        }

        _forceApprove(payload.settlementToken, address(morpho), assets);
    }

    function _validateIntent(FlashArbIntent calldata intent) internal view {
        if (intent.settlementToken == address(0)) revert ZeroAddress();
        if (intent.anchorBlockHash == bytes32(0)) revert InvalidConfiguration();
        if (intent.borrowAmount == 0 || intent.maxGasPrice == 0) revert InvalidConfiguration();
        if (intent.validUntilTimestamp == 0) revert IntentExpired();

        uint256 cap = borrowCap[intent.settlementToken];
        if (cap == 0) revert SettlementNotConfigured(intent.settlementToken);
        if (intent.borrowAmount > cap) {
            revert BorrowCapExceeded(intent.settlementToken, intent.borrowAmount, cap);
        }

        uint256 l2Block = ARBSYS.arbBlockNumber();
        if (l2Block <= intent.anchorBlock) {
            revert AnchorNotReached(l2Block, intent.anchorBlock);
        }

        if (
            intent.validUntilBlock <= intent.anchorBlock ||
            intent.validUntilBlock - intent.anchorBlock > maxAnchorDelay
        ) revert InvalidAnchorWindow();

        if (l2Block > intent.validUntilBlock) {
            revert AnchorExpired(l2Block, intent.validUntilBlock);
        }

        bytes32 actualAnchorHash = ARBSYS.arbBlockHash(intent.anchorBlock);
        if (actualAnchorHash != intent.anchorBlockHash) {
            revert AnchorHashMismatch(actualAnchorHash, intent.anchorBlockHash);
        }

        if (block.timestamp > intent.validUntilTimestamp) revert IntentExpired();
        if (tx.gasprice > intent.maxGasPrice) revert GasPriceTooHigh(tx.gasprice, intent.maxGasPrice);
    }

    function _validateRouteAndHashes(
        FlashArbIntent calldata intent,
        Leg[] calldata legs,
        StateCheck[] calldata checks
    ) internal view {
        uint256 n = legs.length;
        if (n < 2) revert InvalidRoute();
        if (n > MAX_LEGS) revert TooManyLegs(n, MAX_LEGS);

        if (checks.length == 0) revert InvalidConfiguration();
        if (checks.length > MAX_STATE_CHECKS) {
            revert TooManyStateChecks(checks.length, MAX_STATE_CHECKS);
        }

        if (keccak256(abi.encode(legs)) != intent.legsHash) revert RouteHashMismatch();
        if (keccak256(abi.encode(checks)) != intent.checksHash) revert ChecksHashMismatch();

        if (legs[0].tokenIn != intent.settlementToken) revert InvalidRoute();
        if (legs[n - 1].tokenOut != intent.settlementToken) revert InvalidRoute();

        for (uint256 i; i < n; ++i) {
            Leg calldata leg = legs[i];
            if (
                leg.adapter == address(0) ||
                leg.tokenIn == address(0) ||
                leg.tokenOut == address(0)
            ) revert ZeroAddress();
            if (!approvedAdapter[leg.adapter]) revert AdapterNotApproved(leg.adapter);
            if (leg.tokenIn == leg.tokenOut || leg.minOut == 0) revert InvalidRoute();
            if (leg.data.length > MAX_LEG_DATA_BYTES) revert CalldataTooLarge();
            if (i + 1 < n && leg.tokenOut != legs[i + 1].tokenIn) revert InvalidRoute();
        }

        for (uint256 i; i < checks.length; ++i) {
            StateCheck calldata check = checks[i];
            if (check.mode > 1) revert InvalidConfiguration();
            if (check.target == address(0) || check.target.code.length == 0) {
                revert InvalidConfiguration();
            }
            if (check.gasLimit == 0 || check.gasLimit > MAX_STATE_CHECK_GAS) {
                revert InvalidConfiguration();
            }
            if (check.callData.length > MAX_CHECK_DATA_BYTES) revert CalldataTooLarge();
            if (check.expectedReturnHash == bytes32(0)) revert InvalidConfiguration();
        }
    }

    function _runStateChecks(StateCheck[] calldata checks) internal view {
        for (uint256 i; i < checks.length; ++i) {
            StateCheck calldata check = checks[i];
            (bool ok, bytes memory ret) = check.target.staticcall{gas: check.gasLimit}(check.callData);
            if (!ok) revert StateCheckFailed(i, check.target);

            bytes32 actual;
            if (check.mode == 0) {
                actual = keccak256(ret);
            } else {
                if (ret.length < 96) revert StateCheckFailed(i, check.target);
                (uint112 reserve0, uint112 reserve1,) = abi.decode(ret, (uint112, uint112, uint32));
                actual = keccak256(abi.encode(reserve0, reserve1));
            }

            if (actual != check.expectedReturnHash) {
                revert StateMismatch(i, check.target, actual, check.expectedReturnHash);
            }
        }
    }

    function _useNonce(uint256 nonce) internal {
        uint256 word = nonce >> 8;
        uint256 mask = uint256(1) << (nonce & 0xff);
        if ((_nonceBitmap[word] & mask) != 0) revert NonceAlreadyUsed(nonce);
        _nonceBitmap[word] |= mask;
    }

    function _intentDigest(FlashArbIntent calldata i) internal view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    FLASH_ARB_INTENT_TYPEHASH,
                    i.settlementToken,
                    i.borrowAmount,
                    i.minProfit,
                    i.nonce,
                    i.anchorBlock,
                    i.anchorBlockHash,
                    i.validUntilBlock,
                    i.validUntilTimestamp,
                    i.maxGasPrice,
                    i.legsHash,
                    i.checksHash
                )
            )
        );
    }

    receive() external payable {
        revert InvalidConfiguration();
    }
}
