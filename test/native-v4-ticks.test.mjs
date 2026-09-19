import test from 'node:test';
import assert from 'node:assert/strict';
import { Q96, sqrtAtTick, concentratedQuote, directionalFee } from '../native/concentrated.mjs';
import { compileTickWindow, windowSpec, nextTickInWord, tickAtSqrt, quoteV4Window, v4SwapStep, amount0Delta, amount1Delta, MIN_SQRT, MAX_SQRT } from '../native/v4-ticks.mjs';
import { RouteBook, MarketState, optimizeRoute, quoteRoute, isqrt } from '../native/core.mjs';

const A = '0x'+'11'.repeat(20), B = '0x'+'22'.repeat(20), L = 10n**18n;
const spec = {tickSpacing:60,minWord:-1,maxWord:0};
function data(ticks=[], s=spec) {
  const words = Array(s.maxWord-s.minWord+1).fill(0n);
  for (const t of ticks) { const c=t.tick/s.tickSpacing, w=Math.floor(c/256); words[w-s.minWord] |= 1n<<BigInt(c-w*256); }
  return {words,ticks};
}
const t = (tick,gross,net)=>({tick,liquidityGross:gross,liquidityNet:net});
function pool({tick=0,liquidity=L,ticks=[],window=spec,price=sqrtAtTick(tick),fee=600n,protocol=0n}={}) {
  return {kind:'v4',token0:A,token1:B,tick,sqrtPriceX96:price,liquidity,lpFee:fee,protocolFee:protocol,tickBook:compileTickWindow(window,data(ticks,window))};
}
const sqrtRatio=(n,d)=>isqrt((n<<192n)/d);

