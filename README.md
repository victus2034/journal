# Victus Journal

An intraday trading journal and workstation in a single file, `index.html`. No build step and no server: open the file in a browser (desktop or phone) and it runs.

## Tabs

- **Dashboard**: P&L, goals, time-of-day, confidence and mistake/positive tags.
- **Signals**: imported alerts by day, setup, score, outcome, symbol, channel, sector, timeframe and hour, with R and % move.
- **Analysis**: deeper breakdowns, including Market days (BTC daily calendar, and hour by hour for a clicked day).
- **Broker reports**: upload an Excel (.xlsx) or CSV trade report, such as a CoinDCX futures report. The broker is read from the file (and can be changed before import) and gets a book of its own, next to Dhan and Delta. Its closed trades count everywhere a journal trade does: dashboard P&L, calendar, equity curve, goals and the book's balance, dated by the day they closed. Analysis shows them trade by trade (grouped from the report rows, with fees, funding, an equity curve and breakdowns by pair and day), with a "Results by broker" table to compare books. Size and mistake analysis leaves them out, since a report has no price or size. Uploading the same report twice adds nothing twice.
- **Calculator**: position size and risk for NSE (INR) and crypto (USD) accounts.
- **Data**: accounts, Delta Exchange import, CoinDCX import, GitHub sync, CSV export and backups.
- **CoinDCX API import**: in Sync & Settings, paste a CoinDCX API key and secret and press Test & Connect. The journal reads your futures transactions (INR and USDT margined) into the CoinDCX book, the same one an uploaded report fills, and again each time the page opens. A transaction that is also in an uploaded report counts once (same pair and kind, within 3 seconds, same net). CoinDCX has no read-only keys, so use a separate key bound to your IP. This needs CoinDCX to accept calls from a web page; if it doesn't, the status says so and report uploads still work.
- **Rupees and dollars**: the ₹ INR / $ USD switch at the start of the accounts bar shows every book, tab and figure (P&L, fees, balances, limits, goals, broker reports) in one currency. Each book converts at its own rate: dollar books at Delta India's fixed ₹85, CoinDCX at its USDT price (₹99.30 by default, from its wallet ₹ ÷ $). Change a rate in Sync & Settings → Trading Books → Edit. Prices and sizes stay as traded; the trade inspector shows the book's own figure next to the converted one.

## Where data lives

- **This browser**: everything is saved in `localStorage` (`tapeAndTarget.v2` for the journal, `tapeAndTarget.signals` for alerts, `tapeAndTarget.mktHourly` for cached BTC candles). Clearing site data clears the journal.
- **Broker report uploads**: stored with the journal (`backtest` in `tapeAndTarget.v2` and in `journal.json` once something is uploaded): the report's rows only, never the cover sheet's name, email or PAN. Each uploaded file keeps the broker it belongs to; the broker's book (`rep-<broker>-<currency>`) is made from it on any device. The file is read in the browser; nothing is sent anywhere.
- **GitHub sync (optional)**: on the Data tab, add a fine-grained token with *Contents: Read and write* on your sync repo (e.g. `victus2034/trading-journal`). The journal is saved there as `journal.json`, so other devices can pick it up. The token, Delta and CoinDCX API keys and webhook never leave the browser.
- **Export**: the Data tab can download trades as CSV.

## Updating

Replace `index.html` and bump `<meta name="app-version">` near the top, so the version pill in the header shows which build each device is on.
Chart.js loads from jsDelivr; without it, charts are skipped and the rest still works.

## Checks

Every push runs `tests/smoke.mjs` on GitHub: it opens the page in a headless browser, with an empty journal and with made-up sample trades, on desktop and phone widths, opens every tab, and fails on any script error. It also uploads a made-up trade report (`tests/backtest-fixture.mjs`, as .xlsx and as .csv) and checks every trade and total against the report, in Analysis and on the Dashboard, plus the broker books and the per-broker results. To run it locally: `npm install`, `npx playwright install chromium`, then `npm test`.
