// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V4Adapter {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IWETHV4Adapter is IERC20V4Adapter {
    function deposit() external payable;
    function withdraw(uint256) external;
}
interface IPermit2V4Adapter {
    function approve(address token,address spender,uint160 amount,uint48 expiration) external;
}
interface IUniversalRouterV4Adapter {
    function execute(bytes calldata commands,bytes[] calldata inputs,uint256 deadline) external payable;
}

/// @notice Purpose-built native-ETH Uniswap V4 adapter using WETH as settlement.
/// @dev Pools must be owner-allowlisted; hooks are disabled; only executor swaps.
contract UniswapV4WethAdapter {
    uint8 private constant CMD_V4_SWAP = 0x10;
    uint8 private constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 private constant ACT_SETTLE_ALL = 0x0c;
    uint8 private constant ACT_TAKE_ALL = 0x0f;
    address private constant NATIVE = address(0);

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    address public owner;
    address public immutable executor;
    address public immutable router;
    address public immutable permit2;
    address public immutable weth;

    mapping(bytes32 => bool) public allowedPool;
    mapping(address => bool) public preparedToken;
    uint256 private _entered;

    error OnlyOwner();
    error OnlyExecutor();
    error PoolNotAllowed();
    error TokenNotPrepared();
    error BadPair();
    error BadOutput();
    error Reentrant();

    constructor(address owner_, address executor_, address router_, address permit2_, address weth_) {
        require(owner_ != address(0) && executor_ != address(0) && router_ != address(0) &&
                permit2_ != address(0) && weth_ != address(0), "zero");
        require(executor_.code.length > 0 && router_.code.length > 0 &&
                permit2_.code.length > 0 && weth_.code.length > 0, "no code");
        owner = owner_;
        executor = executor_;
        router = router_;
        permit2 = permit2_;
        weth = weth_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }
    modifier onlyExecutor() {
        if (msg.sender != executor) revert OnlyExecutor();
        _;
    }
    modifier nonReentrant() {
        if (_entered != 0) revert Reentrant();
        _entered = 1;
        _;
        _entered = 0;
    }

    function transferOwnership(address next) external onlyOwner {
        require(next != address(0), "zero");
        owner = next;
    }

    function poolId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function setPool(PoolKey calldata key, bool allowed) external onlyOwner {
        require(key.currency0 == NATIVE && key.currency1 != address(0), "bad currencies");
        require(key.hooks == address(0), "hooks disabled");
        require(key.fee <= 1_000_000 && key.tickSpacing > 0, "bad pool");
        allowedPool[poolId(key)] = allowed;
    }

    /// @notice Warm Permit2 approvals outside the hot path.
    function prepareToken(address token) external onlyOwner {
        require(token != address(0) && token != weth, "bad token");
        _forceApprove(token, permit2, type(uint256).max);
        IPermit2V4Adapter(permit2).approve(token, router, type(uint160).max, type(uint48).max);
        preparedToken[token] = true;
    }

    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata data
    ) external onlyExecutor nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0 && minAmountOut > 0, "bad amount");
        PoolKey memory key = abi.decode(data, (PoolKey));
        if (!allowedPool[poolId(key)]) revert PoolNotAllowed();
        if (key.currency0 != NATIVE || key.hooks != address(0)) revert PoolNotAllowed();

        bool zeroForOne;
        address outputAsset;
        uint256 beforeOut;

        if (tokenIn == weth && tokenOut == key.currency1) {
            zeroForOne = true;
            outputAsset = tokenOut;
            beforeOut = IERC20V4Adapter(tokenOut).balanceOf(address(this));
            IWETHV4Adapter(weth).withdraw(amountIn);
        } else if (tokenOut == weth && tokenIn == key.currency1) {
            zeroForOne = false;
            outputAsset = NATIVE;
            beforeOut = address(this).balance;
            if (!preparedToken[tokenIn]) revert TokenNotPrepared();
        } else {
            revert BadPair();
        }

        bytes memory actions = abi.encodePacked(
            ACT_SWAP_EXACT_IN_SINGLE,
            ACT_SETTLE_ALL,
            ACT_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(ExactInputSingleParams({
            poolKey: key,
            zeroForOne: zeroForOne,
            amountIn: uint128(amountIn),
            amountOutMinimum: uint128(minAmountOut),
            hookData: ""
        }));
        params[1] = abi.encode(zeroForOne ? NATIVE : key.currency1, amountIn);
        params[2] = abi.encode(zeroForOne ? key.currency1 : NATIVE, minAmountOut);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);

        IUniversalRouterV4Adapter(router).execute{value: zeroForOne ? amountIn : 0}(
            abi.encodePacked(CMD_V4_SWAP),
            inputs,
            block.timestamp
        );

        if (outputAsset == NATIVE) {
            amountOut = address(this).balance - beforeOut;
            if (amountOut < minAmountOut) revert BadOutput();
            IWETHV4Adapter(weth).deposit{value: amountOut}();
            _safeTransfer(weth, executor, amountOut);
        } else {
            amountOut = IERC20V4Adapter(outputAsset).balanceOf(address(this)) - beforeOut;
            if (amountOut < minAmountOut) revert BadOutput();
            _safeTransfer(outputAsset, executor, amountOut);
        }
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeCall(IERC20V4Adapter.transfer, (to, amount))
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (!_tryApprove(token, spender, amount)) {
            require(_tryApprove(token, spender, 0), "reset failed");
            require(_tryApprove(token, spender, amount), "approve failed");
        }
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeCall(IERC20V4Adapter.approve, (spender, amount))
        );
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    receive() external payable {
        require(msg.sender == weth || msg.sender == router, "unexpected eth");
    }
}
