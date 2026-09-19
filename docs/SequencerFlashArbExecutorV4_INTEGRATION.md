# SequencerFlashArbExecutorV4 integration

## Single-strategy doctrine

This executor exists for one strategy only:

```text
sequencer block N
 -> reconstruct relevant post-block state locally
 -> detect/size atomic arbitrage
 -> sign intent anchored to (N, blockHash(N))
 -> sign one raw transaction
 -> broadcast identical bytes over measured paths
 -> execute in N+1 (preferred) or a tiny fallback window
 -> Morpho borrow -> synchronous route -> repay -> verify profit
```

The sequencer feed is treated as a soft-confirmed block signal, not a pre-execution mempool.

## Robinhood Chain values

Verify immediately before production deployment.

- Chain ID: `4663`
- Morpho Blue: `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`
- Sequencer feed: `wss://feed.mainnet.chain.robinhood.com`
- Direct sequencer: `https://sequencer.mainnet.chain.robinhood.com`

Routers stay behind owner-approved synchronous adapters.

## V4 intent

EIP-712 domain:

```text
name    = RobinhoodSequencerFlashArb
version = 4
chainId = 4663
```

Primary type:

```text
FlashArbIntent(
  address settlementToken,
  uint256 borrowAmount,
  uint256 minProfit,
  uint256 nonce,
  uint64 anchorBlock,
  bytes32 anchorBlockHash,
  uint64 validUntilBlock,
  uint64 validUntilTimestamp,
  uint256 maxGasPrice,
  bytes32 legsHash,
  bytes32 checksHash
)
```

V4 intentionally removes `triggerTxHash` and `validAfterBlock`. The opportunity is bound to the exact sequencer block that produced the state.

## Strict next-block mode

Recommended initial configuration:

```text
maxAnchorDelay = 1
validUntilBlock = anchorBlock + 1
```

Before borrowing, the executor requires:

```text
block.number > anchorBlock
block.number <= validUntilBlock
blockhash(anchorBlock) == anchorBlockHash
block.timestamp <= validUntilTimestamp
tx.gasprice <= maxGasPrice
```

A branch replacement therefore invalidates the signed opportunity automatically.

## Aggressive threshold mode

V4 permits:

```text
minProfit = 0
```

This does not permit principal loss. Before the callback returns:

```text
ending settlement >= baseline + borrowed principal + minProfit
```

After Morpho repayment:

```text
final settlement >= baseline + minProfit
```

For the high-volume policy, the off-chain engine should submit whenever:

```text
modeled netAfterWorstCaseGas > 0
```

A positive on-chain `minProfit` may still be used when an additional economic floor is desired.

## Mandatory pre-borrow state check

Block-hash anchoring proves the source block, but another searcher may still land ahead of us in block N+1. Therefore V4 retains at least one signed pre-borrow state check.

For Uniswap-v2-style pools:

```text
mode = 1
callData = 0x0902f1ac
expectedReturnHash = keccak256(abi.encode(expectedReserve0, expectedReserve1))
```

For V3/V4/curve state, use mode 0 against a reviewed deterministic view/lens call and sign `keccak256(rawReturnBytes)`.

## Route invariant

Every route is closed-loop:

```text
settlement -> token A -> ... -> settlement
```

Every leg:
- uses an approved synchronous adapter
- has its own `minOut`
- must settle before returning

If native ETH is required by a venue, use ERC-20 settlement such as WETH and put wrapping/unwrapping inside a reviewed adapter.

## Hot path

After a feed block arrives, the fast path should avoid exploratory RPC quoting:

```text
feed
 -> local state update
 -> prebuilt route templates
 -> local q optimization
 -> checks + minOuts
 -> EIP-712 signature
 -> populate tx
 -> sign raw tx once
 -> broadcast identical bytes concurrently
```

Do not create different transactions/nonces for different RPC paths.

## Deployment

Recommended:

```text
initialOwner   = Safe/multisig
strategySigner = dedicated hot signer
treasury       = vault/Safe
morpho         = 0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010
maxAnchorDelay = 1
```

Only allowlist adapters and settlement assets used by this one strategy.

## Required tests

Before deployment:
- V4 EIP-712 parity between JS/Python and Solidity
- wrong/expired anchor reverts
- wrong block hash reverts
- stale state reverts before Morpho
- unauthorized signer/relayer reverts
- nonce replay reverts
- borrow cap and gas cap enforced
- route discontinuity and bad adapter revert
- each `minOut` enforced
- `minProfit=0` succeeds only with full principal repayable
- positive `minProfit` enforced
- repayment failure reverts atomically
- profitable fork route repays Morpho and transfers only incremental profit
- Robinhood chain-4663 fork using the current Morpho deployment

## Production metrics

Record:

```text
t_feed
t_decision
t_signed
t_submit[path]
t_included
anchorBlock
executionBlock
modeledNet
realizedProfit
revertReason
```

Tune attempt volume from measured inclusion probability and revert-gas cost rather than from a fixed bps threshold.
