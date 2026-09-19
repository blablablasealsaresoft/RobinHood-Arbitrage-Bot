# Captured mainnet inspection — 19 September 2026

## Status

**Production remains blocked.** This increment adds a cold, read-only inspection
module and captured-state regression tests. It does not change the trading hot
path, supported models, Solidity, configuration, deployments or live switches.
The observations below were obtained through the connected Alchemy provider;
the new collector itself was tested against stub responses. No transaction was
submitted. The fixture is historical evidence, not a live manifest or state feed.

## Collection boundary

Mainnet chain ID: `4663` (`0x1237`). Block: `67237585` (`0x401f6d1`).
Block time: **2026-09-19 16:48:55 UTC**.

```
blockHash  0x56a6d5be13ea6ad93fcc7d987c4958a2177052540c358a85c435441d8f8533db
parentHash 0xe13235be6031bb9a62d409bd5ea5cb5c36bc418b6c3b11c3f2a72142c6c82fc3
stateRoot  0xa651ee9d41f456a840f615af0eb2e4d348fbae8f0de93911b20632999adfd0fd
```

All mainnet market/storage calls used that numeric block tag. Repeated header
reads before and after collection matched, including a final read after the fee
comparison. These are **number-pinned, provider-reported reads with matching
boundary headers**, not EIP-1898 hash-pinned calls or independent consensus proof.
Raw ABI/storage bytes, call data, errors, receipt fields and selected header fields
are preserved in `test/fixtures/robinhood-mainnet-67237585.json`.

## Observed configured-pool state

| Pool ID prefix | Static LP fee | Tick | Active liquidity | 0.002 ETH native-to-token reference quote |
| --- | ---: | ---: | ---: | --- |
| `0x0535a5a6…` | 250000 pips (25%) | 191563 | 0 | RPC error 3: execution reverted |
| `0x3c0c454a…` | 100000 pips (10%) | 187729 | 0 | RPC error 3: execution reverted |

For both pools, packed PoolManager storage matches `StateView.getSlot0()` and
`getLiquidity()` for sqrt price, tick, protocol fee, LP fee and active liquidity.
The packed protocol fee is `4097000` (1000 pips in each direction).

The current single-integer-tick model rejects zero active liquidity. This sample
therefore does not establish an executable opportunity for either configured
pool. **Zero active liquidity is not proof that every other tick range is empty.**
The quote calls cover one size and one direction per pool. No decoded revert
reason was returned; do not assert that zero active liquidity caused the revert.
This is selected-field decoder parity at one block, not complete venue parity,
code-hash verification or a full executed-state transition.

## Curve ABI requires review

The configured RobinFun `curves(token)` getter returned **12 ABI words**, while
`abis.js` at source commit `31b129bd8954b5f0c0327a37ad54b9e7ad092234`
declares six. The sixth returned word is `173138187358603813`, outside the valid
0–10000 range for the declaration's `tradingFeeBps` label.

The declaration cannot safely serve as a reviewed local pricing-state schema.
Do not infer new field names, fix the ABI by guessing, or enable a curve formula
from this observation. The pre-existing raw-return state-hash approach is distinct
from decoding this declaration and is not proven broken by extra return bytes.
A separate `quoteBuy(token, 0.002 ETH)` call returned a positive token amount;
that is not a profitable closed-loop route. No curve model was enabled here.

## Lender, network and version observations

The configured WETH reports 18 decimals. Its `balanceOf()` at the documented
Morpho address was **20.463785044587264454 WETH**. This is a balance observation,
not execution of a flash loan, verification of lender bytecode or guaranteed
future borrowing capacity.

`ArbSys.arbOSVersion()` returned **116**. The documented Nitro convention adds
55, so this corresponds to **ArbOS 61**, not version 116. It does not identify the
serving node's exact source/build or validate our pinned Nitro adapter.

Testnet returned chain ID `46630` (`0xb626`). A separate `latest` code read at the
mainnet WETH address returned `0x`; mainnet addresses must not be reused blindly
on testnet. This does not show that testnet has no WETH at another address.

## One reference revert: actual fee arithmetic

