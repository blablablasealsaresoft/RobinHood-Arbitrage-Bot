// deployments.js — cktheghost.eth's Robinhood Chain mainnet stack (chainId 4663).
// Verified 2026-09-20 by creation txs + on-chain getters. These addresses are
// public; never put private keys here.

export const DEPLOYER = '0xB50516982524DFF3d8d563F46AD54891Aa61944E';

export const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';
export const MORPHO_BLUE = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
export const ARBSYS = '0x0000000000000000000000000000000000000064';

export const DEPLOYMENTS = {
  chainId: 4663,
  explorer: 'https://robinhoodchain.blockscout.com',
  sequencerExecutor: '0x715c5B9eb7Aa86D65C098EBCF9E7AdDCa5A30ecc',
  robinFunWethAdapter: '0xB196298aFDeC35d756aeDe74Ba453eF6062eC29b',
  uniswapV4WethAdapter: '0x0e62FFA0a3E3d418AA0eBE551d88367B6DC88c0b',
  routeQuoter: '0x7a43Dfa87935088705BEddF7A740c5c7E84ADaC9',
  v4TickStateLens: '0xFA5dfA6084113A912C22E21Fbb9D8Eab334Db89C',
};

export const DEPLOYMENT_TXS = {
  sequencerExecutor: '0x0172182b3f59f6bcdf8289a5912f6485a5593e21deec75d04f1e10df43e7a42f',
  robinFunWethAdapter: '0x5c2829c3d8cd687769ce4ec63022dcb4e89d0fd3db21b401a03b1869189fd530',
  uniswapV4WethAdapter: '0x46fe9003b7270205052291e7cb348afc715c2b306f03cfee731560cd14ab77fb',
  v4TickStateLens: '0x2419c44a613f244dd1e32058e132aa0eb60864d9e8e087cbc951763e6433ecb0',
  routeQuoter: '0xc89a96cee26cdb16dac1d68b01d5b1be9d219c83dd5c0bb3b2e050120dfd26c7',
};

export const LIVE_STACK = [
  { key: 'sequencerExecutor', name: 'SequencerFlashArbExecutorV4', address: DEPLOYMENTS.sequencerExecutor },
  { key: 'robinFunWethAdapter', name: 'RobinFunWethAdapter', address: DEPLOYMENTS.robinFunWethAdapter },
  { key: 'uniswapV4WethAdapter', name: 'UniswapV4WethAdapter', address: DEPLOYMENTS.uniswapV4WethAdapter },
  { key: 'routeQuoter', name: 'SequencerRouteQuoter', address: DEPLOYMENTS.routeQuoter },
  { key: 'v4TickStateLens', name: 'V4TickStateLens', address: DEPLOYMENTS.v4TickStateLens },
];

export function envOrDeployed(name, deployed) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : deployed;
}
