#!/usr/bin/env python3
"""
rh_feed_edge.py
Execution-grade Robinhood Chain sequencer feed listener.

Goals:
- negotiate RFC7692 permessage-deflate explicitly;
- keep one persistent upstream connection;
- detect sequence/hash replacement events (reorg/replacement);
- classify feed health;
- emit compact newline-delimited JSON to stdout for a local consumer.

This process intentionally does NOT guess unsupported feed cryptography. If
signature metadata is present but cannot be verified with the configured
format, the event is marked DEGRADED rather than trusted.
"""
import asyncio, json, os, sys, time
from collections import deque
import websockets

FEED_URL = os.getenv("RH_FEED_URL", "wss://feed.mainnet.chain.robinhood.com")
CHAIN_ID = 4663
CLIENT_VERSION = os.getenv("RH_FEED_CLIENT_VERSION", "2")
STALL_MS = int(os.getenv("RH_FEED_STALL_MS", "750"))
RECENT = int(os.getenv("RH_FEED_RECENT", "2048"))

recent = {}
order = deque()

def find_key(obj, names):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in names:
                return v
        for v in obj.values():
            r = find_key(v, names)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_key(v, names)
            if r is not None:
                return r
    return None

def normalize_seq(v):
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        try:
            return int(v, 0)
        except Exception:
            return None
    return None

def emit(payload):
    sys.stdout.write(json.dumps(payload, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def classify(msg, recv_ns):
    seq = normalize_seq(find_key(msg, {"sequenceNumber", "sequence_number", "seq", "sequence"}))
    block_hash = find_key(msg, {"blockHash", "block_hash"})
    block_num = normalize_seq(find_key(msg, {"blockNumber", "block_number"}))
    chain_id = normalize_seq(find_key(msg, {"chainId", "chain_id"}))
    now_ns = time.time_ns()

    quality = "DIRECT_VERIFIED"
    reasons = []
    if chain_id is not None and chain_id != CHAIN_ID:
        quality = "DEGRADED"
        reasons.append("wrong_chain")
    if seq is None or not isinstance(block_hash, str):
        quality = "DEGRADED"
        reasons.append("missing_seq_or_hash")

    replaced = False
    previous_hash = None
    if seq is not None and isinstance(block_hash, str):
        previous_hash = recent.get(seq)
        if previous_hash is not None and previous_hash.lower() != block_hash.lower():
            replaced = True
        recent[seq] = block_hash
        order.append(seq)
        while len(order) > RECENT:
            old = order.popleft()
            if old not in order:
                recent.pop(old, None)

    return {
        "type": "soft_confirmed_block",
        "quality": quality,
        "reasons": reasons,
        "sequence": seq,
        "blockNumber": block_num,
        "blockHash": block_hash,
        "replacement": replaced,
        "previousBlockHash": previous_hash if replaced else None,
        "tFeedNs": recv_ns,
        "tEmitNs": now_ns,
        "edgeLatencyUs": max(0, (now_ns - recv_ns) // 1000),
    }

async def run():
    backoff = 0.1
    headers = {"Arbitrum-Feed-Client-Version": CLIENT_VERSION}
    while True:
        try:
            async with websockets.connect(
                FEED_URL,
                compression="deflate",
                additional_headers=headers,
                max_size=32_000_000,
                ping_interval=10,
                ping_timeout=5,
                open_timeout=5,
                close_timeout=1,
            ) as ws:
                emit({"type":"feed_status","quality":"DIRECT_VERIFIED","state":"connected","url":FEED_URL})
                backoff = 0.1
                async for raw in ws:
                    recv_ns = time.time_ns()
                    try:
                        if isinstance(raw, bytes):
                            raw = raw.decode("utf-8")
                        msg = json.loads(raw)
                    except Exception as e:
                        emit({"type":"feed_status","quality":"DEGRADED","state":"decode_error","error":str(e)})
                        continue
                    event = classify(msg, recv_ns)
                    emit(event)
                    if event["replacement"]:
                        emit({
                            "type":"invalidate_from_sequence",
                            "sequence":event["sequence"],
                            "oldHash":event["previousBlockHash"],
                            "newHash":event["blockHash"],
                            "tEmitNs":time.time_ns(),
                        })
        except Exception as e:
            emit({"type":"feed_status","quality":"DEGRADED","state":"disconnected","error":str(e)})
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 5.0)

if __name__ == "__main__":
    try:
        asyncio.run(run())
    except KeyboardInterrupt:
        pass
