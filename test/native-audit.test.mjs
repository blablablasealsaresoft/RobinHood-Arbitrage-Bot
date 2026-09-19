import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { auditSnapshot, readOnlyRpc, abiWord } from '../native/audit.mjs';
import { RouteBook, MarketState, quoteRoute } from '../native/core.mjs';
const H='0x'+'a'.repeat(64), S='0x'+'b'.repeat(64), TARGET='0x'+'3'.repeat(40);
const word=n=>'0x'+BigInt(n).toString(16).padStart(64,'0');
function fixture(){
  const config=JSON.parse(fs.readFileSync('native/example.json','utf8'));
  const snapshot=JSON.parse(fs.readFileSync('native/example.ndjson','utf8').split('\n')[0]);
  config.codeHashes={};for(const p of config.pools)for(const a of [p.pair,p.adapter,p.token0,p.token1])config.codeHashes[a]=H;config.codeHashes[TARGET]=H;
  const book=new RouteBook(config.pools,config.routes),state=new MarketState(book);state.ingest(snapshot);
  const out=quoteRoute(book.routes.values().next().value,state.pools,100n).out;
  const calls=[];
  const send=async(method,params)=>{
    calls.push({method,params});
    if(method==='eth_chainId')return '0x1237';
    if(method==='eth_getBlockByNumber')return {number:'0x64',hash:snapshot.blockHash};
    if(method==='eth_getCode')return '0x6000';
    if(method==='eth_call')return params[0].to===TARGET?word(out):word(1);
    throw new Error('unexpected method');
  };
  return {config,snapshot,calls,send,referenceCases:[{routeId:'demo-loop',amountIn:'100',target:TARGET,data:'0x12345678',outputWord:0}],
    stateChecks:()=>[{mode:1,target:config.pools[0].pair,callData:'0x0902f1ac',expectedReturnHash:S}],hashCode:()=>H,hashReturn:()=>S};
}
test('audit uses hash-pinned canonical reads and covers every configured route',async()=>{
  const f=fixture(),r=await auditSnapshot(f);assert.equal(r.pass,true);assert.equal(r.quoteResults.length,1);
  for(const c of f.calls)if(['eth_getCode','eth_call'].includes(c.method))assert.deepEqual(c.params[1],{blockHash:f.snapshot.blockHash,requireCanonical:true});
  assert.equal(f.calls.filter(c=>c.method==='eth_getBlockByNumber').length,2);
});
test('audit fails on state or quote mismatch instead of accepting a tolerance',async()=>{
  let f=fixture();f.hashReturn=()=>H;assert.equal((await auditSnapshot(f)).pass,false);
  f=fixture();const orig=f.send;f.send=(m,p)=>m==='eth_call'&&p[0].to===TARGET?word(999):orig(m,p);
  assert.equal((await auditSnapshot(f)).pass,false);
});
test('audit rejects wrong chain, code hash, missing code pin, and replacement during collection',async()=>{
  let f=fixture();const a=f.send;f.send=(m,p)=>m==='eth_chainId'?'0x1':a(m,p);await assert.rejects(auditSnapshot(f),/chain mismatch/);
  f=fixture();f.hashCode=()=>S;await assert.rejects(auditSnapshot(f),/runtime-code mismatch/);
  f=fixture();delete f.config.codeHashes[TARGET];await assert.rejects(auditSnapshot(f),/pin missing/);
  f=fixture();const b=f.send;let n=0;f.send=(m,p)=>m==='eth_getBlockByNumber'&&++n===2?{number:'0x64',hash:H}:b(m,p);await assert.rejects(auditSnapshot(f),/not canonical/);
});
test('empty quote coverage and malformed reference results fail closed',async()=>{
  const f=fixture();f.referenceCases=[];await assert.rejects(auditSnapshot(f),/reference quote cases/);
  for(const raw of ['0x','0x01','0xzz'])assert.throws(()=>abiWord(raw,0));
  assert.throws(()=>abiWord(word(1),1));assert.equal(abiWord(word(123),0),123n);
});
test('the audit transport cannot submit, sign, impersonate, or modify chain state',async()=>{
  let calls=0;const rpc=readOnlyRpc(async()=>calls++);
  for(const method of ['eth_sendRawTransaction','eth_sendTransaction','personal_sign','anvil_setCode','hardhat_impersonateAccount'])await assert.rejects(rpc(method,[]),/refused/);
  assert.equal(calls,0);
});
