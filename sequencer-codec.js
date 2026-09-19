// sequencer-codec.js — minimal hot-path Nitro L2 transaction decoder.
//
// Feed messages are executed soft-confirmed blocks. Decode just enough to
// decide whether a block touched a supported market and retain calldata/hash
// for candidate filtering. Sender recovery stays off the hot path.

import { keccak256 } from 'ethers';

const L2_BATCH = 3;
const L2_SIGNED_TX = 4;
const MAX_BATCH_DEPTH = 16;

const LAYOUTS = new Map([
  [0, [0, 2, 3, 4, 5]],
  [1, [1, 3, 4, 5, 6]],
  [2, [1, 4, 5, 6, 7]],
  [3, [1, 4, 5, 6, 7]],
  [4, [1, 4, 5, 6, 7]],
]);

export function decodeFeedTransactions(frame) {
  const out = [];
  for (const entry of frame?.messages || []) {
    const incoming = entry?.message?.message || {};
    const header = incoming?.header || {};
    const encoded = incoming?.l2Msg;
    if (!encoded || typeof encoded !== 'string') continue;

    let payload;
    try { payload = Buffer.from(encoded, 'base64'); }
    catch { continue; }

    const txs = decodeL2Message(payload);
    for (const tx of txs) {
      out.push({
        ...tx,
        sequenceNumber: entry?.sequenceNumber == null ? null : String(entry.sequenceNumber),
        blockHash: entry?.blockHash || null,
        timestamp: Number(header?.timestamp || 0),
      });
    }
  }
  return out;
}

export function decodeL2Message(payload, depth = 0) {
  if (!payload?.length) return [];
  const kind = payload[0];

  if (kind === L2_SIGNED_TX) {
    const tx = decodeTransaction(payload.subarray(1));
    return tx ? [tx] : [];
  }
  if (kind !== L2_BATCH || depth >= MAX_BATCH_DEPTH) return [];

  const out = [];
  for (const nested of splitBatch(payload.subarray(1))) {
    out.push(...decodeL2Message(nested, depth + 1));
  }
  return out;
}

export function decodeTransaction(raw) {
  if (!raw?.length) return null;
  const txHash = keccak256(raw);
  const typed = raw[0] < 0x80;
  const txType = typed ? raw[0] : 0;
  const layout = LAYOUTS.get(txType);

  if (!layout) {
    return {
      raw, txType, txHash, to: null, selector: null, dataHex: '0x',
      valueWei: '0', nonce: '0', gas: '0', dataLength: 0,
    };
  }

  const body = typed ? raw.subarray(1) : raw;
  let fields;
  try { fields = scanRlpList(body); }
  catch {
    return {
      raw, txType, txHash, to: null, selector: null, dataHex: '0x',
      valueWei: '0', nonce: '0', gas: '0', dataLength: 0,
    };
  }

  const [nonceIndex, gasIndex, toIndex, valueIndex, dataIndex] = layout;
  if (fields.length < dataIndex + 4) return null;

  const toBytes = payloadSlice(body, fields[toIndex]);
  const data = payloadSlice(body, fields[dataIndex]);

  return {
    raw,
    txType,
    txHash,
    to: toBytes.length === 20 ? '0x' + toBytes.toString('hex') : null,
    selector: data.length >= 4 ? '0x' + data.subarray(0, 4).toString('hex') : null,
    dataHex: '0x' + data.toString('hex'),
    valueWei: readUint(body, fields[valueIndex]).toString(),
    nonce: readUint(body, fields[nonceIndex]).toString(),
    gas: readUint(body, fields[gasIndex]).toString(),
    dataLength: data.length,
  };
}

function* splitBatch(payload) {
  let offset = 0;
  while (offset + 8 <= payload.length) {
    const lengthBig = payload.readBigUInt64BE(offset);
    offset += 8;
    if (lengthBig === 0n || lengthBig > BigInt(Number.MAX_SAFE_INTEGER)) return;
    const length = Number(lengthBig);
    if (offset + length > payload.length) return;
    yield payload.subarray(offset, offset + length);
    offset += length;
  }
}

function scanRlpList(buf) {
  if (!buf.length) throw new Error('empty RLP');
  const head = buf[0];
  if (head < 0xc0) throw new Error('not RLP list');

  let i;
  let end;
  if (head < 0xf8) {
    i = 1;
    end = 1 + (head - 0xc0);
  } else {
    const n = head - 0xf7;
    i = 1 + n;
    end = i + readLength(buf, 1, n);
  }
  if (end > buf.length) throw new Error('truncated RLP list');

  const out = [];
  while (i < end) {
    const c = buf[i];
    const itemStart = i;
    let start;
    let finish;

    if (c < 0x80) {
      start = i; finish = i + 1;
    } else if (c < 0xb8) {
      start = i + 1; finish = start + (c - 0x80);
    } else if (c < 0xc0) {
      const n = c - 0xb7;
      start = i + 1 + n; finish = start + readLength(buf, i + 1, n);
    } else if (c < 0xf8) {
      start = i + 1; finish = start + (c - 0xc0);
    } else {
      const n = c - 0xf7;
      start = i + 1 + n; finish = start + readLength(buf, i + 1, n);
    }

    if (finish > end || finish < start) throw new Error('malformed RLP item');
    out.push([itemStart, start, finish]);
    i = finish;
  }

  if (i !== end) throw new Error('malformed RLP list');
  return out;
}

function readLength(buf, start, count) {
  if (count <= 0 || count > 6 || start + count > buf.length) throw new Error('invalid RLP length');
  let value = 0;
  for (let i = 0; i < count; i++) value = value * 256 + buf[start + i];
  return value;
}

function payloadSlice(buf, item) { return buf.subarray(item[1], item[2]); }

function readUint(buf, item) {
  const bytes = payloadSlice(buf, item);
  if (!bytes.length) return 0n;
  return BigInt('0x' + bytes.toString('hex'));
}
