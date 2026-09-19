# Sequencer-native edge

This directory is the latency-sensitive observation layer for the one production strategy.

## Feed process

```bash
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r sequencer/requirements.txt
python sequencer/rh_feed_edge.py
```

`requirements.txt` pins Chainstack Labs' Robinhood feed decoder to a specific commit. The daemon:

- connects directly to the Robinhood mainnet sequencer feed;
- negotiates the current permessage-deflate requirement;
- verifies each feed message with the mainnet sequencer verifier before surfacing it;
- treats `sequenceNumber` as the Robinhood L2 block height;
- keeps the sequencer-provided `blockHash`;
- flags replacement/reorg messages;
- emits compact NDJSON to `sequencer-bot.js`.

The feed is a **soft-confirmed executed block signal**, not a pending Ethereum mempool. It does not provide receipts or final market state, so the Node strategy waits for the local Nitro node to expose the exact same L2 block/hash before pricing an opportunity.

## Fail-closed quality

Only events marked:

```text
quality = DIRECT_VERIFIED
verified = true
contiguous = true
blockHash != null
```

are eligible for the trading path.

A replacement emits `invalidate_from_sequence`; cached opportunity/dedupe state from that L2 height onward is invalidated.

## Runtime helpers

`runtime.js` provides:

- expected-value gating including successful gas and losing-race revert gas;
- a single relayer nonce coordinator;
- opportunity deduplication;
- microsecond-resolution NDJSON telemetry;
- exact local-node block/hash catch-up.

## L2 block semantics

Do not use Solidity `block.number` as the sequencer block height on Robinhood/Nitro.

The executor validates feed anchors with ArbSys at `0x64`:

```solidity
arbBlockNumber()
arbBlockHash(anchorBlock)
```

With `maxAnchorDelay = 1`, a signed opportunity from L2 block N can execute only in L2 block N+1.

## Latency doctrine

The hot path is:

```text
verified feed N
 -> local node exact N/hash
 -> one batched q-grid request
 -> choose q*
 -> one batched state-lock snapshot
 -> EIP-712 sign
 -> reserve one tx nonce
 -> sign outer tx once
 -> parallel identical-byte broadcast
```

There is no remote quote API in the execution path and stale anchors are never queued behind newer work.
