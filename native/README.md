> **19 September 2026 update:** Optional bounded V4 tick-window quoting, committed-state capture and an aggregate state lens are now implemented. The lens/full Nitro build and real venue execution remain unvalidated. See [V4_TICK_WINDOWS.md](V4_TICK_WINDOWS.md); older single-tick descriptions below still apply to the default path and to V3. No configuration is enabled for live trading.

# Quote-free native decision engine

**Draft validation build; not production-ready.** The implementation consumes
executed post-block state from a trusted local producer. It does not implement a
Nitro node, reconstruct complete EVM state from raw calldata, or guarantee profit.
The existing repository monitor/live commands are unchanged.

Start with [VALIDATION.md](./VALIDATION.md) for the current safety changes, exact
validation scope, new receipt fields and remaining release gates. The preserved
[initial design](./INITIAL_DESIGN.md) documents the original state-frame format,
route configuration and architecture; its initial test counts and unfinished
component list are historical, not the current validation result.

## Current components

| File | Role |
| --- | --- |
| `nitro-exporter/` | Standard-library committed-state observer, pinned Nitro integration, owner-only socket, storage/code guards and synthetic integration tests |
| `execution-provenance.mjs` | Live manifest, pool/code/relayer identity and conservative WETH cost-policy binding |
| `core.mjs` | Atomic state updates, physical-pool identity checks, cached fingerprints, route templates, local sizing, EV, dedupe and nonce coordination |
| `concentrated.mjs` | Integer Q64.96 math restricted to one integer tick; unmodeled crossings are rejected |
| `wire.mjs` | Repository V4 ABI/EIP-712 signing, cached checks and executor receipt-event decoding |
| `runner.mjs` | Opt-in execution-stream consumer, cold preflight and receipt processing |
| `transport.mjs` | Identical-byte multipath POSTs, persistent connections, telemetry and durable single-writer nonce journal |
| `accounting.mjs` | Provisional realized profit/gas, pending gas exposure and denomination-specific session loss limits |
| `audit.mjs` | Separate read-only, canonical-block-pinned state/reference-quote auditor |
| `metrics.mjs` | Observed latency and provisional P&L reports without mixing token units |
| `benchmark.mjs` | Explicitly synthetic local-core benchmark, not end-to-end latency |

The hot path does not call RPC quoters. The cold audit command does use RPC and
must remain separate. A `complete:true` frame and matching hash fields are
producer assertions, not cryptographic proof of correct execution. The in-process exporter is now implemented as a standalone tested component
with a pinned Nitro adapter. Its full Nitro build, real-node execution and
actual deployment parity remain production gates; see
[nitro-exporter/README.md](./nitro-exporter/README.md).

V2 quotes use exact integer reserve math. V3/static-fee hookless V4 support is
conservatively restricted to a single integer tick. RobinFun/Pons/Curve,
unreviewed hooks, dynamic fees and unmodeled crossings are not approximated with
an unrelated formula. Real-venue adapters and native/WETH mappings must be
reviewed separately before enabling routes.

## Offline use

```sh
npm run native:replay
npm run native:validate:offline
npm run native:benchmark -- 10000
```

No keys, ethers/npm package installation, or network are needed. The expanded
offline validator requires Linux, Go 1.23 or newer, a native C toolchain for the
race detector, and Python 3; dry replay itself only requires Node. Example pools,
addresses, reserves and costs are synthetic. A live replay file is refused.

For dependency-installed and mocked-EVM validation on a complete checkout:

```sh
npm ci
npm run native:validate
```

This also requires Foundry v1.4.0. Actual stage results are saved under
`validation/native/`; missing tooling is not reported as a passing skip. The
Foundry suite uses mocks, not a Robinhood fork. See VALIDATION.md for cold audit,
telemetry reporting and deployment gates. No live deployment or trade is part of
these validation commands.

## Executor compatibility

The Solidity patch retains the repository V4 domain/type/tuples and ArbSys L2
anchoring. It binds callback calldata and enforces a single callback followed by
a repayment-only phase. It is not the ABI-incompatible uploaded-final executor.
Rebuilding source does not update a deployed contract; reviewed new bytecode and
new runtime-code pins are required before the patch protects live execution.

## Protocol source attribution

`concentrated.mjs` includes GPL-2.0-or-later TickMath constants from Uniswap
v3-core and follows integer SqrtPriceMath rounding conventions:

- https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/TickMath.sol
- https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SqrtPriceMath.sol
- https://github.com/Uniswap/v4-core/blob/main/src/libraries/ProtocolFeeLibrary.sol

Retain that module's license and attribution. A passing synthetic test is not a
claim of deployed quote parity, competitive sequencing priority or net profit.
