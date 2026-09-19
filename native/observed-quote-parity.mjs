// Cold fixture replay only: no RPC, keys, signer, inventory or permission to trade.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { address, hash32, stable, uint } from './core.mjs';
import { decodeV4View, exactWords } from './deployment-inspection.mjs';
import { sqrtAtTick, concentratedQuote, directionalFee } from './concentrated.mjs';
import { v4SwapStep } from './v4-ticks.mjs';
const word=x=>BigInt(x).toString(16).padStart(64,'0');
function quantity(x){if(typeof x!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/.test(x))throw new Error('noncanonical quantity');return BigInt(x);}
export function replayObservedQuotes(s) {
  if(s?.schema!==1||s.kind!=='captured-v4-quote-parity'||quantity(s.chainId)!==4663n)throw new Error('wrong quote sample/chain');
  const b=s.headerBefore,a=s.headerAfter;
  for(const h of[b,a]){
    for(const name of['hash','parentHash','stateRoot'])hash32(h[name]);
    quantity(h.number);if(quantity(h.timestamp)>8_640_000_000_000n)throw new Error('invalid timestamp');
  }
  for(const name of['number','hash','parentHash','stateRoot','timestamp'])if(b[name]!==a[name])throw new Error('inconsistent block boundary');
  const id=hash32(s.poolId),k=s.key,token0=address(k.currency0),token1=address(k.currency1);
  address(s.manager);address(s.stateView);address(s.quoter);
  if(BigInt(token0)>=BigInt(token1)||k.hooks!=='0x'+'0'.repeat(40))throw new Error('ordered hookless currencies required');
  if(!Number.isSafeInteger(k.tickSpacing)||k.tickSpacing<1||k.tickSpacing>32767||!Number.isSafeInteger(k.fee)||k.fee<0||k.fee>=1_000_000)throw new Error('unsupported key');
  const keyWords=[token0,token1,k.fee,k.tickSpacing,k.hooks];
  if(s.keyHashObservation?.method!=='web3_sha3'||s.keyHashObservation.data!=='0x'+keyWords.map(word).join('')||hash32(s.keyHashObservation.result)!==id)throw new Error('recorded pool key hash mismatch');
  const validateCall=(q,to,data)=>{
    if(q?.method!=='eth_call'||q.blockTag!==b.number||address(q.to)!==address(to)||q.data!==data)throw new Error('call identity/block/calldata mismatch');
  };
  validateCall(s.slot0,s.stateView,'0xc815641c'+id.slice(2));validateCall(s.liquidity,s.stateView,'0xfa6793d5'+id.slice(2));
  const state=decodeV4View(s.slot0.result,s.liquidity.result);
  const pool={...state,kind:'v4',token0,token1,lowerX96:sqrtAtTick(state.tick),upperX96:sqrtAtTick(state.tick+1)};
  if(state.liquidity<=0n||state.lpFee!==BigInt(k.fee)||pool.sqrtPriceX96<=pool.lowerX96||pool.sqrtPriceX96>=pool.upperX96)throw new Error('unsupported observed single-tick state');
  directionalFee(pool,true);directionalFee(pool,false);
  if(!Array.isArray(s.quotes)||s.quotes.length<1||s.quotes.length>32)throw new Error('bounded quote coverage required');
  const seen=new Set();
  const quotes=s.quotes.map(q=>{
    if(typeof q.zeroForOne!=='boolean')throw new Error('boolean quote direction required');
    const amount=uint(q.amountIn,'quote input',(1n<<127n)-1n);if(!amount)throw new Error('positive quote input required');
    const identity=`${q.zeroForOne}:${amount}`;if(seen.has(identity))throw new Error('duplicate quote');seen.add(identity);
    validateCall(q,s.quoter,'0xaa9d21cb'+[32,...keyWords,q.zeroForOne?1:0,amount,256,0].map(word).join(''));
    const [referenceOut,referenceQuoterGasEstimate]=exactWords(q.result,2);
    const tokenIn=q.zeroForOne?token0:token1;
    const localOut=concentratedQuote(pool,tokenIn,amount);
    // Use the integer-tick boundary as a conservative target. This checks the
    // V4 per-step implementation without inventing any uncaptured tick records.
    const step=v4SwapStep(state.sqrtPriceX96,q.zeroForOne?pool.lowerX96:pool.upperX96,state.liquidity,amount,directionalFee(pool,q.zeroForOne));
    if(step.sqrtPriceX96<=pool.lowerX96||step.sqrtPriceX96>=pool.upperX96||step.amountIn+step.feeAmount!==amount)throw new Error('quote left observed integer tick');
    return {zeroForOne:q.zeroForOne,tokenIn,amountIn:amount,localOut,v4StepOut:step.amountOut,referenceOut,referenceQuoterGasEstimate,
      exactMatch:localOut===referenceOut&&step.amountOut===referenceOut};
  });
  return {schema:1,scope:'one-provider-one-block-within-integer-tick',productionReady:false,anchorBlock:quantity(b.number),anchorHash:b.hash,
    anchorTimeUTC:new Date(Number(quantity(b.timestamp))*1000).toISOString(),poolId:id,key:k,liquidity:state.liquidity,
    bothDirectionsSampled:quotes.some(q=>q.zeroForOne)&&quotes.some(q=>!q.zeroForOne),allExact:quotes.every(q=>q.exactMatch),quotes,
    fullCrossTickValidated:false,codeIdentityVerified:false,localKeccakVerified:false,closedLoopProfitValidated:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  if(process.argv.length!==3)throw new Error('usage: node native/observed-quote-parity.mjs <captured.json>');
  const result=replayObservedQuotes(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));console.log(stable(result));if(!result.allExact)process.exitCode=2;
}
