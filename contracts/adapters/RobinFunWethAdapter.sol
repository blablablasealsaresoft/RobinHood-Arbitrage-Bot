// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20CurveAdapter {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IWETHCurveAdapter is IERC20CurveAdapter {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IRobinFunCurve {
    function buy(address token, uint256 minTokensOut) external payable returns (uint256);
    function sell(address token, uint256 tokensIn, uint256 minEthOut) external returns (uint256);
}

/// @notice Fail-closed adapter between canonical WETH and one immutable RobinFun curve.
contract RobinFunWethAdapter {
    address public owner;
    address public pendingOwner;
    IRobinFunCurve public immutable curve;
    IWETHCurveAdapter public immutable weth;
    mapping(address => bool) public allowedTokens;
    uint256 private unlocked = 1;

    event TokenAllowed(address indexed token, bool allowed);
    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }
    modifier nonReentrant() { require(unlocked == 1, "reentrant"); unlocked = 2; _; unlocked = 1; }

    constructor(address initialOwner, address curveAddress, address wethAddress) {
        require(initialOwner != address(0), "zero owner");
        require(curveAddress != address(0) && curveAddress.code.length > 0, "bad curve");
        require(wethAddress != address(0) && wethAddress.code.length > 0, "bad weth");
        owner = initialOwner;
        curve = IRobinFunCurve(curveAddress);
        weth = IWETHCurveAdapter(wethAddress);
    }

    receive() external payable {}

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        require(token != address(0) && token != address(weth), "bad token");
        if (allowed) require(token.code.length > 0, "token no code");
        allowedTokens[token] = allowed;
        emit TokenAllowed(token, allowed);
    }

    /// @dev Called only through an executor-approved adapter route.
    ///      data must be empty; direction follows tokenIn/tokenOut.
    function swap(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        bytes calldata data
    ) external nonReentrant returns (uint256 amountOut) {
        require(data.length == 0, "unexpected data");
        require(amountIn > 0 && minOut > 0, "zero amount");

        if (tokenIn == address(weth)) {
            require(allowedTokens[tokenOut], "token not allowed");
            _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
            uint256 beforeOut = IERC20CurveAdapter(tokenOut).balanceOf(address(this));
            weth.withdraw(amountIn);
            curve.buy{value: amountIn}(tokenOut, minOut);
            amountOut = IERC20CurveAdapter(tokenOut).balanceOf(address(this)) - beforeOut;
            require(amountOut >= minOut, "curve buy minOut");
            _safeTransfer(tokenOut, msg.sender, amountOut);
            return amountOut;
        }

        if (tokenOut == address(weth)) {
            require(allowedTokens[tokenIn], "token not allowed");
            _safeTransferFrom(tokenIn, msg.sender, address(this), amountIn);
            _forceApprove(tokenIn, address(curve), amountIn);
            uint256 ethBefore = address(this).balance;
            curve.sell(tokenIn, amountIn, minOut);
            _forceApprove(tokenIn, address(curve), 0);
            uint256 ethOut = address(this).balance - ethBefore;
            require(ethOut >= minOut, "curve sell minOut");
            weth.deposit{value: ethOut}();
            _safeTransfer(address(weth), msg.sender, ethOut);
            return ethOut;
        }

        revert("route must use WETH");
    }

    function _forceApprove(address token, address spender, uint256 amount) internal {
        if (!_callApprove(token, spender, amount)) {
            require(_callApprove(token, spender, 0) && _callApprove(token, spender, amount), "approve failed");
        }
    }

    function _callApprove(address token, address spender, uint256 amount) internal returns (bool) {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20CurveAdapter.approve, (spender, amount)));
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20CurveAdapter.transfer, (to, amount)));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeCall(IERC20CurveAdapter.transferFrom, (from, to, amount)));
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
