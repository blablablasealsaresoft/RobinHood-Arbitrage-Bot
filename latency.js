import fs from 'node:fs';
import path from 'node:path';

export function createLatencyRecorder(file = process.env.LATENCY_LOG || './logs/sequencer-latency.jsonl') {
  let enabled = true;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); }
  catch { enabled = false; }

  return {
    record(event, data = {}) {
      if (!enabled) return;
      try {
        fs.appendFileSync(file, JSON.stringify({ at: Date.now(), event, ...data }) + '\n');
      } catch {
        enabled = false;
      }
    },
    file,
    get enabled() { return enabled; },
  };
}
