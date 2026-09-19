// Quote-free decision core. No provider, socket, wallet or RPC dependency.
import { createHash } from 'node:crypto';
import { sqrtAtTick, concentratedQuote, concentratedCoefficients } from './concentrated.mjs';

export const BPS = 10_000n;
const MAX_UINT = (1n << 256n) - 1n;
export function uint(value, label = 'integer', max = MAX_UINT) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${label}: unsafe number`);
  if (!['number', 'string', 'bigint'].includes(typeof value) || !/^\d+$/.test(String(value))) {
    throw new Error(`${label}: unsigned integer required`);
  }
  const n = BigInt(value);
  if (n > max) throw new Error(`${label}: out of range`);
  return n;
}
export function address(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value) || /^0x0{40}$/i.test(value)) {
    throw new Error('nonzero ERC-20/contract address required');
  }
  return value.toLowerCase();
}
export function hash32(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/i.test(value)) {
    throw new Error('nonzero block hash required');
  }
  return value.toLowerCase();
}
export function stable(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export const fingerprint = value => createHash('sha256').update(stable(value)).digest('hex');
export const ceilDiv = (a, b) => (a + b - 1n) / b;
export function isqrt(n) {
  n = BigInt(n);
  if (n < 0n) throw new Error('negative square root');
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
const clamp = (n, lo, hi) => n < lo ? lo : n > hi ? hi : n;
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };

// V2's exact integer formula, not a spot-price approximation. Fee metadata must
// come from a reviewed, immutable deployment; it is NOT inferred from the ticker.
export function v2Quote(pool, tokenIn, amount) {
  amount = uint(amount, 'amountIn');
  const forward = address(tokenIn) === pool.token0;
  if (!forward && address(tokenIn) !== pool.token1) throw new Error('token not in pool');
  const [rin, rout] = forward ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0];
  if (!rin || !rout) throw new Error('empty pool');
  if (rin + amount >= 1n << 112n) throw new Error('V2 reserve overflow');
  const a = amount * pool.feeNumerator;
  return a * rout / (rin * pool.feeDenominator + a);
}

function compilePool(p) {
  if (typeof p.id !== 'string' || !p.id || p.id.length > 128) throw new Error('pool id required');
  // Never silently apply x*y=k to RobinFun, Pons, V3 ticks or V4 hooks.
  if (!['v2', 'v3', 'v4'].includes(p.kind)) throw new Error(`unsupported local venue model: ${p.kind}`);
  const token0 = address(p.token0), token1 = address(p.token1);
  if (token0 === token1) throw new Error('identical pool tokens');
  if (p.kind !== 'v2') {
    const feePips = uint(p.feePips, 'feePips', 999_999n);
    if (p.kind === 'v4' && p.hooks !== '0x0000000000000000000000000000000000000000') throw new Error('V4 hooks are not modeled');
    if (typeof p.adapterData !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(p.adapterData)) throw new Error('precompiled adapterData required');
    return Object.freeze({ id: p.id, kind: p.kind, pair: address(p.pair), token0, token1,
      feePips, adapter: address(p.adapter), adapterData: p.adapterData,
      ...(p.kind === 'v4' ? { stateView: address(p.stateView), poolKeyHash: hash32(p.poolKeyHash) } : {}) });
  }
  const feeDenominator = uint(p.feeDenominator, 'feeDenominator', 1_000_000n);
  const feeNumerator = uint(p.feeNumerator, 'feeNumerator', feeDenominator);
  if (!feeNumerator || !feeDenominator) throw new Error('invalid pool fee');
  return Object.freeze({ id: p.id, kind: p.kind, pair: address(p.pair), token0, token1,
    feeNumerator, feeDenominator, adapter: address(p.adapter) });
}
function poolState(metadata, update) {
  if (metadata.kind !== 'v2') {
    if (typeof update.tick !== 'number' || !Number.isInteger(update.tick) || update.tick < -887271 || update.tick >= 887271) throw new Error('unsupported tick');
    const sqrtPriceX96 = uint(update.sqrtPriceX96, 'sqrtPriceX96', (1n << 160n) - 1n);
    const lowerX96 = sqrtAtTick(update.tick), upperX96 = sqrtAtTick(update.tick + 1);
    if (sqrtPriceX96 < lowerX96 || sqrtPriceX96 > upperX96) throw new Error('tick/price mismatch');
    const liquidity = uint(update.liquidity, 'liquidity', (1n << 128n) - 1n);
    const fields = metadata.kind === 'v3' ? {
      observationIndex: uint(update.observationIndex, 'observationIndex', 65535n),
      observationCardinality: uint(update.observationCardinality, 'observationCardinality', 65535n),
      observationCardinalityNext: uint(update.observationCardinalityNext, 'observationCardinalityNext', 65535n),
      feeProtocol: uint(update.feeProtocol, 'feeProtocol', 255n), unlocked: update.unlocked,
    } : { protocolFee: uint(update.protocolFee, 'protocolFee', (1n << 24n) - 1n), lpFee: uint(update.lpFee, 'lpFee', 999999n) };
    if (metadata.kind === 'v3' && fields.unlocked !== true) throw new Error('locked pool');
    if (metadata.kind === 'v4' && fields.lpFee !== metadata.feePips) throw new Error('dynamic/mismatched V4 fee');
    if (metadata.kind === 'v4' && ((fields.protocolFee & 4095n) > 1000n || (fields.protocolFee >> 12n) > 1000n)) throw new Error('invalid V4 protocol fee');
    return Object.freeze({ ...metadata, ...fields, sqrtPriceX96, tick: update.tick, liquidity, lowerX96, upperX96 });
  }
  const reserve0 = uint(update.reserve0, 'reserve0', (1n << 112n) - 1n);
  const reserve1 = uint(update.reserve1, 'reserve1', (1n << 112n) - 1n);
  return Object.freeze({ ...metadata, reserve0, reserve1 });
}

export class RouteBook {
  constructor(pools, routes) {
    this.pools = new Map(); this.routes = new Map(); this.affected = new Map();
    const identities = new Set();
    if (!Array.isArray(pools) || !pools.length || pools.length > 256) throw new Error('1..256 pools required');
    for (const input of pools) {
      const p = compilePool(input);
      if (this.pools.has(p.id)) throw new Error('duplicate pool id');
      // Aliases of the same physical pool would incorrectly simulate independent
      // liquidity and can manufacture a fictitious roundtrip profit.
      const identity = p.kind === 'v4' ? `v4:${p.pair}:${p.poolKeyHash}` : `pair:${p.pair}`;
      if (identities.has(identity)) throw new Error('duplicate physical pool');
      identities.add(identity);
      this.pools.set(p.id, p); this.affected.set(p.id, new Set());
    }
    if (!Array.isArray(routes) || !routes.length || routes.length > 1024) throw new Error('1..1024 routes required');
    for (const input of routes) {
      if (typeof input.id !== 'string' || !input.id || this.routes.has(input.id)) throw new Error('unique route id required');
      const settlementToken = address(input.settlementToken);
      let token = settlementToken;
      const seen = new Set();
      if (!Array.isArray(input.legs) || input.legs.length < 2 || input.legs.length > 6) throw new Error('2..6 legs required');
      const legs = input.legs.map(leg => {
        const p = this.pools.get(leg.poolId);
        if (!p || seen.has(p.id)) throw new Error('unknown/repeated pool in route');
        seen.add(p.id);
        if (address(leg.tokenIn) !== token) throw new Error('route discontinuity');
        const tokenOut = address(leg.tokenOut);
        if (!((token === p.token0 && tokenOut === p.token1) || (token === p.token1 && tokenOut === p.token0))) {
          throw new Error('route tokens not in pool');
        }
        const compiled = Object.freeze({ poolId: p.id, tokenIn: token, tokenOut, adapter: p.adapter, data: p.adapterData || '0x' });
        token = tokenOut; this.affected.get(p.id).add(input.id); return compiled;
      });
      if (token !== settlementToken) throw new Error('route is not a closed loop');
      if (legs.reduce((n, l) => n + (this.pools.get(l.poolId).kind === 'v2' ? 1 : 2), 0) > 8) throw new Error('route exceeds state-check budget');
      const minInput = uint(input.minInput, 'minInput');
      const borrowCap = uint(input.borrowCap, 'borrowCap');
      const maxInput = uint(input.maxInput, 'maxInput', borrowCap);
      if (!minInput || maxInput < minInput) throw new Error('invalid route size limits');
      const slippageBps = uint(input.slippageBps ?? 0, 'slippageBps', 2000n);
      const minProfit = uint(input.minProfit ?? 0, 'minProfit');
      const route = { id: input.id, settlementToken, legs: Object.freeze(legs), minInput, maxInput,
        borrowCap, slippageBps, minProfit };
      this.routes.set(route.id, Object.freeze({ ...route, templateHash: fingerprint(route) }));
    }
  }
  affectedRoutes(ids) { return [...new Set(ids.flatMap(id => [...this.affected.get(id)]))].map(id => this.routes.get(id)); }
}

// The producer must be a trusted LOCAL EXECUTION bridge, not a feed-calldata
// decoder. This validates ordering/completeness claims; it does not execute EVM
// bytecode or cryptographically prove the supplied reserves. See README.md.
export class MarketState {
  constructor(book, { clock = () => performance.now(), maxAgeMs = 250, historySize = 256 } = {}) {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) throw new Error('positive maxAgeMs required');
    if (!Number.isInteger(historySize) || historySize < 1 || historySize > 8192) throw new Error('historySize must be 1..8192');
    this.frameDigests = new Map(); this.poolFingerprints = new Map();
    this.book = book; this.clock = clock; this.maxAgeMs = maxAgeMs; this.historySize = historySize;
    this.pools = new Map(); this.history = new Map(); this.blocks = new Map(); this.head = null;
    this.epoch = 0; this.ready = false; this.reason = 'bootstrap required'; this.lastAdvance = -Infinity;
  }
  halt(reason) { this.ready = false; this.reason = reason; this.epoch++; }
  healthy() {
    if (this.ready && this.clock() - this.lastAdvance > this.maxAgeMs) this.halt('execution stream stalled');
    return this.ready;
  }
  ingest(frame) {
    try { return this.#ingest(frame); }
    catch (error) { this.halt(error.message); throw error; }
  }
  #ingest(frame) {
    if (frame.type === 'invalidate') { this.halt(String(frame.reason || 'upstream invalidation')); return null; }
    if (!['snapshot', 'block'].includes(frame.type)) throw new Error('unknown state frame');
    if (frame.schema !== 1 || uint(frame.chainId) !== 4663n || frame.complete !== true) throw new Error('incomplete/wrong-chain frame');
    const sequence = uint(frame.sequence, 'sequence', (1n << 64n) - 1n);
    const number = uint(frame.blockNumber, 'blockNumber', (1n << 64n) - 2n);
    const hash = hash32(frame.blockHash), parent = hash32(frame.parentHash);
    const timestamp = uint(frame.timestamp, 'timestamp', (1n << 64n) - 1n);
    if (hash32(frame.feedBlockHash) !== hash) throw new Error('executed/feed block hash mismatch');
    if (!Array.isArray(frame.updates) || frame.updates.length > this.book.pools.size) throw new Error('invalid updates');
    const isSnapshot = frame.type === 'snapshot';
    if (isSnapshot) {
      if (this.ready) throw new Error('unsolicited snapshot while healthy');
      if (frame.updates.length !== this.book.pools.size) throw new Error('snapshot must contain every watched pool');
    } else {
      if (!this.head || !this.pools.size) throw new Error('bootstrap required');
      if (!this.ready && this.reason !== 'awaiting contiguous block') throw new Error('reconciliation required');
      const known = this.history.get(sequence.toString());
      if (known) {
        if (known !== hash) throw new Error('sequence replacement');
        if (this.frameDigests.get(sequence.toString()) !== fingerprint(frame)) throw new Error('conflicting duplicate execution frame');
        return null; // Replayed frames do not refresh the freshness clock.
      }
      if (sequence !== this.head.sequence + 1n || number !== this.head.number + 1n) throw new Error('sequence/block gap');
      if (parent !== this.head.hash) throw new Error('parent hash mismatch');
      if (timestamp < this.head.timestamp) throw new Error('timestamp moved backwards');
    }
    const activating = !isSnapshot && !this.ready;
    const next = isSnapshot ? new Map() : new Map(this.pools);
    const nextFingerprints = isSnapshot ? new Map() : new Map(this.poolFingerprints);
    const changed = []; const seen = new Set();
    for (const update of frame.updates) {
      const meta = this.book.pools.get(update.poolId);
      if (!meta || seen.has(update.poolId)) throw new Error('unknown/duplicate pool update');
      seen.add(update.poolId);
      const p = poolState(meta, update), previous = next.get(p.id), digest = fingerprint(p);
      const same = previous && nextFingerprints.get(p.id) === digest;
      if (!same) changed.push(p.id);
      next.set(p.id, same ? previous : p); nextFingerprints.set(p.id, digest);
    }
    // Publish only after every field/update validated: no partially applied block.
    if (isSnapshot) { this.history.clear(); this.blocks.clear(); this.frameDigests.clear(); this.epoch++; }
    this.pools = next; this.poolFingerprints = nextFingerprints; this.head = Object.freeze({ sequence, number, hash, parent, timestamp });
    this.history.set(sequence.toString(), hash);
    this.frameDigests.set(sequence.toString(), fingerprint(frame));
    this.blocks.set(number.toString(), hash);
    while (this.blocks.size > this.historySize) this.blocks.delete(this.blocks.keys().next().value);
    while (this.history.size > this.historySize) {
      const oldest = this.history.keys().next().value;
      this.history.delete(oldest); this.frameDigests.delete(oldest);
    }
    this.lastAdvance = this.clock(); this.ready = !isSnapshot;
    this.reason = isSnapshot ? 'awaiting contiguous block' : '';
    return { head: this.head, changed: activating ? [...this.book.pools.keys()] : changed, ready: this.ready, epoch: this.epoch };
  }
  matches(head, epoch) { return this.healthy() && this.epoch === epoch && this.head.hash === head.hash; }
}

export function quoteRoute(route, pools, amount) {
  let out = amount; const outputs = [];
  for (const leg of route.legs) {
    const p = pools.get(leg.poolId);
    if (!p) throw new Error('missing pool state');
    out = p.kind === 'v2' ? v2Quote(p, leg.tokenIn, out) : concentratedQuote(p, leg.tokenIn, out); outputs.push(out);
    if (out === 0n) break;
  }
  return { amount, out, grossProfit: out - amount, outputs };
}

// Compose continuous V2 functions A*q/(B+C*q), solve their stationary point,
// then evaluate the actual integer route near it. This is bounded local sizing,
// not a claim of globally optimal integer profit. Small domains are exhaustive.
export function optimizeRoute(route, pools) {
  let A = 1n, B = 1n, C = 0n;
  for (const leg of route.legs) {
    const p = pools.get(leg.poolId);
    let coefficients;
    if (p.kind === 'v2') {
      const forward = leg.tokenIn === p.token0;
      const rin = forward ? p.reserve0 : p.reserve1, rout = forward ? p.reserve1 : p.reserve0;
      if (!rin || !rout) return null;
      coefficients = [p.feeNumerator * rout, p.feeDenominator * rin, p.feeNumerator];
    } else {
      if (!p.liquidity) return null;
      coefficients = concentratedCoefficients(p, leg.tokenIn);
    }
    const [a, b, c] = coefficients;
    [A, B, C] = [a * A, b * B, b * C + c * A];
    const d = gcd(gcd(A, B), C); A /= d; B /= d; C /= d;
  }
  // Feasibility is monotone for the supported fixed-fee, no-crossing routes.
  // Clip the local search to the largest completely modeled input.
  let maxInput = route.maxInput;
  try { quoteRoute(route, pools, route.minInput); } catch { return null; }
  try { quoteRoute(route, pools, maxInput); } catch {
    let lo = route.minInput, hi = maxInput;
    while (lo < hi) {
      const mid = (lo + hi + 1n) / 2n;
      try { quoteRoute(route, pools, mid); lo = mid; } catch { hi = mid - 1n; }
    }
    maxInput = lo;
  }
  const q = clamp((isqrt(A * B) - B) / C, route.minInput, maxInput);
  const candidates = new Set([route.minInput, maxInput, q]);
  if (maxInput - route.minInput <= 128n) {
    for (let x = route.minInput; x <= maxInput; x++) candidates.add(x);
  } else {
    for (let d = -4n; d <= 4n; d++) candidates.add(clamp(q + d, route.minInput, maxInput));
  }
  let best = null;
  for (const amount of candidates) {
    let item;
    try { item = quoteRoute(route, pools, amount); } catch { continue; }
    if (item.outputs.length !== route.legs.length || item.outputs.some(x => x === 0n)) continue;
    if (!best || item.grossProfit > best.grossProfit || (item.grossProfit === best.grossProfit && item.amount < best.amount)) best = item;
  }
  return best;
}

export function expectedValueGate({ grossProfit, successGasCost, revertGasCost, loseRaceBps, minExpectedValue = 0n }) {
  grossProfit = BigInt(grossProfit); successGasCost = uint(successGasCost); revertGasCost = uint(revertGasCost);
  loseRaceBps = uint(loseRaceBps, 'loseRaceBps', BPS); minExpectedValue = uint(minExpectedValue);
  const weighted = (BPS - loseRaceBps) * (grossProfit - successGasCost) - loseRaceBps * revertGasCost;
  // Compare the numerator so truncation towards zero cannot hide a negative EV.
  return { pass: grossProfit > 0n && weighted > BPS * minExpectedValue,
    expectedNumerator: weighted, expectedDenominator: BPS };
}

export function normalizeCosts(input, settlementToken) {
  if (address(input.settlementToken) !== settlementToken) throw new Error('cost denomination mismatch');
  // Price is settlement BASE UNITS per native wei. Explicit rational conversion
  // prevents mixing USDG decimal units and wei. Round costs UP, not down.
  const numerator = uint(input.settlementUnitsPerWeiNumerator);
  const denominator = uint(input.settlementUnitsPerWeiDenominator);
  if (!numerator || !denominator) throw new Error('positive gas conversion required');
  return Object.freeze({ settlementToken,
    settlementUnitsPerWeiNumerator: numerator, settlementUnitsPerWeiDenominator: denominator,
    validUntilBlock: uint(input.validUntilBlock),
    successGasCost: ceilDiv(uint(input.successGasWei) * numerator, denominator),
    revertGasCost: ceilDiv(uint(input.revertGasWei) * numerator, denominator),
    loseRaceBps: uint(input.loseRaceBps, 'loseRaceBps', BPS),
    minExpectedValue: uint(input.minExpectedValue ?? 0) });
}

export class OpportunityDedupe {
  constructor(limit = 4096) { this.limit = limit; this.map = new Map(); }
  take(key, block) {
    if (this.map.has(key)) return false;
    this.map.set(key, block);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    return true;
  }
  clear() { this.map.clear(); }
}

export class NonceCoordinator {
  constructor({ maxInFlight = 1 } = {}) {
    this.maxInFlight = Number(uint(maxInFlight, 'maxInFlight', 64n));
    if (!this.maxInFlight) throw new Error('maxInFlight must be positive');
    this.next = null; this.pending = new Map(); this.blocked = false;
  }
  bootstrap({ latest, pending }) {
    if (this.pending.size) throw new Error('cannot resync unresolved reservations');
    latest = uint(latest, 'latest nonce', BigInt(Number.MAX_SAFE_INTEGER));
    pending = uint(pending, 'pending nonce', BigInt(Number.MAX_SAFE_INTEGER));
    if (latest !== pending) throw new Error('external pending nonce requires reconciliation');
    this.next = latest; this.blocked = false;
  }
  available() { return this.next !== null && !this.blocked && this.pending.size < this.maxInFlight; }
  reserve() {
    if (!this.available()) throw new Error('nonce coordinator unavailable');
    const nonce = this.next++; this.pending.set(nonce, { state: 'reserved', hash: null }); return nonce;
  }
  releaseUnsent(nonce) {
    const item = this.pending.get(nonce);
    if (!item || item.state !== 'reserved' || nonce !== this.next - 1n) throw new Error('cannot recycle this nonce');
    this.pending.delete(nonce); this.next--;
  }
  submitted(nonce, hash) {
    const item = this.pending.get(nonce);
    if (!item || item.state !== 'reserved') throw new Error('invalid nonce transition');
    item.state = 'submitted'; item.hash = hash32(hash);
  }
  uncertain() { this.blocked = true; }
  included(nonce, hash) {
    nonce = uint(nonce); const item = this.pending.get(nonce);
    if (!item || item.hash !== hash32(hash)) throw new Error('unknown receipt');
    this.pending.delete(nonce);
    // An ambiguous-send halt requires an explicit operator restart/reconciliation.
  }
}

export class NativeEngine {
  constructor({ book, state, costs, wire, broadcaster, nonces, live = false, record = () => {}, beforeSend = () => {}, beforeDispatch = () => {}, canTrade = () => true }) {
    Object.assign(this, { book, state, costs, wire, broadcaster, nonces, live, record, beforeSend, beforeDispatch, canTrade });
    this.dedupe = new OpportunityDedupe(); this.working = false; this.lastEpoch = state.epoch;
  }
  async onFrame(frame) {
    const trace = { anchorBlock: String(frame.blockNumber ?? ''), anchorHash: frame.blockHash ?? null };
    this.record('frame_received', trace);
    this.state.healthy();
    let change;
    try { change = this.state.ingest(frame); } catch (error) { if (this.live) this.nonces.uncertain(); throw error; }
    if (this.live && frame.type === 'invalidate') this.nonces.uncertain();
    this.record('state_updated', trace);
    if (this.lastEpoch !== this.state.epoch) { this.dedupe.clear(); this.lastEpoch = this.state.epoch; }
    if (!change?.ready || this.working || !this.state.healthy()) return null;
    const { head, epoch } = change;
    if (this.live && !this.nonces.available()) { this.record('nonce_backpressure'); return null; }
    let best = null;
    for (const route of this.book.affectedRoutes(change.changed)) {
      if (!this.canTrade(route.settlementToken)) { this.record('risk_backpressure', trace); continue; }
      const costs = this.costs.get(route.settlementToken);
      if (!costs || costs.validUntilBlock < head.number + 1n) continue;
      const q = optimizeRoute(route, this.state.pools);
      if (!q || q.grossProfit < route.minProfit) continue;
      const gate = expectedValueGate({ grossProfit: q.grossProfit, ...costs });
      if (!gate.pass) continue;
      const candidate = { ...q, ...gate, route, costs };
      // Native units of distinct settlement tokens are not comparable. Book order
      // is the explicit priority between tokens; compare EV only within a token.
      if (!best || (best.route.settlementToken === route.settlementToken && candidate.expectedNumerator > best.expectedNumerator)) best = candidate;
    }
    this.record('q_optimized', trace);
    if (!best) return null;
    const selectedPools = best.route.legs.map(l => this.state.pools.get(l.poolId));
    const relevantStateHash = fingerprint(best.route.legs.map(l => this.state.poolFingerprints.get(l.poolId)));
    const key = fingerprint([head.hash, best.route.templateHash, best.route.settlementToken, relevantStateHash]);
    if (!this.dedupe.take(key, head.number)) return null;
    const opportunity = { ...best, head, epoch, key, relevantStateHash, pools: selectedPools };
    this.record('opportunity_found', { ...trace, key, routeId: best.route.id, amount: best.amount.toString(), grossProfit: best.grossProfit.toString() });
    if (!this.live) return opportunity;
    this.working = true;
    let nonce = null, dispatched = false;
    // Recheck costs and risk after asynchronous signing/journaling too. A cost
    // revision must not leave an old positive-EV decision sendable.
    const fresh = () => this.state.matches(head, epoch) && this.costs.get(best.route.settlementToken) === best.costs && (dispatched || this.canTrade(best.route.settlementToken));
    try {
      if (!fresh()) return null;
      nonce = this.nonces.reserve();
      const signed = await this.wire(opportunity, nonce);
      this.record('signed', { key, txHash: signed.hash });
      if (!fresh()) { this.nonces.releaseUnsent(nonce); nonce = null; return null; }
      // A caller may durably journal before dispatch. Its latency is measured,
      // never concealed inside a claimed feed->submit benchmark.
      await this.beforeSend({ nonce, ...signed, anchorBlock: head.number, key });
      if (!fresh()) { this.nonces.releaseUnsent(nonce); nonce = null; return null; }
      this.nonces.submitted(nonce, signed.hash); dispatched = true;
      // Register before POST: a receipt can arrive before its HTTP ACK.
      this.beforeDispatch({ nonce, ...signed, anchorBlock: head.number, key }, opportunity);
      const sent = await this.broadcaster.broadcast(signed.raw, signed.hash, fresh);
      this.record('accepted', { key, txHash: signed.hash, path: sent.path });
      return { ...opportunity, hash: signed.hash, nonce };
    } catch (error) {
      if (dispatched) this.nonces.uncertain();
      else if (nonce !== null) this.nonces.releaseUnsent(nonce);
      this.record('submission_error', { message: error.message, ambiguous: dispatched });
      throw error;
    } finally { this.working = false; }
  }
}
