import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RawBroadcaster, Telemetry, RelayerJournal } from '../native/transport.mjs';
const H='0x'+'a'.repeat(64);
async function server(handler) {
  const s=http.createServer(handler);await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
  return {s,url:`http://127.0.0.1:${s.address().port}`};
}
const close=async s=>{s.closeAllConnections();await new Promise(resolve=>s.close(resolve));};
test('broadcast races the same signed bytes, returns first ack, observes slow path',async()=>{
  const bodies=[];
  const handler=delay=>(req,res)=>{let body='';req.on('data',b=>body+=b);req.on('end',()=>{bodies.push(JSON.parse(body));setTimeout(()=>res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:H})),delay);});};
  const a=await server(handler(0)),b=await server(handler(150));const transport=new RawBroadcaster([a.url,b.url],{timeoutMs:1000});
  try {
    const result=await transport.broadcast('0xabcdef',H);assert.equal(result.path,'path-0');
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(bodies.length,2);assert.deepEqual(bodies[0],bodies[1]);assert.equal(bodies[0].method,'eth_sendRawTransaction');
  } finally {transport.close();await close(a.s);await close(b.s);}
});
test('incorrect transaction hash and already-known errors are not false acknowledgments',async()=>{
  for(const response of [{jsonrpc:'2.0',id:1,result:'0x'+'b'.repeat(64)},{jsonrpc:'2.0',id:1,error:{message:'already known'}}]) {
    const a=await server((req,res)=>{req.resume();res.end(JSON.stringify(response));});const t=new RawBroadcaster([a.url]);
    try {await assert.rejects(t.broadcast('0x01',H),AggregateError);}finally{t.close();await close(a.s);}
  }
});
test('request has a hard deadline and stale work does not POST',async()=>{
  let requests=0;const a=await server(req=>{requests++;req.resume();});const t=new RawBroadcaster([a.url],{timeoutMs:30});
  try {await assert.rejects(t.broadcast('0x01',H,()=>false));assert.equal(requests,0);
    await assert.rejects(t.broadcast('0x01',H));assert.equal(requests,1);
  } finally {t.close();await close(a.s);}
});
test('telemetry queue is bounded and final flush is awaited',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-telemetry-'));const file=path.join(dir,'trace.ndjson');
  const t=new Telemetry(file,{maxQueued:2});t.record('a');t.record('b');t.record('c');await t.close();
  const records=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records.length,2);assert.equal(t.dropped,1);assert.ok(BigInt(records[0].monotonicNs)>0n);fs.rmSync(dir,{recursive:true});
});
test('relayer lock excludes a second writer; dirty history survives clean exit',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'arb-nonce-'));const relayer='0x'+'1'.repeat(40);
  const a=new RelayerJournal(dir,relayer);assert.throws(()=>new RelayerJournal(dir,relayer));
  a.append({nonce:3n,txHash:H});a.close();assert.throws(()=>new RelayerJournal(dir,relayer));
  assert.match(fs.readFileSync(path.join(dir,`${relayer}.ndjson`),'utf8'),/"nonce":"3"/);fs.rmSync(dir,{recursive:true});
});
