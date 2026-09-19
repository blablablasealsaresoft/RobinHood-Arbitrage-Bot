#!/usr/bin/env python3
"""Verified direct Robinhood sequencer feed -> compact NDJSON events."""
import asyncio
import json
import os
import sys
import time

from rhfeed import MAINNET_FEED, MAINNET_VERIFIER, FeedConsumer, addr

WATCH = {
    addr(x.strip())
    for x in os.getenv("RH_HOT_ADDRESSES", "").split(",")
    if x.strip()
}

def emit(value):
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()

async def main():
    consumer = FeedConsumer(MAINNET_FEED, verify=MAINNET_VERIFIER)
    last_seq = None
    emit({"type":"feed_status","quality":"CONNECTING","state":"starting","verified":True})

    async for msg in consumer.live():
        recv_ns = time.time_ns()
        contiguous = last_seq is None or msg.seq == last_seq + 1 or msg.reorg
        last_seq = msg.seq

        touched = []
        for tx in msg.txs:
            if WATCH and tx.to_bytes not in WATCH:
                continue
            touched.append({
                "hash": tx.hash,
                "to": tx.to,
                "selector": tx.selector_hex,
                "value": tx.value,
                "nonce": tx.nonce,
                "gas": tx.gas,
            })

        quality = "DIRECT_VERIFIED" if contiguous and msg.block_hash else "DEGRADED"
        emit({
            "type": "soft_confirmed_block",
            "quality": quality,
            "verified": True,
            "sequence": msg.seq,
            "blockNumber": msg.seq,
            "blockHash": msg.block_hash,
            "timestamp": msg.timestamp,
            "reorg": bool(msg.reorg),
            "contiguous": contiguous,
            "touched": touched,
            "txCount": len(msg.txs),
            "tFeedNs": recv_ns,
            "tEmitNs": time.time_ns(),
        })

        if msg.reorg:
            emit({
                "type": "invalidate_from_sequence",
                "sequence": msg.seq,
                "newHash": msg.block_hash,
                "tEmitNs": time.time_ns(),
            })

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        emit({
            "type":"feed_status",
            "quality":"DEGRADED",
            "state":"fatal",
            "verified":False,
            "error":str(exc),
        })
        raise
