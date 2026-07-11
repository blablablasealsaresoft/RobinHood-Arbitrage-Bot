# 🤖 RobinArb 🇮🇩

> 🌐 English version: **[README.md](README.md)**

**Bot arbitrase atomic buat Robinhood Chain** (chainId `4663`) — ngambil selisih harga
antara **bonding curve RobinFun** sebuah token dan **pool Uniswap V4**-nya, dalam satu
transaksi **profit‑or‑revert**.

| Arah | Rute | Nembak pas |
|:--:|---|---|
| 🅐 | 🟢 beli **curve** → 🔴 jual **V4** | V4 ke‑pump **di atas** curve |
| 🅑 | 🟢 beli **V4** → 🔴 jual **curve** | V4 di‑dump **di bawah** curve |

⚙️ Otomatis nyari semua token yang punya curve aktif **dan** pool V4 berlikuiditas,
mantau event‑driven, cari ukuran trade optimal, dan cuma nembak kalau net edge
(setelah fee curve 1%, fee pool V4, slippage & gas) ngelewatin gate.

---

## 📖 Cara kerja — panduan operator

> 🎯 **Lo yang bikin venue arb-nya; bot yang eksekusi otomatis.**

### 1️⃣ Cari token curve
Buka **[robinfun.live](https://robinfun.live)** → pilih yang **bonding-nya minimal
10%** (biar curve-nya cukup dalem buat di-trade).

### 2️⃣ Bikin pool Uniswap V4-nya
Add pool token itu dengan **base fee 25%**, dan set **harga awal = harga bonding curve
saat itu** — biar pool selaras sama curve (gak rugi pas seed).

### 3️⃣ Trigger / seed pool-nya
Copy **contract address** token → paste ke
**[trigerpool.vercel.app](https://trigerpool.vercel.app)** → connect wallet → biarin
**default** → klik **Swap**. Ini nginisialisasi pool + ngeluarin Swap pertama.

### 4️⃣ Review dan allowlist pool
Listener real‑time RobinArb mantau event `Initialize` di PoolManager Uniswap V4.
Pool baru terdeteksi otomatis, tetapi **tidak boleh ditradingkan sebelum direview dan
di-allowlist on-chain**. Jalankan `npm run scan`, periksa `watchlist.json`, lalu
`npm run allow-pools`. Pemisahan discovery dan permission mencegah pool berbahaya
langsung mendapat akses ke executor.

> ⚡ **Ringkas** — pilih token bonding ≥10% → bikin pool V4 fee 25% di harga curve →
> trigger sekali → review watchlist → allowlist → bot arb otomatis. 💰

---

## ⚛️ Cara trade-nya (atomic)

`contracts/ArbExecutor.sol` nyimpen modal kerja dan ngelakuin beli+jual dalam **1 tx**
yang **revert kalau saldo kontrak gak naik minimal `minProfit`**. Bot memasukkan batas
maksimum gas ke `minProfit`, sehingga transaksi yang berhasil tetap melewati target
profit net. Transaksi revert masih membayar gas, tetapi tidak meninggalkan inventory.

- 🅐 `curveToV4(...)` — arah A · 🅑 `v4ToCurve(...)` — arah B
- 🛡️ pool wajib di-allowlist, hook pool dinonaktifkan, dan ukuran trade dibatasi on-chain
- 🔑 `withdraw` / `rescueToken` / transfer ownership dua langkah — owner only

## Setup

```bash
npm install
cp .env.example .env      # isi PRIVATE_KEY, EXEC_RPC_URL, Telegram; EXECUTOR_ADDR nanti
```

RPC (opsional): langsung jalan pake **RPC publik Robinhood** (udah keisi di
`.env.example`), dengan **bypass blokir DNS bawaan** (pin IP Cloudflare + DoH) buat
ISP yang blok `*.robinhood.com` — tanpa VPN. Kalau mau eksekusi lebih reliable, bisa
**opsional** arahin `EXEC_RPC_URL` ke endpoint privat Alchemy — bikin gratis di
**https://dashboard.alchemy.com** (create app buat Robinhood Chain).

## Deploy + isi modal kontrak

```bash
npm run build:contract                 # compile -> build/ArbExecutor.json
npm run deploy                         # deploy, nampilin address
# masukin address ke .env sebagai EXECUTOR_ADDR, terus:
AMOUNT_ETH=0.006 npm run deposit        # isi modal (>= MAX_SIZE_ETH)
npm run scan                            # review watchlist.json
npm run allow-pools                     # izin eksplisit pool hasil review
npm run pause                           # circuit breaker darurat
npm run unpause                         # aktifkan lagi setelah review
```

## Tarik dana (withdraw)

```bash
npm run withdraw                       # tarik semua ke wallet owner
LEAVE_ETH=0.006 npm run withdraw        # tarik, sisain 0.006 (modal trade)
AMOUNT_ETH=0.01 npm run withdraw        # tarik jumlah tertentu
```

## Jalanin

```bash
npm run scan            # discover token arbitrable -> watchlist.json
npm run monitor        # dry-run: pantau spread, gak trading
npm run smoke          # validasi read-only RPC, ABI, dependency, dan quote
npm run live            # trading atomic live (perlu kontrak ke-fund + EXECUTOR_ADDR)
npm run snapshot       # snapshot ekonomi sekali jalan
```

24/7 pake pm2:

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
pm2 logs robinarb
pm2 logs robinarb-scanner
```

PM2 menjalankan dua proses: `robinarb` untuk monitor/trading 24/7 dan
`robinarb-scanner` untuk incremental scan saat startup lalu setiap 6 jam. Interval
diatur lewat `SCAN_INTERVAL_MS`. Scanner hanya read-only; `smoke`, `allow-pools`,
dan `deposit` tetap manual. Setelah allowlist pool baru, restart bot dengan
`pm2 restart robinarb --update-env` agar watchlist dimuat ulang.

## Setting (.env)

| var | arti |
|---|---|
| `LIVE` | `1` = trading, `0` = monitor |
| `MIN_SIZE_ETH` / `MAX_SIZE_ETH` | batas ukuran trade |
| `MIN_PROFIT_BPS` | edge net minimal setelah fee + gas |
| `GAS_UNITS` / `GAS_BUFFER_BPS` | batas gas tx dan buffer fee untuk profit floor |
| `GRID_POINTS` | jumlah ukuran probe per arah |
| `POLL_MS` / `EVENT_POLL_MS` | poll cadangan / cadence event Swap |
| `SCAN_INTERVAL_MS` / `SCAN_RETRY_MS` | interval scan PM2 / retry saat gagal |
| `EXEC_RPC_URL` | RPC eksekusi privat (Alchemy) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | notifikasi |

## Keamanan

- `.env` (private key + RPC privat) di-gitignore — jangan pernah di-commit.
- Trade yang berhasil wajib menutup target profit net + batas gas; revert tetap membayar gas.
- Mode EOA dua-transaksi dinonaktifkan; live wajib memakai executor atomic.
- Pool wajib allowlist dan hook-enabled pool ditolak.
- Modal kerja ada di kontrak; tarik kapan aja (owner only).
- Kontrak versi lama harus di-redeploy karena ABI dan safety policy berubah.
