# SequencerFlashArbExecutorV4 integration

## Single-strategy doctrine

This stack exists for one strategy only:

```text
verified sequencer L2 block N
 -> local Nitro node reaches exact N / hash(N)
 -> batch price RobinFun ↔ Uniswap V4 sizes
 -> choose positive-EV q*
 -> build exact state locks at N
 -> sign intent anchored to N / hash(N)
 -> sign one outer raw transaction
 -> broadcast identical bytes over measured paths
 -> execute in L2 block N+1
 -> Morpho WETH borrow
 -> synchronous WETH → token → WETH route
 -> repay Morpho
 -> verify/transfer incremental profit
```

The sequencer feed is an already-sequenced soft-confirmation, not a pre-execution Ethereum mempool.

## Robinhood dependencies

Verify again immediately before deployment.

- Chain ID: `4663`
- ArbSys: `0x0000000000000000000000000000000000000064`
- Morpho Blue: `0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010`
- WETH: `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`
- Sequencer feed: `wss://feed.mainnet.chain.robinhood.com`
- Direct sequencer: `https://sequencer.mainnet.chain.robinhood.com`

Only owner-approved synchronous adapters are exposed to the flash executor.

## Critical Nitro block-number rule

The sequencer feed sequence / RPC L2 height must **not** be compared to Solidity `block.number`.

V4 anchors through ArbSys:

```solidity
uint256 l2Block = ARBSYS.arbBlockNumber();
bytes32 anchorHash = ARBSYS.arbBlockHash(intent.anchorBlock);
```

Strict next-block configuration:

```text
maxAnchorDelay = 1
validUntilBlock = anchorBlock + 1
```

Before Morpho is called:

```text
arbBlockNumber() > anchorBlock
arbBlockNumber() <= validUntilBlock
arbBlockHash(anchorBlock) == anchorBlockHash
block.timestamp <= validUntilTimestamp
tx.gasprice <= maxGasPrice
all signed state checks still match
```

A replaced branch or a competitor changing the locked state causes a pre-borrow revert.

## EIP-712 intent

Domain:

```text
name    = RobinhoodSequencerFlashArb
version = 4
chainId = 4663
verifyingContract = deployed executor
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

There is deliberately no `triggerTxHash`: the strategy is bound to the exact executed sequencer block/state.

## Execution contracts

### SequencerFlashArbExecutorV4

- chain-ID guard;
- Safe-compatible owner + pending owner;
- separate hot EIP-712 strategy signer;
- relayer allowlist;
- nonce bitmap;
- WETH borrow cap;
- adapter allowlist;
- ArbSys L2 block/hash anchor;
- timestamp and gas-price limits;
- mandatory signed state checks before borrowing;
- closed-loop route enforcement;
- per-leg `minOut`;
- exact Morpho repayment approval;
- profit invariant before and after repayment;
- incremental profit transfer to treasury;
- pause/rescue controls.

### RobinFunWethAdapter

Executor-only WETH ↔ RobinFun adapter. WETH is unwrapped only inside the adapter and route output is returned to the executor.

### UniswapV4WethAdapter

Executor-only WETH ↔ native-ETH Uniswap V4 adapter. PoolKeys are separately owner-allowlisted, hooks are disabled, and Permit2 approvals are warmed before live operation.

### SequencerRouteQuoter

One-call two-venue quote helper used only through `eth_call` on the local node. The bot sends the entire pool/size/direction grid as one JSON-RPC batch.

## Exact state locks

For the chosen route the bot signs three mode-0 checks from exact L2 block N:

1. RobinFun `curves(token)`
2. Uniswap V4 StateView `getSlot0(poolId)`
3. Uniswap V4 StateView `getLiquidity(poolId)`

Each expected value is:

```text
keccak256(rawReturnBytes)
```

These are checked again on-chain immediately before the Morpho flash loan.

## Route invariant

Production route shape is exactly:

```text
WETH -> TOKEN -> WETH
```

Each leg uses a reviewed adapter and non-zero `minOut`. No inventory route and no asynchronous/order-based venue is permitted.

## Aggressive expected-value gate

V4 permits:

```text
minProfit = 0
```

This does not permit loss of flash principal. Morpho still has to be fully repayable.

The bot's submission gate is:

```text
P(win) × (gross route profit - successful gas)
-
P(lose race) × reverted-tx gas
>
MIN_EXPECTED_VALUE_WEI
```

This removes an arbitrary fixed-bps hurdle without intentionally submitting modeled negative-EV trades.

## Broadcast and nonce discipline

One opportunity produces exactly one outer transaction:

- one relayer nonce;
- one signed raw byte string;
- one tx hash;
- the identical bytes are POSTed concurrently to all configured delivery endpoints.

Do not produce endpoint-specific transactions or nonces.

## Deployment

`npm run deploy` now deploys and configures the sequencer stack:

1. `SequencerFlashArbExecutorV4`
2. `RobinFunWethAdapter`
3. `UniswapV4WethAdapter`
4. `SequencerRouteQuoter`

It then:

- allowlists configured V4 pools;
- warms Permit2 approval for the configured token;
- allowlists both adapters;
- enables the relayer;
- sets the WETH borrow cap;
- deploys the executor with `maxAnchorDelay=1`;
- initiates executor ownership transfer to `SAFE_OWNER` when configured.

## Required pre-production validation

Run `npm run check` and a Robinhood chain-4663 mainnet-fork suite proving:

- all Solidity sources compile together;
- JS EIP-712 hashes equal Solidity hashes;
- feed sequence/hash equals ArbSys anchor semantics;
- wrong/replaced/expired anchor reverts;
- stale curve or V4 state reverts before Morpho;
- unauthorized signer/relayer and nonce replay revert;
- borrow/gas caps are enforced;
- adapter/pool restrictions hold;
- every minOut is enforced;
- `minProfit=0` still requires full principal repayment;
- positive minProfit is enforced;
- losing routes revert atomically;
- profitable routes repay Morpho and transfer only incremental WETH profit.

## Production telemetry

Record and tune from:

```text
feed sequence/hash
feed→local catch-up µs
q-grid quote µs
intent-build µs
sign→broadcast µs
per-path POST latency
tx hash / nonce
included L2 block
modeled gross profit
modeled expected value
realized profit
revert reason
```

Attempt volume should be tuned from measured inclusion/revert economics rather than from a fixed percentage threshold.
