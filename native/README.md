# Opt-in sequencer-native local engine — review build

This is an **additive, fail-closed implementation**, not a completed production
RobinFun/Pons bot. Existing `monitor`, `live`, deployments, contracts, adapters,
and the two source branches remain unchanged. No contracts were deployed and no
live transactions were submitted as part of this change.

## Run the offline demonstration

From the repository root, with Node 20 or newer:

```sh
node native/runner.mjs --config native/example.json --replay native/example.ndjson
node --test test/native-core.test.mjs test/native-transport.test.mjs test/native-runner.test.mjs
npm ci
npm run test:native
npm run check
```

The first two commands need no dependencies, wallet, chain connection or RPC.
All example addresses, reserves, timestamps and gas costs are synthetic. The
example is deliberately `reviewed: false`. `LIVE=1` does not enable this runner;
live replay is always refused. The example's profit is not evidence of a market
opportunity, realized profit or competitive latency.

## What is implemented

| Enhancement | Implementation and boundary |
| --- | --- |
| Mandatory local state | `MarketState` holds immutable V2 reserves or complete supported V3/V4 state, validates full snapshots and atomically applies complete executed-block updates. No quoter/provider dependency in the decision core. |
| Precompiled routes | Closed-loop 2–6 leg templates, borrow limits, continuity, no repeated pool, affected-pool reverse index, fixed adapter calldata and check budget. |
| Local sizing | Exact integer V2 quotes; analytic composed-curve sizing with integer neighbors. Small domains are exhaustive. This is bounded local sizing, not a global integer-optimum guarantee. |
| Concentrated liquidity | Exact-input Q64.96 math restricted to the open interval of ONE INTEGER TICK. Tick crossings, dynamic fees, hooks and unknown venue formulas fail closed. |
| Warm execution | Detached strategy/relayer wallets, prebuilt type-2 fields, pooled keep-alive HTTP(S), cold connection warm-up. |
| Nonce authority | One local filesystem lock per relayer, bounded in-flight reservations, durable signed-intent journal, no blind rewind after uncertain submission. Default one outstanding tx; maximum 64. |
| Obsolescence | New blocks immediately invalidate older in-flight signatures, including while signing. Stale signed on-chain intents expire at N+1. No cancellation/replacement spam. |
| Deduplication | Anchor hash + immutable route template + settlement token + relevant state fingerprint. Amount is deliberately not a separate dedupe dimension. SHA-256 here is off-chain only; on-chain hashes remain keccak256. |
| Feed health | Full snapshot plus contiguous block before readiness. Sequence/block/parent/hash conflicts, incomplete frames, replacements and stalls stop decisions. Reconciliation requires another complete snapshot. Live faults also block nonce issuance. |
| Telemetry | Monotonic nanosecond timestamps (microsecond differences), decoded/state/optimizer/sign/journal/POST/ACK/inclusion events, bounded asynchronous queue and dropped-event count. This is instrumentation, not a measured production latency claim. |
| EV gate | `(1-pLose)*(gross-successGas) - pLose*revertGas > minimumEV`, comparing the unrounded numerator. Explicit rational conversion into settlement-token base units, conservatively rounded gas cost, block-expiring cost cache. No artificial bps profit hurdle. |
| Submission | One raw signed transaction, identical JSON-RPC payload on every path; first valid hash acknowledgment wins. Deadlines, response limits, TLS for remote endpoints. Ambiguous errors are not success or safe nonce recycling. |

`wire.mjs` matches the **existing repository** V4 executor. State checks are built
entirely from the cached state. Final leg minOut cannot be below principal plus
minProfit. There is no `populateTransaction`, quote RPC, gas estimation or nonce
fetch on the event-to-submit path.

## The missing state producer is a production blocker

**The sequencer feed is not a post-state database.** Decoding raw calldata or
copying event fields into this schema does not establish complete, correct state.
This PR does not implement a Nitro execution hook, a full local EVM, feed signature
verification, or a production bridge that exports all relevant post-block state.
Do not relabel a per-block RPC quoter as that bridge or advertise end-to-end zero
RPC based on this decision core alone.

