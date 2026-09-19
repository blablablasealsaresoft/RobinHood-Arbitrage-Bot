// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRobinFunQuote {
    function quoteBuy(address token,uint256 ethIn) external view returns (uint256);
    function quoteSell(address token,uint256 tokensIn) external view returns (uint256);
}
interface IV4Quote {
    struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }
    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external returns (uint256 amountOut,uint256 gasEstimate);
}

/// @notice One-call route quoter for the single RobinFun <-> Uniswap V4 strategy.
/// @dev Designed for eth_call against a local Nitro node. It removes the two-leg
///      dependency chain from the bot process, so a whole q-grid can be JSON-RPC batched.
contract SequencerRouteQuoter {
    IRobinFunQuote public immutable curve;
    IV4Quote public immutable v4Quoter;

    constructor(address curve_, address v4Quoter_) {
        require(curve_ != address(0) && v4Quoter_ != address(0), "zero");
        curve = IRobinFunQuote(curve_);
        v4Quoter = IV4Quote(v4Quoter_);
    }

    function quoteCurveToV4(
        address token,
        uint128 wethIn,
        IV4Quote.PoolKey calldata key
    ) external returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate) {
        tokenOut = curve.quoteBuy(token, wethIn);
        (wethOut, v4GasEstimate) = v4Quoter.quoteExactInputSingle(
            IV4Quote.QuoteExactSingleParams({
                poolKey: key,
                zeroForOne: false,
                exactAmount: uint128(tokenOut),
                hookData: ""
            })
        );
    }

    function quoteV4ToCurve(
        address token,
        uint128 wethIn,
        IV4Quote.PoolKey calldata key
    ) external returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate) {
        (tokenOut, v4GasEstimate) = v4Quoter.quoteExactInputSingle(
            IV4Quote.QuoteExactSingleParams({
                poolKey: key,
                zeroForOne: true,
                exactAmount: wethIn,
                hookData: ""
            })
        );
        wethOut = curve.quoteSell(token, tokenOut);
    }
}
