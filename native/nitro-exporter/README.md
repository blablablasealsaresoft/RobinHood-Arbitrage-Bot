# In-process Nitro execution observer — validation candidate

This component reads the **post-commit local StateDB**, not raw sequencer calldata
and not RPC quotes. It fills a missing integration boundary in the native bot.
The standalone Go library and synthetic Go-to-JavaScript path are executable
without third-party dependencies. **The complete modified Nitro node has not
been compiled or run here, and this is not production sign-off.**

The current executor, venue adapters and local models are not replaced. RobinFun,
Pons, Curve, V4 hooks/dynamic fees and cross-integer-tick quotes are not added by
this observer. Unsupported routes still fail closed.

## Source pin and integration boundary

The installer accepts only:

- Nitro commit `a618155919315241665356fe60f3cd00d66d5e46`.
- Its go-ethereum submodule `0f618f330b8d78457524839997f0041d86f3cd1a`.
- Exact `execution/gethexec/executionengine.go` Git blob
  `b65ba2c676c8f9baef00d72d1b5eee60d516f9f9`.

This is a reviewed **source boundary**, not a claim that this upstream revision
is the release currently running Robinhood. Chain configuration, node version,
feed authentication, parent-chain synchronization, and deployment compatibility
must be verified by the node operator. The pinned Nitro go.mod requires Go 1.25;
its normal native/Stylus build dependencies are still required.

The patch adds an observer field, a call after `appendBlock`'s canonical write
succeeds, and invalidation immediately before `ReorgToOldBlock`. Speculative
prefetch execution never reaches this hook. The patch does not change transaction
admission, filtering, consensus, block execution, or ArbSys behavior. Observer
failures close its subscribers but do not reject an already committed node block.

The adapter uses `BlockNumberToMessageIndex` for the sequence number and
`StateAt(block.Root())` for local state. It does not assume a sequence/genesis
block offset. The exact canonical block hash and state root travel with the
snapshot. `feedBlockHash` is set to Nitro's **computed execution result** for
compatibility with the existing consumer; it is NOT a second independently
signed hash from the raw feed.

Primary source references:

- https://github.com/OffchainLabs/nitro/blob/a618155919315241665356fe60f3cd00d66d5e46/execution/gethexec/executionengine.go
- https://github.com/OffchainLabs/nitro/blob/a618155919315241665356fe60f3cd00d66d5e46/go.mod
- https://github.com/OffchainLabs/go-ethereum/blob/0f618f330b8d78457524839997f0041d86f3cd1a/core/types/receipt.go
- https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol

## Validation commands

Run from the bot repository on Linux, with Go 1.23 or newer and Python 3:

```sh
npm run native:validate:offline
npm run native:test:exporter
npm run native:test:bridge
python3 -m unittest discover -s native/nitro-exporter -p 'install_test.py' -v
```

No RPC, private keys, ethers, npm package installation, or network is needed for
these commands. Go's race detector requires a working native C toolchain.
The standalone library was tested on Go 1.23.2. This does not compile the Nitro
adapter: that adapter belongs to the pinned Nitro module and needs its Go 1.25
and native build environment. CI requests Go 1.25.x and records the actual version.

The installer tests exercise synthetic source anchors, refusal of wrong/dirty
checkouts, check-only mode and file hashes. They are **not** a patch application
to a full Nitro checkout. The Go fixture exercises real packing/decoding through
the existing JS optimizer, but its addresses, balances and opportunities are
synthetic. It is not a chain fork or profitable-trade test.

## Install into a staging Nitro checkout, not a running production node

Prepare the exact source and submodules using the upstream node build procedure.
From the bot repository:

```sh
python3 native/nitro-exporter/install.py /absolute/path/to/nitro --check
python3 native/nitro-exporter/install.py /absolute/path/to/nitro
```

