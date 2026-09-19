# Sequencer-native edge

This directory contains the latency-sensitive feed process used by the next-block arb path.

## Run

```bash
python3.11 -m venv .venv
. .venv/bin/activate
pip install -r sequencer/requirements.txt
python sequencer/rh_feed_edge.py
```

The process negotiates `permessage-deflate` explicitly and sends `Arbitrum-Feed-Client-Version: 2`. It emits NDJSON events suitable for piping into the strategy process.

A repeated sequence number with a different block hash emits `invalidate_from_sequence`; all opportunities, signatures, and prebuilt transactions derived from that sequence or later must be discarded.

The process is deliberately fail-closed: frames without an extractable sequence/hash are marked `DEGRADED`, not tradeable.

Production execution should treat this feed as a **soft-confirmed block / next-block edge**, not as a pre-execution mempool.
