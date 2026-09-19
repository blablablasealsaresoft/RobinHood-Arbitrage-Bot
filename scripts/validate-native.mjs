// Reproducible validation entry point. Missing dependencies/runners are failures,
// never silently skipped tests. No deployment or trading commands are executed.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const offline=process.argv.includes('--offline');
if(process.argv.slice(2).some(a=>a!=='--offline'))throw new Error('usage: node scripts/validate-native.mjs [--offline]');
const output='validation/native';fs.mkdirSync(output,{recursive:true});
const unitFiles=fs.readdirSync('test').filter(f=>/^native-.*\.test\.mjs$/.test(f)&&f!=='native-wire.test.mjs').sort().map(f=>'test/'+f);
const stages=offline?[
  ['offline-tests',process.execPath,['--test',...unitFiles]],
  ['synthetic-core-benchmark',process.execPath,['native/benchmark.mjs','10000']],
]:[
  ['repository-check','npm',['run','check']],
  ['executor-evm','forge',['test','--match-contract','ExecutorV4Test','-vv']],
  ['synthetic-core-benchmark',process.execPath,['native/benchmark.mjs','10000']],
];
const report={schema:1,mode:offline?'offline-only':'repository-build-and-mocked-evm',startedAt:new Date().toISOString(),node:process.version,
  productionReady:false,stages:[],unverified:['trusted Nitro execution bridge','actual venue integration and quote-domain coverage','Robinhood fork','live inclusion and gas performance','competitive ranking']};
for(const [name,cmd,args] of stages){
  const t=process.hrtime.bigint(),r=spawnSync(cmd,args,{encoding:'utf8',timeout:180000,maxBuffer:32*1024*1024});
  const log=(r.stdout||'')+(r.stderr||'')+(r.error?'\n'+r.error.message:'');
  fs.writeFileSync(path.join(output,name+'.log'),log);
  report.stages.push({name,status:r.status===0&&!r.error?'pass':'fail',exitCode:r.status,error:r.error?.message??null,
    durationMs:Number(process.hrtime.bigint()-t)/1e6,logSha256:createHash('sha256').update(log).digest('hex')});
  console.log(`${name}: ${report.stages.at(-1).status}`);
}
report.pass=report.stages.every(s=>s.status==='pass');report.finishedAt=new Date().toISOString();
fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
if(!report.pass)process.exitCode=1;
