# Bounded V4 tick windows — 19 September 2026

## Release status

**Opt-in implementation; not production validated or enabled.** This increment
adds a V4 cross-tick quote path, committed-state capture and a proposed aggregate
state lens. No live configuration, source branch, deployed contract, RPC routing,
node process, funding or trading switch is changed. Existing default commands
remain unchanged. The `tickWindow` option is not present in the shipped live
configuration. V3 retains its prior single-integer-tick restriction.

The JavaScript simulator and standalone Go exporter were executed. The new lens
and its Foundry tests were **not compiled or executed**, and the modified Nitro
adapter was not built as part of a complete Nitro node. The implementation is not
a substitute for those gates, a chain fork or a deployment security review.

## Local math and bounded state coverage

`v4-ticks.mjs` implements hookless, static-LP-fee V4 exact-input simulation with
BigInt amounts. It follows the bitmap word-boundary traversal, directional
liquidity-net crossing and per-step integer rounding in v4-core revision
`46c6834698c48bc4a463a86d8420f4eb1d7f3b75`. In particular, V4 consumes the full
net input on a partial step; copying V3's recomputed delta can produce a different
fee/dust result. Four upstream numeric vectors cover this distinction and other
input-step cases. Those vectors are not an executed upstream pool contract.

A window contains **every bitmap word in the configured consecutive range,
including explicit zero words**, and exactly one packed gross/net liquidity
record for each set bit. Missing state is never interpreted as zero. Data is
checked before atomic publication, and all published arrays/records are frozen.

Limits are 8 bitmap words, 256 initialized tick records and 512 quote steps.
Amounts and outputs are bounded to positive signed-int128 deltas. Inputs that
need an unread word, exceed a budget, leave unspent input at the global price
limit, or cross inconsistent liquidity fail closed. Zero active liquidity may
be traversed only when the complete intervening state is known. This is bounded
cross-tick coverage, **not an unlimited global tick book**.

Hooks, dynamic LP fees, 100% total fees, exact-output swaps, transfer-tax/rebasing
assets and custom pool implementations are not supported by this path. Their
absence must be established for actual reviewed deployments, not inferred from
addresses or token names. The reused TickMath module retains its existing
GPL-2.0-or-later attribution; the new module does not relicense it.

## Configuration and exporter integration

A reviewed V4 pool may add:

```json
"tickWindow": {
  "tickSpacing": 60,
  "minWord": -1,
  "maxWord": 0,
  "lens": "<reviewed V4TickStateLens address>"
}
```

This snippet is documentation, not a deployable manifest. The fixed adapter
calldata must encode the exact static five-word PoolKey. The consumer checks
currency ordering, fee, spacing, empty hooks and native/WETH mapping. Signing
and cold preflight also verify that keccak256(PoolKey) equals the pool ID.

