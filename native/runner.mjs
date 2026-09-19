// Opt-in runner. Dry replay works without ethers, a provider, keys, or network.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { RouteBook, MarketState, NativeEngine, NonceCoordinator, normalizeCosts, uint, address, stable } from './core.mjs';
import { RawBroadcaster, Telemetry, RelayerJournal } from './transport.mjs';
import { SettlementLedger } from './accounting.mjs';
import { loadExecutionManifest, assertExecutionSocket } from './execution-provenance.mjs';
import { assertOwnedPrivate } from './fs-privacy.mjs';

export async function* frames(stream, maxBytes = 1_048_576) {
  let pending = Buffer.alloc(0);
  for await (const chunk of stream) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      if (end > maxBytes) throw new Error('oversized execution frame');
      const line = pending.subarray(0, end).toString('utf8').trim();
      pending = pending.subarray(end + 1);
      if (line) yield JSON.parse(line);
    }
    if (pending.length > maxBytes) throw new Error('oversized execution frame');
  }
  if (pending.toString('utf8').trim()) throw new Error('truncated execution frame (newline required)');
}

function options(args) {
  const out = { live: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--live') { out.live = true; continue; }
    if (!['--config', '--replay', '--socket'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage: node native/runner.mjs --config FILE (--replay NDJSON | --socket PATH) [--live]');
    out[args[i].slice(2)] = args[++i];
  }
  if (!out.config || Boolean(out.replay) === Boolean(out.socket)) throw new Error('--config and exactly one of --replay/--socket required');
  if (out.live && out.replay) throw new Error('live execution cannot use a replay file');
  return out;
}

// All chain reads are here, BEFORE attaching the execution stream. This is an
// operator-reviewed deployment manifest, not automated contract auditing.
async function preflight(config, book, nonces, record) {
  if (config.executorSchema !== 'repository-v4' || config.reviewed !== true || config.producer !== 'trusted-local-execution-bridge') throw new Error('reviewed repository-v4 deployment and trusted local execution bridge required');
  if (!process.env.NATIVE_PREFLIGHT_RPC_URL || !process.env.NATIVE_STRATEGY_KEY || !process.env.NATIVE_RELAYER_KEY) throw new Error('NATIVE_PREFLIGHT_RPC_URL, NATIVE_STRATEGY_KEY, NATIVE_RELAYER_KEY required for live');
  const provenance = loadExecutionManifest(config, book);
  const { Contract, JsonRpcProvider, keccak256 } = await import('ethers');
  const { createWire, REPOSITORY_V4_ABI, decodeReceipt } = await import('./wire.mjs');
  const signer = createWire({ ...config.transaction, executor: config.executor,
    strategyKey: process.env.NATIVE_STRATEGY_KEY, relayerKey: process.env.NATIVE_RELAYER_KEY, record });
  provenance.assertRelayer(signer.relayerAddress);
  const journal = new RelayerJournal(config.runtimeDirectory || 'native/.runtime', signer.relayerAddress);
  const provider = new JsonRpcProvider(process.env.NATIVE_PREFLIGHT_RPC_URL);
  try {
    if (BigInt(await provider.send('eth_chainId', [])) !== 4663n) throw new Error('preflight RPC is not chain 4663');
    const required = new Set([address(config.executor), address(config.morpho)]);
    for (const p of book.pools.values()) for (const a of [p.pair, p.adapter, p.token0, p.token1, p.stateView, p.tickWindow?.lens].filter(Boolean)) required.add(a);
    const pins = new Map(Object.entries(config.codeHashes || {}).map(([a, h]) => [address(a), h.toLowerCase()]));
    await Promise.all([...required].map(async a => {
      const code = await provider.getCode(a);
      if (code === '0x' || pins.get(a) !== keccak256(code)) throw new Error(`missing/mismatched reviewed runtime-code hash: ${a}`);
    }));
    const executor = new Contract(config.executor, REPOSITORY_V4_ABI, provider);
    const [strategy, allowed, paused, window, delay, domain, morpho, latest, pending] = await Promise.all([
      executor.strategySigner(), executor.relayers(signer.relayerAddress), executor.paused(), executor.maxBlockWindow(),
      executor.maxAnchorDelay(), executor.domainSeparator(), executor.morpho(),
      provider.send('eth_getTransactionCount', [signer.relayerAddress, 'latest']),
      provider.send('eth_getTransactionCount', [signer.relayerAddress, 'pending']),
    ]);
    if (address(strategy) !== address(signer.strategyAddress) || !allowed || paused || window !== 1n || delay !== 1n || domain !== signer.domainSeparator || address(morpho) !== address(config.morpho)) throw new Error('executor configuration/domain/authorization mismatch');
    for (const p of book.pools.values()) {
      if (!(await executor.adapters(p.adapter))) throw new Error('adapter not approved');
      if (p.tickWindow) {
        if (keccak256(p.adapterData) !== p.poolKeyHash) throw new Error('V4 PoolKey hash mismatch');
        const lens = new Contract(p.tickWindow.lens, ['function poolManager() view returns (address)'], provider);
        if (address(await lens.poolManager()) !== p.pair) throw new Error('V4 tick lens manager mismatch');
      }
    }
    for (const route of book.routes.values()) if (await executor.borrowCaps(route.settlementToken) < route.maxInput) throw new Error('on-chain borrow cap below route size');
    nonces.bootstrap({ latest: BigInt(latest), pending: BigInt(pending) });
    const ledger = new SettlementLedger({ executor: config.executor, relayer: signer.relayerAddress, lossLimits: config.sessionLossLimits });
    for (const route of book.routes.values()) if (!ledger.canTrade(route.settlementToken)) throw new Error('missing session loss limit for settlement');
    if (config.receiptFeeModel !== 'gasUsed-times-effectiveGasPrice-inclusive') throw new Error('reviewed inclusive receipt fee model required');
    const broadcaster = new RawBroadcaster(config.submissionUrls, { timeoutMs: config.submitTimeoutMs ?? 250, record });
    await broadcaster.warm();
    record('preflight_complete', { executor: config.executor, relayer: signer.relayerAddress });
    return { ...signer, broadcaster, journal, ledger, decodeReceipt, provenance };
  } catch (error) { journal.close(); throw error; }
  finally { provider.destroy(); }
}

export async function run(args = process.argv.slice(2)) {
  const opt = options(args), config = JSON.parse(fs.readFileSync(opt.config, 'utf8'));
  const book = new RouteBook(config.pools, config.routes);
  const costs = new Map();
  const replaceCosts = entries => {
    if (!Array.isArray(entries) || entries.length > book.routes.size) throw new Error('invalid cost cache');
    const next = new Map();
    for (const item of entries) {
      const token = address(item.settlementToken);
      if (next.has(token)) throw new Error('duplicate cost denomination');
      next.set(token, normalizeCosts(item, token));
    }
    costs.clear(); for (const [key, value] of next) costs.set(key, value);
  };
  replaceCosts(config.costs || []);
  const telemetryPath = config.telemetryPath || 'native/.runtime/telemetry.ndjson';
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true, mode: 0o700 });
  const telemetry = new Telemetry(telemetryPath);
  const record = telemetry.record;
  const nonces = new NonceCoordinator({ maxInFlight: config.maxInFlight ?? 1 });
  const state = new MarketState(book, { maxAgeMs: config.maxStateAgeMs ?? 250 });
  let live = null, input, timer, interrupted = false, failures = 0, opportunities = 0;
  const halt = reason => { state.halt(reason); nonces.uncertain(); record('halt', { reason }); };
  const stop = () => { interrupted = true; halt('operator shutdown'); input?.destroy(); };
  const tasks = new Set();
  let engine, drainHandle;
  const trackDecision = promise => {
    const task = promise.then(result => {
      if (!result) return;
      opportunities++;
      console.log(stable({ mode: opt.live ? 'submitted' : 'dry', key: result.key,
        anchorBlock: result.head.number, route: result.route.id, amount: result.amount,
        grossProfit: result.grossProfit, expectedNumerator: result.expectedNumerator,
        expectedDenominator: result.expectedDenominator, txHash: result.hash ?? null }));
    }).catch(error => { failures++; halt(error.message); console.error(`native: ${error.message}`); });
    tasks.add(task);
    void task.finally(() => { tasks.delete(task); scheduleDrain(); });
  };
  const scheduleDrain = () => {
    if (interrupted || drainHandle || !engine?.hasPendingDecision || engine.working || !state.healthy() || (opt.live && !nonces.available())) return;
    // A single event-loop callback lets a buffered state+receipt group finish
    // ingestion first. There is no unbounded queue of obsolete block decisions.
    drainHandle = setImmediate(() => {
      drainHandle = null;
      if (!interrupted && state.healthy()) trackDecision(engine.drainPending());
    });
  };
  try {
    live = opt.live ? await preflight(config, book, nonces, record) : null;
    engine = new NativeEngine({ book, state, costs, nonces, live: opt.live, record,
      wire: live?.wire, broadcaster: live?.broadcaster,
      beforeSend: entry => { live.journal.append({ type: 'signed', ...entry }); record('journal_persisted', { key: entry.key }); },
      beforeDispatch: (entry, opportunity) => {
        live.ledger.register(entry, opportunity);
        live.journal.append({ type: 'dispatch', nonce: entry.nonce, txHash: entry.hash, key: entry.key });
      },
      canTrade: token => !opt.live || live.ledger.canTrade(token),
    });
    if (opt.socket) {
      if (opt.live) assertExecutionSocket(opt.socket, live.provenance.socketPath);
      const info = fs.lstatSync(opt.socket);
      if (!info.isSocket()) throw new Error('live execution socket must be owner-only and owned by this process user');
      if (opt.live) {
        assertOwnedPrivate(opt.socket, {
          kind: 'socket',
          posixForbidGroupWorld: true,
          message: 'live execution socket must be owner-only and owned by this process user',
        });
      }
      input = net.createConnection(opt.socket);
    } else input = fs.createReadStream(opt.replay);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    if (opt.socket) timer = setInterval(() => {
      if (state.ready && !state.healthy()) halt('execution stream stalled');
      if (telemetry.error || (opt.live && telemetry.dropped)) { halt('telemetry persistence failed or records dropped'); input.destroy(); }
    }, 25);
    for await (const frame of frames(input)) {
      if (opt.live) live.provenance.check(frame);
      record('decoded', { anchorBlock: String(frame.blockNumber ?? ''), anchorHash: frame.blockHash ?? null });
      if (frame.type === 'costs') { replaceCosts(frame.entries); record('costs_updated'); continue; }
      if (frame.type === 'receipt') {
        if (!opt.live) continue;
        const decoded = live.decodeReceipt(frame, config.executor);
        const result = live.ledger.settle(decoded, (number, hash) => state.blocks.get(number.toString()) === hash);
        if (result) {
          nonces.included(result.nonce, result.txHash);
          scheduleDrain();
          live.journal.append({ type: 'receipt', ...result });
          record('included', { nonce: result.nonce.toString(), txHash: result.txHash, executionBlock: result.blockNumber.toString(), status: result.status });
          record('realized_pnl', result);
        }
        continue;
      }
      if (opt.live && frame.type === 'invalidate') {
        const removedTxHashes = live.ledger.invalidateFrom(frame.fromBlock ?? 0);
        record('accounting_invalidated', { ...live.ledger.summary(), removedTxHashes });
      }
      if (opt.live && frame.type !== 'invalidate') {
        const seconds = Number(uint(frame.timestamp, 'timestamp', BigInt(Number.MAX_SAFE_INTEGER)));
        if (Math.abs(Date.now() / 1000 - seconds) > 3) throw new Error('live executed frame outside wall-clock freshness bound');
      }
      // Do not await signing here: a newer block must immediately invalidate an
      // in-flight older signature. NativeEngine serializes decisions, not state.
      trackDecision(engine.onFrame(frame));
    }
    halt('execution stream closed');
    await Promise.allSettled(tasks);
    return { mode: opt.live ? 'live' : 'dry', opportunities, failures, interrupted, ...(live ? { accounting: live.ledger.summary() } : {}) };
  } finally {
    halt('runner stopped'); clearInterval(timer); clearImmediate(drainHandle); input?.destroy();
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await Promise.allSettled(tasks);
    live?.broadcaster.close(); live?.journal.close(); await telemetry.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run().then(result => { console.log(stable(result)); if (result.failures) process.exitCode = 1; })
    .catch(error => { console.error(`native: ${error.message}`); process.exitCode = 1; });
}
