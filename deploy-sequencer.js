// deploy-sequencer.js — deploy the V4 next-block flash-arb stack fail-closed.
import 'dotenv/config';
import fs from 'node:fs';
import { ContractFactory, JsonRpcProvider, Network, Wallet, getAddress } from 'ethers';
import { CURVE, V4, WETH } from './config.js';

const CHAIN_ID = 4663;
const MORPHO_BLUE = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';

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
  const treasury = required('TREASURY_ADDR');
  const morpho = getAddress(process.env.MORPHO_ADDR || MORPHO_BLUE);

  for (const [label, address] of [
    ['Morpho', morpho],
    ['RobinFun curve', CURVE.address],
    ['WETH', WETH.address],
    ['V4 router', V4.universalRouter],
    ['Permit2', V4.permit2],
    ['V4 quoter', V4.quoter],
  ]) {
    if (await provider.getCode(address) === '0x') throw new Error(`${label} has no code at ${address}`);
  }

  const executor = await deploy(
    new ContractFactory(
      artifact('SequencerFlashArbExecutorV4').abi,
      artifact('SequencerFlashArbExecutorV4').bytecode,
      wallet,
    ),
    [owner, signer, treasury, morpho, 1, 1],
    'SequencerFlashArbExecutorV4',
  );

  const curveAdapter = await deploy(
    new ContractFactory(
      artifact('RobinFunWethAdapter').abi,
      artifact('RobinFunWethAdapter').bytecode,
      wallet,
    ),
    [owner, CURVE.address, WETH.address],
    'RobinFunWethAdapter',
  );

  const v4Adapter = await deploy(
    new ContractFactory(
      artifact('UniswapV4WethAdapter').abi,
      artifact('UniswapV4WethAdapter').bytecode,
      wallet,
    ),
    [owner, WETH.address, V4.permit2, V4.universalRouter],
    'UniswapV4WethAdapter',
  );

  const routeQuoter = await deploy(
    new ContractFactory(
      artifact('SequencerRouteQuoter').abi,
      artifact('SequencerRouteQuoter').bytecode,
      wallet,
    ),
    [CURVE.address, V4.quoter],
    'SequencerRouteQuoter',
  );

  console.log('\nDEPLOYED FAIL-CLOSED');
  console.log('The Safe must explicitly enable:');
  console.log('- relayer on executor');
  console.log('- both adapters on executor');
  console.log('- WETH borrow cap');
  console.log('- configured token on RobinFun adapter');
  console.log('- configured PoolKeys on V4 adapter');
  console.log('\n.env values:');
  console.log(`SEQUENCER_EXECUTOR_ADDR=${executor}`);
  console.log(`ROBIN_FUN_WETH_ADAPTER=${curveAdapter}`);
  console.log(`UNISWAP_V4_WETH_ADAPTER=${v4Adapter}`);
  console.log(`ROUTE_QUOTER_ADDR=${routeQuoter}`);
  console.log(`MORPHO_ADDR=${morpho}`);
}

main().catch(error => {
  console.error('FATAL', error?.shortMessage || error?.message || error);
  process.exit(1);
});