The exporter manifest declares matching tickSpacing/minWord/maxWord (without
the consumer's lens field), canonical slot0 bit fields and active-liquidity slot.
The optional `MappingReader` computes ABI-encoded storage mapping slots. The
actual Nitro adapter uses geth's `crypto.Keccak256Hash`, not new production
cryptography. The standalone tests use explicit mapping tables/spies; they do
not validate the full upstream geth adapter in a node.

Capture reads bitmaps and initialized records from the same committed root as
slot0/liquidity. It recomputes the V4 pool base from poolId and mapping slot 6;
incorrect layouts, missing words and gross/net inconsistencies stop capture.
The producer/consumer guard binds identical bounds and requires the lens in
both per-block runtime-code pin sets. Cold preflight checks its immutable
PoolManager. None of these calls is added to the decision hot path.

## Aggregate pre-borrow check

`contracts/V4TickStateLens.sol` proposes one mode-0 executor state check for each
windowed pool. It hashes the meaningful 232 slot0 bits, active liquidity, every
bitmap word, sorted tick indices and each tick's gross/net packed word. New
initialized ticks change the bitmap even if they were not in the earlier list.
Changes outside the traversable window are not part of the quote domain.

The wire encoder hashes the exact ABI-encoded lens return bytes as required by
the existing executor. A synthetic golden fixture uses independent Python ABI
encoding and Keccak-256; its test-only reference was checked against standard
empty/abc vectors and captured base slots. This is not a replacement signer.
Eight dependency-installed wire tests (including two new lens tests) and eight
new mocked Foundry lens tests are present but **remain unrun**. The prior 33
mocked executor tests also remain unrun. Full validation now includes all
Foundry tests rather than filtering only the executor contract.

The lens adds storage reads and gas. Its maximum shape is a work bound, not a
claim that all 256-tick windows fit a given transaction gas cap or are economic.
Actual gas sizing, lender/adapter execution and quote parity must be validated
on the intended fork before a deployment, reviewed new code pins or enablement.

## Bounded sizing

Routes using windowed pools switch from the single-region rational approximation
to a bounded local quote search. The default is at most 96 evaluations, including
feasibility probes; small domains are exhaustively evaluated and larger domains
use a bracketed search with integer neighbors. The selected amount always has
an exact route quote and is rechecked by the normal EV gate. Piecewise liquidity
can make a profit curve irregular: this search is **not a proof of the global
integer optimum**. It neither fabricates a quote nor waits on RPC.

## Historical configured-pool finding

Six new provider-reported storage reads used mainnet block **67,237,585**
(`0x401f6d1`), previously captured at **2026-09-19 16:48:55 UTC**:

- Pool `0x0535a5a6095fdb5293563f435a635cab5fcf0511e732158086fdc9721feb6362`,
  spacing 5000: bitmap words -1 and 0 were both zero.
- Pool `0x3c0c454af4afbd7619fd7a67059fb1b65188442b91d70f8bedf0c986d837b326`,
  spacing 2000: bitmap words -2, -1, 0 and 1 were all zero.

For spacing 5000, legal compressed ticks run from -177 to 177. For spacing 2000,
they run from -443 to 443. Thus these words cover **every legal initialized tick**
for those configured spacings, not merely the active range. Together with the
prior zero active-liquidity observation, no initialized liquidity was found
anywhere in either selected pool at that historical block under the canonical
V4 layout. This does not say anything about all Robinhood pools, later state,
or a pool implementation with a different layout.

`test/fixtures/v4-bitmaps-67237585.json` retains raw slots/results. Slot derivation
was independently checked against the previously captured base slots. A final
header read matched the original hash
`0x56a6d5be13ea6ad93fcc7d987c4958a2177052540c358a85c435441d8f8533db`.
These are numeric-block-tag reads and a matching final header, not EIP-1898 calls,
account proofs, a new code-hash verification or independent consensus evidence.
The historical empty pools are not relabeled as fresh, tradeable routes.

## Validation executed in this increment

All seven offline validation stages passed: **141 native JavaScript tests**,
**24 top-level Go tests plus 32 subtests with the race detector**, **7 Python
installer tests**, both synthetic compiled-Go-to-JavaScript bridges, the Go
version check and the existing synthetic V2-core benchmark. The Go suite also
passed a separate ten-repetition race run. JavaScript syntax checks and Python
installer compilation passed. The 141-test total excludes all eight wire tests;
the 41 intended mocked EVM tests and full repository/Nitro build remain unrun.
No end-to-end or competitive performance conclusion follows from these tests.

## Executed integration and remaining gates

The compiled Go window fixture decodes synthetic packed storage into frames
consumed by the actual JavaScript state engine, cross-tick simulator, bounded
optimizer and dry decision path. Starting at zero active liquidity, its selected
route crosses into one populated range. Its synthetic integer result is 996
input units and 19 gross surplus units. These are not ETH amounts, observed
opportunities, after-gas real profits or inclusion measurements. The fixture
contains no keys and cannot enable live mode.

The historical Go regression exercises the same decoder on the six captured
zero words and verifies that its coverage reaches all legal ticks. Installer
checks use synthetic source fixtures, not a full Nitro patch/build.

Remaining production requirements include full dependency-installed repository
and EVM builds, the full modified Nitro build, actual deployment/code/layout
identity, real-venue quote parity and gas limits, viable reviewed route discovery,
a Robinhood fork, and shadow/nonce/receipt recovery evidence. The RobinFun V5
12-word getter schema remains unresolved from verified source; a V2 source or
similar frontend ABI is not authority to enable a guessed V5 model. Pons/Curve
models remain unsupported. No deployment or trading approval is implied.

## Primary algorithm references

- https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/SwapMath.sol
- https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/TickBitmap.sol
- https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/src/libraries/StateLibrary.sol
- https://github.com/Uniswap/v4-core/blob/46c6834698c48bc4a463a86d8420f4eb1d7f3b75/test/libraries/SwapMath.t.sol

These sources specify algorithms and layouts. They do not verify the code
currently deployed at a Robinhood address or validate this integration build.
