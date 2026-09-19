# Native engine validation increment — 19 September 2026

## Release status

This is a **draft, non-production validation build**. No contract deployment,
fund transfer, live broadcast, or claim of competitive superiority is part of
this change. Existing monitor/live entrypoints remain unchanged. The opt-in
native runner still requires a trusted local execution-state producer; this
change does **not** implement a Nitro node or invent one from RPC quotes.

The uploaded-final ABI is still not selected. This patch retains the repository
V4 EIP-712 domain, tuple order, hash scheme, adapter interface and ArbSys L2
anchoring. Source changes require a newly built/reviewed deployment and updated
runtime-code pins before they protect any live executor. No existing deployment
has been modified.

## Changes

### Executor callback integrity

`pendingCallbackHash` commits to the exact ABI-encoded signed legs sent to
Morpho. The callback checks this hash before decoding/swapping. The phase machine
is now idle (0), awaiting callback (1), executing route (2), repayment-only (3).
A missing or second callback cannot pass the post-loan phase check. Limits of six
legs and eight state checks match the native route compiler.

The immutable, reviewed Morpho deployment remains a trust dependency. These
checks are defense in depth; this is not a claim that deployed Morpho mutates
payloads or repeats callbacks.

`test/evm/ExecutorV4.t.sol` declares 33 Foundry tests, including a 256-run fuzz
case. It uses mocks for tokens, adapters, Morpho and ArbSys; **it is not a
Robinhood fork**. Covered paths include principal/baseline/profit conservation,
repayment failure, exact approval, callback mutation/absence/repetition,
reentrancy, signatures, nonce replay, gas/deadline/anchor restrictions,
allowlisting and per-leg floors. Source-regression assertions in the offline
suite are clearly named and are not counted as EVM executions.

### State and submission correctness

The route compiler rejects aliases of a physical pool, including cross-model
aliases of the same pair. Otherwise two pool IDs could incorrectly model one
liquidity source as independent. Duplicate sequence/hash messages must also have
identical complete payloads. Valid duplicate messages still do not refresh age.

Pool fingerprints are cached and committed atomically with pool objects, reducing
repeated hashing of immutable metadata. Unchanged updates retain object identity.
A cost-cache replacement or session risk halt during signing invalidates the old
decision before dispatch. Pending receipt bookkeeping is registered before POST,
not after HTTP acknowledgement; a receipt can legitimately beat the ACK.

### Provisional realized P&L and session risk

The runner decodes the real `FlashArbitrage` event from the configured executor's
receipt logs. The ledger binds the emitter, relayer, EIP-712 digest, anchor hash,
anchor block, settlement token and borrowed principal to the signed transaction.
Success must be in N+1 and satisfy the signed floor. A reverted stale transaction
may arrive later and is still charged gas. Unknown, conflicting, malformed or
wrong-branch receipts consume no registration.

Gas accounting requires the reviewed frame convention
`gasUsed-times-effectiveGasPrice-inclusive`. Do not select it on a deployment
whose receipt fields omit a charge or require an additional fee; establish that
convention with actual Robinhood receipts first. Gas cost is not derived from the
quote estimate. The original native gas amount is retained, and conversion to
settlement base units uses the decision's frozen rational price, rounded upward.
This is not an independently marked fiat P&L.

Required live configuration additions:

```text
receiptFeeModel: gasUsed-times-effectiveGasPrice-inclusive
sessionLossLimits: [{ settlementToken: <reviewed ERC-20>, maxLoss: <base units> }]
```

All unresolved transactions reserve their **maximum signed gas exposure**, not
expected gas, against their denomination's session loss budget. Gas reserve is
replaced by realized net P&L on validated receipt. Different settlement tokens
are never added together. This is a bounded process-session control, not a global
cross-host or daily risk service. Reorg invalidation reverses affected provisional
P&L and halts risk pending reconciliation. History is bounded; filling it requires
an operator checkpoint rather than silently forgetting losses.

