import test from 'node:test';
import assert from 'assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DIAGNOSTIC_TOKEN, buildHubN1Status, writeHubN1Status } from '../native/hub-shadow-status.mjs';

test('hub snapshot stays unsigned and drops unknown fields', () => {
  const status = buildHubN1Status({
    now: 1_700_000_000_000,
    funnel: {
      blocks: 32,
      triggers: 10,
      affected: 3,
      multiVenue: 0,
      supportedLoops: 0,
      repayable: 0,
      evPositive: 0,
      n1: 0,
      candidate_rate: 0,
      repayable_rate: 0,
      closestNegativeBps: -5.6,
      misses: { 'no-supported-alternate': 3, secret: 9 },
      rpcUrl: 'https://secret.example',
    },
    lifecycle: {
      tokens: 2,
      venues0: 1,
      venues1: 1,
      venues2: 0,
      supported1: 1,
      supported2: 0,
      ownedOnly: 0,
      still_owned_only_rate: 0,
      graduate_rate_supported: 0.5,
      rows: [
        { token: DIAGNOSTIC_TOKEN, stage: 'supported-alternate', triggerCount: 2, lastTriggerBlock: 100, venueCount: 1, supportedVenueCount: 1, ownedVenueCount: 0, privateKey: 'nope' },
        { token: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', stage: 'venues-0', triggerCount: 1, lastTriggerBlock: 90, venueCount: 0, supportedVenueCount: 0, ownedVenueCount: 1 },
      ],
    },
    pools: { known: 16, withToken: 11, unresolved: 0, resolved_rate: 1 },
    transport: { lastBlock: 101, feed_blocks: 80, poll_blocks: 21, feed_ws_connects: 1 },
  });
  assert.equal(status.mode, 'shadow-n1');
  assert.equal(status.live, false);
  assert.equal(status.signing, false);
  assert.equal(status.broadcasting, false);
  assert.equal(status.funnel.n1, 0);
  assert.equal(status.funnel.misses['no-supported-alternate'], 3);
  assert.equal(status.funnel.misses.secret, undefined);
  assert.equal(status.lifecycle.diagnostic.token, DIAGNOSTIC_TOKEN);
  assert.equal(status.lifecycle.diagnostic.privateKey, undefined);
  assert.equal(status.lifecycle.recent.length, 2);
  const dir = mkdtempSync(join(tmpdir(), 'hub-n1-'));
  try {
    const path = writeHubN1Status(status, join(dir, 'n1-status.json'));
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(saved.live, false);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
    assert.equal(JSON.stringify(saved).includes('privateKey'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
