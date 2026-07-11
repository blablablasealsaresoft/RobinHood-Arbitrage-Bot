# RobinHood Arbitrage Bot

> Indonesian documentation: [README.id.md](README.id.md)

Atomic arbitrage between a configured RobinFun bonding-curve manager and Uniswap V4 on Robinhood Chain (`chainId 4663`). The bot quotes both directions:

| Direction | Route |
|---|---|
| A | buy on the curve, sell on V4 |
| B | buy on V4, sell on the curve |

Live trading requires the deployed `ArbExecutor`. Both legs execute in one transaction. The executor reverts unless its ETH balance increases by the requested gross profit floor, which includes the bot's configured net target and bounded maximum gas cost. A reverted transaction still costs gas.

This software does not guarantee profit. It is designed to reject unprofitable or unsupported trades.

## Supported market scope

The scanner currently considers markets that satisfy all of these conditions:

- The pool belongs to the configured Uniswap V4 PoolManager.
- `currency0` is native ETH and `currency1` is the token.
- The token has an active, non-graduated curve on the single RobinFun manager in `config.js`.
- The pool has active liquidity according to V4 StateView.
- The pool has no hooks.
- Its fee and tick spacing pass validation.

The bot does not cover other RobinFun factory versions, hook-enabled pools, non-native pairs, or other DEXes. A market passing the scanner is only technically eligible. The trading loop still requires a positive quote after fees, conservative slippage, price impact, and bounded gas.

## Safety model

- Live mode is atomic-only. The unsafe two-transaction EOA path is disabled.
- Every PoolKey requires an on-chain allowlist entry.
- Newly discovered pools never receive permission automatically.
- The executor enforces a maximum trade size and rejects hook-enabled pools.
- The contract uses token balance deltas, safe ERC-20 calls, a reentrancy guard, two-step ownership transfer, and a pause switch.
- The bot serializes scans and execution to prevent overlapping trades and nonce races.
- Explicit gas and fee ceilings make the successful-trade profit floor conservative.
- PM2 restarts failed processes, while transient RPC event errors are retried or ignored safely.

## Requirements

- Node.js 20 or newer
- npm
- A dedicated wallet funded with Robinhood Chain ETH
- A private Robinhood Chain RPC is recommended for live operation
- PM2 for continuous operation

Do not use a primary wallet. Never commit `.env`.

## Install on Windows

```powershell
npm install
Copy-Item .env.example .env
npm run check
```

Fill at least these values in `.env`:

```env
PRIVATE_KEY=0x...
EXECUTOR_ADDR=
LIVE=0

EXEC_RPC_URL=https://robinhood-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL=

WATCHLIST=1
MIN_SIZE_ETH=0.002
MAX_SIZE_ETH=0.005
MIN_PROFIT_BPS=150
SLIPPAGE_BPS=100
GAS_UNITS=700000
GAS_BUFFER_BPS=12000
```

RPC selection works as follows:

- Trading uses `EXEC_RPC_URL` when configured.
- Monitoring uses `RPC_URL`, then falls back to `EXEC_RPC_URL`, then to the built-in pinned public provider.
- Scheduled scanning uses `SCAN_RPC_URL`; when blank, it uses the pinned public provider so historical log reads do not consume the trading RPC quota.

`RPC_URL` and `EXEC_RPC_URL` may point to the same private Alchemy endpoint.

## Deploy the executor

Deployment is a one-time operation for each executor version:

```powershell
npm run build:contract
npm run deploy
```

Copy the printed contract address into `.env`:

```env
EXECUTOR_ADDR=0x...
```

The deployment starts with no allowed pools. Existing deployments from the original RobinArb contract are not ABI-compatible with this hardened executor.

## Discover and review markets

These commands are read-only on-chain:

```powershell
npm run scan
npm run smoke
npm run snapshot -- 0.002
```

`scan` writes `watchlist.json` and an ignored incremental cache. A cold scan reads historical `Initialize` events once. Later scans read only a reorg overlap and new blocks.

The scan summary distinguishes raw pool discovery from eligible markets. `Added: none` means no new pool passed every filter; raw V4 pools may still have been created.

Review `watchlist.json` immediately before granting permissions. Then run:

```powershell
npm run allow-pools
```

This command sends on-chain transactions. It skips PoolKeys and tokens already approved, so rerunning it does not intentionally pay for duplicate permissions.

After allowing a new pool, reload the trading process:

```powershell
pm2 restart robinarb --update-env
pm2 save
```

Scanner removal does not revoke an existing on-chain permission. The bot stops loading removed pools after restart, but the executor permission remains until explicitly revoked at contract level.

## Fund and withdraw

Deposit `0.01 ETH`:

```powershell
$env:AMOUNT_ETH="0.01"
npm run deposit
Remove-Item Env:AMOUNT_ETH
```

Withdraw everything:

```powershell
npm run withdraw
```

Withdraw an exact amount:

```powershell
$env:AMOUNT_ETH="0.005"
npm run withdraw
Remove-Item Env:AMOUNT_ETH
```

The executor balance is working capital. `MAX_SIZE_ETH` remains the maximum size per trade.

## Run the bot

One-time dry run:

```powershell
npm run monitor:once
```

