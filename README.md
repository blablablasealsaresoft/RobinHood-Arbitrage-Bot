# 🤖 RobinArb

> 🇮🇩 Versi Bahasa Indonesia: **[README.id.md](README.id.md)**

**Atomic arbitrage bot for Robinhood Chain** (chainId `4663`) — trades the gap between
a token's **RobinFun bonding curve** and its **Uniswap V4 pool**, in a single
**profit‑or‑revert** transaction.

| Dir | Route | Fires when |
|:--:|---|---|
| 🅐 | 🟢 buy **curve** → 🔴 sell **V4** | V4 pumped **above** the curve |
| 🅑 | 🟢 buy **V4** → 🔴 sell **curve** | V4 dumped **below** the curve |

⚙️ Auto‑discovers every token with an active curve **and** a liquid V4 pool, watches
them event‑driven, sizes each trade optimally, and only fires when the net edge
(after the 1% curve fee, the V4 pool fee, slippage & gas) clears the gate.

---

## 📖 How it works — operator playbook

> 🎯 **You create the arbitrage venue; the bot captures it automatically.**

### 1️⃣ Find a curve token
Browse **[robinfun.live](https://robinfun.live)** → pick one with **≥ 10% bonding
progress** (enough curve depth to trade against).

### 2️⃣ Create its Uniswap V4 pool
Add a pool for that token with a **25% base fee**, and set the **initial price = the
token's current bonding‑curve price** — so the pool starts aligned (no free loss).

### 3️⃣ Trigger / seed the pool
Copy the token's **contract address** → paste into
**[trigerpool.vercel.app](https://trigerpool.vercel.app)** → connect wallet → leave
settings on **default** → click **Swap**. This initializes the pool + emits its first
on‑chain Swap.

### 4️⃣ Review and allowlist the pool
RobinArb's real‑time listener watches the V4 PoolManager `Initialize` event. The
listener detects new pools, but they **cannot be traded until reviewed and allowlisted
on-chain**. Run `npm run scan`, inspect `watchlist.json`, then run
`npm run allow-pools`. Separating discovery from permission prevents an untrusted pool
from gaining immediate access to the executor.

> ⚡ **TL;DR** — pick a ≥10% bonded token → make its 25% V4 pool at the curve price →
> trigger once → review → allowlist → the bot arbs it automatically. 💰

---

## ⚛️ How it trades (atomic)

`contracts/ArbExecutor.sol` holds the working capital and does buy+sell in **one tx**
that **reverts unless the contract's ETH balance grows by `minProfit`**. The bot adds
the transaction's bounded maximum gas charge to that floor, so a successful trade
still clears the configured net target. A revert still costs gas but leaves no inventory.

- 🅐 `curveToV4(token, ethIn, minTokensOut, key, minEthOut, minProfit)` — dir A
- 🅑 `v4ToCurve(token, ethIn, minTokensOut, key, minEthOut, minProfit)` — dir B
- 🛡️ pools are allowlisted, hook-enabled pools are disabled, and trade size is capped on-chain
- 🔑 `withdraw` / `rescueToken` / two-step ownership transfer — owner only

## Setup

```bash
npm install
cp .env.example .env      # fill PRIVATE_KEY, EXEC_RPC_URL, Telegram; leave EXECUTOR_ADDR blank for now
```

RPC (optional): works out of the box on the **public Robinhood RPC** (already set in
`.env.example`), with a **built-in DNS-block bypass** (Cloudflare IP pin + DoH) for
ISPs that block `*.robinhood.com` — no VPN. For more reliable execution you can
**optionally** point `EXEC_RPC_URL` at a private Alchemy endpoint — get one free at
**https://dashboard.alchemy.com** (create an app for Robinhood Chain).

## Deploy + fund the contract

```bash
npm run build:contract                 # compile -> build/ArbExecutor.json
npm run deploy                         # deploy ArbExecutor, prints the address
# put the printed address in .env as EXECUTOR_ADDR, then:
AMOUNT_ETH=0.006 npm run deposit        # fund working capital (>= MAX_SIZE_ETH)
npm run scan                            # inspect watchlist.json
npm run allow-pools                     # explicitly permit reviewed pools
npm run pause                           # emergency on-chain circuit breaker
npm run unpause                         # resume after review
```

## Withdraw

```bash
npm run withdraw                       # withdraw everything to the owner wallet
LEAVE_ETH=0.006 npm run withdraw        # withdraw all but 0.006 (keep trading capital)
AMOUNT_ETH=0.01 npm run withdraw        # withdraw an exact amount
```

## Run

```bash
npm run scan            # discover arbitrable tokens -> watchlist.json
npm run monitor        # dry-run: watch spreads, no trading
npm run smoke          # read-only RPC, ABI, dependency, and quote validation
npm run live            # live atomic trading (needs funded contract + EXECUTOR_ADDR)
npm run snapshot       # one-off econ snapshot across the watchlist
```

24/7 with pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs robinarb
pm2 logs robinarb-scanner
```

PM2 runs two processes: `robinarb` for continuous monitoring/trading and
`robinarb-scanner` for an incremental scan at startup and every six hours. Configure
the cadence with `SCAN_INTERVAL_MS`. Scanning is read-only; smoke testing, pool
permissions, and deposits remain manual. After allowing a new pool, run
`pm2 restart robinarb --update-env` so the bot reloads the watchlist.

## Files

| File | Purpose |
|---|---|
| `arb.js` | main bot: discover, quote both directions, optimal size, fire atomic |
| `scanner.js` | on-chain discovery of curve+V4 tokens -> watchlist.json |
| `snapshot.js` | econ snapshot across the watchlist |
| `discover.mjs` | verify curve state / PoolKey / V4 liquidity on-chain |
| `provider.js` | ethers provider with DNS-block bypass + concurrency/backoff |
| `config.js` | verified on-chain addresses (factory, V4 infra, PoolKeys) |
| `abis.js` | curve ABI + Universal Router V4 swap encoder |
| `telegram.js` | real-time trade notifications |
| `contracts/ArbExecutor.sol` | atomic profit-or-revert executor |
| `deploy.js` / `deposit.js` / `withdraw.js` | contract lifecycle |
| `allow-pools.js` | explicit on-chain permission for reviewed pools |
| `test/` | deterministic risk, PoolKey, and contract compile tests |

## Config knobs (.env)

| var | meaning |
|---|---|
| `LIVE` | `1` = trade, `0` = monitor |
| `MIN_SIZE_ETH` / `MAX_SIZE_ETH` | trade size bounds |
| `MIN_PROFIT_BPS` | required net edge after fees + gas |
| `GAS_UNITS` / `GAS_BUFFER_BPS` | hard transaction gas bound and fee buffer |
| `GRID_POINTS` | probe sizes per direction |
| `POLL_MS` / `EVENT_POLL_MS` | fallback poll / Swap-event cadence |
| `SCAN_INTERVAL_MS` / `SCAN_RETRY_MS` | PM2 scan cadence / failure retry delay |
| `EXEC_RPC_URL` | private execution RPC (Alchemy) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | notifications |

## Safety

- `.env` (private key + private RPC) is gitignored — never commit it.
- A successful trade must cover the net target plus bounded gas; reverts still cost gas.
- Unsafe two-transaction EOA execution is disabled; live mode requires the executor.
- Pools require an allowlist entry and hook-enabled pools are rejected.
- Working capital lives in the contract; withdraw anytime (owner only).
- Existing executor deployments must be replaced because the ABI and safety policy changed.
