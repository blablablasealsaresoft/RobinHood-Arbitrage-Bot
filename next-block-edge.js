// next-block-edge.js — helpers for the Robinhood sequencer-tail fast path.

import { toBeHex } from 'ethers';

export const FILTER_PRECOMPILE = '0x0000000000000000000000000000000000000074';
export const IS_FILTERED_SELECTOR = '0x85c733a4';
export const ZERO_HASH = '0x' + '00'.repeat(32);

export function transactionTouchesMarket(tx, { curve, poolManager, universalRouter, tokenAddresses = [], poolIds = [] }) {
  if (!tx?.to) return false;
  const to = tx.to.toLowerCase();
  const data = String(tx.dataHex || '').toLowerCase().replace(/^0x/, '');
  if (to === String(curve).toLowerCase()) {
    return tokenAddresses.some((token) => data.includes(String(token).toLowerCase().replace(/^0x/, '')));
  }
  if (to !== String(poolManager).toLowerCase() && to !== String(universalRouter).toLowerCase()) return false;

  if (!data) return false;
  for (const token of tokenAddresses) {
    const needle = String(token).toLowerCase().replace(/^0x/, '');
    if (needle && data.includes(needle)) return true;
  }
  for (const id of poolIds) {
    const needle = String(id).toLowerCase().replace(/^0x/, '');
    if (needle && data.includes(needle)) return true;
  }
  return false;
}

export async function isTransactionFiltered(provider, txHash, blockTag = 'latest') {
  if (!txHash || txHash === ZERO_HASH) return false;
  const clean = String(txHash).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) throw new Error('invalid trigger tx hash');
  const data = IS_FILTERED_SELECTOR + clean;
  const result = await provider.send('eth_call', [{ to: FILTER_PRECOMPILE, data }, blockTag]);
  return BigInt(result || '0x0') !== 0n;
}

export async function waitForAnchor(provider, anchorBlock, anchorHash, {
  timeoutMs = 100,
  pollMs = 5,
  now = Date.now,
} = {}) {
  const deadline = now() + timeoutMs;
  const tag = toBeHex(BigInt(anchorBlock));
  do {
    const block = await provider.send('eth_getBlockByNumber', [tag, false]).catch(() => null);
    if (block?.hash && String(block.hash).toLowerCase() === String(anchorHash).toLowerCase()) return block;
    if (now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
  return null;
}

export async function callAtBlock(provider, to, data, blockNumber) {
  return provider.send('eth_call', [{ to, data }, toBeHex(BigInt(blockNumber))]);
}

export async function broadcastRawTransaction(rawTransaction, urls, { timeoutMs = 1500 } = {}) {
  const unique = [...new Set((urls || []).map((x) => String(x).trim()).filter(Boolean))];
  if (!unique.length) throw new Error('no transaction submission URLs configured');
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [rawTransaction],
  });

  const attempts = await Promise.all(unique.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    const started = performance.now();
    try {
      const response = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: controller.signal,
      });
      const json = await response.json().catch(() => ({}));
      return {
        url, ok: Boolean(response.ok && json?.result), result: json?.result || null,
        error: json?.error?.message || (!response.ok ? `HTTP ${response.status}` : null),
        ms: performance.now() - started,
      };
    } catch (error) {
      return { url, ok: false, result: null, error: error?.message || String(error), ms: performance.now() - started };
    } finally {
      clearTimeout(timer);
    }
  }));

  return { accepted: attempts.some((x) => x.ok), attempts };
}
