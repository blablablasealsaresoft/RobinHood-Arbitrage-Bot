// Retrospective, same-process-clock telemetry analysis. Not a hot-path import.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stable } from './core.mjs';
export function telemetryReport(records) {
  if (!Array.isArray(records) || records.length > 1000000) throw new Error('at most one million telemetry records per report');
  const blocks=new Map(),opportunities=new Map(),transactions=new Map(),pnl=new Map();
  let invalidated=0;
  const put=(map,key)=>{if(!map.has(key))map.set(key,{});return map.get(key);};
  for(const r of records){
    if(!r||typeof r.monotonicNs!=='string'||!/^\d{1,30}$/.test(r.monotonicNs))throw new Error('local monotonic timestamp required');
    const ns=BigInt(r.monotonicNs);
    if(['frame_received','state_updated','q_optimized'].includes(r.type)&&r.anchorHash){
      const b=put(blocks,r.anchorHash);if(b[r.type]===undefined)b[r.type]=ns;
    }
    if(r.type==='opportunity_found')Object.assign(put(opportunities,r.key),{anchorHash:r.anchorHash,found:ns});
    if(['intent_signed','raw_signed'].includes(r.type))put(opportunities,r.key)[r.type]=ns;
    if(r.type==='signed')Object.assign(put(transactions,r.txHash),{key:r.key,signed:ns});
    if(r.type==='POST_started'){
      const t=put(transactions,r.txHash);if(t.post===undefined||ns<t.post)t.post=ns;
    }
    if(r.type==='path_accepted'){
      const t=put(transactions,r.txHash);if(t.accepted===undefined||ns<t.accepted)t.accepted=ns;
    }
    if(r.type==='included')Object.assign(put(transactions,r.txHash),{included:ns,status:r.status});
    if(r.type==='realized_pnl')pnl.set(r.txHash,r);
    if(r.type==='accounting_invalidated')for(const h of r.removedTxHashes||[]){pnl.delete(h);invalidated++;}
  }
  const samples={stateUpdateUs:[],localDecisionUs:[],intentSigningUs:[],rawSigningUs:[],frameToFirstPostUs:[],firstPostToAckUs:[],firstPostToObservedInclusionUs:[]};
  const add=(key,a,b)=>{if(a!==undefined&&b!==undefined&&b>=a)samples[key].push(Number(b-a)/1000);};
  for(const b of blocks.values()){
    add('stateUpdateUs',b.frame_received,b.state_updated);add('localDecisionUs',b.frame_received,b.q_optimized);
  }
  let posted=0,accepted=0,included=0,reverted=0,unresolved=0,orphanReceiptObservations=0;
  for(const t of transactions.values()){
    const o=opportunities.get(t.key)||{},b=blocks.get(o.anchorHash)||{};
    add('intentSigningUs',o.found,o.intent_signed);add('rawSigningUs',o.intent_signed,o.raw_signed);
    add('frameToFirstPostUs',b.frame_received,t.post);add('firstPostToAckUs',t.post,t.accepted);
    add('firstPostToObservedInclusionUs',t.post,t.included);
    if(t.post!==undefined)posted++;if(t.accepted!==undefined)accepted++;
    if(t.post!==undefined&&t.included===undefined)unresolved++;
    if(t.included!==undefined){included++;if(t.post===undefined)orphanReceiptObservations++;if(t.status===0)reverted++;}
  }
  const stats=values=>{
    values.sort((a,b)=>a-b);const p=x=>values[Math.max(0,Math.ceil(x*values.length)-1)]??null;
    return {samples:values.length,p50:p(.5),p95:p(.95),p99:p(.99),max:values.at(-1)??null};
  };
  const totals=new Map();
  for(const r of pnl.values()){
    const token=r.settlementToken;if(typeof token!=='string')throw new Error('P&L settlement denomination required');
    const t=totals.get(token)||{grossProfit:0n,gasWei:0n,gasCost:0n,net:0n,receipts:0};
    for(const key of ['grossProfit','gasWei','gasCost','net'])t[key]+=BigInt(r[key]);t.receipts++;totals.set(token,t);
  }
  return {schema:1,scope:'local-monotonic-telemetry-and-provisional-receipt-accounting',
    posted,accepted,included,reverted,unresolved,orphanReceiptObservations,invalidatedProfitRecords:invalidated,
    latencyUs:Object.fromEntries(Object.entries(samples).map(([k,v])=>[k,stats(v)])),
    provisionalSettlements:[...totals].map(([settlementToken,t])=>({settlementToken,...t})),
    notes:['Inclusion latency is receipt observation, not a sequencer timestamp.',
      'Frame latency begins at local executed-state receipt, not raw sequencer feed receipt.',
      'No cross-token profit totals or unmeasured success rates are inferred.']};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{
    if(process.argv.length!==3)throw new Error('usage: node native/metrics.mjs TELEMETRY_NDJSON');
    const file=process.argv[2];if(fs.statSync(file).size>128*1024*1024)throw new Error('rotate/partition telemetry larger than 128 MiB');
    const records=fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(JSON.parse);console.log(stable(telemetryReport(records)));
  }catch(e){console.error(`metrics: ${e.message}`);process.exitCode=1;}
}
