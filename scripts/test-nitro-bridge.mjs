// End-to-end synthetic Go storage capture -> existing JS decision engine.
// No live node, EVM, keys, RPC, signing or network is involved.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { RouteBook, MarketState, NativeEngine, NonceCoordinator, normalizeCosts } from '../native/core.mjs';
const text = execFileSync('go', ['run', './cmd/fixture'], { cwd: 'native/nitro-exporter', encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local', GOPROXY: 'off', GOSUMDB: 'off' } });
const frames = text.trim().split('\n').map(JSON.parse);
assert.equal(frames.length, 2);
const config = JSON.parse(fs.readFileSync('native/example.json', 'utf8'));
const book = new RouteBook(config.pools, config.routes), state = new MarketState(book);
const costs = new Map(config.costs.map(c => [c.settlementToken, normalizeCosts(c, c.settlementToken)]));
const engine = new NativeEngine({ book, state, costs, nonces: new NonceCoordinator(), live: false });
assert.equal(await engine.onFrame(frames[0]), null);
const result = await engine.onFrame(frames[1]);
assert.ok(result && result.grossProfit > 0n);
assert.equal(state.head.number, 101n);
assert.equal(state.pools.get('demo-a').reserve1, 2010000n);
assert.equal(frames[1].executionSource.kind, 'nitro-in-process');
console.log(JSON.stringify({ pass: true, synthetic: true, nodeOrEVMExecuted: false, frameCount: frames.length, route: result.route.id, amount: result.amount.toString(), grossProfit: result.grossProfit.toString() }));
