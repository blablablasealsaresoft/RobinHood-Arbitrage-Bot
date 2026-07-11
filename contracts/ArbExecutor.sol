// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArbExecutor — atomic RobinFun-curve <-> Uniswap-V4 arbitrage.
/// @notice Buys on the RobinFun bonding curve and sells into a Uniswap V4 pool
///         (or the reverse) in ONE transaction, reverting unless the contract's
///         ETH balance grows by at least `minProfit`. No inventory risk: if the
///         V4 leg can't meet the profit floor the whole tx reverts (gas only).
///
/// The contract holds a working ETH balance (deposit via receive()). Each arb
/// call spends from and returns to that balance. Owner can withdraw anytime.
/// Tokens and pools are owner-allowlisted; hook-enabled pools are deliberately
/// rejected to keep the execution surface small and predictable.

interface ICurve {
    function buy(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut);
    function sell(address token, uint256 tokensIn, uint256 minEthOut) external returns (uint256 ethOut);
}
interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address a) external view returns (uint256);
}
interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}
interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

contract ArbExecutor {
    // --- Uniswap V4 command / action selectors ---
    uint8 private constant CMD_V4_SWAP = 0x10;
    uint8 private constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 private constant ACT_SETTLE_ALL = 0x0c;
    uint8 private constant ACT_TAKE_ALL = 0x0f;
    address private constant NATIVE = address(0);

    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct ExactInputSingleParams { PoolKey poolKey; bool zeroForOne; uint128 amountIn; uint128 amountOutMinimum; bytes hookData; }

    address public owner;
    address public pendingOwner;
    ICurve public immutable curve;
    IUniversalRouter public immutable router;
    IPermit2 public immutable permit2;
    mapping(address => bool) public approved;   // token => approvals set
    mapping(bytes32 => bool) public allowedPools;
    uint256 public maxTradeSize;
    bool public paused;
    uint256 private unlocked = 1;

    event PoolPermission(bytes32 indexed poolId, bool allowed);
    event MaxTradeSizeChanged(uint256 oldSize, uint256 newSize);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);
    event Arbitrage(address indexed token, bytes32 indexed poolId, bool curveFirst, uint256 ethIn, uint256 profit);
    event Withdrawal(uint256 amount);
    event PauseChanged(bool paused);
    event TokenApproval(address indexed token, bool approved);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier nonReentrant() {
        require(unlocked == 1, "reentrant");
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(address _curve, address _router, address _permit2, uint256 _maxTradeSize) {
        require(_curve != address(0) && _router != address(0) && _permit2 != address(0), "zero dependency");
        require(_curve.code.length > 0 && _router.code.length > 0 && _permit2.code.length > 0, "dependency has no code");
        require(_maxTradeSize > 0, "zero max trade");
        owner = msg.sender;
        curve = ICurve(_curve);
        router = IUniversalRouter(_router);
        permit2 = IPermit2(_permit2);
        maxTradeSize = _maxTradeSize;
    }

    receive() external payable {}

    /// @notice One-time approvals for a token so the Universal Router can pull it
    ///         via Permit2, and the curve can pull it on the reverse leg. Called
    ///         automatically on first use, or ahead of time by the owner.
    function approve(address token) public onlyOwner {
        require(token != address(0), "zero token");
        _safeApprove(token, address(permit2), type(uint256).max);
        permit2.approve(token, address(router), type(uint160).max, type(uint48).max);
        _safeApprove(token, address(curve), type(uint256).max);
        approved[token] = true;
        emit TokenApproval(token, true);
    }
    function revokeToken(address token) external onlyOwner {
        require(token != address(0), "zero token");
        _safeApprove(token, address(permit2), 0);
        permit2.approve(token, address(router), 0, 0);
        _safeApprove(token, address(curve), 0);
        approved[token] = false;
        emit TokenApproval(token, false);
    }
    function _ensure(address token) internal {
        if (!approved[token]) {
            _safeApprove(token, address(permit2), type(uint256).max);
            permit2.approve(token, address(router), type(uint160).max, type(uint48).max);
            _safeApprove(token, address(curve), type(uint256).max);
            approved[token] = true;
            emit TokenApproval(token, true);
        }
    }
    function _safeApprove(address token, address spender, uint256 amount) internal {
        if (!_callApprove(token, spender, amount)) {
            require(_callApprove(token, spender, 0) && _callApprove(token, spender, amount), "approve failed");
        }
    }
    function _callApprove(address token, address spender, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }
    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(abi.encodeCall(IERC20.transfer, (to, amount)));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }
    function poolId(PoolKey calldata key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }
    function setPoolAllowed(PoolKey calldata key, bool allowed) external onlyOwner {
        require(key.currency0 == NATIVE && key.currency1 != address(0), "bad key");
        require(key.hooks == address(0), "hooks disabled");
        require(key.fee <= 1_000_000 && key.tickSpacing > 0, "unsafe pool parameters");
        bytes32 id = poolId(key);
        allowedPools[id] = allowed;
        emit PoolPermission(id, allowed);
    }
    function _validate(address token, uint256 ethIn, PoolKey calldata key) internal view returns (bytes32 id) {
        require(!paused, "paused");
        require(ethIn > 0 && ethIn <= maxTradeSize, "bad trade size");
        require(key.currency1 == token && key.currency0 == NATIVE, "bad key");
        require(key.hooks == address(0), "hooks disabled");
        require(key.fee <= 1_000_000 && key.tickSpacing > 0, "unsafe pool parameters");
        id = poolId(key);
        require(allowedPools[id], "pool not allowed");
    }

    // internal: BUY token on curve -> SELL into V4 pool. Returns pre-trade balance.
    function _curveToV4(address token, uint256 ethIn, uint256 minTokensOut, PoolKey calldata key, uint128 minEthOut)
        internal returns (uint256 balBefore)
    {
        _validate(token, ethIn, key);
        _ensure(token);
        balBefore = address(this).balance;

        uint256 tokenBefore = IERC20(token).balanceOf(address(this));
        curve.buy{value: ethIn}(token, minTokensOut);
        uint256 tokensOut = IERC20(token).balanceOf(address(this)) - tokenBefore;
        require(tokensOut >= minTokensOut && tokensOut <= type(uint128).max, "bad token output");
        // sell exactly tokensOut on V4 (token1 -> token0/ETH => zeroForOne = false)
        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: key, zeroForOne: false,
            amountIn: uint128(tokensOut), amountOutMinimum: minEthOut, hookData: ""
        }));
        params[1] = abi.encode(key.currency1, tokensOut);
        params[2] = abi.encode(key.currency0, uint256(minEthOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        router.execute(abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp);
    }

    // internal: BUY token on V4 pool -> SELL on curve. Returns pre-trade balance.
    function _v4ToCurve(address token, uint256 ethIn, uint128 minTokensOut, PoolKey calldata key, uint256 minEthOut)
        internal returns (uint256 balBefore)
    {
        _validate(token, ethIn, key);
        _ensure(token);
        balBefore = address(this).balance;
        uint256 tokenBefore = IERC20(token).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: key, zeroForOne: true,
            amountIn: uint128(ethIn), amountOutMinimum: minTokensOut, hookData: ""
        }));
        params[1] = abi.encode(key.currency0, ethIn);
        params[2] = abi.encode(key.currency1, uint256(minTokensOut));
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        router.execute{value: ethIn}(abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp);

        uint256 got = IERC20(token).balanceOf(address(this)) - tokenBefore;
        require(got >= minTokensOut, "bad token output");
        curve.sell(token, got, minEthOut);
    }

    /// @notice BUY curve -> SELL V4. Reverts unless net ETH gain >= minProfit.
    function curveToV4(address token, uint256 ethIn, uint256 minTokensOut, PoolKey calldata key, uint128 minEthOut, uint256 minProfit) external onlyOwner nonReentrant {
        require(minProfit > 0 && uint256(minEthOut) >= ethIn + minProfit, "unsafe profit floor");
        uint256 balBefore = _curveToV4(token, ethIn, minTokensOut, key, minEthOut);
        require(address(this).balance >= balBefore + minProfit, "no profit");
        emit Arbitrage(token, poolId(key), true, ethIn, address(this).balance - balBefore);
    }
    /// @notice BUY V4 -> SELL curve. Reverts unless net ETH gain >= minProfit.
    function v4ToCurve(address token, uint256 ethIn, uint128 minTokensOut, PoolKey calldata key, uint256 minEthOut, uint256 minProfit) external onlyOwner nonReentrant {
        require(minProfit > 0 && minEthOut >= ethIn + minProfit, "unsafe profit floor");
        uint256 balBefore = _v4ToCurve(token, ethIn, minTokensOut, key, minEthOut);
        require(address(this).balance >= balBefore + minProfit, "no profit");
        emit Arbitrage(token, poolId(key), false, ethIn, address(this).balance - balBefore);
    }

    // --- admin ---
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= address(this).balance, "insufficient balance");
        (bool ok, ) = payable(owner).call{value: amount}("");
        require(ok, "withdraw failed");
        emit Withdrawal(amount);
    }
    function rescueToken(address t, uint256 amount) external onlyOwner nonReentrant {
        _safeTransfer(t, owner, amount);
    }
    function setMaxTradeSize(uint256 size) external onlyOwner {
        require(size > 0, "zero max trade");
        emit MaxTradeSizeChanged(maxTradeSize, size);
        maxTradeSize = size;
    }
    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit PauseChanged(value);
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
}
