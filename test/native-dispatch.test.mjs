import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { RawBroadcaster } from '../native/transport.mjs';
const H = '0x' + 'a'.repeat(64);
async function server() {
  const responses = [], requests = [];
  const s = http.createServer((req,res) => {
    let body=''; req.on('data',b=>{ body+=b; });
    req.on('end',()=>{requests.push(JSON.parse(body));responses.push(res);});
  });
  await new Promise(r=>s.listen(0,'127.0.0.1',r));
  return { s, requests, responses, url:`http://127.0.0.1:${s.address().port}`,
    release:()=>{for(const r of responses.splice(0)) r.end(JSON.stringify({jsonrpc:'2.0',id:1,result:H}));},
    close:async()=>{s.closeAllConnections();await new Promise(r=>s.close(r));} };
}
async function until(predicate) {
  const end=performance.now()+1500;
  while(!predicate()) { if(performance.now()>end)throw new Error('test condition deadline');await new Promise(r=>setTimeout(r,2)); }
}
test('queued HTTP request rechecks freshness before sending any bytes',async()=>{
  const a=await server(), records=[];
  const t=new RawBroadcaster([a.url],{timeoutMs:1000,record:(...x)=>records.push(x)});
  try {
    const first=t.broadcast('0x01',H), second=t.broadcast('0x01',H);
    await until(()=>a.requests.length===2);
    let fresh=true;
    const third=t.broadcast('0x01',H,()=>fresh); const rejected=assert.rejects(third,AggregateError);
    fresh=false; a.release(); await Promise.all([first,second,rejected]);
    assert.equal(a.requests.length,2);
    assert.equal(records.filter(([type])=>type==='POST_started').length,2);
  } finally {t.close();await a.close();}
});
test('queued timeout cannot send later when a socket becomes available',async()=>{
  const a=await server(),t=new RawBroadcaster([a.url],{timeoutMs:40});
  try {
    const outcomes=[t.broadcast('0x01',H),t.broadcast('0x01',H),t.broadcast('0x01',H)].map(p=>p.catch(e=>e));
    const results=await Promise.all(outcomes); assert.ok(results.every(x=>x instanceof AggregateError));
    a.release();await new Promise(r=>setTimeout(r,20));assert.ok(a.requests.length<=2);
  } finally {t.close();await a.close();}
});
test('closing broadcaster cancels active and queued requests and forbids new work',async()=>{
  const a=await server(),t=new RawBroadcaster([a.url],{timeoutMs:1000});
  try {
    const attempts=[t.broadcast('0x01',H),t.broadcast('0x01',H),t.broadcast('0x01',H)].map(p=>p.catch(e=>e));
    await until(()=>a.requests.length===2);t.close();
    assert.ok((await Promise.all(attempts)).every(x=>x instanceof Error));
    await assert.rejects(t.broadcast('0x01',H),/closed/);
    assert.equal(a.requests.length,2);
  } finally {t.close();await a.close();}
});
test('a socket-stage freshness exception is handled without a POST',async()=>{
  const a=await server();let calls=0;
  const t=new RawBroadcaster([a.url]);
  try {
    await assert.rejects(t.broadcast('0x01',H,()=>{if(++calls>1)throw new Error('state halted');return true;}));
    assert.equal(a.requests.length,0);
  } finally {t.close();await a.close();}
});
