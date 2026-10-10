# Victus Journal

An intraday trading journal and workstation in a single file, `index.html`. No build step and no server: open the file in a browser (desktop or phone) and it runs.

## Tabs

- **Dashboard**: P&L, goals, time-of-day, confidence and mistake/positive tags.
- **Signals**: imported alerts by day, setup, score, outcome, symbol, channel, sector, timeframe and hour, with R and % move.
- **Analysis**: deeper breakdowns, including Market days (BTC daily calendar, and hour by hour for a clicked day).
- **Broker reports in Analysis**: a Broker switch lists your journal books (Dhan, Delta) and every broker you uploaded a report from (CoinDCX ...), with a "Results by broker" table to compare them. Upload an Excel (.xlsx) or CSV trade report, such as a CoinDCX futures report; the broker is read from the file and can be changed before import. Its rows are grouped into trades with win rate, profit factor, drawdown, fees, funding, an equity curve, and breakdowns by pair and day. Kept apart from the journal books, so the dashboard and live stats never change. Uploading the same report twice adds nothing twice.
- **Calculator**: position size and risk for NSE (INR) and crypto (USD) accounts.
- **Data**: accounts, Delta Exchange import, GitHub sync, CSV export and backups.

## Where data lives

- **This browser**: everything is saved in `localStorage` (`tapeAndTarget.v2` for the journal, `tapeAndTarget.signals` for alerts, `tapeAndTarget.mktHourly` for cached BTC candles). Clearing site data clears the journal.
- **Broker report uploads**: stored with the journal (`backtest` in `tapeAndTarget.v2` and in `journal.json` once something is uploaded): the report's rows only, never the cover sheet's name, email or PAN. Each uploaded file keeps the broker it belongs to. The file is read in the browser; nothing is sent anywhere.
- **GitHub sync (optional)**: on the Data tab, add a fine-grained token with *Contents: Read and write* on your sync repo (e.g. `victus2034/trading-journal`). The journal is saved there as `journal.json`, so other devices can pick it up. The token, Delta API key and webhook never leave the browser.
- **Export**: the Data tab can download trades as CSV.

## Updating

Replace `index.html` and bump `<meta name="app-version">` near the top, so the version pill in the header shows which build each device is on.
Chart.js loads from jsDelivr; without it, charts are skipped and the rest still works.

## Checks

Every push runs `tests/smoke.mjs` on GitHub: it opens the page in a headless browser, with an empty journal and with made-up sample trades, on desktop and phone widths, opens every tab, and fails on any script error. It also uploads a made-up trade report (`tests/backtest-fixture.mjs`, as .xlsx and as .csv) in Analysis and checks every trade and total against the report, the broker switch and the per-broker results. To run it locally: `npm install`, `npx playwright install chromium`, then `npm test`.