The installer refuses other revisions, dirty source/submodules, conflicting
files and unexpected anchors. It performs no download, deployment or startup.
It copies the standard-library package into `execution/nativebridge`, adds the
adapter to `execution/gethexec`, and replaces the engine file atomically after
all checks/copies succeed. Other non-WASM platforms keep the observer disabled.

Build and test that modified checkout using **its own pinned build instructions**,
including required native/Stylus libraries. A successful standalone `go test`
is not a substitute. Review `git diff` before building. Do not migrate a serving
node until the full build, state parity, reorg tests and shadow run pass.

## Reviewed manifest

The manifest is a JSON file owned by the node/bot service UID with mode `0600`.
The consumer references the same exact bytes via SHA-256. A layout is not
inferred from a pool name, ticker or factory family. Build each layout from the
verified deployed contract source and confirm it with the cold parity auditor.

The schema is illustrated below with placeholders; it is deliberately **not a
runnable deployment configuration**:

```json
{
  "schema": 1,
  "chainId": 4663,
  "nitroRevision": "a618155919315241665356fe60f3cd00d66d5e46",
  "socketPath": "/run/robinarb/execution.sock",
  "relayer": "<dedicated relayer address>",
  "receiptFeeModel": "gasUsed-times-effectiveGasPrice-inclusive",
  "codeHashes": {"<contract address>": "<reviewed runtime keccak256>"},
  "guards": [{"address": "<proxy or contract>", "slot": "<32-byte slot>", "value": "<expected 32-byte word>"}],
  "pools": [{
    "id": "<same ID as route config>",
    "kind": "v2",
    "address": "<pair address>",
    "fields": [
      {"name": "reserve0", "slot": "<reviewed 32-byte slot>", "offset": 0, "width": 112, "type": "uint"},
      {"name": "reserve1", "slot": "<reviewed 32-byte slot>", "offset": 112, "width": 112, "type": "uint"}
    ]
  }],
  "gasBudget": {
    "settlementToken": "<reviewed canonical WETH>",
    "gasLimit": "<same positive integer as signed transaction>",
    "maxFeePerGas": "<same positive integer as signed transaction>",
    "loseRaceBps": 2000,
    "wrappedNativeReviewed": false
  }
}
```

`wrappedNativeReviewed:false` intentionally prevents acceptance. Setting a review
flag does not perform the review. Example `loseRaceBps` is illustrative, not a
measured inclusion probability. The gas budget is WETH-only: no stablecoin/fiat
exchange rate or price oracle is silently assumed.

Every consumer `codeHashes` entry must appear identically in the producer: pool,
executor, lender, adapter, token and lens pins are rechecked at every capture.
Mutable proxies require reviewed implementation-slot guards as well; matching
proxy runtime alone cannot establish implementation identity. Avoid unsupported
or unaudited mutable deployments.

Field offsets count from the least significant bit of a storage word. All slots
must be explicit 32-byte hexadecimal values, including zero. Required field sets:

| Model | Exact fields |
|---|---|
| V2 | `reserve0:uint112`, `reserve1:uint112` |
| V3 | `sqrtPriceX96:uint160`, `tick:int24`, `liquidity:uint128`, `observationIndex:uint16`, `observationCardinality:uint16`, `observationCardinalityNext:uint16`, `feeProtocol:uint8`, `unlocked:bool8` |
| V4 | `sqrtPriceX96:uint160`, `tick:int24`, `liquidity:uint128`, `protocolFee:uint24`, `lpFee:uint24`; also supply the consumer's exact `poolKeyHash` |

V4 shared-manager mappings require the reviewed pool-specific storage base, not
a reused slot from another pool. Fields with missing coverage, overlap, wrong
width/type or malformed slots are rejected. Storage is cached per address/slot
within one capture. Signed ticks become JSON numbers; unsigned amounts remain
decimal strings. An invalid Solidity boolean is rejected, never coerced.

The manifest has at most 128 pools, 1,024 code pins and 512 storage guards.
Do not copy the synthetic fixture's slot numbers into RobinFun/Pons contracts.

## Consumer binding and process setup

