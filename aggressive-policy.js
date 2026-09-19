// aggressive-policy.js — low-threshold but bounded-risk execution gate.
// Fires on any positive expected surplus by default, while still requiring the
// quote to cover the bot's explicit worst-case gas estimate.
import { parseEther } from 'ethers';

function parseNonNegativeWei(name, fallback='0') {
  const raw = process.env[name] ?? fallback;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new Error(`${name} must be a non-negative ETH amount`);
  return parseEther(raw);
}

export function aggressiveGate({ size, netAfterGas }) {
  const minNet = parseNonNegativeWei('MIN_NET_ETH', '0');
  const minBps = BigInt(process.env.MIN_PROFIT_BPS || '0');
  if (minBps < 0n || minBps > 10_000n) throw new Error('MIN_PROFIT_BPS must be 0..10000');
  const bpsFloor = (size * minBps) / 10_000n;
  const required = bpsFloor > minNet ? bpsFloor : minNet;
  return { pass: netAfterGas > 0n && netAfterGas >= required, required };
}