A trusted local execution bridge must consume/verify the feed, execute canonical
messages, and export state only after a complete block. It must provide the real
L2 block number/hash, consistent sequence mapping, all relevant pool changes,
and explicit invalidations. Bootstrap/recovery may use a pinned RPC snapshot,
but no trade is allowed while recovering. Local execution latency belongs in the
end-to-end measurements; it is not eliminated by moving work to another daemon.

The runner accepts NDJSON over an owner-only Unix socket. Schema version 1:

```json
{"type":"snapshot","schema":1,"chainId":4663,"complete":true,"sequence":"100","blockNumber":"100","blockHash":"0x...64 hex...","feedBlockHash":"0x...same hash...","parentHash":"0x...64 hex...","timestamp":"1700000100","updates":[{"poolId":"pool-a","reserve0":"1000000","reserve1":"2000000"}]}
```

`block` has the same header and full replacement state for each changed watched
pool (not delta arithmetic). A snapshot includes EVERY configured pool. Even an
empty block must arrive; never coalesce/drop blocks. A snapshot followed by its
first contiguous block evaluates all routes; subsequent blocks evaluate affected
routes only. The schema assumes one exported sequence per executed L2 block; an
upstream bridge must explicitly maintain that mapping rather than assuming a raw
feed header's L1 number is an L2 number.

All unsigned quantities should be decimal strings; JS numbers must be safe
integers. V3 requires `sqrtPriceX96`, numeric `tick`, `liquidity`, all three oracle
observation fields, `feeProtocol`, and `unlocked`. V4 requires price/tick/liquidity,
`protocolFee` and `lpFee`. A pool's fixed metadata is in the reviewed manifest,
not changeable by market frames. Hash equality and `complete:true` are **trusted
producer assertions**, not cryptographic proof of the reserves. IPC owner checks
are not protection against a compromised producer.

Additional messages: `{"type":"invalidate","reason":"replacement"}`;
`{"type":"costs","entries":[...same fields as example costs...]}` atomically
replaces the cost cache. Trusted `receipt` messages contain nonce, txHash,
blockNumber, blockHash and status (0/1); their block/hash must match observed
history. Inclusion is not finalized settlement. On replacement, nonce issuance
halts and receipts must be independently reconciled. Realized profit/revert
reason decoding is not implemented; gasUsed is recorded when supplied.

## Optional live interface — not production approval

```sh
node native/runner.mjs --config /secure/reviewed-manifest.json --socket /secure/executed-state.sock --live
```

Live requires `NATIVE_PREFLIGHT_RPC_URL`, `NATIVE_STRATEGY_KEY`,
`NATIVE_RELAYER_KEY` in the environment, `reviewed:true`,
`producer:"trusted-local-execution-bridge"`, `executorSchema:"repository-v4"`,
explicit executor/Morpho addresses, submission URLs, transaction gasLimit,
maxFeePerGas, optional maxPriorityFeePerGas, TTL 1–5 seconds, and pinned runtime
`codeHashes` for executor/Morpho/tokens/pools/adapters/state lenses. RPC is used
only for cold chain-ID/code/config/domain/authorization/nonce checks, then the
provider is destroyed before consuming the stream. Configure caps, prices,
slippage and loss probabilities deliberately; there are no mainnet defaults here.

A runtime-code hash is NOT an audit, and does not bind an upgradeable proxy's
implementation or mutable fee/configuration storage. Pin and audit those states
separately; only enable immutable reviewed venue semantics. For a V4 native/WETH
route, the adapter's wrapping behavior, pool key, currency directions and unit
mapping require explicit review. No new on-chain adapters are supplied by this
PR, and arbitrary V2/V3 adapters are not interchangeable with the existing V4
adapter. Gas budgets must include all actual chain charges, including data fees
where applicable. No gas-price oracle or empirical race-loss calibrator is
provided. Zero modeled EV is rejected, but a positive model is not a guarantee.

