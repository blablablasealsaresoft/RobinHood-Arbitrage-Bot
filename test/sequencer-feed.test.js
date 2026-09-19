import test from 'node:test';
import assert from 'node:assert/strict';
import { SequencerFeedClient } from '../sequencer-feed.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.handlers = new Map();
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    const list = this.handlers.get(type) || [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  emit(type, payload = {}) {
    for (const fn of this.handlers.get(type) || []) fn(payload);
  }
  close() {
    this.emit('close');
  }
}

test('sequencer feed parses Nitro broadcast envelopes and tracks sequence', async () => {
  FakeWebSocket.instances.length = 0;
  const batches = [];
  const statuses = [];
  let now = 1000;
  const client = new SequencerFeedClient({
    WebSocketImpl: FakeWebSocket,
    now: () => now,
    idleTimeoutMs: 60000,
    onBatch: (b) => batches.push(b),
    onStatus: (s) => statuses.push(s.type),
  });

  client.start();
  const ws = FakeWebSocket.instances[0];
  assert.ok(ws);
  ws.emit('open');
  now = 1015;
  ws.emit('message', { data: JSON.stringify({
    version: 1,
    messages: [
      { sequenceNumber: 41, message: { message: { header: { timestamp: 1 } } } },
      { sequenceNumber: 42, message: { message: { header: { timestamp: 1 } } } },
    ],
  }) });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batches.length, 1);
  assert.equal(batches[0].messageCount, 2);
  assert.equal(batches[0].lastSequenceNumber, '42');
  assert.equal(batches[0].receivedAt, 1015);
  assert.equal(batches[0].live, true);
  assert.equal(batches[0].messageAgeMs, 15);
  assert.equal(client.snapshot().frames, 1);
  assert.equal(client.snapshot().messages, 2);
  assert.equal(client.snapshot().lastSequenceNumber, '42');
  assert.deepEqual(statuses, ['connected']);

  client.stop();
});

test('sequencer feed records malformed frames without calling batch handler', async () => {
  FakeWebSocket.instances.length = 0;
  let batches = 0;
  const client = new SequencerFeedClient({
    WebSocketImpl: FakeWebSocket,
    idleTimeoutMs: 60000,
    onBatch: () => { batches++; },
  });

  client.start();
  const ws = FakeWebSocket.instances[0];
  ws.emit('open');
  ws.emit('message', { data: '{not-json' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(batches, 0);
  assert.equal(client.snapshot().parseErrors, 1);
  assert.match(client.snapshot().lastError, /JSON/);
  client.stop();
});
