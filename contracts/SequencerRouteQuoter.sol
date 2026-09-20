// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRobinFunQuoteV4 {
    function quoteBuy(address token,uint256 ethIn) external view returns (uint256);
    function quoteSell(address token,uint256 tokensIn) external view returns (uint256);
}

interface IV4QuoterRoute {
    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }
    function quoteExactInputSingle(QuoteExactSingleParams memory params)
        external returns (uint256 amountOut,uint256 gasEstimate);
}

/// @notice Local eth_call helper for the one RobinFun <-> Uniswap V4 route.
/// @dev Lets the bot send the entire q-grid as one JSON-RPC batch to its local node.
contract SequencerRouteQuoter {
    IRobinFunQuoteV4 public immutable curve;
    IV4QuoterRoute public immutable v4Quoter;

    constructor(address curve_, address v4Quoter_) {
        require(curve_ != address(0) && v4Quoter_ != address(0), "zero");
        curve = IRobinFunQuoteV4(curve_);
        v4Quoter = IV4QuoterRoute(v4Quoter_);
    }

    function quoteCurveToV4(address token,uint128 wethIn,IV4QuoterRoute.PoolKey calldata key)
        external returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate)
    {
        tokenOut = curve.quoteBuy(token, wethIn);
        require(tokenOut <= type(uint128).max, "quote overflow");
        (wethOut, v4GasEstimate) = v4Quoter.quoteExactInputSingle(
            IV4QuoterRoute.QuoteExactSingleParams({
                poolKey: key,
                zeroForOne: false,
                exactAmount: uint128(tokenOut),
                hookData: ""
            })
        );
    }

    function quoteV4ToCurve(address token,uint128 wethIn,IV4QuoterRoute.PoolKey calldata key)
        external returns (uint256 tokenOut,uint256 wethOut,uint256 v4GasEstimate)
    {
        (tokenOut, v4GasEstimate) = v4Quoter.quoteExactInputSingle(
            IV4QuoterRoute.QuoteExactSingleParams({
                poolKey: key,
                zeroForOne: true,
                exactAmount: wethIn,
                hookData: ""
            })
        );
        wethOut = curve.quoteSell(token, tokenOut);
    }
}
