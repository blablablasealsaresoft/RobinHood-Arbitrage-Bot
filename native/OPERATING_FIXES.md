# Local operating fixes and observed quote parity — 19 September 2026

## Publication boundary

This increment is local and is not a GitHub commit. The last verified published
head of draft PR #4 is `8d48626b734801503b137db4e3be13d20a366709`.
The preceding V4 tick-window increment also remains unpublished. The cumulative
review patch includes both increments; it does not enable production trading.
No contracts were deployed, funds moved, live transactions sent, or node started.

## Three reproduced operating defects

### New blocks received while a signature is in flight

The prior engine applied a newer state frame immediately but returned when the
signer was busy, dropping the opportunity evaluation associated with that frame.
The fix coalesces affected pool IDs and retains one latest anchor, without
coalescing or skipping the state transitions themselves. After the old signature
finishes, the runtime schedules one bounded drain against the newest state.
An unchanged newer block also retains dependencies of a signature abandoned
before dispatch. Nonce backpressure retains pending dependencies until a receipt
frees capacity. Epoch changes, replacements and stalls discard obsolete work.

This is a serial signer with bounded pending dependencies, not parallel nonce
allocation. Ambiguous dispatch still halts the coordinator; it never rewinds an
uncertain nonce. A receipt is registered before the first POST, as before.
The dependency-free tests use synthetic signing/receipt controls. Live runner
preflight and actual signing still require the unexecuted dependency suite.

### HTTP connection-pool queue outlives an opportunity

The old freshness check ran before `http.request`; a request could then wait for
a busy persistent socket with already-buffered signed bytes. New requests wait
for a ready socket (and TLS handshake for a new HTTPS connection), recheck
freshness immediately before `req.end`, and record `POST_started` at that point.
Closing the broadcaster cancels tracked active and queued requests and refuses
new broadcasts. Deadlines remain attempt-wide, including socket wait time.

Real localhost HTTP tests reproduce stale queued dispatch and shutdown behavior.
Those four tests had three failures before the patch and all pass after it.
They are not a measurement or live test of Robinhood's remote endpoint, and do
not exercise remote TLS infrastructure. A send already started cannot be recalled;
uncertain outcomes still require nonce reconciliation.

### Incomplete or failed journal persistence

A single `writeSync` may write fewer bytes than requested. Journal writes now
loop until complete, retry a bounded number of interruptions, reject zero progress,
and only return after `fsync`. Persistence failure permanently poisons that
journal instance and retains the restart lock. New journal/lock directory entries
are synced before trading; no signed history is automatically discarded.

The runtime directory must be owner-only, owned by the process and not a symlink.
The lock remains local-filesystem/single-host protection, not a distributed lock.
Seven injected-I/O/filesystem tests failed on the prior implementation and pass
after the change. This is fault injection, not an actual power-loss experiment or
proof about an arbitrary filesystem's fsync semantics. Journal latency remains on
the critical path and must be included in deployment measurements.

## Actual provider-reported quote comparisons

A candidate key extracted from public transaction calldata was compared with an
observed V4 Swap pool ID using a provider `web3_sha3` call:

- Pool: `0xe4930a6215f21aa3b37c01adbded3362f56ae31b9a60066f5f9641e601d5111f`
- Currency 0: `0x5fc5360d0400a0fd4f2af552add042d716f1d168`
- Currency 1: `0xe0444ef8bf4ed74f74fd73686e2ddf4c1c5591e8`
- Static LP fee: 10000 pips; tick spacing 100; hooks zero.
- Mainnet block: **67,287,800** (`0x402baf8`), **2026-09-19 18:13:08 UTC**.
- Hash: `0x44f9da9302bdbe39e5f29ed45e0d891cae5dd487231205680681dc9100304b9e`.
- Active liquidity: `86928024356806040`; tick `233585`.

| Direction | Input base units | Local output = reference output |
| --- | ---: | ---: |
| 0 to 1 | 10000 | 137773166826979 |
| 0 to 1 | 1000000 | 13777437672305491 |
| 1 to 0 | 1000000000000 | 70 |
| 1 to 0 | 100000000000000 | 7099 |

Both the existing single-integer-tick quote and V4 partial-step math match all
four reference outputs exactly. Each calculation stays inside one integer tick.
The fixture includes raw ABI return values and request calldata. Reads were
pinned to the numeric block tag and the selected boundary headers matched.
The observed bitmap word is retained as auxiliary evidence; its initialized
liquidity records were NOT all collected and it is not a complete simulation book.

This is one provider at one block, not independent state proof, a full initialized
book, token transfer/tax review, code identity verification, full router decode,
actual adapter execution, flash-loan validation, or closed-loop profitability.
No route or allowlist was changed. Quoter gas estimates are not executor costs.
Dependency-free replay checks the recorded key/hash correspondence; it does not
locally recompute keccak. The new replay utility cannot submit any transaction.

The provider rejected a 1000-block event range and reported a 10-block Free-tier
limit. A compliant 10-block result was truncated. Candidate discovery therefore
does not claim a complete pool census. No account limits or subscription changed.

## Curve source boundary

RobinFun's official whitepaper lists V6 as current and the configured V5 as legacy:
https://robinfun.live/whitepaper (retrieved 19 September 2026).
Legacy status alone does not make a V5 token invalid; tokens remain associated
with their own factory. A V6 address, high-level constant-product description, or
unrelated V2 source does not resolve V5's observed twelve-word ABI or rounding.
No speculative curve model or automatic factory migration was enabled.

## Executed validation

All seven offline stages pass. **169 native JavaScript tests** passed with no
failures or skips: 141 preceding tests plus 8 scheduling, 4 dispatch, 7 journal
and 9 captured-quote tests. The 19 scheduling/dispatch/journal tests also passed
10 consecutive additional runs. Counts are not inflated by those repetitions.
Go race tests passed (24 top-level plus 32 subtests); 7 installer tests and both
synthetic Go-to-JavaScript bridges passed. Source syntax checks also passed.

Not executed: eight ethers/solc wire tests, complete repository build/tests,
41 intended mocked Foundry tests, full modified Nitro build, independent code
identity, actual cross-tick venue parity, Robinhood fork, shadow or live trading.
The reconstructed local checkout is incomplete for the legacy repository suite.
Dependency download and CI runner constraints have not been resolved. A passing
offline report is not production approval.

The direct-feed/local-execution/local-decision/direct-submission architecture is
unchanged. These provider calls are a separate validation path. Public endpoint
production/throughput limits still need an operational access plan; see the
primary network documentation: https://docs.robinhood.com/chain/connecting/.

## Reproduction (no keys or network for fixture replay)

```sh
node --test test/native-scheduling.test.mjs test/native-dispatch.test.mjs test/native-journal.test.mjs test/native-observed-quotes.test.mjs
node native/observed-quote-parity.mjs test/fixtures/robinhood-v4-quotes-67287800.json
npm run native:validate:offline
```

The first two commands require Node; the full offline validator additionally
requires Go, a C toolchain for the race detector and Python. None compiles the
Solidity contracts or operates a Nitro node.
