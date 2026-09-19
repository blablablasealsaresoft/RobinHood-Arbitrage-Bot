# Sequencer edge

The production bot consumes Robinhood's direct sequencer feed through a pinned `rhfeed` decoder.

```bash
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r sequencer/requirements.txt
python sequencer/rh_feed_edge.py
```

The daemon verifies feed signatures, emits L2 sequence/block hashes, detects replacements, and fails closed on gaps.

The feed is an already-sequenced soft-confirmed block signal. It does not contain receipts/final state. The Node runtime therefore waits for the local Nitro node to expose the exact same L2 block/hash before quoting.

The on-chain executor anchors with ArbSys `arbBlockNumber()` / `arbBlockHash()`, never Solidity `block.number`.
