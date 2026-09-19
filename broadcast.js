// broadcast.js — sign once, broadcast identical raw bytes to multiple Robinhood RPC/sequencer paths.
import { keccak256 } from 'ethers';

function urlsFromEnv() {
  return (process.env.BROADCAST_RPC_URLS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

async function sendRaw(url, rawTx, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [rawTx] }),
      signal: ac.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    return { url, ok: true, result: j.result };
  } catch (e) {
    return { url, ok: false, error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

export async function signAndBroadcast(wallet, txRequest, {
  urls = urlsFromEnv(),
  timeoutMs = Number(process.env.BROADCAST_TIMEOUT_MS || 1200),
} = {}) {
  const populated = await wallet.populateTransaction(txRequest);
  const rawTx = await wallet.signTransaction(populated);
  const txHash = keccak256(rawTx);

  if (!urls.length) {
    const sent = await wallet.provider.broadcastTransaction(rawTx);
    return { txHash: sent.hash, rawTx, results: [{ url: 'wallet.provider', ok: true, result: sent.hash }] };
  }

  const results = await Promise.all(urls.map(url => sendRaw(url, rawTx, timeoutMs)));
  if (!results.some(x => x.ok)) {
    throw new Error('all broadcast paths failed: ' + results.map(x => x.error || 'unknown').join(' | '));
  }
  return { txHash, rawTx, results };
}
