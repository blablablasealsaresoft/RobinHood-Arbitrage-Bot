import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RelayerJournal } from '../native/transport.mjs';
const A='0x'+'1'.repeat(40),H='0x'+'2'.repeat(64);
const directory=()=>fs.mkdtempSync(path.join(os.tmpdir(),'arb-journal-'));
const entry={nonce:7n,hash:H,raw:'0xabcdef',anchorBlock:12n};
function fixture(t){const dir=directory(),j=new RelayerJournal(dir,A);t.after(()=>{j.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,j};}
test('journal completes short writes before returning durable signed bytes',t=>{
 const {j}=fixture(t),original=fs.writeSync;let calls=0;
 fs.writeSync=(fd,b,offset,length,position)=>{if(fd!==j.fd)return original(fd,b,offset,length,position);calls++;return Buffer.isBuffer(b)?original(fd,b,offset,Math.min(length,7),position):original(fd,b.slice(0,7));};
 try{j.append(entry);}finally{fs.writeSync=original;}
 assert.ok(calls>1);const stored=JSON.parse(fs.readFileSync(j.filename,'utf8'));assert.equal(stored.raw,entry.raw);assert.equal(stored.hash,H);assert.equal(stored.nonce,'7');
});
test('journal retries interrupted writes without duplicating a record',t=>{
 const {j}=fixture(t),original=fs.writeSync;let interrupts=0;
 fs.writeSync=(...args)=>{if(args[0]===j.fd&&!interrupts++){const e=new Error('interrupted');e.code='EINTR';throw e;}return original(...args);};
 try{j.append(entry);}finally{fs.writeSync=original;}
 assert.equal(fs.readFileSync(j.filename,'utf8').trim().split('\n').length,1);
});
test('zero-progress write poisons journal and retains restart interlock',t=>{
 const {j}=fixture(t),original=fs.writeSync;
 fs.writeSync=(...args)=>args[0]===j.fd?0:original(...args);
 try{assert.throws(()=>j.append(entry),/write made no progress/);}finally{fs.writeSync=original;}
 assert.throws(()=>j.append(entry),/failed.*reconciliation/);j.close();assert.ok(fs.existsSync(j.lock));
});
test('fsync failure forbids later dispatch history and keeps the lock',t=>{
 const {j}=fixture(t),original=fs.fsyncSync;
 fs.fsyncSync=fd=>{if(fd===j.fd)throw new Error('injected fsync failure');return original(fd);};
 try{assert.throws(()=>j.append(entry),/fsync failure/);}finally{fs.fsyncSync=original;}
 assert.throws(()=>j.append(entry),/failed.*reconciliation/);j.close();assert.ok(fs.existsSync(j.lock));
});
test('journal refuses an existing group/world-accessible directory',()=>{
 const dir=directory();fs.chmodSync(dir,0o755);
 try{assert.throws(()=>new RelayerJournal(dir,A),/private.*directory/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('journal refuses a symlink as its runtime directory',()=>{
 const dir=directory(),actual=path.join(dir,'actual'),link=path.join(dir,'link');fs.mkdirSync(actual,{mode:0o700});fs.symlinkSync(actual,link);
 try{assert.throws(()=>new RelayerJournal(link,A),/private.*directory/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('clean unopened-for-trading journal closes and removes its lock',()=>{
 const dir=directory();try{const j=new RelayerJournal(dir,A);j.close();j.close();assert.deepEqual(fs.readdirSync(dir),[]);assert.throws(()=>j.append(entry),/closed/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
