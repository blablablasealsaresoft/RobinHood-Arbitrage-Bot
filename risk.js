import { formatEther, parseEther } from 'ethers';

export const BPS = 10_000n;

export function bpsDown(value, bps) {
  if (bps < 0n || bps >= BPS) throw new Error('slippage bps must be between 0 and 9999');
  return value - (value * bps) / BPS;
}

export function envInteger(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name] ?? String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

export function buildGrid(minSize, maxSize, points) {
  if (minSize <= 0n || maxSize < minSize) throw new Error('invalid trade-size range');
  if (!Number.isInteger(points) || points < 1 || points > 32) throw new Error('GRID_POINTS must be 1..32');
  if (points === 1) return [minSize];
  const lo = Number(formatEther(minSize));
  const hi = Number(formatEther(maxSize));
  const values = [];
  for (let i = 0; i < points; i++) {
    values.push(parseEther((lo * Math.pow(hi / lo, i / (points - 1))).toFixed(12)));
  }
  values[0] = minSize;
  values[values.length - 1] = maxSize;
  return [...new Set(values.map(String))].map(BigInt);
}

export function feeOverrides(feeData, gasLimit, bufferBps = 12_000n) {
  if (gasLimit <= 0n) throw new Error('GAS_UNITS must be positive');
  const bump = (x) => (x * bufferBps + BPS - 1n) / BPS;
  if (feeData.maxFeePerGas != null) {
    const maxFeePerGas = bump(feeData.maxFeePerGas);
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas == null
      ? undefined : bump(feeData.maxPriorityFeePerGas);
    return {
      maxGasCost: gasLimit * maxFeePerGas,
      overrides: { gasLimit, maxFeePerGas, ...(maxPriorityFeePerGas == null ? {} : { maxPriorityFeePerGas }) },
    };
  }
  const gasPrice = bump(feeData.gasPrice ?? 100_000_000n);
  return { maxGasCost: gasLimit * gasPrice, overrides: { gasLimit, gasPrice } };
}

export function serialRunner(run, onError = () => {}) {
  let active = false;
  let queued = false;
  let queuedReason = 'queued';
  const trigger = async (reason = 'poll') => {
    if (active) {
      queued = true;
      queuedReason = reason;
      return false;
    }
    active = true;
    try {
      await run(reason);
    } finally {
      active = false;
      if (queued) {
        const next = queuedReason;
        queued = false;
        queueMicrotask(() => trigger(next).catch(onError));
      }
    }
    return true;
  };
  return trigger;
}
