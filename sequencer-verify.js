// sequencer-verify.js — verify Robinhood Chain Nitro feed signatureV2 envelopes.
//
// Robinhood's sequencer signs each BroadcastFeedMessage. The preimage matches
// Nitro broadcaster/message.SignatureHash. Verification is local and cheap and
// should be enabled on the execution-grade feed, including when a local relay is
// used (the stock relay forwards signatures but does not verify them itself).

import { getAddress, hexlify, keccak256, recoverAddress } from 'ethers';

export const FEED_CHAIN_ID = 4663n;
export const MAINNET_FEED_SIGNER = getAddress('0xDaa526086787d9DEbE1D7F3FFdb1fE50cf8687F4');
const FEED_PREFIX = Buffer.from('Arbitrum Nitro Feed:', 'utf8');

function u64be(value) {
  let x = BigInt(value ?? 0);
  if (x < 0n || x > 0xffffffffffffffffn) throw new Error('feed u64 out of range');
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(x);
  return b;
}

function minimalBigEndian(value) {
  let x = BigInt(value ?? 0);
  if (x === 0n) return Buffer.alloc(0);
  let hex = x.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

function hexBytes(value, expectedLength = null) {
  if (value == null) return Buffer.alloc(0);
  const s = String(value).replace(/^0x/, '');
  if (s.length % 2 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('invalid feed hex');
  const out = Buffer.from(s, 'hex');
  if (expectedLength != null && out.length !== expectedLength) {
    throw new Error(`invalid feed hex length ${out.length}, expected ${expectedLength}`);
  }
  return out;
}

export function signaturePayload(entry, chainId = FEED_CHAIN_ID) {
  const wrapper = entry?.message || {};
  const incoming = wrapper?.message || {};
  const header = incoming?.header || {};
  const chunks = [FEED_PREFIX, u64be(chainId), u64be(entry?.sequenceNumber ?? 0)];

  if (entry?.blockHash) chunks.push(hexBytes(entry.blockHash, 32));
  if (entry?.blockMetadata) chunks.push(Buffer.from(entry.blockMetadata, 'base64'));

  chunks.push(u64be(wrapper?.delayedMessagesRead ?? 0));
  chunks.push(Buffer.from([Number(header?.kind ?? 0) & 0xff]));
  chunks.push(hexBytes(header?.sender || '0x'));
  chunks.push(u64be(header?.blockNumber ?? 0));
  chunks.push(u64be(header?.timestamp ?? 0));

  if (header?.requestId != null) chunks.push(hexBytes(header.requestId));
  if (header?.baseFeeL1 != null) chunks.push(minimalBigEndian(header.baseFeeL1));
  if (incoming?.l2Msg) chunks.push(Buffer.from(incoming.l2Msg, 'base64'));

  return Buffer.concat(chunks);
}

export function recoverFeedSigner(entry, chainId = FEED_CHAIN_ID) {
  const encoded = entry?.signatureV2;
  if (!encoded) return null;
  let sig;
  try { sig = Buffer.from(encoded, 'base64'); } catch { return null; }
  if (sig.length !== 65) return null;

  const v = sig[64];
  if (v <= 1) sig[64] = v + 27;
  else if (v === 27 || v === 28) { /* already normalized */ }
  else return null;

  try {
    const digest = keccak256(signaturePayload(entry, chainId));
    return getAddress(recoverAddress(digest, hexlify(sig)));
  } catch {
    return null;
  }
}

export function verifyFeedEntry(
  entry,
  { chainId = FEED_CHAIN_ID, allowedSigners = [MAINNET_FEED_SIGNER] } = {},
) {
  const signer = recoverFeedSigner(entry, chainId);
  if (!signer) return { ok: false, signer: null };
  const allowed = new Set(allowedSigners.map((x) => getAddress(x).toLowerCase()));
  return { ok: allowed.has(signer.toLowerCase()), signer };
}
