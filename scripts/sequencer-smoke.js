import { SequencerFeedClient } from '../sequencer-feed.js';

const durationMs = Math.max(1000, Number(process.env.SEQUENCER_SMOKE_MS || 10000));
let firstAt = null;
let lastAt = null;
let frames = 0;
let messages = 0;

const client = new SequencerFeedClient({
  onBatch: (batch) => {
    firstAt ??= batch.receivedAt;
    lastAt = batch.receivedAt;
    frames++;
    messages += batch.messageCount;
    if (frames <= 5) {
      console.log(JSON.stringify({
        feed: 'batch',
        sequenceNumber: batch.lastSequenceNumber,
        messageCount: batch.messageCount,
        frameBytes: batch.frameBytes,
        receivedAt: batch.receivedAt,
      }));
    }
  },
  onStatus: (status) => {
    console.log(JSON.stringify({
      feed: status.type,
      at: status.at,
      error: status.error || null,
    }));
  },
});

client.start();

setTimeout(() => {
  client.stop();
  const elapsedMs = firstAt && lastAt ? Math.max(1, lastAt - firstAt) : durationMs;
  console.log(JSON.stringify({
    feed: 'summary',
    durationMs,
    frames,
    messages,
    framesPerSecond: Number((frames * 1000 / elapsedMs).toFixed(2)),
    messagesPerSecond: Number((messages * 1000 / elapsedMs).toFixed(2)),
    stats: client.snapshot(),
  }, null, 2));
  process.exit(frames > 0 ? 0 : 1);
}, durationMs).unref?.();
