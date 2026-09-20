// deploy-sequencer.js — deploy the V4 next-block flash-arb stack fail-closed.
// Deploys the same five contracts as the live 2026-09-20 stack:
//   SequencerFlashArbExecutorV4, RobinFunWethAdapter, UniswapV4WethAdapter,
//   SequencerRouteQuoter, V4TickStateLens.
// Deployment does NOT enable relayers, adapters, tokens, pools, or borrow caps.
import 'dotenv/config';
import fs from 'node:fs';
import { ContractFactory, JsonRpcProvider, Network, Wallet, getAddress } from 'ethers';
import { CURVE, V4 } from './config.js';
import { DEPLOYMENTS, MORPHO_BLUE, WETH } from './deployments.js';

const CHAIN_ID = 4663;

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return getAddress(value);
};
const artifact = (name) =>
  JSON.parse(fs.readFileSync(new URL(`./build/${name}.json`, import.meta.url)));

async function deploy(factory, args, name) {
  console.log('deploying', name);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  console.log(name, address);
  return address;
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required');
  const rpc = process.env.EXEC_RPC_URL || process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
  const network = new Network('robinhood', CHAIN_ID);
  const provider = new JsonRpcProvider(rpc, network, { staticNetwork: network });
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

  const owner = required('SAFE_OWNER');
  const signer = process.env.STRATEGY_PRIVATE_KEY
    ? new Wallet(process.env.STRATEGY_PRIVATE_KEY).address
    : required('STRATEGY_SIGNER');
  const treasury = required(process.env.TREASURY_ADDR ? 'TREASURY_ADDR' : 'TREASURY');
  const morpho = getAddress(process.env.MORPHO_ADDR || MORPHO_BLUE);
  const weth = getAddress(process.env.WETH_ADDR || WETH);

  for (const [label, address] of [
    ['Morpho', morpho],
    ['RobinFun curve', CURVE.address],
    ['WETH', weth],
    ['V4 router', V4.universalRouter],
    ['Permit2', V4.permit2],
    ['V4 quoter', V4.quoter],
    ['V4 poolManager', V4.poolManager],
  ]) {
    if (await provider.getCode(address) === '0x') throw new Error(`${label} has no code at ${address}`);
  }

  console.log('deployer', wallet.address);
  console.log('owner', owner);
  console.log('strategy signer', signer);
  console.log('treasury', treasury);
  console.log('existing live stack is documented in deployments.js; this run creates a NEW fail-closed copy');

  const executor = await deploy(
    new ContractFactory(artifact('SequencerFlashArbExecutorV4').abi, artifact('SequencerFlashArbExecutorV4').bytecode, wallet),
    [owner, signer, treasury, morpho, 1, 1],
    'SequencerFlashArbExecutorV4',
  );
  const curveAdapter = await deploy(
    new ContractFactory(artifact('RobinFunWethAdapter').abi, artifact('RobinFunWethAdapter').bytecode, wallet),
    [owner, CURVE.address, weth],
    'RobinFunWethAdapter',
  );
  const v4Adapter = await deploy(
    new ContractFactory(artifact('UniswapV4WethAdapter').abi, artifact('UniswapV4WethAdapter').bytecode, wallet),
    [owner, weth, V4.permit2, V4.universalRouter],
    'UniswapV4WethAdapter',
  );
  const routeQuoter = await deploy(
    new ContractFactory(artifact('SequencerRouteQuoter').abi, artifact('SequencerRouteQuoter').bytecode, wallet),
    [CURVE.address, V4.quoter],
    'SequencerRouteQuoter',
  );
  const tickLens = await deploy(
    new ContractFactory(artifact('V4TickStateLens').abi, artifact('V4TickStateLens').bytecode, wallet),
    [V4.poolManager],
    'V4TickStateLens',
  );

  console.log('\nDEPLOYED FAIL-CLOSED');
  console.log('The owner must explicitly enable the relayer, both adapters, WETH borrow cap,');
  console.log('the RobinFun token, and the reviewed V4 PoolKeys before LIVE.');
  console.log('\nCurrent live (already configured) addresses:');
  console.log(`SEQUENCER_EXECUTOR_ADDR=${DEPLOYMENTS.sequencerExecutor}`);
  console.log(`ROBIN_FUN_WETH_ADAPTER=${DEPLOYMENTS.robinFunWethAdapter}`);
  console.log(`UNISWAP_V4_WETH_ADAPTER=${DEPLOYMENTS.uniswapV4WethAdapter}`);
  console.log(`ROUTE_QUOTER_ADDR=${DEPLOYMENTS.routeQuoter}`);
  console.log(`V4_TICK_STATE_LENS=${DEPLOYMENTS.v4TickStateLens}`);
  console.log('\nThis new deployment:');
  console.log(`SEQUENCER_EXECUTOR_ADDR=${executor}`);
  console.log(`ROBIN_FUN_WETH_ADAPTER=${curveAdapter}`);
  console.log(`UNISWAP_V4_WETH_ADAPTER=${v4Adapter}`);
  console.log(`ROUTE_QUOTER_ADDR=${routeQuoter}`);
  console.log(`V4_TICK_STATE_LENS=${tickLens}`);
  console.log(`MORPHO_ADDR=${morpho}`);
}

main().catch((error) => {
  console.error('FATAL', error?.shortMessage || error?.message || error);
  process.exit(1);
});