In addition to the existing live preflight configuration, supply:

```text
executionManifest: /absolute/path/to/reviewed-exporter.json
producerManifestHash: 0x<SHA-256 of the exact file bytes>
wrappedNativeToken: <the reviewed WETH address>
```

The existing `producer: trusted-local-execution-bridge`, `reviewed: true`,
repository-V4 schema, executor code pins, session loss limits, key environment
variables and authorization checks remain mandatory. Never commit a key.

Create `/run/robinarb` as a real, non-symlink directory owned by the service UID,
mode `0700`. Both processes must use that UID and see the same socket path.
The node observer reads `NATIVE_EXPORT_CONFIG=/absolute/path/to/manifest.json`
on its first committed block. No variable means the observer stays disabled.
It creates an owner-only `0600` Unix socket and checks client UID using
`SO_PEERCRED`. It refuses an existing socket path instead of deleting a possibly
live producer's socket. Socket and manifest paths must be kept outside the repo.

The Node consumer verifies the manifest hash, pool identities, full code-pin
coverage, relayer, WETH identity, signed gas limits and socket ownership/path
before consuming live messages. Every frame must carry the approved revision
and manifest hash; block frames also require a state root.

This is a **trusted-local-process binding, not cryptographic attestation**. A
compromised service UID/root can forge frames and provenance. Nitro's configured
feed authentication and parent-chain reconciliation must be reviewed separately.
No `complete:true` flag or `stateRoot` string proves a snapshot by itself.

## Ordering, receipts, costs and failures

For a new subscriber, the next complete capture is a snapshot; it contains no
historical receipts. The following contiguous block makes the existing engine
eligible to decide. Each delivery is ordered:

```text
conservative cost policy -> complete block state -> dedicated-relayer receipts
```

The producer refreshes the fixed WETH worst-case cost policy through N+1 only.
Both success and revert costs equal `gasLimit * maxFeePerGas`, so the policy never
pretends a one-wei theoretical gain covers unmodeled gas. This is intentionally
conservative initial operation, not a measured optimal fee or race model.
Changing the budget/relayer/layout requires manifest review and restart with
nonce/risk reconciliation, not unchecked hot reconfiguration.

Receipts are selected from actual block transactions belonging to the dedicated
relayer. Unexpected ordinary transaction types from that EOA halt the observer.
Only EIP-1559 receipts are supported by this adapter. Transaction hash, block,
nonce, status, inclusive `GasUsed`, actual `EffectiveGasPrice` and logs are copied;
missing effective prices are an error, never guessed. The consumer still binds
successful executor events to signed intents and handles revert gas. Verify the
inclusive fee interpretation against actual Robinhood balance/receipt evidence.

Capture is all-or-nothing and owns its serialized bytes. Read errors, code-pin or
storage-guard changes close subscribers. Each peer has a bounded eight-batch
queue and 250-ms write deadline; a slow reader is disconnected, not silently
skipped ahead. A reorg clears queued old-branch work, emits invalidation, and
requires a fresh snapshot. Data already written to a socket cannot be recalled;
on-chain anchor/state checks remain necessary. The bot's existing nonce/P&L
risk interlocks remain halted until operator reconciliation after ambiguity.
Never delete the signed journal simply to make the bot resume.

## Remaining release evidence

1. Full pinned Nitro build and execution of the installed observer.
2. Actual feed authenticity/configuration and committed-state parity over many
   blocks, reconnects, replacements and reorgs, including protocol upgrades.
3. Deployed pool/lender/adapter/token layout, code, ABI and quote parity, plus
   required RobinFun/Pons/Curve models and cross-tick coverage where applicable.
4. Successful full repository/EIP-712/mocked-EVM suite and real Robinhood fork.
5. Receipt fee/balance reconciliation, loss/nonce recovery, shadow run, measured
   end-to-end latency, and a separately authorized limited live canary.

No node was started, no contracts deployed, no real trade submitted and no
competitive ranking established by these standalone tests.