Receipt frames must contain decimal-integer `nonce`, `blockNumber`, `gasUsed`,
`effectiveGasPrice`, a numeric status 0/1, `txHash`, `blockHash`, the explicit
`feeModel`, and full `logs` with `address`, `topics`, and `data`. Block state must
arrive before its receipts. Supplied `profit`/`arbitrageEvents` claims are ignored
in favor of decoding logs. The producer itself is still a trust boundary.

### Read-only parity auditor

`native/audit.mjs` checks a complete snapshot against a chosen RPC using
EIP-1898 `{blockHash, requireCanonical:true}` for code and state reads. It checks
chain ID, reviewed runtime-code hashes, cached pre-borrow state hashes and exact
local route outputs against explicitly supplied reviewed reference calls. It
checks canonicality before and after collecting evidence. A mismatch or missing
route coverage fails; no fallback to latest state or tolerance is applied.

Only four read-only RPC methods are allowed. The auditor never signs or submits.
It is a cold/offline process and is not imported by the decision loop.

```sh
NATIVE_AUDIT_RPC_URL=<trusted-RPC> npm run native:audit -- \
  deployment.json snapshot.json reference-cases.json audit-result.json
```

Each reference case has `routeId`, `amountIn` (base units), `target`, `data` and
`outputWord` (zero-based static ABI word). The target's code hash must be pinned.
The ABI, amount/route binding of calldata, result index and venue provenance must
be reviewed. One snapshot or a self-selected reference call does **not** certify
an entire venue or production integration. The report states this limited scope.
The actual deployed auditor has not been run in this environment.

### Telemetry and benchmark

```sh
npm run native:benchmark -- 10000
npm run native:metrics -- native/.runtime/telemetry.ndjson
```

The benchmark uses two synthetic V2 pools and one route, after 1,000 warmup
iterations. It excludes framing/decoding, persistence, feed acquisition, EVM
execution, signing, durable journaling, networking and inclusion. Its numbers
cannot establish FCFS position, live profitability or superiority over another
bot. Run it on the intended host and preserve machine conditions and artifacts.

The metrics report correlates local monotonic timestamps across anchors,
opportunity keys and transaction hashes. Receipt observation is not the exact
sequencer inclusion timestamp. Missing spans remain missing, never zero.
Reorged P&L is removed and denominations stay separate. RPC ACKs are not counted
as successful trades.

## Reproducible validation

```sh
# No dependencies, keys or network required:
npm run native:validate:offline

# Complete checkout; requires pinned npm packages and Foundry v1.4.0:
npm ci
npm run native:validate
```

`validation/native/report.json` and per-stage logs capture actual results. The
full command runs the repository check/build and the mocked EVM suite. Missing
tools/dependencies are failures, not passing skips. Even a full pass is explicitly
scoped and does not set `productionReady` to true. Native CI uses a commit-pinned
Foundry installer, Foundry v1.4.0, read-only repository permissions and no secrets.

## Remaining release gates

1. Get full repository compilation, the six dependency-installed wire tests and
   all Foundry executor tests to execute successfully on a working runner.
2. Build and verify the actual trusted Nitro/EVM state exporter, including feed
   signature/sequence handling, canonical replacements, complete state and receipts.
3. Complete reviewed RobinFun/Pons/Curve and actual adapter/native-WETH integrations.
   Concentrated-liquidity support remains deliberately single-integer-tick; hooks,
   dynamic fees and unmodeled tick crossings fail closed.
4. Establish actual deployment code/ABI/state/quote parity over representative
   blocks and amount boundaries; run profitable and losing routes on a Robinhood
   fork with the real lender, tokens and reviewed adapters.
5. Validate shadow operation, current fee accounting, nonce recovery and measured
   frame-to-submit/inclusion distributions. Any live canary requires a separate
   operator decision, dedicated funded relayer and reviewed limits.

Only measured after-cost outcomes can support a performance claim. Synthetic
volume and passing unit tests are not substitutes for these gates.

## Primary protocol references

- Morpho callback/repayment flow: https://docs.morpho.org/learn/concepts/flashloans/
- Standard feed structure and L1-vs-L2 numbering:
  https://docs.arbitrum.io/run-arbitrum-node/sequencer/read-sequencer-feed
- Foundry cheatcode reference: https://getfoundry.sh/reference/cheatcodes/
