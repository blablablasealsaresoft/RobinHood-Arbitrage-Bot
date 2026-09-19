// Cold, read-only parity auditor. NEVER imported by the latency-critical runner.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { RouteBook, MarketState, quoteRoute, uint, address, hash32, stable, fingerprint } from './core.mjs';
const READ_METHODS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call']);
export function readOnlyRpc(send) {
  return async (method, params) => {
    if (!READ_METHODS.has(method)) throw new Error(`audit RPC write/unsupported method refused: ${method}`);
    return send(method, params);
  };
}
export function abiWord(raw, index) {
  if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{64})+$/.test(raw) || !Number.isInteger(index) || index < 0 || index > 31) throw new Error('invalid static ABI result/index');
  const word = raw.slice(2 + index * 64, 2 + (index + 1) * 64);
  if (word.length !== 64) throw new Error('missing quote output word');
  return BigInt('0x' + word);
}

export async function auditSnapshot({ config, snapshot, referenceCases, send, stateChecks, hashCode, hashReturn }) {
  if (snapshot.type !== 'snapshot') throw new Error('complete snapshot required for audit');
  const book = new RouteBook(config.pools, config.routes), state = new MarketState(book);
  state.ingest(snapshot);
  if (!Array.isArray(referenceCases) || !referenceCases.length || referenceCases.length > 4096) throw new Error('1..4096 explicit reference quote cases required');
  const call = readOnlyRpc(send), numberTag = '0x' + state.head.number.toString(16);
  const blockTag = { blockHash: state.head.hash, requireCanonical: true };
  if (BigInt(await call('eth_chainId', [])) !== 4663n) throw new Error('audit RPC chain mismatch');
  const checkAnchor = async () => {
    const block = await call('eth_getBlockByNumber', [numberTag, false]);
    if (!block || hash32(block.hash) !== state.head.hash || BigInt(block.number) !== state.head.number) throw new Error('audit anchor not canonical');
  };
  await checkAnchor();
  const pins = new Map(Object.entries(config.codeHashes || {}).map(([a,h]) => [address(a), hash32(h)]));
  const required = new Set();
  for (const p of book.pools.values()) for (const a of [p.pair,p.adapter,p.token0,p.token1,p.stateView].filter(Boolean)) required.add(a);
  for (const a of [config.executor,config.morpho].filter(Boolean)) required.add(address(a));
  for (const c of referenceCases) required.add(address(c.target));
  const codeResults = [];
  for (const target of required) {
    if (!pins.has(target)) throw new Error(`reviewed runtime-code pin missing: ${target}`);
    const code = await call('eth_getCode', [target, blockTag]);
    if (code === '0x' || hashCode(code).toLowerCase() !== pins.get(target)) throw new Error(`runtime-code mismatch: ${target}`);
    codeResults.push({ target, codeHash: pins.get(target) });
  }
  const stateResults = [];
  for (const check of stateChecks([...state.pools.values()])) {
    const raw = await call('eth_call', [{ to: check.target, data: check.callData }, blockTag]);
    const observedHash = hashReturn(check.mode, raw);
    stateResults.push({ target: check.target, callData: check.callData, expectedHash: check.expectedReturnHash,
      observedHash, match: observedHash.toLowerCase() === check.expectedReturnHash.toLowerCase() });
  }
  if (!stateResults.length) throw new Error('auditor produced no state checks');
  const quoteResults = [], coverage = new Set();
  for (const c of referenceCases) {
    const route = book.routes.get(c.routeId);
    if (!route || typeof c.data !== 'string' || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(c.data)) throw new Error('invalid reviewed reference call');
    const amount = uint(c.amountIn);
    if (amount < route.minInput || amount > route.maxInput) throw new Error('reference amount outside configured route limits');
    const local = quoteRoute(route, state.pools, amount);
    const raw = await call('eth_call', [{ to: address(c.target), data: c.data }, blockTag]);
    const referenceOut = abiWord(raw, c.outputWord);
    quoteResults.push({ routeId: c.routeId, amountIn: amount, localOut: local.out, referenceOut,
      difference: local.out-referenceOut, match: local.out===referenceOut, referenceTarget:address(c.target), referenceData:c.data });
    coverage.add(c.routeId);
  }
  for (const id of book.routes.keys()) if (!coverage.has(id)) throw new Error(`no reference quote coverage for route ${id}`);
  await checkAnchor(); // Reject a reorg that occurs while collecting evidence.
  return { schema:1, scope:'one-snapshot-state-and-operator-supplied-reference-calls-only', chainId:4663,
    checkedAt:new Date().toISOString(), anchorBlock:state.head.number, anchorHash:state.head.hash,
    configHash:fingerprint(config), snapshotHash:fingerprint(snapshot),
    pass:stateResults.every(x=>x.match)&&quoteResults.every(x=>x.match), codeResults,stateResults,quoteResults,
    limitations:['Not execution-bridge validation or a flash-loan/fork test.',
      'Reference calldata, output index, venue provenance and amount/route binding require review.',
      'One state/sample set is not full tick, fee, hook or amount-domain coverage.'] };
}

async function main(args) {
  if (args.length!==4) throw new Error('usage: node native/audit.mjs CONFIG SNAPSHOT REFERENCE_CASES OUTPUT_JSON');
  if (!process.env.NATIVE_AUDIT_RPC_URL) throw new Error('NATIVE_AUDIT_RPC_URL required (read-only; no wallet keys)');
  const { JsonRpcProvider, AbiCoder, keccak256 } = await import('ethers');
  const { stateChecks } = await import('./wire.mjs');
  const provider = new JsonRpcProvider(process.env.NATIVE_AUDIT_RPC_URL), coder = AbiCoder.defaultAbiCoder();
  const read = file=>JSON.parse(fs.readFileSync(file,'utf8'));
  try {
    const report = await auditSnapshot({ config:read(args[0]),snapshot:read(args[1]),referenceCases:read(args[2]),
      send:provider.send.bind(provider),stateChecks,hashCode:keccak256,
      hashReturn:(mode,raw)=>{
        if(mode===0)return keccak256(raw);
        const [a,b]=coder.decode(['uint112','uint112','uint32'],raw);
        return keccak256(coder.encode(['uint112','uint112'],[a,b]));
      } });
    fs.writeFileSync(args[3],stable(report)+'\n',{mode:0o600});
    console.log(stable({pass:report.pass,anchorHash:report.anchorHash,stateChecks:report.stateResults.length,quoteCases:report.quoteResults.length}));
    if(!report.pass)process.exitCode=1;
  } finally { provider.destroy(); }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(e=>{console.error(`audit: ${e.message}`);process.exitCode=1;});