Continuous dry run:

```powershell
npm run monitor
```

Foreground live mode:

```powershell
npm run live
```

`npm run live` can submit transactions. It requires a funded, unpaused executor owned by `PRIVATE_KEY`, at least one allowlisted watchlist pool, and matching chain configuration.

## PM2 operation

`ecosystem.config.cjs` defines two processes:

| Process | Responsibility |
|---|---|
| `robinarb` | quote markets and execute allowed atomic trades |
| `robinarb-scanner` | run the incremental read-only scanner at startup and every 30 minutes |

Start or reload both:

```powershell
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 status
```

Logs:

```powershell
pm2 logs robinarb
pm2 logs robinarb-scanner
```

PM2 reloads `.env` only when the process restarts. Set `LIVE=1`, then run `pm2 restart robinarb --update-env` to enable live mode. On Windows, `pm2 save` stores the process list; use `pm2 resurrect` after reboot unless a separate Windows startup task has been configured.

Emergency stop:

```powershell
npm run pause
pm2 stop robinarb
```

Resume after review:

```powershell
npm run unpause
pm2 restart robinarb --update-env
```

## Telegram alerts

Set:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_POLL_ALERTS=1
TELEGRAM_SCAN_ALERTS=1
```

The bot reports startup, each configured poll, idle and negative spreads, eligible opportunities, successful trades, execution errors, scheduled scan summaries, added and removed markets, scanner failures, pool permissions, deposits, withdrawals, pause, and unpause.

Polling alerts can be noisy. Set `TELEGRAM_POLL_ALERTS=0` to disable them without disabling trade and scanner alerts. Telegram requests have a timeout and never block trading permanently.

## Main configuration

| Variable | Purpose |
|---|---|
| `LIVE` | `1` enables live trading for PM2; `npm run live` forces live and monitor commands force dry-run |
| `WATCHLIST` | load supported markets from `watchlist.json` |
| `MIN_SIZE_ETH`, `MAX_SIZE_ETH` | geometric probe boundaries and per-trade size range |
| `GRID_POINTS` | number of geometric probe sizes per direction |
| `MIN_PROFIT_BPS` | required net profit after the bounded gas reserve |
| `SLIPPAGE_BPS` | conservative first-leg token floor |
| `GAS_UNITS` | hard transaction gas limit and profit-reserve basis |
| `GAS_BUFFER_BPS` | fee-per-gas ceiling buffer; `12000` means 20% |
| `POLL_MS` | fallback market polling interval |
| `EVENT_POLL_MS` | provider log polling cadence |
| `RPC_URL`, `EXEC_RPC_URL` | monitoring and execution RPC endpoints |
| `SCAN_RPC_URL` | optional scanner-specific RPC |
| `SCAN_INTERVAL_MS` | PM2 scanner interval; default `1800000` (30 minutes) |
| `SCAN_RETRY_MS` | retry delay after a failed scheduled scan |
| `SCAN_CONFIRMATIONS` | blocks excluded from the scanner head for finality |
| `SCAN_REORG_OVERLAP` | blocks re-read to replace a reorged cache tail |
| `RPC_CONCURRENCY`, `RPC_RETRIES` | limits for the pinned public provider |

`GAS_UNITS=700000` is a ceiling, not the amount always charged. The transaction receipt charges actual gas used. The bot nevertheless reserves the full configured ceiling when deciding whether a trade meets the profit threshold, which may reject thin opportunities.

## Validation commands

```powershell
npm test
npm run check
npm run smoke
npm audit
```

`npm run check` runs syntax validation, seven automated tests, and deterministic Solidity compilation with `solc 0.8.26`.

## Repository layout

| Path | Purpose |
|---|---|
| `arb.js` | market quoting, event handling, serialized live execution |
| `risk.js` | configuration validation, gas policy, grid sizing, serialization |
| `scanner.js` | incremental on-chain market discovery and watchlist generation |
| `scanner-daemon.js` | scheduled scanner process used by PM2 |
| `scripts/smoke.js` | read-only chain, bytecode, liquidity, and quote checks |
| `allow-pools.js` | idempotent on-chain PoolKey and token permissions |
| `executor-admin.js` | pause and unpause operations |
| `provider.js` | private RPC selection and pinned-provider retry logic |
| `telegram.js` | non-blocking operational and trade alerts |
| `contracts/ArbExecutor.sol` | atomic executor and on-chain risk controls |
| `deploy.js`, `deposit.js`, `withdraw.js` | executor lifecycle and funds |
| `test/` | contract compile, PoolKey, risk, and scanner-output tests |

## Known limitations

- The configured RobinFun manager is the only supported curve venue.
- The bot does not support hook-enabled pools or non-native V4 pairs.
- A successful trade must satisfy the configured net floor, but reverted attempts, deployment, permissions, and admin operations still cost gas.
- There is no persistent P&L database or daily gas-loss circuit breaker yet.
- The contracts have not received an independent security audit.
- Competition, transaction ordering, liquidity changes, and RPC latency can eliminate a quoted opportunity before inclusion.

Use a dedicated wallet, start with limited capital, and review on-chain receipts rather than treating uptime or scanner activity as evidence of profit.
