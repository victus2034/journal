# Victus Journal

An intraday trading journal and workstation in a single file, `index.html`. No build step and no server: open the file in a browser (desktop or phone) and it runs.

## Tabs

- **Dashboard**: P&L, goals, time-of-day, confidence and mistake/positive tags.
- **Signals**: imported alerts by day, setup, score, outcome, symbol, channel, sector, timeframe and hour, with R and % move.
- **Analysis**: deeper breakdowns, including Market days (BTC daily calendar, and hour by hour for a clicked day).
- **Calculator**: position size and risk for NSE (INR) and crypto (USD) accounts.
- **Data**: accounts, Delta Exchange import, GitHub sync, CSV export and backups.

## Where data lives

- **This browser**: everything is saved in `localStorage` (`tapeAndTarget.v2` for the journal, `tapeAndTarget.signals` for alerts, `tapeAndTarget.mktHourly` for cached BTC candles). Clearing site data clears the journal.
- **GitHub sync (optional)**: on the Data tab, add a fine-grained token with *Contents: Read and write* on your sync repo (e.g. `victus2034/trading-journal`). The journal is saved there as `journal.json`, so other devices can pick it up. The token, Delta API key and webhook never leave the browser.
- **Export**: the Data tab can download trades as CSV.

## Updating

Replace `index.html` and bump `<meta name="app-version">` near the top, so the version pill in the header shows which build each device is on.
Chart.js loads from jsDelivr; without it, charts are skipped and the rest still works.
