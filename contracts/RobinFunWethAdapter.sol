// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20CurveAdapter {
    function balanceOf(address) external view returns (uint256);
    function transfer(address,uint256) external returns (bool);
    function approve(address,uint256) external returns (bool);
}
interface IWETHCurveAdapter is IERC20CurveAdapter {
    function deposit() external payable;
    function withdraw(uint256) external;
}
interface IRobinFunCurveAdapter {
    function buy(address token,uint256 minTokensOut) external payable returns (uint256);
    function sell(address token,uint256 tokensIn,uint256 minEthOut) external returns (uint256);
}

/// @notice Purpose-built WETH <-> RobinFun adapter for SequencerFlashArbExecutorV4.
/// @dev Only the immutable executor can call swaps. No arbitrary-call surface.
contract RobinFunWethAdapter {
    address public immutable executor;
    address public immutable curve;
    address public immutable weth;
    uint256 private _entered;

    error OnlyExecutor();
    error BadPair();
    error BadOutput();
    error Reentrant();

    constructor(address executor_, address curve_, address weth_) {
        require(executor_ != address(0) && curve_ != address(0) && weth_ != address(0), "zero");
        require(executor_.code.length > 0 && curve_.code.length > 0 && weth_.code.length > 0, "no code");
        executor = executor_;
        curve = curve_;
        weth = weth_;
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

    function swapExactInput(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata
    ) external onlyExecutor nonReentrant returns (uint256 amountOut) {
        require(amountIn > 0 && minAmountOut > 0, "bad amount");

        if (tokenIn == weth && tokenOut != weth) {
            uint256 beforeOut = IERC20CurveAdapter(tokenOut).balanceOf(address(this));
            IWETHCurveAdapter(weth).withdraw(amountIn);
            IRobinFunCurveAdapter(curve).buy{value: amountIn}(tokenOut, minAmountOut);
            amountOut = IERC20CurveAdapter(tokenOut).balanceOf(address(this)) - beforeOut;
            if (amountOut < minAmountOut) revert BadOutput();
            _safeTransfer(tokenOut, executor, amountOut);
            return amountOut;
        }

        if (tokenOut == weth && tokenIn != weth) {
            uint256 beforeEth = address(this).balance;
            _forceApprove(tokenIn, curve, amountIn);
            IRobinFunCurveAdapter(curve).sell(tokenIn, amountIn, minAmountOut);
            _forceApprove(tokenIn, curve, 0);
            uint256 ethOut = address(this).balance - beforeEth;
            if (ethOut < minAmountOut) revert BadOutput();
            IWETHCurveAdapter(weth).deposit{value: ethOut}();
            _safeTransfer(weth, executor, ethOut);
            return ethOut;
        }

        revert BadPair();
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory ret) = token.call(
            abi.encodeCall(IERC20CurveAdapter.transfer, (to, amount))
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
            abi.encodeCall(IERC20CurveAdapter.approve, (spender, amount))
        );
        return ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))));
    }

    receive() external payable {
        require(msg.sender == weth || msg.sender == curve, "unexpected eth");
    }
}
