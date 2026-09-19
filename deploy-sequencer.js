// deploy-sequencer.js — deploy and configure the single sequencer-flash strategy stack.
import 'dotenv/config';
import fs from 'node:fs';
import { ContractFactory, Wallet, parseEther, getAddress } from 'ethers';
import { makeProvider } from './provider.js';
import { CURVE, V4, POOLS, TOKEN, WETH } from './config.js';

const MORPHO_DEFAULT = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';

function artifact(name) {
  return JSON.parse(fs.readFileSync(new URL(`./build/${name}.json`, import.meta.url)));
}
const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return getAddress(v);
};

async function deploy(factory, args, name) {
  console.log('deploying', name);
  const c = await factory.deploy(...args);
  await c.waitForDeployment();
  const address = await c.getAddress();
  console.log(name, address);
  return c;
}

async function main() {
  if (!process.env.PRIVATE_KEY) throw new Error('PRIVATE_KEY is required');
  const provider = await makeProvider({ rpcUrl: process.env.EXEC_RPC_URL || process.env.RPC_URL });
  const wallet = new Wallet(process.env.PRIVATE_KEY, provider);

  const chain = await provider.getNetwork();
  if (Number(chain.chainId) !== 4663) throw new Error('wrong chain');

  const strategySigner = process.env.STRATEGY_PRIVATE_KEY
    ? new Wallet(process.env.STRATEGY_PRIVATE_KEY).address
    : required('STRATEGY_SIGNER');
  const treasury = required('TREASURY_ADDR');
  const morpho = getAddress(process.env.MORPHO_ADDR || MORPHO_DEFAULT);
  const finalOwner = process.env.SAFE_OWNER ? getAddress(process.env.SAFE_OWNER) : wallet.address;
  const relayer = process.env.RELAYER_ADDR ? getAddress(process.env.RELAYER_ADDR) : wallet.address;
  const borrowCap = parseEther(process.env.WETH_BORROW_CAP || process.env.MAX_SIZE_ETH || '0.25');

  for (const [name, address] of [
    ['Morpho', morpho], ['Curve', CURVE.address], ['WETH', WETH.address],
    ['V4 Router', V4.universalRouter], ['Permit2', V4.permit2],
    ['V4 Quoter', V4.quoter], ['StateView', V4.stateView],
  ]) {
    if (await provider.getCode(address) === '0x') throw new Error(`${name} has no code at ${address}`);
  }

  const Executor = artifact('SequencerFlashArbExecutorV4');
  const CurveAdapter = artifact('RobinFunWethAdapter');
  const V4Adapter = artifact('UniswapV4WethAdapter');
  const RouteQuoter = artifact('SequencerRouteQuoter');

  // Deployer owns setup, then hands ownership to SAFE_OWNER after configuration.
  const executor = await deploy(
    new ContractFactory(Executor.abi, Executor.bytecode, wallet),
    [wallet.address, strategySigner, treasury, morpho, 1],
    'SequencerFlashArbExecutorV4',
  );
  const executorAddr = await executor.getAddress();

  const curveAdapter = await deploy(
    new ContractFactory(CurveAdapter.abi, CurveAdapter.bytecode, wallet),
    [executorAddr, CURVE.address, WETH.address],
    'RobinFunWethAdapter',
  );
  const v4Adapter = await deploy(
    new ContractFactory(V4Adapter.abi, V4Adapter.bytecode, wallet),
    [wallet.address, executorAddr, V4.universalRouter, V4.permit2, WETH.address],
    'UniswapV4WethAdapter',
  );
  const routeQuoter = await deploy(
    new ContractFactory(RouteQuoter.abi, RouteQuoter.bytecode, wallet),
    [CURVE.address, V4.quoter],
    'SequencerRouteQuoter',
  );

  console.log('warming approvals + allowlists');
  for (const p of POOLS) await (await v4Adapter.setPool(p.key, true)).wait();
  await (await v4Adapter.prepareToken(TOKEN.address)).wait();
  await (await executor.setAdapter(await curveAdapter.getAddress(), true)).wait();
  await (await executor.setAdapter(await v4Adapter.getAddress(), true)).wait();
  await (await executor.setRelayer(relayer, true)).wait();
  await (await executor.setBorrowCap(WETH.address, borrowCap)).wait();

  if (finalOwner.toLowerCase() !== wallet.address.toLowerCase()) {
    await (await executor.transferOwnership(finalOwner)).wait();
    await (await v4Adapter.transferOwnership(finalOwner)).wait();
    console.log('executor ownership pending Safe acceptance:', finalOwner);
    console.log('V4 adapter ownership transferred:', finalOwner);
  }

  console.log('\nAdd to .env:');
  console.log(`FLASH_EXECUTOR_ADDR=${executorAddr}`);
  console.log(`CURVE_ADAPTER_ADDR=${await curveAdapter.getAddress()}`);
  console.log(`V4_ADAPTER_ADDR=${await v4Adapter.getAddress()}`);
  console.log(`ROUTE_QUOTER_ADDR=${await routeQuoter.getAddress()}`);
  console.log(`RELAYER_ADDR=${relayer}`);
  console.log(`WETH_BORROW_CAP=${process.env.WETH_BORROW_CAP || process.env.MAX_SIZE_ETH || '0.25'}`);
  console.log('\nDo not start LIVE until npm run check and the chain-4663 fork suite pass.');
}

main().catch(e => {
  console.error('FATAL', e.shortMessage || e.message);
  process.exit(1);
});
