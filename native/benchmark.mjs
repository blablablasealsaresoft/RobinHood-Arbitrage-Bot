// Synthetic LOCAL CORE ONLY. No claim about feed, signing, durable journal,
// network delivery, inclusion, chain gas costs, or competitors.
import fs from 'node:fs';
import os from 'node:os';
import { RouteBook, MarketState, NativeEngine, normalizeCosts, stable } from './core.mjs';
const iterations=Number(process.argv[2]||10000);
if(!Number.isSafeInteger(iterations)||iterations<100||iterations>100000)throw new Error('100..100000 iterations required');
const config=JSON.parse(fs.readFileSync(new URL('./example.json',import.meta.url),'utf8'));
const source=fs.readFileSync(new URL('./example.ndjson',import.meta.url),'utf8').trim().split('\n').map(JSON.parse);
const book=new RouteBook(config.pools,config.routes),state=new MarketState(book,{maxAgeMs:60000});
const costs=new Map(config.costs.map(c=>[c.settlementToken,normalizeCosts({...c,validUntilBlock:1000000},c.settlementToken)]));
const engine=new NativeEngine({book,state,costs,live:false});
await engine.onFrame(source[0]);
const samples=[];let opportunities=0;
const hash=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
const makeFrame=i=>({ ...source[1],sequence:String(101+i),blockNumber:String(101+i),blockHash:hash(101+i),feedBlockHash:hash(101+i),
  parentHash:i===0?source[0].blockHash:hash(100+i),updates:[{...source[0].updates[0],reserve0:String(1000000+(i%2))}] });
// Warm up the actual execution path; samples exclude warm-up and frame creation.
for(let i=0;i<1000;i++)await engine.onFrame(makeFrame(i));
const heapStart=process.memoryUsage().heapUsed;
for(let i=1000;i<1000+iterations;i++){
  const frame=makeFrame(i),start=process.hrtime.bigint();
  if(await engine.onFrame(frame))opportunities++;
  samples.push(Number(process.hrtime.bigint()-start)/1000);
}
samples.sort((a,b)=>a-b);
const percentile=p=>samples[Math.min(samples.length-1,Math.ceil(p*samples.length)-1)];
const report={schema:1,scope:'synthetic-local-decision-core-only',node:process.version,platform:`${os.platform()}-${os.arch()}`,
  iterations,warmup:1000,pools:book.pools.size,routes:book.routes.size,opportunities,
  p50Us:percentile(.5),p95Us:percentile(.95),p99Us:percentile(.99),maxUs:samples.at(-1),
  meanUs:samples.reduce((a,b)=>a+b,0)/samples.length,heapDeltaBytes:process.memoryUsage().heapUsed-heapStart,
  excludes:['JSON framing/decoding','telemetry persistence','feed acquisition/verification','EVM execution/state bridge','signing','fsync journal','network','block inclusion','on-chain execution'],
  measuredAt:new Date().toISOString()};
console.log(stable(report));
