# RobinHood Arbitrage Bot

> Dokumentasi Inggris: [README.md](README.md)

Bot arbitrase atomik antara bonding curve RobinFun yang dikonfigurasi dan Uniswap V4 di Robinhood Chain (`chainId 4663`). Bot memeriksa dua arah:

| Arah | Rute |
|---|---|
| A | beli di curve, jual di V4 |
| B | beli di V4, jual di curve |

Trading live wajib memakai `ArbExecutor`. Kedua leg berjalan dalam satu transaksi. Executor melakukan revert kecuali saldo ETH kontrak bertambah sebesar target profit kotor, yang mencakup target net bot dan batas maksimum biaya gas. Transaksi yang revert tetap membayar gas.

Software ini tidak menjamin keuntungan. Bot dirancang untuk menolak transaksi yang tidak profitable atau tidak didukung.

## Cakupan market

Scanner hanya memasukkan market yang memenuhi seluruh syarat berikut:

- Pool berasal dari Uniswap V4 PoolManager yang dikonfigurasi.
- `currency0` adalah native ETH dan `currency1` adalah token.
- Token mempunyai curve aktif dan belum graduation pada satu RobinFun manager di `config.js`.
- Pool mempunyai active liquidity menurut V4 StateView.
- Pool tidak memakai hooks.
- Fee dan tick spacing lolos validasi.

Bot belum mendukung factory RobinFun lain, hook-enabled pool, pair non-native, atau DEX lain. Market yang lolos scanner baru layak diperiksa secara teknis. Trading loop tetap meminta quote positif setelah fee, slippage konservatif, price impact, dan batas gas.

## Model keamanan

- Mode live hanya memakai eksekusi atomik. Jalur EOA dua transaksi dinonaktifkan.
- Setiap PoolKey wajib mendapat izin on-chain.
- Pool baru tidak pernah mendapat izin otomatis.
- Executor membatasi ukuran trade dan menolak pool dengan hooks.
- Kontrak memakai token balance delta, safe ERC-20 calls, reentrancy guard, transfer ownership dua langkah, dan pause switch.
- Bot menjalankan scan dan eksekusi secara serial untuk mencegah trade paralel dan nonce race.
- Batas gas dan fee eksplisit membuat profit floor transaksi sukses tetap konservatif.
- PM2 me-restart proses yang gagal; error event RPC yang sementara ditangani tanpa crash loop.

## Kebutuhan

- Node.js 20 atau lebih baru
- npm
- Wallet khusus yang mempunyai ETH Robinhood Chain
- Private RPC Robinhood Chain untuk operasi live
- PM2 untuk operasi 24/7

Jangan memakai wallet utama. Jangan commit `.env`.

## Instalasi Windows

```powershell
npm install
Copy-Item .env.example .env
npm run check
```

Isi minimal konfigurasi berikut di `.env`:

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

Pemilihan RPC:

- Trading memakai `EXEC_RPC_URL` jika diisi.
- Monitoring memakai `RPC_URL`, lalu `EXEC_RPC_URL`, lalu pinned public provider.
- Scheduled scanner memakai `SCAN_RPC_URL`; jika kosong, scanner memakai pinned public provider agar pembacaan log historis tidak memakan kuota RPC trading.

`RPC_URL` dan `EXEC_RPC_URL` boleh memakai endpoint Alchemy yang sama.

## Deploy executor

Deployment hanya dilakukan satu kali untuk setiap versi executor:

```powershell
npm run build:contract
npm run deploy
```

Masukkan alamat kontrak yang dicetak ke `.env`:

```env
EXECUTOR_ADDR=0x...
```

Executor baru tidak mengizinkan pool apa pun secara default. Deployment kontrak RobinArb original tidak kompatibel dengan ABI executor versi ini.

## Temukan dan review market

Command berikut hanya membaca blockchain:

```powershell
npm run scan
npm run smoke
npm run snapshot -- 0.002
```

`scan` menulis `watchlist.json` dan cache incremental yang di-ignore Git. Cold scan membaca event `Initialize` historis satu kali. Scan berikutnya hanya membaca overlap reorg dan blok baru.

Ringkasan scan membedakan raw pool discovery dari market yang lolos filter. `Added: none` berarti tidak ada pool baru yang lolos seluruh filter; raw V4 pool mungkin tetap bertambah.

Periksa `watchlist.json` tepat sebelum memberi izin. Setelah itu jalankan:

```powershell
npm run allow-pools
```

Command tersebut mengirim transaksi on-chain. PoolKey dan token yang sudah diizinkan akan dilewati sehingga rerun tidak sengaja membayar izin duplikat.

Setelah allow pool baru, reload proses trading:

```powershell
pm2 restart robinarb --update-env
pm2 save
```

Pool yang hilang dari hasil scanner tidak otomatis kehilangan izin on-chain. Bot berhenti memuat pool tersebut setelah restart, tetapi permission executor tetap ada sampai dicabut di level kontrak.

## Deposit dan withdraw

Deposit `0.01 ETH`:

```powershell
$env:AMOUNT_ETH="0.01"
npm run deposit
Remove-Item Env:AMOUNT_ETH
```

Withdraw seluruh saldo executor:

```powershell
npm run withdraw
```

Withdraw jumlah tertentu:

```powershell
$env:AMOUNT_ETH="0.005"
npm run withdraw
Remove-Item Env:AMOUNT_ETH
```

Saldo executor adalah modal kerja. `MAX_SIZE_ETH` tetap menjadi batas ukuran setiap trade.

## Menjalankan bot

Dry run satu kali:

```powershell
npm run monitor:once
```

Dry run terus-menerus:

```powershell
npm run monitor
```

Live di foreground:

```powershell
npm run live
```

