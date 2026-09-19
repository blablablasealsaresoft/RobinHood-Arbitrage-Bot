// Cold read-only inspection. Never imported by the signer or execution loop.
// Captured results are evidence to inspect, not attestation or live configuration.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { address, hash32, stable } from './core.mjs';
const MASK = bits => (1n << BigInt(bits)) - 1n;
const READS = new Set(['eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'eth_getStorageAt']);
const WORD = /^0x[\da-fA-F]{64}$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][\da-fA-F]{0,63})$/;
const quantity = x => { if (typeof x !== 'string' || !QUANTITY.test(x)) throw new Error('invalid RPC quantity'); return BigInt(x); };
const word = x => { if (typeof x !== 'string' || !WORD.test(x)) throw new Error('exact ABI/storage word required'); return BigInt(x); };
const encodeWord = x => BigInt(x).toString(16).padStart(64, '0');
export function exactWords(raw, count) {
  if (!Number.isInteger(count) || count < 1 || count > 32 || typeof raw !== 'string' || !/^0x[\da-fA-F]+$/.test(raw) || raw.length !== 2 + count * 64) throw new Error('ABI return shape mismatch');
  return Array.from({ length: count }, (_, i) => BigInt('0x' + raw.slice(2 + 64*i, 66 + 64*i)));
}
const bounded = (n, bits) => { if (n < 0n || n > MASK(bits)) throw new Error('ABI field width mismatch'); return n; };
const signed24 = n => { const x = n & MASK(24); return Number(x >= 1n<<23n ? x - (1n<<24n) : x); };
export function decodeV4Storage(slot0, liquidity) {
  const n = word(slot0), l = word(liquidity);
  if ((n >> 232n) !== 0n || (l >> 128n) !== 0n) throw new Error('unreviewed packed storage bits');
  return { sqrtPriceX96: n & MASK(160), tick: signed24(n >> 160n), protocolFee: (n >> 184n) & MASK(24), lpFee: (n >> 208n) & MASK(24), liquidity: l };
}
export function decodeV4View(slot0, liquidity) {
  const [p, t, protocol, fee] = exactWords(slot0, 4), tick = signed24(t);
  if (t !== (tick < 0 ? (1n<<256n) + BigInt(tick) : BigInt(tick))) throw new Error('noncanonical int24');
  return { sqrtPriceX96: bounded(p,160), tick, protocolFee: bounded(protocol,24), lpFee: bounded(fee,24), liquidity: bounded(word(liquidity),128) };
}
export function inspectLegacyCurve(raw) {
  if (typeof raw !== 'string' || !/^0x(?:[\da-fA-F]{64}){1,32}$/.test(raw)) throw new Error('malformed curve return');
  const returnedWords = (raw.length-2)/64;
  // Do NOT give names to the newly observed trailing fields or infer a fee.
  return { declaredWords: 6, returnedWords, exactLegacyShape: returnedWords === 6,
    declaredFeeWordInBpsRange: returnedWords >= 6 && BigInt('0x'+raw.slice(2+5*64,2+6*64)) <= 10_000n };
}
function header(h) {
  if (!h || quantity(h.number) > BigInt(Number.MAX_SAFE_INTEGER) || quantity(h.timestamp) > 8_640_000_000_000n) throw new Error('invalid bounded header');
  for (const k of ['hash','parentHash','stateRoot']) hash32(h[k]);
  return h;
}
export function inspectReferenceRevert(reference, anchor) {
  const r=reference.receipt, parent=header(reference.parentHeader);
  if(quantity(parent.number)+1n!==quantity(anchor.number)||parent.hash.toLowerCase()!==anchor.parentHash.toLowerCase())throw new Error('reference parent mismatch');
  if(r.blockNumber!==anchor.number||r.blockHash.toLowerCase()!==anchor.hash.toLowerCase()||address(r.from)!==address(reference.sender))throw new Error('reference receipt identity mismatch');
  hash32(r.transactionHash);
  if(quantity(r.status)!==0n||quantity(r.type)!==2n||!Array.isArray(r.logs)||r.logs.length!==0)throw new Error('failed type-2 reference receipt required');
  const nonceIncrement=quantity(reference.nonceAfter)-quantity(reference.nonceBefore);
  if(nonceIncrement!==1n)throw new Error('reference sender consumed multiple/zero nonces');
  const gasUsed=quantity(r.gasUsed), effectiveGasPrice=quantity(r.effectiveGasPrice), l1=quantity(r.gasUsedForL1);
  if(gasUsed===0n||effectiveGasPrice===0n||l1>gasUsed)throw new Error('invalid reference gas fields');
  const receiptGasCharge=gasUsed*effectiveGasPrice, balanceChange=quantity(reference.balanceBefore)-quantity(reference.balanceAfter);
  return {txHash:r.transactionHash,gasUsed,effectiveGasPrice,gasUsedForL1:l1,receiptGasCharge,balanceChange,nonceIncrement,
    arithmeticMatches:receiptGasCharge===balanceChange,transactionScopedStateDiffVerified:false,
    scope:'one failed public reference transaction; whole-block balance comparison; not bot gas calibration'};
}
export function inspectDeploymentSample(s) {
  if (s?.schema !== 1 || s.kind !== 'captured-read-only-rpc-sample' || quantity(s.chainId) !== 4663n) throw new Error('wrong sample schema/chain');
  const before = header(s.anchorBefore), after = header(s.anchorAfter);
  for (const k of ['number','hash','parentHash','stateRoot','timestamp']) if (before[k].toLowerCase() !== after[k].toLowerCase()) throw new Error('anchor changed during collection');
  const checkTag = item => { if (item?.blockTag !== before.number) throw new Error('mixed-block evidence'); };
  for (const item of [s.weth,s.arbSys,s.curve]) checkTag(item);
  address(s.weth.address); address(s.weth.morpho); address(s.curve.address); address(s.curve.token);
  const c=s.curve;
  if(c.getterData.toLowerCase()!=='0x2cc3dc6e'+encodeWord(c.token)||c.quoteBuy.data.toLowerCase()!=='0x0d7a94f6'+encodeWord(c.token)+encodeWord(c.quoteBuy.amountIn))throw new Error('curve calldata binding mismatch');
  if(s.arbSys.address.toLowerCase()!=='0x0000000000000000000000000000000000000064')throw new Error('wrong ArbSys address');
  const decimals = bounded(word(s.weth.decimalsResult),8), balance = word(s.weth.morphoBalanceResult);
  const rawVersion = word(s.arbSys.versionResult);
  if (rawVersion < 56n) throw new Error('not a recognized Nitro ArbSys version');
  if (!Array.isArray(s.pools) || !s.pools.length || s.pools.length > 128) throw new Error('bounded pool coverage required');
  const seen = new Set(), issues = [];
  if (decimals !== 18n) issues.push('WETH_DECIMALS_UNEXPECTED');
  const pools = s.pools.map(p => {
    checkTag(p); const id = hash32(p.poolId); address(p.manager); address(p.stateView);
    const identity = `${p.manager.toLowerCase()}:${id}`;
    if (seen.has(identity)) throw new Error('duplicate pool evidence'); seen.add(identity);
    if (word(p.liquidity.slot) !== word(p.slot0.slot)+3n) throw new Error('V4 liquidity offset mismatch');
    const stored = decodeV4Storage(p.slot0.storage,p.liquidity.storage), viewed = decodeV4View(p.slot0.viewResult,p.liquidity.viewResult);
    if (stable(stored) !== stable(viewed)) throw new Error('storage/lens mismatch');
    const flags = [];
    const k=p.key, zero='0x'+'0'.repeat(40);
    if(k.currency0!==zero||address(k.currency1)!==address(c.token)||k.hooks!==zero||!Number.isInteger(k.fee)||k.fee<0||k.fee>=1000000||!Number.isInteger(k.tickSpacing)||k.tickSpacing<1||k.tickSpacing>32767)throw new Error('unsupported reviewed pool key');
    address(p.quote.target);
    if(!/^\d+$/.test(p.quote.amountIn)||BigInt(p.quote.amountIn)<=0n||BigInt(p.quote.amountIn)>MASK(128)||p.quote.direction!=='native-to-token')throw new Error('quote amount/direction binding mismatch');
    const expectedData='0xaa9d21cb'+encodeWord(32)+[0,k.currency1,k.fee,k.tickSpacing,0,1,p.quote.amountIn,256,0].map(encodeWord).join('');
    if(p.quote.data.toLowerCase()!==expectedData)throw new Error('quote calldata binding mismatch');
    if (stored.liquidity === 0n) flags.push('ZERO_ACTIVE_LIQUIDITY_SINGLE_TICK_UNSUPPORTED');
    if (stored.lpFee !== BigInt(p.key.fee)) flags.push('POOL_FEE_MISMATCH');
    if ((stored.protocolFee & 4095n)>1000n || (stored.protocolFee>>12n)>1000n) flags.push('PROTOCOL_FEE_UNSUPPORTED');
    if (Boolean(p.quote.error) === Object.hasOwn(p.quote,'result')) throw new Error('ambiguous/missing quote evidence');
    if (p.quote.error) {
      if (p.quote.error.code !== 3) throw new Error('quote collection failed, not a revert');
      flags.push('REFERENCE_QUOTE_REVERTED_REASON_UNDETERMINED');
    } else exactWords(p.quote.result,2);
    issues.push(...flags.map(x=>`${id}:${x}`));
    return { poolId:id, ...stored, flags };
  });
  const curve = inspectLegacyCurve(s.curve.getterResult);
  if (!curve.exactLegacyShape || !curve.declaredFeeWordInBpsRange) issues.push('LEGACY_CURVE_ABI_REQUIRES_REVIEW');
  const quoteBuyOutput = word(s.curve.quoteBuy.result);
  const referenceRevert=s.referenceRevert?inspectReferenceRevert(s.referenceRevert,before):null;
  if(referenceRevert&&!referenceRevert.arithmeticMatches)issues.push('REFERENCE_REVERT_FEE_ARITHMETIC_MISMATCH');
  return { schema:1, scope:'one-provider-one-block-read-only-inspection', productionReady:false,
    anchorBlock:quantity(before.number), anchorHash:before.hash, anchorTimeUTC:new Date(Number(quantity(before.timestamp))*1000).toISOString(),
    headerStableDuringCollection:true, arbSysVersionRaw:rawVersion, arbOSVersion:rawVersion-55n,
    wethDecimals:decimals, morphoWethBalanceBaseUnits:balance, curve, curveQuoteBuyOutput:quoteBuyOutput, pools, issues, referenceRevert,
    limitations:['Number-pinned reads with matching boundary headers are not an independent consensus or storage proof.',
      'One sample does not establish node correctness, full tick coverage, code identity, profitability or N+1 inclusion.',
      'Curve schema/fee meanings require verified source review; no curve pricing model is enabled.',
      'This report cannot authorize live trading or replace the required executor, adapter, fork and shadow checks.'] };
}

