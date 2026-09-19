# Production sequencer strategy

## Scope

One strategy only:

```text
verified sequencer L2 block N
→ exact local N/hash
→ batched RobinFun ↔ Uniswap V4 q-grid
→ positive-EV q*
→ exact state locks
→ EIP-712 flash intent
→ identical raw-tx fanout
→ L2 block N+1
→ Morpho WETH flash loan
→ WETH → token → WETH
→ repay
→ incremental profit
```

The direct feed is not a pending mempool. The bot races for the following L2 block.

## Critical Robinhood/Nitro rule

Sequencer sequence numbers and RPC block heights are L2 heights. Solidity `block.number` is not the correct sequencer clock.

`SequencerFlashArbExecutorV4` therefore uses ArbSys at `0x64`:

```solidity
arbBlockNumber()
arbBlockHash(anchorBlock)
```

Production configuration requires:

```text
maxBlockWindow = 1
maxAnchorDelay = 1
validAfterBlock = anchorBlock + 1
validUntilBlock = anchorBlock + 1
```

## Hot path

1. `sequencer/rh_feed_edge.py` verifies signed feed messages.
2. `sequencer-bot.js` keeps only the newest eligible feed block.
3. Local Nitro must expose the identical block hash.
4. The full pool × size × direction grid is one local JSON-RPC batch through `SequencerRouteQuoter`.
5. The chosen route gets exact RobinFun `curves()`, V4 `slot0`, and V4 liquidity locks from block N.
6. The strategy key signs the existing V4 EIP-712 intent with `triggerTxHash = 0`.
7. The relayer reserves one transaction nonce and signs once.
8. The same raw bytes are broadcast concurrently to every configured transport.

## Aggressive volume policy

There is no fixed bps gate in this runner.

```text
EV =
P(win) × (gross profit - successful gas)
-
P(lose race) × revert gas
```

Submit only when `EV > MIN_EXPECTED_VALUE_WEI`.

`ONCHAIN_MIN_PROFIT_WEI=0` is supported. It does not allow loss of flash principal: Morpho still must be fully repayable or the transaction reverts.

## Deployment

`npm run deploy` deploys fail-closed:

- SequencerFlashArbExecutorV4
- RobinFunWethAdapter
- UniswapV4WethAdapter
- SequencerRouteQuoter

The Safe must then explicitly enable the relayer, both executor adapters, WETH borrow cap, configured RobinFun token, and configured V4 pools.

## Pre-live gate

Run:

```bash
npm ci
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r sequencer/requirements.txt
npm run check
npm run monitor
```

Before capital deployment, add/run a Robinhood chain-4663 fork suite proving actual Morpho borrow/repay, both route directions, stale-state pre-borrow reverts, replaced-anchor reverts, and treasury-only incremental profit.
