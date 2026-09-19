// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20FlashV4 {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IArbSysV4 {
    function arbBlockNumber() external view returns (uint256);
    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32);
}

interface IMorphoBlueV4 {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface ISwapAdapterV4 {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, bytes calldata data)
        external returns (uint256 amountOut);
}

/// @title SequencerFlashArbExecutorV4
/// @notice Next-block Robinhood Chain flash-arb executor.
/// @dev The sequencer feed is a soft-confirmed executed-block stream, not a
///      pre-execution mempool. Each signed intent is anchored to the exact block
///      hash whose post-state produced the opportunity. If that anchor is no
///      longer canonical, if the relevant state moved, if any swap misses its
///      floor, or if final profit is below minProfit, the whole tx reverts.
contract SequencerFlashArbExecutorV4 {
    IArbSysV4 private constant ARBSYS = IArbSysV4(address(0x64));
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "FlashIntent(address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 maxGasPrice,uint64 anchorBlock,bytes32 anchorBlockHash,uint64 validAfterBlock,uint64 validUntilBlock,uint64 deadline,uint256 nonce,bytes32 triggerTxHash,bytes32 routeHash,bytes32 stateChecksHash)"
    );
    bytes32 private constant LEG_TYPEHASH =
        keccak256("Leg(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes32 dataHash)");
    bytes32 private constant STATE_CHECK_TYPEHASH =
        keccak256("StateCheck(uint8 mode,address target,bytes32 callDataHash,bytes32 expectedReturnHash)");

    bytes4 private constant GET_RESERVES_SELECTOR = 0x0902f1ac;
    address private constant FILTER_PRECOMPILE = 0x0000000000000000000000000000000000000074;
    bytes4 private constant IS_FILTERED_SELECTOR = 0x85c733a4;

    struct FlashIntent {
        address settlementToken;
        uint256 borrowAmount;
        uint256 minProfit;
        uint256 maxGasPrice;
        uint64 anchorBlock;
        bytes32 anchorBlockHash;
        uint64 validAfterBlock;
        uint64 validUntilBlock;
        uint64 deadline;
        uint256 nonce;
        bytes32 triggerTxHash;
        bytes32 routeHash;
        bytes32 stateChecksHash;
    }

    struct Leg {
        address adapter;
        address tokenIn;
        address tokenOut;
        uint256 minOut;
        bytes data;
    }

    /// mode 0: keccak256(raw staticcall returndata)
    /// mode 1: Uniswap-v2-style getReserves(), hash reserve0/reserve1 only
    struct StateCheck {
        uint8 mode;
        address target;
        bytes callData;
        bytes32 expectedReturnHash;
    }

    address public owner;
    address public pendingOwner;
    address public strategySigner;
    address public treasury;
    IMorphoBlueV4 public immutable morpho;
    uint64 public maxBlockWindow;
    uint64 public maxAnchorDelay;
    bool public paused;

    mapping(address => bool) public relayers;
    mapping(address => bool) public adapters;
    mapping(address => uint256) public borrowCaps;
    mapping(uint256 => uint256) public nonceBitmap;

    uint8 private phase;
    bytes32 private pendingDigest;
    bytes32 private pendingCallbackHash;
    address private pendingSettlement;
    uint256 private pendingBorrow;
    uint256 private pendingMinProfit;
    uint256 private pendingBaseline;

    event RelayerSet(address indexed relayer, bool allowed);
    event AdapterSet(address indexed adapter, bool allowed);
    event BorrowCapSet(address indexed token, uint256 cap);
    event StrategySignerSet(address indexed signer);
    event TreasurySet(address indexed treasury);
    event MaxBlockWindowSet(uint64 window);
    event MaxAnchorDelaySet(uint64 delayBlocks);
    event PauseSet(bool paused);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event FlashArbitrage(
        bytes32 indexed digest,
        uint64 indexed anchorBlock,
        bytes32 indexed anchorBlockHash,
        bytes32 triggerTxHash,
        address settlementToken,
        uint256 borrowed,
        uint256 profit,
        address relayer
    );
    event Rescue(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    constructor(
        address initialOwner,
        address initialStrategySigner,
        address initialTreasury,
        address morphoBlue,
        uint64 initialMaxBlockWindow,
        uint64 initialMaxAnchorDelay
    ) {
        require(initialOwner != address(0), "zero owner");
        require(initialStrategySigner != address(0), "zero signer");
        require(initialTreasury != address(0), "zero treasury");
        require(morphoBlue != address(0) && morphoBlue.code.length > 0, "bad morpho");
        require(initialMaxBlockWindow > 0 && initialMaxBlockWindow <= 64, "bad window");
        require(initialMaxAnchorDelay > 0 && initialMaxAnchorDelay <= 64, "bad anchor delay");

        owner = initialOwner;
        strategySigner = initialStrategySigner;
        treasury = initialTreasury;
        morpho = IMorphoBlueV4(morphoBlue);
        maxBlockWindow = initialMaxBlockWindow;
        maxAnchorDelay = initialMaxAnchorDelay;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256(bytes("SequencerFlashArbExecutorV4")),
            keccak256(bytes("1")),
            block.chainid,
            address(this)
        ));
    }

    function hashLegs(Leg[] calldata legs) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](legs.length);
        for (uint256 i; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            hashes[i] = keccak256(abi.encode(
                LEG_TYPEHASH, leg.adapter, leg.tokenIn, leg.tokenOut, leg.minOut, keccak256(leg.data)
            ));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hashStateChecks(StateCheck[] calldata checks) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](checks.length);
        for (uint256 i; i < checks.length; ++i) {
            StateCheck calldata check = checks[i];
            hashes[i] = keccak256(abi.encode(
                STATE_CHECK_TYPEHASH, check.mode, check.target,
                keccak256(check.callData), check.expectedReturnHash
            ));
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hashIntent(FlashIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(abi.encode(
            INTENT_TYPEHASH,
            intent.settlementToken,
            intent.borrowAmount,
            intent.minProfit,
            intent.maxGasPrice,
            intent.anchorBlock,
            intent.anchorBlockHash,
            intent.validAfterBlock,
            intent.validUntilBlock,
            intent.deadline,
            intent.nonce,
            intent.triggerTxHash,
            intent.routeHash,
            intent.stateChecksHash
        ));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function executeFlashArb(
        FlashIntent calldata intent,
        Leg[] calldata legs,
        StateCheck[] calldata checks,
        bytes calldata signature
    ) external {
        require(!paused, "paused");
        require(phase == 0, "busy");
        require(relayers[msg.sender], "relayer not allowed");
        require(intent.settlementToken != address(0), "zero settlement");
        require(intent.borrowAmount > 0, "zero borrow");
        require(intent.maxGasPrice > 0 && tx.gasprice <= intent.maxGasPrice, "gas price");

        uint256 l2Block = ARBSYS.arbBlockNumber();
        require(intent.anchorBlock < l2Block, "anchor not previous");
        require(l2Block <= uint256(intent.anchorBlock) + maxAnchorDelay, "anchor stale");
        require(ARBSYS.arbBlockHash(intent.anchorBlock) == intent.anchorBlockHash, "anchor hash");
        require(intent.validAfterBlock > intent.anchorBlock, "window before anchor");
        require(l2Block >= intent.validAfterBlock, "too early");
        require(l2Block <= intent.validUntilBlock, "too late");
        require(intent.validUntilBlock >= intent.validAfterBlock, "bad blocks");
        require(intent.validUntilBlock - intent.validAfterBlock <= maxBlockWindow, "window too wide");
        require(block.timestamp <= intent.deadline, "expired");

        if (intent.triggerTxHash != bytes32(0)) _requireNotFiltered(intent.triggerTxHash);

        uint256 cap = borrowCaps[intent.settlementToken];
        require(cap > 0 && intent.borrowAmount <= cap, "borrow disabled/capped");
        require(legs.length >= 2, "route too short");
        require(legs.length <= 6, "route too long");
        require(checks.length > 0, "no state checks");
        require(checks.length <= 8, "too many state checks");
        require(intent.routeHash == hashLegs(legs), "route hash");
        require(intent.stateChecksHash == hashStateChecks(checks), "checks hash");

        _validateClosedLoop(intent.settlementToken, legs);
        _verifyState(checks);

        bytes32 digest = hashIntent(intent);
        require(_recover(digest, signature) == strategySigner, "bad signature");
        _useNonce(intent.nonce);

        uint256 baseline = IERC20FlashV4(intent.settlementToken).balanceOf(address(this));
        pendingDigest = digest;
        pendingSettlement = intent.settlementToken;
        pendingBorrow = intent.borrowAmount;
        pendingMinProfit = intent.minProfit;
        pendingBaseline = baseline;
        {
            bytes memory callbackData = abi.encode(legs);
            pendingCallbackHash = keccak256(callbackData);
            phase = 1; // Await exactly one authenticated callback.
            morpho.flashLoan(intent.settlementToken, intent.borrowAmount, callbackData);
        }

        require(phase == 3, "callback phase");
        _forceApprove(intent.settlementToken, address(morpho), 0);
        uint256 afterRepay = IERC20FlashV4(intent.settlementToken).balanceOf(address(this));
        require(afterRepay >= baseline + intent.minProfit, "post-repay profit");

        uint256 profit = afterRepay - baseline;
        _safeTransfer(intent.settlementToken, treasury, profit);

        phase = 0;
        pendingDigest = bytes32(0);
        pendingCallbackHash = bytes32(0);
        pendingSettlement = address(0);
        pendingBorrow = 0;
        pendingMinProfit = 0;
        pendingBaseline = 0;

        _emitFlashArbitrage(digest, intent, profit);
    }

    // Keep this emit off the executeFlashArb stack. The repository compiler
    // settings are paris + optimizer 500 + via_ir=false; do not flip via_ir
    // just to paper over too many live locals around the success event.
    function _emitFlashArbitrage(bytes32 digest, FlashIntent calldata intent, uint256 profit) private {
        emit FlashArbitrage(
            digest, intent.anchorBlock, intent.anchorBlockHash, intent.triggerTxHash,
            intent.settlementToken, intent.borrowAmount, profit, msg.sender
        );
    }

    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        require(msg.sender == address(morpho), "not morpho");
        require(phase == 1, "unexpected callback");
        require(assets == pendingBorrow, "borrow mismatch");
        require(keccak256(data) == pendingCallbackHash, "callback payload");

        phase = 2;
        Leg[] memory legs = abi.decode(data, (Leg[]));
        uint256 amount = assets;

        for (uint256 i; i < legs.length; ++i) {
            Leg memory leg = legs[i];
            require(adapters[leg.adapter], "adapter not allowed");
            require(leg.adapter.code.length > 0, "adapter no code");
            require(leg.tokenIn != address(0) && leg.tokenOut != address(0), "zero route token");
            require(leg.minOut > 0, "zero minOut");

            uint256 beforeOut = IERC20FlashV4(leg.tokenOut).balanceOf(address(this));
            _forceApprove(leg.tokenIn, leg.adapter, amount);
            uint256 reported = ISwapAdapterV4(leg.adapter).swap(
                leg.tokenIn, leg.tokenOut, amount, leg.minOut, leg.data
            );
            _forceApprove(leg.tokenIn, leg.adapter, 0);

            uint256 afterOut = IERC20FlashV4(leg.tokenOut).balanceOf(address(this));
            uint256 received = afterOut - beforeOut;
            require(received >= leg.minOut, "leg minOut");
            require(reported == 0 || reported <= received, "bad adapter report");
            amount = received;
        }

        uint256 routeBalance = IERC20FlashV4(pendingSettlement).balanceOf(address(this));
        require(routeBalance >= pendingBaseline + pendingBorrow + pendingMinProfit, "pre-repay profit");

        _forceApprove(pendingSettlement, address(morpho), pendingBorrow);
        phase = 3; // Repayment-only: a second callback is never permitted.
    }

    function isNonceUsed(uint256 nonce) external view returns (bool) {
        uint256 word = nonce >> 8;
        uint256 mask = uint256(1) << (nonce & 255);
        return nonceBitmap[word] & mask != 0;
    }

    function _useNonce(uint256 nonce) internal {
        uint256 word = nonce >> 8;
        uint256 mask = uint256(1) << (nonce & 255);
        require(nonceBitmap[word] & mask == 0, "nonce used");
        nonceBitmap[word] |= mask;
    }

    function _validateClosedLoop(address settlement, Leg[] calldata legs) internal view {
        require(legs[0].tokenIn == settlement, "route start");
        require(legs[legs.length - 1].tokenOut == settlement, "route end");
        for (uint256 i; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            require(adapters[leg.adapter], "adapter not allowed");
            require(leg.adapter.code.length > 0, "adapter no code");
            require(leg.tokenIn != leg.tokenOut, "same token leg");
            require(leg.minOut > 0, "zero minOut");
            if (i + 1 < legs.length) require(leg.tokenOut == legs[i + 1].tokenIn, "broken route");
        }
    }

    function _verifyState(StateCheck[] calldata checks) internal view {
        for (uint256 i; i < checks.length; ++i) {
            StateCheck calldata check = checks[i];
            require(check.target != address(0) && check.target.code.length > 0, "bad state target");
            if (check.mode == 0) {
                (bool ok, bytes memory ret) = check.target.staticcall(check.callData);
                require(ok && keccak256(ret) == check.expectedReturnHash, "state mismatch");
            } else if (check.mode == 1) {
                require(
                    check.callData.length == 4 &&
                    keccak256(check.callData) == keccak256(abi.encodePacked(GET_RESERVES_SELECTOR)),
                    "bad reserves check"
                );
                (bool ok, bytes memory ret) = check.target.staticcall(check.callData);
                require(ok && ret.length >= 96, "reserves read");
                (uint112 reserve0, uint112 reserve1, ) = abi.decode(ret, (uint112, uint112, uint32));
                require(keccak256(abi.encode(reserve0, reserve1)) == check.expectedReturnHash, "reserve mismatch");
            } else {
                revert("unknown state mode");
            }
        }
    }

    function _requireNotFiltered(bytes32 txHash) internal view {
        (bool ok, bytes memory ret) = FILTER_PRECOMPILE.staticcall(
            abi.encodeWithSelector(IS_FILTERED_SELECTOR, txHash)
        );
        require(ok && ret.length >= 32, "filter read");
        require(abi.decode(ret, (uint256)) == 0, "trigger filtered");
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        require(signature.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        require(uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0, "high s");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signer");
        return signer;
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        if (!_callApprove(token, spender, amount)) {
            require(_callApprove(token, spender, 0) && _callApprove(token, spender, amount), "approve failed");
        }
    }

    function _callApprove(address token, address spender, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20FlashV4.approve, (spender, amount)));
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20FlashV4.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function setRelayer(address relayer, bool allowed) external onlyOwner {
        require(relayer != address(0), "zero relayer");
        relayers[relayer] = allowed;
        emit RelayerSet(relayer, allowed);
    }

    function setAdapter(address adapter, bool allowed) external onlyOwner {
        require(adapter != address(0), "zero adapter");
        if (allowed) require(adapter.code.length > 0, "adapter no code");
        adapters[adapter] = allowed;
        emit AdapterSet(adapter, allowed);
    }

    function setBorrowCap(address token, uint256 cap) external onlyOwner {
        require(token != address(0), "zero token");
        borrowCaps[token] = cap;
        emit BorrowCapSet(token, cap);
    }

    function setStrategySigner(address signer) external onlyOwner {
        require(signer != address(0), "zero signer");
        strategySigner = signer;
        emit StrategySignerSet(signer);
    }

    function setTreasury(address nextTreasury) external onlyOwner {
        require(nextTreasury != address(0), "zero treasury");
        treasury = nextTreasury;
        emit TreasurySet(nextTreasury);
    }

    function setMaxBlockWindow(uint64 window) external onlyOwner {
        require(window > 0 && window <= 64, "bad window");
        maxBlockWindow = window;
        emit MaxBlockWindowSet(window);
    }

    function setMaxAnchorDelay(uint64 delayBlocks) external onlyOwner {
        require(delayBlocks > 0 && delayBlocks <= 64, "bad anchor delay");
        maxAnchorDelay = delayBlocks;
        emit MaxAnchorDelaySet(delayBlocks);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseSet(value);
    }

    function rescueToken(address token, address to, uint256 amount) external onlyOwner {
        require(phase == 0, "busy");
        require(to != address(0), "zero to");
        _safeTransfer(token, to, amount);
        emit Rescue(token, to, amount);
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        require(nextOwner != address(0), "zero owner");
        pendingOwner = nextOwner;
        emit OwnershipTransferStarted(owner, nextOwner);
    }

    function acceptOwnership() external {
        require(msg.sender == pendingOwner, "not pending owner");
        address oldOwner = owner;
        owner = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }
}