// Recollect the SAME reviewed call templates at another block; no writes, keys,
// endpoints, stale result fields or unrelated testnet observations are inherited.
export async function collectDeploymentSample(template, send, at = 'latest') {
  inspectDeploymentSample(template);
  if (at !== 'latest') quantity(at);
  const call = (m,p) => { if (!READS.has(m)) throw new Error('write method refused'); return send(m,p); };
  const chainId = await call('eth_chainId',[]);
  if (quantity(chainId) !== 4663n) throw new Error('collection endpoint is not mainnet 4663');
  const first = header(await call('eth_getBlockByNumber',[at,false])), tag = first.number;
  const read = (to,data) => call('eth_call',[{to,data},tag]);
  const s = { schema:1,kind:template.kind,chainId,collectionDateUTC:new Date().toISOString(),provider:'configured-read-only-endpoint',anchorBefore:first };
  const w=template.weth,c=template.curve;
  s.weth={address:w.address,morpho:w.morpho,blockTag:tag,decimalsResult:await read(w.address,'0x313ce567'),morphoBalanceResult:await read(w.address,'0x70a08231'+encodeWord(w.morpho))};
  s.arbSys={address:template.arbSys.address,blockTag:tag,versionResult:await read(template.arbSys.address,'0x051038f2')};
  s.curve={address:c.address,token:c.token,blockTag:tag,getterData:c.getterData,getterResult:await read(c.address,c.getterData),quoteBuy:{data:c.quoteBuy.data,amountIn:c.quoteBuy.amountIn,result:await read(c.address,c.quoteBuy.data)}};
  s.pools=[];
  for (const p of template.pools) {
    const q={target:p.quote.target,data:p.quote.data,amountIn:p.quote.amountIn,direction:p.quote.direction};
    try { q.result=await read(q.target,q.data); }
    catch(e) { if(e.code!==3)throw e; q.error={code:3,message:'execution reverted'}; }
    s.pools.push({poolId:p.poolId,manager:p.manager,stateView:p.stateView,key:p.key,blockTag:tag,
      slot0:{slot:p.slot0.slot,storage:await call('eth_getStorageAt',[p.manager,p.slot0.slot,tag]),viewResult:await read(p.stateView,'0xc815641c'+p.poolId.slice(2))},
      liquidity:{slot:p.liquidity.slot,storage:await call('eth_getStorageAt',[p.manager,p.liquidity.slot,tag]),viewResult:await read(p.stateView,'0xfa6793d5'+p.poolId.slice(2))},quote:q});
  }
  s.anchorAfter=header(await call('eth_getBlockByNumber',[tag,false]));
  inspectDeploymentSample(s); return s;
}

