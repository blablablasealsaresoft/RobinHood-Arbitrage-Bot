// Compiled Go capture -> actual JS pricing/sizing, including a zero-L gap.
// All values and identities are SYNTHETIC. No node/EVM/RPC/signing/trade occurs.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { RouteBook, MarketState, NativeEngine, NonceCoordinator, normalizeCosts } from '../native/core.mjs';
import { quoteV4Window } from '../native/v4-ticks.mjs';
const fixture=JSON.parse(fs.readFileSync('test/fixtures/v4-window-bridge.json','utf8'));
assert.equal(fixture.synthetic,true);assert.equal(fixture.consumerConfig.reviewed,false);
const text=execFileSync('go',['run','./cmd/windowfixture','../../test/fixtures/v4-window-bridge.json'],{cwd:'native/nitro-exporter',encoding:'utf8',env:{...process.env,GOTOOLCHAIN:'local',GOPROXY:'off',GOSUMDB:'off'}});
const frames=text.trim().split('\n').map(JSON.parse),config=fixture.consumerConfig;
assert.equal(frames.length,2);
const book=new RouteBook(config.pools,config.routes),state=new MarketState(book,{maxAgeMs:10000});
const costs=new Map(config.costs.map(c=>[c.settlementToken,normalizeCosts(c,c.settlementToken)]));
const engine=new NativeEngine({book,state,costs,nonces:new NonceCoordinator(),live:false});
assert.equal(await engine.onFrame(frames[0]),null);
const result=await engine.onFrame(frames[1]);
assert.ok(result&&result.grossProfit>0n);assert.equal(state.pools.get('window').liquidity,0n);
const quote=quoteV4Window(state.pools.get('window'),result.route.settlementToken,result.amount);
assert.equal(quote.crossings,1);assert.ok(quote.liquidity>0n);
console.log(JSON.stringify({pass:true,synthetic:true,nodeOrEVMExecuted:false,frameCount:frames.length,route:result.route.id,amount:result.amount.toString(),grossProfit:result.grossProfit.toString(),crossings:quote.crossings}));
