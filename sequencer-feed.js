// sequencer-feed.js — low-latency Robinhood Chain Nitro sequencer feed client.
//
// The Nitro feed publishes JSON BroadcastMessage envelopes over WebSocket.
// This client intentionally treats the feed as an ordering/pulse source only:
// execution state still comes from the configured fast RPC/full node. That keeps
// parsing independent from Nitro's internal L2-message encoding while still
// allowing the arb engine to react immediately to newly sequenced work.

import WebSocket from 'ws';
import { decodeFeedTransactions } from './sequencer-codec.js';

const DEFAULT_URL = 'wss://feed.mainnet.chain.robinhood.com';

export class SequencerFeedClient {
  constructor({
    url = process.env.SEQUENCER_FEED_URL || DEFAULT_URL,
    onBatch = () => {},
    onStatus = () => {},
    WebSocketImpl = WebSocket,
    reconnectMinMs = 500,
    reconnectMaxMs = 15000,
    idleTimeoutMs = 30000,
    maxLiveAgeMs = 5000,
    decodeTransactions = true,
    now = Date.now,
  } = {}) {
    this.url = url;
    this.onBatch = onBatch;
    this.onStatus = onStatus;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.idleTimeoutMs = idleTimeoutMs;
    this.maxLiveAgeMs = maxLiveAgeMs;
    this.decodeTransactions = decodeTransactions;
    this.now = now;

    this.ws = null;
    this.stopped = true;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.idleTimer = null;
    this.stats = {
      connected: false,
      connects: 0,
      reconnects: 0,
      frames: 0,
      messages: 0,
      parseErrors: 0,
      lastFrameAt: null,
      lastSequenceNumber: null,
      lastError: null,
    };
  }

  start() {
    if (!this.WebSocketImpl) {
      throw new Error('Sequencer feed requires a WebSocket-capable Node runtime (Node 22+ recommended).');
    }
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.idleTimer);
    this.reconnectTimer = null;
    this.idleTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(); } catch {}
    }
    this.stats.connected = false;
  }

  snapshot() {
    return { ...this.stats };
  }

  #connect() {
    if (this.stopped) return;
    let ws;
    try {
      const headers = { 'Arbitrum-Feed-Client-Version': '2' };
      if (this.stats.lastSequenceNumber !== null) {
        headers['Arbitrum-Requested-Sequence-Number'] = String(this.stats.lastSequenceNumber);
      }
      ws = new this.WebSocketImpl(this.url, {
        perMessageDeflate: true,
        headers,
        maxPayload: 16 * 1024 * 1024,
      });
    } catch (error) {
      this.#fail(error);
      this.#scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener('open', () => {
      if (this.ws !== ws || this.stopped) return;
      this.stats.connected = true;
      this.stats.connects++;
      if (this.reconnectAttempt > 0) this.stats.reconnects++;
      this.reconnectAttempt = 0;
      this.stats.lastError = null;
      this.onStatus({ type: 'connected', at: this.now(), stats: this.snapshot() });
      this.#armIdle(ws);
    });

    ws.addEventListener('message', (event) => {
      if (this.ws !== ws || this.stopped) return;
      this.#armIdle(ws);
      void this.#handleFrame(event.data).catch((error) => {
        this.stats.parseErrors++;
        this.#fail(error);
      });
    });

    ws.addEventListener('error', () => {
      if (this.ws !== ws || this.stopped) return;
      this.#fail(new Error('sequencer feed websocket error'));
    });

    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stats.connected = false;
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
      this.onStatus({ type: 'disconnected', at: this.now(), stats: this.snapshot() });
      if (!this.stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const exp = Math.min(this.reconnectAttempt++, 8);
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** exp));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #armIdle(ws) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.ws !== ws || this.stopped) return;
      this.#fail(new Error('sequencer feed idle timeout'));
      try { ws.close(); } catch {}
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  #fail(error) {
    const message = error instanceof Error ? error.message : String(error);
    this.stats.lastError = message;
    this.onStatus({ type: 'error', at: this.now(), error: message, stats: this.snapshot() });
  }

  async #handleFrame(data) {
    const text = await frameToText(data);
    const parsed = JSON.parse(text);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const receivedAt = this.now();
    const sequenceNumbers = messages
      .map((m) => m?.sequenceNumber)
      .filter((v) => v !== undefined && v !== null);
    const lastSequenceNumber = sequenceNumbers.length
      ? String(sequenceNumbers[sequenceNumbers.length - 1])
      : null;
    const timestamps = messages
      .map((m) => Number(m?.message?.message?.header?.timestamp || 0))
      .filter((v) => Number.isFinite(v) && v > 0);
    const latestTimestamp = timestamps.length ? Math.max(...timestamps) : 0;
    const messageAgeMs = latestTimestamp ? receivedAt - latestTimestamp * 1000 : null;
    const live = messageAgeMs !== null && messageAgeMs <= this.maxLiveAgeMs;
    const transactions = this.decodeTransactions && live ? decodeFeedTransactions(parsed) : [];

    this.stats.frames++;
    this.stats.messages += messages.length;
    this.stats.lastFrameAt = receivedAt;
    if (lastSequenceNumber !== null) this.stats.lastSequenceNumber = lastSequenceNumber;

    this.onBatch({
      receivedAt,
      version: parsed?.version ?? null,
      messageCount: messages.length,
      lastSequenceNumber,
      frameBytes: Buffer.byteLength(text),
      latestTimestamp,
      messageAgeMs,
      live,
      transactions,
    });
  }
}

async function frameToText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof data.text === 'function') return await data.text();
  return String(data);
}
