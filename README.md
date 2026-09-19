# Robinhood Sequencer Flash Arb

One bot. One strategy.

```text
verified Robinhood sequencer block N
        ↓
local Nitro node reaches the exact same N / blockHash
        ↓
one batched q-grid for RobinFun ↔ Uniswap V4
        ↓
choose highest positive expected-value q*
        ↓
sign EIP-712 intent anchored to L2 block N
        ↓
sign outer transaction once
        ↓
broadcast identical raw bytes through all measured paths
        ↓
L2 block N+1
        ↓
state locks
        ↓
Morpho WETH flash loan
        ↓
WETH → token → WETH
        ↓
repay principal
        ↓
incremental profit → treasury
```

This is intentionally **not** a general MEV framework, scanner, sandwich bot, directional trader, or inventory strategy.

## Why this architecture

Robinhood Chain is an Arbitrum/Nitro chain. The public sequencer feed gives a soft-confirmed L2 block before ordinary RPC consumers necessarily expose the executed state.

The bot uses that timing edge only to race an atomic arbitrage into the next L2 block.

The feed is not treated as a pending Ethereum mempool. We do not attempt to insert before a transaction already sequenced.

## Hot path

`sequencer/rh_feed_edge.py`

- connects directly to the Robinhood mainnet sequencer feed
- negotiates the required compression
- uses the pinned `rhfeed` implementation
- verifies every feed message against the mainnet sequencer signer
- detects sequence/block-hash replacement events
- emits compact NDJSON to the Node strategy process

`sequencer-bot.js`

- keeps a latest-only queue; stale work is discarded rather than queued
- waits for `LOCAL_RPC_URL` to expose the exact feed block/hash
- sends the complete q-grid as one JSON-RPC batch to `SequencerRouteQuoter`
- evaluates both RobinFun→V4 and V4→RobinFun
- chooses the candidate with the highest positive expected value
- builds exact curve + V4 slot0 + V4 liquidity state locks
- EIP-712 signs the V4 intent
- reserves one relayer nonce
- signs one EIP-1559 transaction
- concurrently broadcasts the same raw bytes to every configured path

There is no remote quote API in the execution path.

## The Robinhood block-number trap

Robinhood inherits Arbitrum's split block-number semantics:

- RPC `eth_blockNumber` / sequencer sequence = L2 height
- Solidity `block.number` = parent-chain estimate

Therefore `SequencerFlashArbExecutorV4` **does not use `block.number` or the BLOCKHASH opcode for the sequencer anchor**.

It uses the ArbSys precompile at `0x0000000000000000000000000000000000000064`:

```solidity
arbBlockNumber()
arbBlockHash(anchorBlock)
```

With `maxAnchorDelay = 1`, an intent derived from L2 block N is executable only in L2 block N+1.

## Execution contracts

### `SequencerFlashArbExecutorV4.sol`

- chain ID 4663 guard
- EIP-712 strategy signer
- separate relayer allowlist
- owner / pending-owner administration
- WETH borrow caps
- adapter allowlist
- nonce bitmap
- ArbSys L2 block + block-hash anchoring
- timestamp expiry
- max gas-price check
- mandatory signed state checks before Morpho
- closed-loop routes only
- per-leg minOut
- exact Morpho principal approval
- profit invariant before repayment
- profit invariant after repayment
- incremental profit transfer only
- pause/rescue controls
- no OpenZeppelin build dependency

### `RobinFunWethAdapter.sol`

Purpose-built WETH↔RobinFun conversion. It can only be called by the executor.

### `UniswapV4WethAdapter.sol`

Purpose-built WETH↔native-ETH V4 adapter.

- executor-only swap entry
- owner-allowlisted PoolKeys
- hooks disabled
- Permit2 approval warmed outside the hot path

### `SequencerRouteQuoter.sol`

Collapses each two-venue route quote into one `eth_call`, allowing the entire size/pool/direction grid to be sent in one local JSON-RPC batch.

## Aggressive volume gate

There is no fixed 150-bps hurdle.

The strategy evaluates:

```text
P(win) × (gross route profit - successful gas)
-
P(lose race) × reverted-tx gas
```

and submits when expected value exceeds `MIN_EXPECTED_VALUE_WEI`.

The default template starts with:

```env
LOSE_RACE_BPS=0
MIN_EXPECTED_VALUE_WEI=0
ONCHAIN_MIN_PROFIT_WEI=0
```

This means a route may be attempted with a very small edge, but it still must cover the modeled successful gas cost. As telemetry accumulates, set `LOSE_RACE_BPS` from measured race/revert frequency.

`ONCHAIN_MIN_PROFIT_WEI=0` does **not** permit principal loss. The callback still has to end with the full borrowed WETH principal available for Morpho.

## Install

Node:

```bash
npm ci
npm run check
```

Feed environment:

```bash
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r sequencer/requirements.txt
```

Copy configuration:

```bash
cp .env.example .env
```

## Required infrastructure

For live mode:

- dedicated relayer key
- separate strategy-signing key
- treasury
- Safe/multisig owner
- **local Robinhood Nitro RPC** at `LOCAL_RPC_URL`
- at least one measured transaction-delivery path
- Python 3.11+ feed process

The local node matters. The feed carries ordering/calldata but not receipts or state. The bot waits for the local node to re-execute the signed block and then reads exact state from that exact hash.

## Build and deploy

```bash
npm run check
npm run deploy
```

Deployment creates/configures:

1. `SequencerFlashArbExecutorV4`
2. `RobinFunWethAdapter`
3. `UniswapV4WethAdapter`
4. `SequencerRouteQuoter`

It warms V4 approvals and pool permissions, allowlists both adapters, enables the relayer, sets the WETH borrow cap, and sets `maxAnchorDelay=1`.

If `SAFE_OWNER` differs from the deployer, executor ownership is left pending for the Safe to accept after configuration.

Do not start live mode until the chain-4663 Morpho fork suite passes.

## Run

Dry:

```bash
npm run monitor
```

Live:

```bash
LIVE=1 npm run live
```

PM2:

```bash
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
```

The PM2 configuration intentionally runs **one process / one strategy**.

## Telemetry

`SEQUENCER_TELEMETRY` is NDJSON and records:

- anchor block/hash
- feed→local-node catch-up latency
- q-grid quote latency
- chosen direction/pool/size
- modeled gross profit
- expected value
- intent-build latency
- tx nonce/hash
- per-broadcast-path latency
- skipped/replaced anchors
- broadcast failures

Use this data to tune:

- `LOSE_RACE_BPS`
- local-node catch-up budget
- q-grid size
- gas model
- broadcast path selection

Do not optimize from anecdotes; optimize from inclusion and realized-P&L measurements.

## Validation gate

`npm run check` now:

1. syntax-checks root, scripts, tests, and sequencer modules
2. runs unit tests
3. compiles every Solidity source under `contracts/` with solc 0.8.26

Production still requires a Robinhood mainnet-fork suite proving:

- ArbSys block anchor parity with feed sequence/hash
- wrong/replaced anchor reverts
- stale curve/V4 state reverts before borrowing
- Morpho flash callback/repayment succeeds
- losing route reverts atomically
- `minProfit=0` still preserves principal
- positive minProfit is enforced
- both adapters settle exactly back to WETH
- Permit2/router permissions cannot route arbitrary assets/pools
- only incremental profit reaches treasury

## Legacy files

The repository retains the earlier `arb.js`, scanner, funded `ArbExecutor.sol`, and related scripts for comparison/history.

They are **not the primary production strategy**. `npm run live`, `npm run monitor`, PM2, and `npm run deploy` now target the sequencer-flash architecture.
