// broadcast.js — sign once, broadcast identical raw bytes to multiple Robinhood paths.
import { keccak256 } from 'ethers';

function urlsFromEnv() {
  return (process.env.BROADCAST_RPC_URLS || '')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean);
}

async function sendRaw(url, rawTx, timeoutMs) {
  const started = process.hrtime.bigint();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', connection: 'keep-alive' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_sendRawTransaction',
        params: [rawTx],
      }),
      signal: ac.signal,
    });
    const body = await response.json();
    if (body.error) throw new Error(body.error.message || JSON.stringify(body.error));
    return {
      url,
      ok: true,
      result: body.result,
      latencyUs: Number((process.hrtime.bigint() - started) / 1000n),
    };
  } catch (error) {
    return {
      url,
      ok: false,
      error: error?.message || String(error),
      latencyUs: Number((process.hrtime.bigint() - started) / 1000n),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function signAndBroadcast(wallet, txRequest, {
  urls = urlsFromEnv(),
  timeoutMs = Number(process.env.BROADCAST_TIMEOUT_MS || 1200),
  populate = true,
} = {}) {
  const populated = populate ? await wallet.populateTransaction(txRequest) : txRequest;
  const rawTx = await wallet.signTransaction(populated);
  const txHash = keccak256(rawTx);

  if (!urls.length) {
    const sent = await wallet.provider.broadcastTransaction(rawTx);
    return {
      txHash: sent.hash,
      rawTx,
      results: [{ url: 'wallet.provider', ok: true, result: sent.hash, latencyUs: null }],
    };
  }

  const results = await Promise.all(urls.map(url => sendRaw(url, rawTx, timeoutMs)));
  if (!results.some(x => x.ok)) {
    throw new Error('all broadcast paths failed: ' + results.map(x => x.error || 'unknown').join(' | '));
  }
  return { txHash, rawTx, results };
}
