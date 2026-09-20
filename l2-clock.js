import { Contract, ZeroHash } from 'ethers';
import { ARBSYS } from './deployments.js';

export const ARBSYS_ABI = [
  'function arbBlockNumber() view returns (uint256)',
  'function arbBlockHash(uint256 arbBlockNum) view returns (bytes32)',
  'function arbOSVersion() view returns (uint256)',
];

export const FLASH_EXECUTOR_ABI = [
  'function executeFlashArb((address settlementToken,uint256 borrowAmount,uint256 minProfit,uint256 maxGasPrice,uint64 anchorBlock,bytes32 anchorBlockHash,uint64 validAfterBlock,uint64 validUntilBlock,uint64 deadline,uint256 nonce,bytes32 triggerTxHash,bytes32 routeHash,bytes32 stateChecksHash) intent,(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes data)[] legs,(uint8 mode,address target,bytes callData,bytes32 expectedReturnHash)[] checks,bytes signature)',
  'function owner() view returns (address)',
  'function strategySigner() view returns (address)',
  'function treasury() view returns (address)',
  'function morpho() view returns (address)',
  'function relayers(address) view returns (bool)',
  'function adapters(address) view returns (bool)',
  'function borrowCaps(address) view returns (uint256)',
  'function paused() view returns (bool)',
  'function maxBlockWindow() view returns (uint64)',
  'function maxAnchorDelay() view returns (uint64)',
];

export function arbSysContract(provider) {
  return new Contract(ARBSYS, ARBSYS_ABI, provider);
}

export function nextBlockValidity(anchorBlock) {
  const after = BigInt(anchorBlock) + 1n;
  return { validAfterBlock: after, validUntilBlock: after };
}

export async function readL2Number(provider) {
  return arbSysContract(provider).arbBlockNumber();
}

export async function confirmAnchorHash(provider, anchorBlock, expectedHash, {
  timeoutMs = 400,
  pollMs = 20,
  now = Date.now,
} = {}) {
  if (!expectedHash || expectedHash === ZeroHash) throw new Error('missing sequencer anchor hash');
  const clock = arbSysContract(provider);
  const deadline = now() + timeoutMs;
  const want = String(expectedHash).toLowerCase();
  do {
    const hash = await clock.arbBlockHash(anchorBlock);
    if (hash && hash !== ZeroHash && hash.toLowerCase() === want) return hash;
    if (now() >= deadline) {
      throw new Error(`ArbSys hash mismatch for L2 ${anchorBlock}: have ${hash} want ${expectedHash}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  } while (true);
}
