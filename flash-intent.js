import crypto from 'node:crypto';
import {
  AbiCoder,
  Wallet,
  concat,
  getAddress,
  keccak256,
  toUtf8Bytes,
} from 'ethers';

const coder = AbiCoder.defaultAbiCoder();
const LEG_TYPEHASH = keccak256(toUtf8Bytes(
  'Leg(address adapter,address tokenIn,address tokenOut,uint256 minOut,bytes32 dataHash)'
));
const STATE_CHECK_TYPEHASH = keccak256(toUtf8Bytes(
  'StateCheck(uint8 mode,address target,bytes32 callDataHash,bytes32 expectedReturnHash)'
));

export const FLASH_INTENT_TYPES = {
  FlashIntent: [
    { name: 'settlementToken', type: 'address' },
    { name: 'borrowAmount', type: 'uint256' },
    { name: 'minProfit', type: 'uint256' },
    { name: 'maxGasPrice', type: 'uint256' },
    { name: 'anchorBlock', type: 'uint64' },
    { name: 'anchorBlockHash', type: 'bytes32' },
    { name: 'validAfterBlock', type: 'uint64' },
    { name: 'validUntilBlock', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
    { name: 'triggerTxHash', type: 'bytes32' },
    { name: 'routeHash', type: 'bytes32' },
    { name: 'stateChecksHash', type: 'bytes32' },
  ],
};

export function hashLegs(legs) {
  const hashes = legs.map((leg) => keccak256(coder.encode(
    ['bytes32','address','address','address','uint256','bytes32'],
    [
      LEG_TYPEHASH,
      getAddress(leg.adapter),
      getAddress(leg.tokenIn),
      getAddress(leg.tokenOut),
      BigInt(leg.minOut),
      keccak256(leg.data || '0x'),
    ],
  )));
  return keccak256(hashes.length ? concat(hashes) : '0x');
}

export function hashStateChecks(checks) {
  const hashes = checks.map((check) => keccak256(coder.encode(
    ['bytes32','uint8','address','bytes32','bytes32'],
    [
      STATE_CHECK_TYPEHASH,
      Number(check.mode),
      getAddress(check.target),
      keccak256(check.callData || '0x'),
      check.expectedReturnHash,
    ],
  )));
  return keccak256(hashes.length ? concat(hashes) : '0x');
}

export function genericStateCheck(target, callData, returnData) {
  return {
    mode: 0,
    target: getAddress(target),
    callData,
    expectedReturnHash: keccak256(returnData),
  };
}

export function v2ReserveStateCheck(pair, reserve0, reserve1) {
  return {
    mode: 1,
    target: getAddress(pair),
    callData: '0x0902f1ac',
    expectedReturnHash: keccak256(coder.encode(
      ['uint112','uint112'],
      [BigInt(reserve0), BigInt(reserve1)],
    )),
  };
}

export function randomNonce192() {
  return BigInt('0x' + crypto.randomBytes(24).toString('hex'));
}

export function buildFlashIntent({
  settlementToken,
  borrowAmount,
  minProfit,
  maxGasPrice,
  anchorBlock,
  anchorBlockHash,
  validAfterBlock,
  validUntilBlock,
  deadline,
  nonce,
  triggerTxHash,
  legs,
  stateChecks,
}) {
  return {
    settlementToken: getAddress(settlementToken),
    borrowAmount: BigInt(borrowAmount),
    minProfit: BigInt(minProfit),
    maxGasPrice: BigInt(maxGasPrice),
    anchorBlock: BigInt(anchorBlock),
    anchorBlockHash,
    validAfterBlock: BigInt(validAfterBlock),
    validUntilBlock: BigInt(validUntilBlock),
    deadline: BigInt(deadline),
    nonce: BigInt(nonce),
    triggerTxHash,
    routeHash: hashLegs(legs),
    stateChecksHash: hashStateChecks(stateChecks),
  };
}

export function intentDomain(executor, chainId = 4663) {
  return {
    name: 'SequencerFlashArbExecutorV4',
    version: '1',
    chainId,
    verifyingContract: getAddress(executor),
  };
}

export async function signFlashIntent({
  privateKey,
  executor,
  chainId = 4663,
  intent,
}) {
  const wallet = new Wallet(privateKey);
  return wallet.signTypedData(intentDomain(executor, chainId), FLASH_INTENT_TYPES, intent);
}
