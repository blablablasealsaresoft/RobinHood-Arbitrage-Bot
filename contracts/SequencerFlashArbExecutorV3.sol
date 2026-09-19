// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Flash {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IMorphoBlue {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface ISwapAdapter {
    /// @notice Pull tokenIn from msg.sender and deliver tokenOut back to msg.sender.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data
    ) external returns (uint256 amountOut);
}

/// @title SequencerFlashArbExecutorV3
/// @notice Atomic Morpho-backed backrun executor for Robinhood Chain.
///         A signed opportunity is executable only inside a tiny block/time window,
///         only by an approved relayer, against owner-approved adapters, and only
///         while the predicted post-target state still matches on-chain state.
///
///         Lifecycle:
///         verify state -> borrow -> route -> pre-repay profit check -> approve
///         exact principal -> Morpho pulls repayment -> post-repay profit check
///         -> transfer incremental profit to treasury.
///
///         This contract does not predict opportunities. It fail-closes around
///         off-chain sequencer/state simulation supplied by the strategy signer.
contract SequencerFlashArbExecutorV3 {
    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant INTENT_TYPEHASH =
        keccak256(
            "FlashIntent(address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 maxGasPrice,uint64 validAfterBlock,uint64 validUntilBlock,uint64 deadline,uint256 nonce,bytes32 triggerTxHash,bytes32 routeHash,bytes32 stateChecksHash)"
        );
    bytes32 private constant LEG_TYPEHASH =
        keccak256("Leg(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes32 dataHash)");
    bytes32 private constant STATE_CHECK_TYPEHASH =
        keccak256("StateCheck(uint8 mode,address target,bytes32 callDataHash,bytes32 expectedReturnHash)");

    bytes4 private constant GET_RESERVES_SELECTOR = 0x0902f1ac;

    struct FlashIntent {
        address settlementToken;
        uint256 borrowAmount;
        uint256 minProfit;
        uint256 maxGasPrice;
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
    /// mode 1: Uniswap-v2-style getReserves(), hashing only reserve0/reserve1
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
    IMorphoBlue public immutable morpho;
    uint64 public maxBlockWindow;
    bool public paused;

    mapping(address => bool) public relayers;
    mapping(address => bool) public adapters;
    mapping(address => uint256) public borrowCaps;
    mapping(uint256 => uint256) public nonceBitmap;

    // 0 idle, 1 flash requested / callback permitted, 2 inside callback.
    uint8 private phase;
    bytes32 private pendingDigest;
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
    event PauseSet(bool paused);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event FlashArbitrage(
        bytes32 indexed digest,
        bytes32 indexed triggerTxHash,
        address indexed settlementToken,
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
        uint64 initialMaxBlockWindow
    ) {
        require(initialOwner != address(0), "zero owner");
        require(initialStrategySigner != address(0), "zero signer");
        require(initialTreasury != address(0), "zero treasury");
        require(morphoBlue != address(0) && morphoBlue.code.length > 0, "bad morpho");
        require(initialMaxBlockWindow > 0 && initialMaxBlockWindow <= 64, "bad window");

        owner = initialOwner;
        strategySigner = initialStrategySigner;
        treasury = initialTreasury;
        morpho = IMorphoBlue(morphoBlue);
        maxBlockWindow = initialMaxBlockWindow;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("SequencerFlashArbExecutorV3")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function hashLegs(Leg[] calldata legs) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](legs.length);
        for (uint256 i = 0; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            hashes[i] = keccak256(
                abi.encode(
                    LEG_TYPEHASH,
                    leg.adapter,
                    leg.tokenIn,
                    leg.tokenOut,
                    leg.minOut,
                    keccak256(leg.data)
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hashStateChecks(StateCheck[] calldata checks) public pure returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](checks.length);
        for (uint256 i = 0; i < checks.length; ++i) {
            StateCheck calldata check = checks[i];
            hashes[i] = keccak256(
                abi.encode(
                    STATE_CHECK_TYPEHASH,
                    check.mode,
                    check.target,
                    keccak256(check.callData),
                    check.expectedReturnHash
                )
            );
        }
        return keccak256(abi.encodePacked(hashes));
    }

    function hashIntent(FlashIntent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.settlementToken,
                intent.borrowAmount,
                intent.minProfit,
                intent.maxGasPrice,
                intent.validAfterBlock,
                intent.validUntilBlock,
                intent.deadline,
                intent.nonce,
                intent.triggerTxHash,
                intent.routeHash,
                intent.stateChecksHash
            )
        );
        return keccak256(abi.encodePacked(hex"1901", domainSeparator(), structHash));
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
        require(intent.borrowAmount > 0 && intent.minProfit > 0, "zero economics");
        require(intent.maxGasPrice > 0 && tx.gasprice <= intent.maxGasPrice, "gas price");
        require(block.number >= intent.validAfterBlock, "too early");
        require(block.number <= intent.validUntilBlock, "too late");
        require(intent.validUntilBlock >= intent.validAfterBlock, "bad blocks");
        require(intent.validUntilBlock - intent.validAfterBlock <= maxBlockWindow, "window too wide");
        require(block.timestamp <= intent.deadline, "expired");

        uint256 cap = borrowCaps[intent.settlementToken];
        require(cap > 0 && intent.borrowAmount <= cap, "borrow disabled/capped");
        require(legs.length >= 2, "route too short");
        require(checks.length > 0, "no state checks");
        require(intent.routeHash == hashLegs(legs), "route hash");
        require(intent.stateChecksHash == hashStateChecks(checks), "checks hash");

        _validateClosedLoop(intent.settlementToken, legs);
        _verifyState(checks);

        bytes32 digest = hashIntent(intent);
        require(_recover(digest, signature) == strategySigner, "bad signature");
        _useNonce(intent.nonce);

        uint256 baseline = IERC20Flash(intent.settlementToken).balanceOf(address(this));

        pendingDigest = digest;
        pendingSettlement = intent.settlementToken;
        pendingBorrow = intent.borrowAmount;
        pendingMinProfit = intent.minProfit;
        pendingBaseline = baseline;
        phase = 1;

        morpho.flashLoan(
            intent.settlementToken,
            intent.borrowAmount,
            abi.encode(legs)
        );

        require(phase == 1, "callback phase");
        _forceApprove(intent.settlementToken, address(morpho), 0);
        uint256 afterRepay = IERC20Flash(intent.settlementToken).balanceOf(address(this));
        require(afterRepay >= baseline + intent.minProfit, "post-repay profit");

        uint256 profit = afterRepay - baseline;
        _safeTransfer(intent.settlementToken, treasury, profit);

        phase = 0;
        pendingDigest = bytes32(0);
        pendingSettlement = address(0);
        pendingBorrow = 0;
        pendingMinProfit = 0;
        pendingBaseline = 0;

        emit FlashArbitrage(
            digest,
            intent.triggerTxHash,
            intent.settlementToken,
            intent.borrowAmount,
            profit,
            msg.sender
        );
    }

    /// @dev Morpho calls this after transferring the flash-loan principal.
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external {
        require(msg.sender == address(morpho), "not morpho");
        require(phase == 1, "unexpected callback");
        require(assets == pendingBorrow, "borrow mismatch");

        phase = 2;
        Leg[] memory legs = abi.decode(data, (Leg[]));

        uint256 amount = assets;
        for (uint256 i = 0; i < legs.length; ++i) {
            Leg memory leg = legs[i];
            require(adapters[leg.adapter], "adapter not allowed");
            require(leg.adapter.code.length > 0, "adapter no code");
            require(leg.tokenIn != address(0) && leg.tokenOut != address(0), "zero route token");
            require(leg.minOut > 0, "zero minOut");

            uint256 beforeOut = IERC20Flash(leg.tokenOut).balanceOf(address(this));
            _forceApprove(leg.tokenIn, leg.adapter, amount);
            uint256 reported = ISwapAdapter(leg.adapter).swap(
                leg.tokenIn,
                leg.tokenOut,
                amount,
                leg.minOut,
                leg.data
            );
            _forceApprove(leg.tokenIn, leg.adapter, 0);

            uint256 afterOut = IERC20Flash(leg.tokenOut).balanceOf(address(this));
            uint256 received = afterOut - beforeOut;
            require(received >= leg.minOut, "leg minOut");
            require(reported == 0 || reported <= received, "bad adapter report");
            amount = received;
        }

        uint256 routeBalance = IERC20Flash(pendingSettlement).balanceOf(address(this));
        require(
            routeBalance >= pendingBaseline + pendingBorrow + pendingMinProfit,
            "pre-repay profit"
        );

        _forceApprove(pendingSettlement, address(morpho), pendingBorrow);
        phase = 1;
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

        for (uint256 i = 0; i < legs.length; ++i) {
            Leg calldata leg = legs[i];
            require(adapters[leg.adapter], "adapter not allowed");
            require(leg.adapter.code.length > 0, "adapter no code");
            require(leg.tokenIn != leg.tokenOut, "same token leg");
            require(leg.minOut > 0, "zero minOut");
            if (i + 1 < legs.length) {
                require(leg.tokenOut == legs[i + 1].tokenIn, "broken route");
            }
        }
    }

    function _verifyState(StateCheck[] calldata checks) internal view {
        for (uint256 i = 0; i < checks.length; ++i) {
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
                require(
                    keccak256(abi.encode(reserve0, reserve1)) == check.expectedReturnHash,
                    "reserve mismatch"
                );
            } else {
                revert("unknown state mode");
            }
        }
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
        require(
            uint256(s) <= 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0,
            "high s"
        );
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "bad signer");
        return signer;
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        if (!_callApprove(token, spender, amount)) {
            require(
                _callApprove(token, spender, 0) &&
                _callApprove(token, spender, amount),
                "approve failed"
            );
        }
    }

    function _callApprove(address token, address spender, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20Flash.approve, (spender, amount))
        );
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeCall(IERC20Flash.transfer, (to, amount))
        );
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    // --- owner controls ---

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
