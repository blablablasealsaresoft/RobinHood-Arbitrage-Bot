// deploy-sequencer.js — deploy SequencerFlashArbExecutorV3 + WETH adapters.
// Deployment only. It does NOT enable relayers, adapters, pools or borrow caps.
//
// Required:
//   PRIVATE_KEY=deployment wallet
//   SAFE_OWNER=Safe/multisig owner of all deployed contracts
//   STRATEGY_SIGNER=hot EIP-712 strategy-signing key
//   TREASURY=profit receiver
//
// Optional:
//   EXEC_RPC_URL / RPC_URL
//   MAX_BLOCK_WINDOW=2

import 'dotenv/config';
import fs from 'node:fs';
import { ContractFactory, JsonRpcProvider, Network, Wallet, getAddress } from 'ethers';
import { CURVE, V4 } from './config.js';

const CHAIN_ID = 4663;
const MORPHO_BLUE = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
}

function artifact(name) {
  return JSON.parse(fs.readFileSync(new URL(`./build/${name}.json`, import.meta.url)));
}

async function deploy(factory, args, label) {
  console.log('deploying', label, '...');
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(label, address);
  return address;
}

async function main() {
  const privateKey = required('PRIVATE_KEY');
  const safeOwner = getAddress(required('SAFE_OWNER'));
  const strategySigner = getAddress(required('STRATEGY_SIGNER'));
  const treasury = getAddress(required('TREASURY'));
  const maxBlockWindow = Number(process.env.MAX_BLOCK_WINDOW || '2');
  if (!Number.isInteger(maxBlockWindow) || maxBlockWindow < 1 || maxBlockWindow > 64) {
    throw new Error('MAX_BLOCK_WINDOW must be 1..64');
  }

  const rpcUrl = process.env.EXEC_RPC_URL || process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const network = new Network('robinhood', CHAIN_ID);
  const provider = new JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
  const wallet = new Wallet(privateKey, provider);
  const chain = await provider.send('eth_chainId', []);
  if (Number(BigInt(chain)) !== CHAIN_ID) throw new Error(`wrong chain ${chain}`);

  for (const [label, address] of [
    ['Morpho Blue', MORPHO_BLUE],
    ['WETH', WETH],
    ['RobinFun curve', CURVE.address],
    ['Universal Router', V4.universalRouter],
    ['Permit2', V4.permit2],
  ]) {
    const code = await provider.getCode(address);
    if (code === '0x') throw new Error(`${label} has no code at ${address}`);
  }

  console.log('deployer', wallet.address);
  console.log('owner', safeOwner);
  console.log('strategy signer', strategySigner);
  console.log('treasury', treasury);

  const executorArtifact = artifact('SequencerFlashArbExecutorV3');
  const curveArtifact = artifact('RobinFunWethAdapter');
  const v4Artifact = artifact('UniswapV4WethAdapter');

  const executor = await deploy(
    new ContractFactory(executorArtifact.abi, executorArtifact.bytecode, wallet),
    [safeOwner, strategySigner, treasury, MORPHO_BLUE, maxBlockWindow],
    'SequencerFlashArbExecutorV3',
  );

  const curveAdapter = await deploy(
    new ContractFactory(curveArtifact.abi, curveArtifact.bytecode, wallet),
    [safeOwner, CURVE.address, WETH],
    'RobinFunWethAdapter',
  );

  const v4Adapter = await deploy(
    new ContractFactory(v4Artifact.abi, v4Artifact.bytecode, wallet),
    [safeOwner, WETH, V4.permit2, V4.universalRouter],
    'UniswapV4WethAdapter',
  );

  console.log('\nDEPLOYED — FAIL-CLOSED');
  console.log('No relayer is enabled.');
  console.log('No executor adapter is enabled.');
  console.log('No settlement-token borrow cap is enabled.');
  console.log('No curve token or V4 pool is enabled.');
  console.log('\nAdd these to your private deployment notes:');
  console.log(`SEQUENCER_EXECUTOR_ADDR=${executor}`);
  console.log(`ROBIN_FUN_WETH_ADAPTER=${curveAdapter}`);
  console.log(`UNISWAP_V4_WETH_ADAPTER=${v4Adapter}`);
  console.log(`MORPHO_BLUE=${MORPHO_BLUE}`);
  console.log(`WETH=${WETH}`);
  console.log('\nNext step is Safe-admin configuration + fork validation, not LIVE mode.');
}

main().catch((error) => {
  console.error('FATAL', error?.shortMessage || error?.message || error);
  process.exit(1);
});