// Numeric expected values from the pinned upstream V4 SwapMath test cases.
const upstream=[
  {name:'capped exact input',p:Q96,target:sqrtRatio(101n,100n),l:2n*L,q:L,fee:600n,input:9975124224178055n,out:9925619580021728n,paid:5988667735148n},
  {name:'fully spent exact input',p:Q96,target:sqrtRatio(1000n,100n),l:2n*L,q:L,fee:600n,input:999400000000000000n,out:666399946655997866n,paid:600000000000000n},
  {name:'tiny price target',p:2n,target:1n,l:1n,q:3915081100057732413702495386755767n,fee:1n,input:39614081257132168796771975168n,out:0n,paid:39614120871253040049813n},
  {name:'V4 dust is not all fee',p:2413n,target:79887613182836312n,l:1985041575832132834610021537970n,q:10n,fee:1872n,input:9n,out:0n,paid:1n},
];
for(const v of upstream)test('upstream V4 numeric vector: '+v.name,()=>{
  const x=v4SwapStep(v.p,v.target,v.l,v.q,v.fee);
  assert.equal(x.amountIn,v.input);assert.equal(x.amountOut,v.out);assert.equal(x.feeAmount,v.paid);
  assert.ok(x.amountIn+x.feeAmount<=v.q);
});
test('window specifications reject invalid bounds and unsafe integers',()=>{
  for(const x of [{...spec,tickSpacing:0},{...spec,tickSpacing:32768},{...spec,maxWord:8},{...spec,minWord:-32769},{...spec,minWord:0,maxWord:-1},{...spec,minWord:'-1'}])assert.throws(()=>windowSpec(x));
});
test('complete zero words differ from absent words',()=>{
  assert.equal(compileTickWindow(spec,data()).words.length,2);
  assert.throws(()=>compileTickWindow(spec,{words:[0n],ticks:[]}),/coverage/);
});
test('bitmap requires exactly ordered complete initialized records',()=>{
  const raw=data([t(-60,L,L),t(60,L,-L)]);
  assert.throws(()=>compileTickWindow(spec,{...raw,ticks:[raw.ticks[1],raw.ticks[0]]}),/order/);
  assert.throws(()=>compileTickWindow(spec,{...raw,ticks:raw.ticks.slice(1)}),/coverage/);
  assert.throws(()=>compileTickWindow(spec,{...raw,words:[0n,0n]}),/coverage/);
});
test('liquidity range, net, gross and parity validation',()=>{
  for(const [g,n]of[[0n,0n],[1n,2n],[2n,1n],[1n,-2n],[1n<<128n,0n],[1n<<127n,1n<<127n]])
    assert.throws(()=>compileTickWindow(spec,data([t(0,g,n)])));
});
test('initialized bits outside legal ticks are rejected',()=>{
  assert.throws(()=>compileTickWindow({tickSpacing:5000,minWord:0,maxWord:0},{words:[1n<<255n],ticks:[t(1275000,L,L)]}),/global range/);
});
test('input data and compiled records cannot mutate each other',()=>{
  const raw=data([t(-60,L,L),t(60,L,-L)]), b=compileTickWindow(spec,raw);
  raw.words[0]=0n;raw.ticks[0].liquidityNet=0n;assert.equal(b.byTick[-60].liquidityNet,L);
  assert.throws(()=>{b.words[0]=0n;},TypeError);assert.throws(()=>{b.byTick[-60].liquidityNet=0n;},TypeError);
});
test('negative compression floors rather than truncates toward zero',()=>{
  const b=compileTickWindow(spec,data([t(-60,L,L),t(0,L,-L)]));
  assert.deepEqual(nextTickInWord(b,-1,true),{tick:-60,initialized:true});
  assert.deepEqual(nextTickInWord(b,-1,false),{tick:0,initialized:true});
});
test('uninitialized bitmap word boundaries are retained',()=>{
  const b=compileTickWindow({tickSpacing:1,minWord:-1,maxWord:1},{words:[0n,0n,0n],ticks:[]});
  assert.deepEqual(nextTickInWord(b,7,true),{tick:0,initialized:false});
  assert.deepEqual(nextTickInWord(b,7,false),{tick:255,initialized:false});
  assert.deepEqual(nextTickInWord(b,-1,true),{tick:-256,initialized:false});
});
test('sqrt-price inverse covers positive, negative and boundary ticks',()=>{
  for(const i of [-887272,-200001,-1,0,1,200001,887270]){
    assert.equal(tickAtSqrt(sqrtAtTick(i)),i);
    assert.equal(tickAtSqrt(sqrtAtTick(i+1)-1n),i);
  }
  assert.throws(()=>tickAtSqrt(MAX_SQRT));assert.throws(()=>tickAtSqrt(MIN_SQRT-1n));
});
test('zero-liquidity swap step advances without inventing input or output',()=>{
  assert.deepEqual(v4SwapStep(Q96,sqrtAtTick(60),0n,100n,600n),{sqrtPriceX96:sqrtAtTick(60),amountIn:0n,amountOut:0n,feeAmount:0n});
});
test('upward zero-liquidity gap enters an initialized range',()=>{
  const p=pool({liquidity:0n,ticks:[t(60,L,L),t(120,L,-L)]});
  const x=quoteV4Window(p,B,10n**12n);
  const expected=v4SwapStep(sqrtAtTick(60),sqrtAtTick(120),L,10n**12n,600n);
  assert.equal(x.crossings,1);assert.equal(x.out,expected.amountOut);assert.equal(x.sqrtPriceX96,expected.sqrtPriceX96);
  assert.equal(p.liquidity,0n);assert.equal(p.tick,0);
});
test('downward boundary crossing uses the opposite liquidity-net sign',()=>{
  const p=pool({tick:120,liquidity:0n,ticks:[t(60,L,L),t(120,L,-L)]});
  const x=quoteV4Window(p,A,10n**12n);
  assert.equal(x.crossings,1);assert.equal(x.liquidity,L);assert.equal(x.tick,119);assert.ok(x.out>0n);
});
test('crossing changes the next range liquidity and rounds fee per step',()=>{
  const p=pool({ticks:[t(-600,L,L),t(60,3n*L,L),t(180,2n*L,-2n*L)]});
  const first=v4SwapStep(Q96,sqrtAtTick(60),L,L,600n);
  const extra=10n**14n, amount=first.amountIn+first.feeAmount+extra;
  const second=v4SwapStep(sqrtAtTick(60),sqrtAtTick(180),2n*L,extra,600n);
  const x=quoteV4Window(p,B,amount);
  assert.equal(x.out,first.amountOut+second.amountOut);assert.equal(x.feePaid,first.feeAmount+second.feeAmount);assert.equal(x.liquidity,2n*L);assert.equal(x.crossings,1);
});
test('zero-liquidity traversal includes multiple empty bitmap words',()=>{
  const w={tickSpacing:1,minWord:0,maxWord:2};
  const p=pool({tick:1,liquidity:0n,ticks:[t(512,L,L),t(600,L,-L)],window:w});
  const x=quoteV4Window(p,B,1000000n);assert.equal(x.crossings,1);assert.equal(x.steps,4);assert.ok(x.out>0n);
});
test('an unread word halts rather than supplying implicit zero liquidity',()=>{
  assert.throws(()=>quoteV4Window(pool({liquidity:0n}),B,100n),/window exhausted/);
});
test('global price limit with input remaining is not a complete route quote',()=>{
  const w={tickSpacing:32767,minWord:-1,maxWord:0};
  assert.throws(()=>quoteV4Window(pool({window:w,liquidity:0n}),B,100n),/partial V4 fill/);
});
test('crossing underflow and work budgets fail closed',()=>{
  const p=pool({liquidity:0n,ticks:[t(0,L,L)]});assert.throws(()=>quoteV4Window(p,A,100n),/underflow/);
  const w={tickSpacing:1,minWord:0,maxWord:2}, q=pool({tick:1,liquidity:0n,ticks:[t(512,L,L),t(600,L,-L)],window:w});
  assert.throws(()=>quoteV4Window(q,B,100n,{maxSteps:2}),/budget/);
});
test('amount and fee boundaries are explicit',()=>{
  const p=pool();assert.throws(()=>quoteV4Window(p,B,1n<<127n),/input/);assert.throws(()=>quoteV4Window(p,B,-1n));
  assert.throws(()=>v4SwapStep(Q96,2n*Q96,L,1n,1000000n),/fee/);
  assert.equal(quoteV4Window(p,B,0n).out,0n);
});
test('V4 directional protocol fee applies on both directions',()=>{
  const p=pool({protocol:(1000n<<12n)|500n});
  assert.equal(directionalFee(p,true),500n+600n-500n*600n/1000000n);
  assert.equal(directionalFee(p,false),1000n+600n-1000n*600n/1000000n);
});
test('1000 deterministic no-crossing quotes agree with existing integer math',()=>{
  const tick=50, p=pool({tick,price:(sqrtAtTick(50)+sqrtAtTick(51))/2n,protocol:4097000n});
  p.lowerX96=sqrtAtTick(tick);p.upperX96=sqrtAtTick(tick+1);
  for(let i=1n;i<=500n;i++) for(const token of[A,B]){
    const q=i*1234567n;assert.equal(quoteV4Window(p,token,q).out,concentratedQuote(p,token,q));
  }
});
test('1000 deterministic swap steps conserve input and bound price',()=>{
  let seed=4663n;const rand=n=>(seed=(seed*1664525n+1013904223n)%4294967296n)%n;
  for(let i=0;i<1000;i++){
    const tick=Number(rand(10000n))-5000, d=Number(rand(120n))+1, zero=Boolean(i%2);
    const p=sqrtAtTick(tick),target=sqrtAtTick(tick+(zero?-d:d)),l=rand(10n**18n)+1n,q=rand(10n**16n)+1n;
    const x=v4SwapStep(p,target,l,q,rand(300000n));
    assert.ok(x.amountIn+x.feeAmount<=q);assert.ok(x.sqrtPriceX96>= (zero?target:p));assert.ok(x.sqrtPriceX96<=(zero?p:target));
    if(x.sqrtPriceX96!==target)assert.equal(x.amountIn+x.feeAmount,q);
  }
});