export function inspectionRpc(endpoint,{fetchImpl=fetch,timeoutMs=5000,maxBytes=2_097_152}={}) {
  const u=new URL(endpoint);
  if(u.username||u.password||!(u.protocol==='https:'||(u.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(u.hostname))))throw new Error('TLS or loopback read endpoint required');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isInteger(maxBytes)||maxBytes<1||maxBytes>16_777_216)throw new Error('bounded RPC limits required');
  let id=0;
  return async(method,params)=>{
    if(!READS.has(method))throw new Error('write/unsupported RPC refused');
    const requestId=++id;
    let response,raw='';
    try {
      response=await fetchImpl(u,{method:'POST',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:requestId,method,params})});
      if(response.status!==200)throw new Error('http');
      const reader=response.body.getReader(),chunks=[];let size=0;
      try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw new Error('size');chunks.push(Buffer.from(value));} }
      finally { await reader.cancel(); reader.releaseLock(); }
      raw=Buffer.concat(chunks).toString('utf8');
    } catch { throw new Error('read-only RPC transport failed (endpoint credentials omitted)'); }
    let result;try{result=JSON.parse(raw);}catch{throw new Error('malformed RPC JSON');}
    if(result?.jsonrpc!=='2.0'||result.id!==requestId||Object.hasOwn(result,'error')===Object.hasOwn(result,'result'))throw new Error('invalid RPC envelope');
    if(result.error){const e=new Error('read-only RPC returned an error');e.code=Number.isInteger(result.error.code)?result.error.code:null;throw e;}
    return result.result;
  };
}
async function main(args) {
  if(args.length!==2||!['--sample','--collect'].includes(args[0]))throw new Error('usage: deployment-inspection.mjs (--sample|--collect) JSON');
  const template=JSON.parse(fs.readFileSync(args[1],'utf8'));
  const sample=args[0]==='--collect'?await collectDeploymentSample(template,inspectionRpc(process.env.NATIVE_AUDIT_RPC_URL)):template;
  console.log(stable({sample,inspection:inspectDeploymentSample(sample)}));
  // Blockers are an expected result for the historical regression fixture, not
  // a reason to modify fixtures until the report is green.
  if(inspectDeploymentSample(sample).issues.length)process.exitCode=2;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main(process.argv.slice(2)).catch(()=>{console.error('inspection failed; no live authorization');process.exitCode=1;});