`npm run live` dapat mengirim transaksi. Command ini membutuhkan executor yang sudah didanai, tidak paused, dimiliki oleh `PRIVATE_KEY`, mempunyai setidaknya satu pool watchlist yang sudah di-allow, dan berada pada chain yang benar.

## Operasi PM2

`ecosystem.config.cjs` menjalankan dua proses:

| Proses | Tugas |
|---|---|
| `robinarb` | quote market dan eksekusi trade atomik yang diizinkan |
| `robinarb-scanner` | incremental scan saat startup dan setiap 30 menit |

Start atau reload keduanya:

```powershell
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
pm2 status
```

Log:

```powershell
pm2 logs robinarb
pm2 logs robinarb-scanner
```

PM2 membaca ulang `.env` ketika proses restart. Ubah `LIVE=1`, lalu jalankan `pm2 restart robinarb --update-env` untuk mengaktifkan live. Pada Windows, `pm2 save` menyimpan daftar proses; jalankan `pm2 resurrect` setelah reboot jika belum membuat Windows startup task terpisah.

Emergency stop:

```powershell
npm run pause
pm2 stop robinarb
```

Aktifkan kembali setelah review:

```powershell
npm run unpause
pm2 restart robinarb --update-env
```

## Alert Telegram

Isi:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_POLL_ALERTS=1
TELEGRAM_SCAN_ALERTS=1
```

Bot mengirim startup, setiap poll yang dikonfigurasi, idle dan spread negatif, opportunity yang memenuhi gate, trade sukses, execution error, ringkasan scan, market yang bertambah atau hilang, scanner failure, allowlist, deposit, withdraw, pause, dan unpause.

Alert setiap poll dapat memenuhi chat. Set `TELEGRAM_POLL_ALERTS=0` untuk mematikannya tanpa mematikan alert trade dan scanner. Request Telegram mempunyai timeout dan tidak memblokir trading selamanya.

## Konfigurasi utama

| Variabel | Kegunaan |
|---|---|
| `LIVE` | `1` mengaktifkan live pada PM2; `npm run live` memaksa live dan command monitor memaksa dry-run |
| `WATCHLIST` | membaca market dari `watchlist.json` |
| `MIN_SIZE_ETH`, `MAX_SIZE_ETH` | batas geometric probe dan ukuran trade |
| `GRID_POINTS` | jumlah ukuran probe per arah |
| `MIN_PROFIT_BPS` | target profit net setelah bounded gas reserve |
| `SLIPPAGE_BPS` | batas konservatif token pada leg pertama |
| `GAS_UNITS` | hard gas limit transaksi dan dasar profit reserve |
| `GAS_BUFFER_BPS` | buffer fee-per-gas; `12000` berarti 20% |
| `POLL_MS` | interval fallback market poll |
| `EVENT_POLL_MS` | cadence polling log provider |
| `RPC_URL`, `EXEC_RPC_URL` | endpoint monitoring dan eksekusi |
| `SCAN_RPC_URL` | endpoint khusus scanner, opsional |
| `SCAN_INTERVAL_MS` | interval scanner PM2; default `1800000` (30 menit) |
| `SCAN_RETRY_MS` | jeda retry scheduled scan yang gagal |
| `SCAN_CONFIRMATIONS` | blok terbaru yang belum dipakai scanner untuk finality |
| `SCAN_REORG_OVERLAP` | blok yang dibaca ulang untuk mengganti tail cache akibat reorg |
| `RPC_CONCURRENCY`, `RPC_RETRIES` | batas pinned public provider |

`GAS_UNITS=700000` adalah batas, bukan jumlah yang selalu dibayar. Receipt menagih gas yang benar-benar dipakai. Bot tetap memakai seluruh batas tersebut sebagai reserve ketika menilai profit sehingga opportunity tipis dapat ditolak.

## Validasi

```powershell
npm test
npm run check
npm run smoke
npm audit
```

`npm run check` menjalankan syntax check, tujuh automated tests, dan kompilasi Solidity deterministik dengan `solc 0.8.26`.

## Struktur repository

| Path | Kegunaan |
|---|---|
| `arb.js` | quoting market, event handling, dan serialized live execution |
| `risk.js` | validasi konfigurasi, gas policy, grid size, dan serialization |
| `scanner.js` | discovery incremental dan pembuatan watchlist |
| `scanner-daemon.js` | scheduled scanner untuk PM2 |
| `scripts/smoke.js` | pemeriksaan read-only chain, bytecode, liquidity, dan quote |
| `allow-pools.js` | permission PoolKey dan token yang idempotent |
| `executor-admin.js` | pause dan unpause |
| `provider.js` | pemilihan private RPC dan retry pinned provider |
| `telegram.js` | alert operasional dan trade yang non-blocking |
| `contracts/ArbExecutor.sol` | executor atomik dan risk control on-chain |
| `deploy.js`, `deposit.js`, `withdraw.js` | lifecycle executor dan dana |
| `test/` | test kompilasi kontrak, PoolKey, risk, dan output scanner |

## Batasan

- Hanya RobinFun manager yang dikonfigurasi yang didukung.
- Hook-enabled pool dan non-native V4 pair tidak didukung.
- Trade sukses wajib melewati target net, tetapi revert, deployment, permission, dan operasi admin tetap membayar gas.
- Belum ada database P&L persisten atau daily gas-loss circuit breaker.
- Kontrak belum diaudit oleh auditor independen.
- Kompetisi, transaction ordering, perubahan liquidity, dan latency RPC dapat menutup opportunity sebelum transaksi masuk blok.

Gunakan wallet khusus, mulai dengan modal terbatas, dan nilai receipt on-chain. Uptime dan aktivitas scanner bukan bukti keuntungan.