A public, already-mined type-2 transaction (not sent by this bot/session) reverted:

```
txHash 0x82ebd5d95c998f5196fd5a1b236879bdce2afa485fbf08c3d70580a8fe725ee9
```

Its receipt reports 89790 gas used, effective gas price 66628000 wei and zero
`gasUsedForL1`. Their product is **5982528120000 wei (0.00000598252812 ETH)**.
The sender's whole-block balance decrease matches that amount exactly, and its
nonce increases by one. The parent header matches the sampled anchor's parent.

This is one whole-block balance comparison, not a verified transaction-scoped
state diff. It does not calibrate this bot's gas usage or race probability, prove
all fee semantics, or validate a nonzero L1-data-gas component.

## Unavailable capabilities and unresolved release gates

- `eth_getProof` at the sampled root returned missing-trie-node/state unavailable;
  no account proof was obtained. Ordinary historical reads above did succeed.
- `trace_replayTransaction` with `stateDiff` returned method unavailable on this
  network. No transaction-scoped state-diff validation is claimed.
- GitHub checks for the source head still failed before test steps/runner
  assignment. Two annotations were advertised, but the connected fetch action
  does not support their endpoint. The underlying CI cause remains unknown.
- Direct dependency-download attempts still fail in this container. The complete
  repository/EIP-712/Solidity/Foundry checks and full modified Nitro build remain
  unexecuted, as do fork tests, actual node operation and shadow/live performance.
- Reviewed RobinFun/Pons/Curve models, actual adapter/native-WETH integrations,
  full cross-tick coverage and independently verified deployment/code identities
  remain unfinished. These observations do not remove those gates.

## What the new tooling validates

`deployment-inspection.mjs` strictly checks ABI lengths, packed widths, signed
int24 encoding, per-read block tags, stable boundary headers, duplicate pool
identities, storage/lens parity and exact quote call-data/amount binding. It flags
unsupported market states and the curve ABI mismatch. It checks the reference
receipt against the sampled headers and compares gas arithmetic with balances.
The report always sets `productionReady: false`.

The recollector reuses explicitly reviewed call templates, rejects the wrong
chain, and drops previous auxiliary testnet/proof/receipt observations rather
than relabeling them as fresh. It is outside the signer and hot loop. Its optional
RPC transport permits only read methods, enforces bounded responses/deadlines,
refuses remote plain HTTP and redirects, and sanitizes endpoint-bearing errors.
It cannot send transactions. Provider reads still do not independently attest
that state is correct, and templates still need code/layout/venue review.

Executed in this increment: **110 native JavaScript tests**, including 22 new
inspection tests; **18 top-level Go tests and 26 subtests with the race detector**;
**7 installer tests**; and the existing synthetic Go-to-JavaScript integration.
All six offline validation stages pass. The new Go test exercises the exporter's
actual storage decoder against the captured storage/view bytes; it does not
execute an EVM or Nitro node. The installer/bridge scenarios remain synthetic.
The dependency-installed full repository suite is not included in this result.

For reproducibility, the historical sample command is:

```sh
node native/deployment-inspection.mjs --sample test/fixtures/robinhood-mainnet-67237585.json
```

Exit code **2 is expected** because the captured observations contain blockers.
Exit code 1 means invalid evidence or a failed collection. Even a zero-issue report
is not authorization for live trading. Future recollection uses `--collect` with
`NATIVE_AUDIT_RPC_URL` outside the hot path; no credential is stored in this repo.

## Primary references

- Captured bytes: `test/fixtures/robinhood-mainnet-67237585.json`.
- Existing six-word declaration: repository `abis.js` at source commit above.
- V4 storage layout: https://github.com/Uniswap/v4-core/blob/main/src/libraries/StateLibrary.sol
- ArbSys version convention: https://github.com/OffchainLabs/nitro-precompile-interfaces/blob/main/ArbSys.sol
- Network identifiers: https://docs.robinhood.com/chain/connecting/

External documentation corroborates interfaces/conventions; it does not certify
these deployed code hashes, our integration build, or these market opportunities.