Never run the same EOA in another process/host: the lock is filesystem-local.
A crash or any signed history intentionally leaves `.lock` and `.ndjson` files.
Before clearing them, reconcile every reservation against chain latest/pending
nonces, receipts and each submission endpoint; archive the history. **Intent
expiry does not remove an EOA nonce from a sequencer queue.** It may still be
included, revert and consume gas, or block later nonces while pending. This PR
intentionally has no automatic replacement/cancellation recovery. A journaled
signature is not proof that it was broadcast; never blindly replay the journal.
The journal fsync before sending adds real latency, which is separately logged.
Private keys and endpoint credentials are not logged; signed raw transactions
are in the owner-only journal and must still be protected.

## Uploaded final V4 versus repository V4

The uploaded `SequencerFlashArbExecutorV4.final(1).sol` is NOT a drop-in update:

| Item | Repository V4 | Uploaded final V4 |
| --- | --- | --- |
| L2 anchor | ArbSys `arbBlockNumber` / `arbBlockHash` | Solidity `block.number` / `blockhash` |
| EIP-712 | `SequencerFlashArbExecutorV4`, version `1`, primary `FlashIntent` | `RobinhoodSequencerFlashArb`, version `4`, primary `FlashArbIntent` |
| Intent | 13 fields, including legacy zero trigger field | 11 fields; different names/order |
| Array hashes | Typed per-element hashes then packed concatenation | Whole `abi.encode(array)` hashes |
| State check | Four fields | Adds `uint32 gasLimit` |
| Adapter | `swap`, executor approval then adapter pull | `swapExactInput`, prefunded adapter |
| Dependencies | Self-contained | OpenZeppelin imports not in current build |

On Nitro/Arbitrum the Solidity block opcodes do not supply the L2 anchor used by
this strategy. Preserve ArbSys L2 anchoring during any uploaded-contract
migration. `wire.mjs` includes separate uploaded-final hash/domain helpers for
compatibility tests, but the live runner **does not select that contract**. No
silent schema/selector/funding-model migration was attempted. A full migration
needs an ArbSys patch, dedicated prefunded adapters, pinned OpenZeppelin build,
updated deploy/admin scripts, and actual Solidity/EIP-712/fork parity tests.

## Verification and unfinished work

At implementation time, 34 dependency-free tests passed locally: integer quotes,
small-domain optimizer versus brute force, TickMath reference boundaries, tick
crossing rejection, snapshots/replacements/stalls, gas denomination/EV, nonce
ambiguity, concurrent signing invalidation, HTTP duplicate broadcasts/deadlines,
journal ownership, bounded framing and the offline CLI. Four additional tests
exercise ethers signing/recovery, ABI selector parity against solc, cached check
encoding and uploaded-final hash separation in the dependency-installed suite.
Local dependencies were unavailable; those four are not claimed as locally run.
CI results are reported separately in the PR.

**Unfinished:** real verified execution bridge; RobinFun/Pons/Curve local models;
full initialized-tick state and cross-tick math; reviewed venue adapters and
native-currency mappings; real receipt/profit accounting; byte-for-byte local
quote versus deployed venue parity; full flash-loan failure-path/EVM tests;
Robinhood fork integration; live latency and realized-P&L validation. No branch
should be frozen or funded as production based only on this test suite.

### Primary references / attribution

- Arbitrum block-number semantics: https://docs.arbitrum.io/build-decentralized-apps/arbitrum-vs-ethereum/block-numbers-and-time
- Arbitrum sequencer feed: https://docs.arbitrum.io/run-arbitrum-node/sequencer/read-sequencer-feed
- ArbSys precompile: https://docs.arbitrum.io/build-decentralized-apps/precompiles/reference
- Exact-input math reference: https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SqrtPriceMath.sol
- `concentrated.mjs` derives its TickMath integer constants/algorithm from https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol (GPL-2.0-or-later). That file carries the corresponding SPDX attribution; review license obligations before redistribution. No claim is made to relicense other repository files.
