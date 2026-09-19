// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20V4Adapter {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETHV4Adapter is IERC20V4Adapter {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IPermit2V4Adapter {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniversalRouterV4Adapter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

/// @notice Fail-closed hookless native-ETH Uniswap-v4 adapter that presents WETH externally.
/// @dev Route data = abi.encode(PoolKey). Pool must be owner-allowlisted.
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
    address public pendingOwner;
    IWETHV4Adapter public immutable weth;
    IPermit2V4Adapter public immutable permit2;
    IUniversalRouterV4Adapter public immutable router;
    mapping(bytes32 => bool) public allowedPools;

    event PoolAllowed(bytes32 indexed poolId, bool allowed);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    constructor(
        address initialOwner,
        address wethAddress,
        address permit2Address,
        address routerAddress
    ) {
        require(initialOwner != address(0), "zero owner");
        require(wethAddress != address(0) && wethAddress.code.length > 0, "bad weth");
        require(permit2Address != address(0) && permit2Address.code.length > 0, "bad permit2");
        require(routerAddress != address(0) && routerAddress.code.length > 0, "bad router");
        owner = initialOwner;
        weth = IWETHV4Adapter(wethAddress);
        permit2 = IPermit2V4Adapter(permit2Address);
        router = IUniversalRouterV4Adapter(routerAddress);
    }

    receive() external payable {}

    function poolId(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function setPoolAllowed(PoolKey calldata key, bool allowed) external onlyOwner {
        _validateKey(key);
        bytes32 id = poolId(key);
        allowedPools[id] = allowed;
        emit PoolAllowed(id, allowed);
    }

    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data
    ) external returns (uint256 amountOut) {
        require(amountIn > 0 && minOut > 0, "zero amount");
        require(amountIn <= type(uint128).max && amountIn <= type(uint160).max, "amount too large");
        PoolKey memory key = abi.decode(data, (PoolKey));
        _validateKey(key);
        require(allowedPools[poolId(key)], "pool not allowed");

        bool zeroForOne;
        uint256 value;

        if (tokenIn == address(weth)) {
            require(tokenOut == key.currency1, "bad WETH buy route");
            zeroForOne = true;
            _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
            weth.withdraw(amountIn);
            value = amountIn;
        } else {
            require(tokenOut == address(weth), "bad WETH sell route");
            require(tokenIn == key.currency1, "bad token sell route");
            zeroForOne = false;
            _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
            _forceApprove(tokenIn, address(permit2), amountIn);
            permit2.approve(tokenIn, address(router), uint160(amountIn), uint48(block.timestamp + 60));
        }

        uint256 outBefore = tokenOut == address(weth)
            ? address(this).balance
            : IERC20V4Adapter(tokenOut).balanceOf(address(this));

        bytes memory actions = abi.encodePacked(
            ACT_SWAP_EXACT_IN_SINGLE,
            ACT_SETTLE_ALL,
            ACT_TAKE_ALL
        );
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            ExactInputSingleParams({
                poolKey: key,
                zeroForOne: zeroForOne,
                amountIn: uint128(amountIn),
                amountOutMinimum: uint128(minOut),
                hookData: ""
            })
        );
        params[1] = abi.encode(zeroForOne ? key.currency0 : key.currency1, amountIn);
        params[2] = abi.encode(zeroForOne ? key.currency1 : key.currency0, minOut);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        router.execute{value: value}(
            abi.encodePacked(CMD_V4_SWAP),
            inputs,
            block.timestamp
        );

        if (!zeroForOne) {
            permit2.approve(tokenIn, address(router), 0, 0);
            _forceApprove(tokenIn, address(permit2), 0);
            uint256 ethOut = address(this).balance - outBefore;
            require(ethOut >= minOut, "V4 sell minOut");
            weth.deposit{value: ethOut}();
            amountOut = ethOut;
        } else {
            amountOut = IERC20V4Adapter(tokenOut).balanceOf(address(this)) - outBefore;
            require(amountOut >= minOut, "V4 buy minOut");
        }

        _safeTransfer(tokenOut, msg.sender, amountOut);
    }

    function _validateKey(PoolKey memory key) internal pure {
        require(key.currency0 == NATIVE, "currency0 not native");
        require(key.currency1 != address(0), "zero token");
        require(key.hooks == address(0), "hooks disabled");
        require(key.fee <= 1_000_000, "bad fee");
        require(key.tickSpacing > 0, "bad tick spacing");
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        if (!_callApprove(token, spender, amount)) {
            require(_callApprove(token, spender, 0) && _callApprove(token, spender, amount), "approve failed");
        }
    }

    function _callApprove(address token, address spender, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20V4Adapter.approve, (spender, amount)));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20V4Adapter.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20V4Adapter.transferFrom, (from, to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transferFrom failed");
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
