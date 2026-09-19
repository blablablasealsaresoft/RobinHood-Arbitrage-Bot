import test from 'node:test';
import assert from 'node:assert/strict';
import { aggressiveGate } from '../aggressive-policy.js';

test('aggressive gate accepts positive bounded net at zero threshold', () => {
  const oldNet = process.env.MIN_NET_ETH;
  const oldBps = process.env.MIN_PROFIT_BPS;
  process.env.MIN_NET_ETH = '0';
  process.env.MIN_PROFIT_BPS = '0';
  try {
    assert.equal(aggressiveGate({ size: 1_000_000n, netAfterGas: 1n }).pass, true);
    assert.equal(aggressiveGate({ size: 1_000_000n, netAfterGas: 0n }).pass, false);
    assert.equal(aggressiveGate({ size: 1_000_000n, netAfterGas: -1n }).pass, false);
  } finally {
    if (oldNet == null) delete process.env.MIN_NET_ETH; else process.env.MIN_NET_ETH = oldNet;
    if (oldBps == null) delete process.env.MIN_PROFIT_BPS; else process.env.MIN_PROFIT_BPS = oldBps;
  }
});

test('aggressive gate honors bps floor', () => {
  const oldNet = process.env.MIN_NET_ETH;
  const oldBps = process.env.MIN_PROFIT_BPS;
  process.env.MIN_NET_ETH = '0';
  process.env.MIN_PROFIT_BPS = '10';
  try {
    const g = aggressiveGate({ size: 1_000_000n, netAfterGas: 999n });
    assert.equal(g.pass, false);
    assert.equal(g.required, 1000n);
  } finally {
    if (oldNet == null) delete process.env.MIN_NET_ETH; else process.env.MIN_NET_ETH = oldNet;
    if (oldBps == null) delete process.env.MIN_PROFIT_BPS; else process.env.MIN_PROFIT_BPS = oldBps;
  }
});