const word=n=>BigInt(n).toString(16).padStart(64,'0');
const key=(fee=500)=>'0x'+[0n,BigInt(B),BigInt(fee),60n,0n].map(word).join('');
function setup() {
  const meta=(id,pair,tick)=>({id,kind:'v4',pair,token0:A,token1:B,adapter:'0x'+'33'.repeat(20),adapterData:key(),feePips:'500',hooks:'0x'+'00'.repeat(20),wrappedNativeToken:A,stateView:'0x'+'44'.repeat(20),poolKeyHash:'0x'+id.repeat(64),tickWindow:{...spec,lens:'0x'+'55'.repeat(20)}});
  const pools=[meta('1','0x'+'66'.repeat(20)),meta('2','0x'+'77'.repeat(20))];
  const routes=[{id:'window-loop',settlementToken:A,minInput:'1',maxInput:'120',borrowCap:'10000',legs:[{poolId:'1',tokenIn:A,tokenOut:B},{poolId:'2',tokenIn:B,tokenOut:A}]}];
  const book=new RouteBook(pools,routes),state=new MarketState(book);
  const update=(id,tick)=>({poolId:id,sqrtPriceX96:sqrtAtTick(tick).toString(),tick,liquidity:'100000',protocolFee:'0',lpFee:'500',tickWindow:data([t(-60,100000n,100000n),t(60,100000n,-100000n)])});
  const frame={schema:1,chainId:4663,complete:true,sequence:'1',blockNumber:'1',blockHash:'0x'+'ab'.repeat(32),feedBlockHash:'0x'+'ab'.repeat(32),parentHash:'0x'+'ac'.repeat(32),timestamp:'1',updates:[update('1',30),update('2',-30)],type:'snapshot'};
  state.ingest(frame);return{book,state,pools,routes,frame};
}
test('state engine accepts an explicitly configured complete window',()=>{
  const x=setup();assert.ok(x.state.pools.get('1').tickBook);assert.equal(x.book.pools.get('1').tickWindow.lens,'0x'+'55'.repeat(20));
});
test('bitmap update is an economic state change even with unchanged slot0',()=>{
  const x=setup();const previous=x.state.poolFingerprints.get('1');
  const u=x.frame.updates[0];u.tickWindow=data([t(-60,100002n,100000n),t(60,100002n,-100000n)]);
  x.state.ingest({...x.frame,type:'block',sequence:'2',blockNumber:'2',parentHash:x.frame.blockHash,blockHash:'0x'+'ad'.repeat(32),feedBlockHash:'0x'+'ad'.repeat(32),updates:[u]});
  assert.notEqual(x.state.poolFingerprints.get('1'),previous);
});
test('state engine refuses missing coverage atomically',()=>{
  const x=setup();delete x.frame.updates[0].tickWindow;
  assert.throws(()=>x.state.ingest({...x.frame,type:'block',sequence:'2',blockNumber:'2',parentHash:x.frame.blockHash,blockHash:'0x'+'ad'.repeat(32),feedBlockHash:'0x'+'ad'.repeat(32)}),/coverage/);
  assert.equal(x.state.head.number,1n);assert.equal(x.state.ready,false);
});
test('native/ERC20 mapping and static PoolKey spacing must match configuration',()=>{
  const x=setup();x.pools[0].tickWindow.tickSpacing=1;assert.throws(()=>new RouteBook(x.pools,x.routes),/PoolKey/);
  x.pools[0].tickWindow.tickSpacing=60;x.pools[0].wrappedNativeToken=B;assert.throws(()=>new RouteBook(x.pools,x.routes),/mapping/);
});
test('bounded window sizing agrees with brute force on small domains',()=>{
  const x=setup(),route={...x.book.routes.get('window-loop'),maxInput:60n};
  const chosen=optimizeRoute(route,x.state.pools);
  let best;for(let q=1n;q<=60n;q++){const r=quoteRoute(route,x.state.pools,q);if(r.outputs.length===2&&r.outputs.every(v=>v>0n)&&(!best||r.grossProfit>best.grossProfit))best=r;}
  assert.equal(chosen.grossProfit,best.grossProfit);assert.equal(chosen.amount,best.amount);assert.ok(chosen.sizingEvaluations<=96);
});
