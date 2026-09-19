import test from 'node:test';
import assert from 'node:assert/strict';
import { Wallet, verifyTypedData } from 'ethers';
import {
  FLASH_INTENT_TYPES,
  buildFlashIntent,
  genericStateCheck,
  hashLegs,
  hashStateChecks,
  signFlashIntent,
} from '../flash-intent.js';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

test('flash intent hashes route/state and recovers EIP-712 strategy signer', async () => {
  const wallet = new Wallet(PK);
  const executor = '0x1111111111111111111111111111111111111111';
  const legs = [
    {
      adapter: '0x2222222222222222222222222222222222222222',
      tokenIn: '0x3333333333333333333333333333333333333333',
      tokenOut: '0x4444444444444444444444444444444444444444',
      minOut: 123n,
      data: '0x1234',
    },
    {
      adapter: '0x5555555555555555555555555555555555555555',
      tokenIn: '0x4444444444444444444444444444444444444444',
      tokenOut: '0x3333333333333333333333333333333333333333',
      minOut: 120n,
      data: '0xabcd',
    },
  ];
  const checks = [
    genericStateCheck(
      '0x6666666666666666666666666666666666666666',
      '0x01020304',
      '0x' + '11'.repeat(32),
    ),
  ];

  const intent = buildFlashIntent({
    settlementToken: legs[0].tokenIn,
    borrowAmount: 100n,
    minProfit: 5n,
    maxGasPrice: 1_000_000_000n,
    anchorBlock: 999n,
    anchorBlockHash: '0x' + '66'.repeat(32),
    validAfterBlock: 1000n,
    validUntilBlock: 1001n,
    deadline: 2_000_000_000n,
    nonce: 7n,
    triggerTxHash: '0x' + '77'.repeat(32),
    legs,
    stateChecks: checks,
  });

  assert.equal(intent.routeHash, hashLegs(legs));
  assert.equal(intent.stateChecksHash, hashStateChecks(checks));

  const signature = await signFlashIntent({
    privateKey: PK,
    executor,
    intent,
  });

  const recovered = verifyTypedData(
    {
      name: 'SequencerFlashArbExecutorV4',
      version: '1',
      chainId: 4663,
      verifyingContract: executor,
    },
    FLASH_INTENT_TYPES,
    intent,
    signature,
  );
  assert.equal(recovered, wallet.address);

  const reordered = [...legs].reverse();
  assert.notEqual(hashLegs(reordered), intent.routeHash);
});
