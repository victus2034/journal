// NSE candles for the Signals tab, run by GitHub Actions in the journal's sync repo
// (.github/workflows/nse-paths.yml there, twice a day after the NSE close).
//
// The Signals tab plays every alert on real candles (Exit at, SL types, Move SL,
// Trail TP, Partial, the Demo account). Crypto candles come from Delta, read by the
// page. Delta has no NSE stocks and Yahoo (which has them) doesn't answer web pages,
// so this job reads the candles of every NSE symbol the scanner alerts on from Yahoo
// and writes them to OUT_DIR. The workflow then commits that folder as the one commit
// of the sync repo's "nse-candles" branch (no history kept). The journal reads it
// there with its sync token (tree + blobs, cached on the device by blob sha).
//
// Until v.190 this job walked each graded alert itself and wrote one summary per
// alert (nse-paths.json): only the alert's own stop could be scored, so every other
// SL type left NSE out (lakky, 2026-11-13: "fix this", NSE 1D trendlines all dashes).
//
// Two files per symbol, so a device reads again only what changed:
//   SYM.a.json  candles that opened before the previous month (changes once a month)
//   SYM.b.json  the rest (changes every run)
// Each: { v, sym, f32, s: { "60": rows, "4H": rows, "1D": rows, "1W": rows, "1M": rows } }
// row = [open time (s), open, high, low, close]. "60" = Yahoo's 60m candles (the
// walks). 4H / 1D / 1W / 1M = NSE's own candles of each alert timeframe (the candle
// SL): 4H = 09:15-13:15 and 13:15-15:30 IST built from the 60m, 1D / 1W (Monday
// weeks) / 1M (calendar months) built from Yahoo's days, each stamped at its 09:15
// IST open. f32 = 1: Yahoo's prices are float32; each is written as the shortest
// decimal that rounds back to it (the reader applies Math.fround), a third the size.
// index.json: { v, builtAt, cut, starts, symbols }.
//
// Each run starts from the last run's files (the workflow checks the branch out into
// OUT_DIR) and lays Yahoo's new reads over them, so a failed read keeps what was
// there and candles older than Yahoo keeps (60m: 730 days) stay.
//
// Environment:
//   NSE_CANDLES_DIR           where the files go (default ./nse-candles)
//   SCANNER_BASE, YAHOO_BASE  tests point these at fakes
import fs from 'node:fs';
import path from 'node:path';

const env = process.env;
const SCANNER_BASE = (env.SCANNER_BASE || 'https://raw.githubusercontent.com/victus2034/victus-indicator-strategy/scanner-runtime-state').replace(/\/+$/, '');
const YAHOO_BASE = (env.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
const DAY = 864e5, IST = 5.5 * 3600e3;
export const KEYS = ['60', '4H', '1D', '1W', '1M'];
// Fixed first days (IST), so a later run never changes the candles an old alert sees.
// 60: a week before the first NSE alert the journal has (1 Jun 2026). The rest reach
// 300 candles of their timeframe (the candle SL's look-back) before that alert.
export const STARTS = { '60': '2026-05-25', '4H': '2025-10-01', '1D': '2025-01-01', '1W': '2019-06-03', '1M': '2000-01-01' };

// ---- time on the NSE clock (IST, no daylight saving) ----
function ist(ms) { const d = new Date(ms + IST); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: d.getUTCDay(), min: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
const atIst = (y, m, d, min) => Date.UTC(y, m, d) - IST + min * 60000;
const OPEN = 9 * 60 + 15, MID = 13 * 60 + 15;
export const istDay = s => Date.parse(s + 'T00:00:00+05:30');
// The open (ms) of the NSE candle of size key that the moment ms falls in.
export function candleStart(ms, key) {
  const p = ist(ms);
  if (key === '4H') return atIst(p.y, p.m, p.d, p.min < MID ? OPEN : MID);
  if (key === '1D') return atIst(p.y, p.m, p.d, OPEN);
  if (key === '1W') return atIst(p.y, p.m, p.d - (p.dow + 6) % 7, OPEN);
  if (key === '1M') return atIst(p.y, p.m, 1, OPEN);
  return ms;
}
// Pure: rows {t ms, o, h, l, c} (sorted) -> NSE candles of size key, [t s, o, h, l, c].
export function build(rows, key) {
  const out = [];
  rows.forEach(k => {
    const b = candleStart(k.t, key) / 1000, last = out[out.length - 1];
    if (last && last[0] === b) { last[2] = Math.max(last[2], k.h); last[3] = Math.min(last[3], k.l); last[4] = k.c; }
    else out.push([b, k.o, k.h, k.l, k.c]);
  });
  return out;
}

// ---- the symbols the scanner alerts on ----
const sym = v => String(v || '').split('/')[0].replace(/\.NS$/i, '').toUpperCase();
function jsonLines(text) { return String(text || '').split(/\r?\n/).map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch (e) { return null; } }).filter(Boolean); }
export function nseSymbols(texts) {
  const out = new Set();
  texts.forEach(t => jsonLines(t).forEach(r => { if (/^nse$/i.test(r.market || '') && sym(r.symbol || r.display_symbol)) out.add(sym(r.symbol || r.display_symbol)); }));
  return [...out].sort();
}

// ---- Yahoo ----
async function yahoo(symbol, interval, from, to) {
  const url = YAHOO_BASE + '/v8/finance/chart/' + encodeURIComponent(symbol + '.NS') + '?interval=' + interval + '&period1=' + Math.floor(from / 1000) + '&period2=' + Math.ceil(to / 1000) + '&includePrePost=false';
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (victus-journal nse-candles)' } });
    if ((res.status === 429 || res.status >= 500) && i < 2) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
    if (res.status === 404) return [];
    if (!res.ok) throw new Error('Yahoo ' + res.status + ' for ' + symbol + ' ' + interval);
    const j = await res.json(), r = j && j.chart && j.chart.result && j.chart.result[0];
    if (!r || !Array.isArray(r.timestamp)) return [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {}, seen = {};
    return r.timestamp.map((t, i) => ({ t: t * 1000, o: q.open && q.open[i], h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i] }))
      .filter(k => k.o > 0 && k.h > 0 && k.l > 0 && k.c > 0 && !seen[k.t] && (seen[k.t] = 1))
      .map(k => Object.assign(k, { h: Math.max(k.h, k.o, k.c), l: Math.min(k.l, k.o, k.c) }))
      .sort((a, b) => a.t - b.t);
  }
}

// ---- files ----
// The shortest decimal that rounds back to the float32 v.
function f32(v) { for (let p = 1; p <= 9; p++) { const x = +v.toPrecision(p); if (Math.fround(x) === v) return x; } return v; }
export function encode(symbol, series) {
  const all = KEYS.every(k => (series[k] || []).every(r => r.slice(1).every(v => Math.fround(v) === v)));
  const s = {};
  KEYS.forEach(k => { s[k] = (series[k] || []).map(r => all ? [r[0]].concat(r.slice(1).map(f32)) : r.slice()); });
  return JSON.stringify({ v: 1, sym: symbol, f32: all ? 1 : 0, s });
}
export function decode(text) {
  let j = null; try { j = JSON.parse(text); } catch (e) { return null; }
  if (!j || typeof j.s !== 'object' || !j.s) return null;
  const s = {};
  KEYS.forEach(k => { s[k] = (Array.isArray(j.s[k]) ? j.s[k] : []).filter(r => Array.isArray(r) && r.length === 5).map(r => j.f32 ? [r[0]].concat(r.slice(1).map(Math.fround)) : r.slice()); });
  return s;
}
const fileOf = (dir, symbol, part) => path.join(dir, symbol + '.' + part + '.json');
function readOld(dir, symbol) {
  const s = {};
  KEYS.forEach(k => { s[k] = []; });
  ['a', 'b'].forEach(part => {
    let t = null; try { t = fs.readFileSync(fileOf(dir, symbol, part), 'utf8'); } catch (e) { return; }
    const d = decode(t);
    if (d) KEYS.forEach(k => { s[k] = s[k].concat(d[k]); });
  });
  return s;
}
// Pure: the old rows with the new ones laid over them (same open time: the new one).
export function merge(oldRows, newRows) {
  const m = new Map();
  (oldRows || []).forEach(r => m.set(r[0], r));
  (newRows || []).forEach(r => m.set(r[0], r));
  return [...m.values()].sort((a, b) => a[0] - b[0]);
}
// The previous IST month's first day: candles before it go to the ".a" file.
export function cutOf(now) { const p = ist(now); return atIst(p.y, p.m - 1, 1, 0) / 1000; }

export async function main(now = Date.now()) {
  const dir = path.resolve(env.NSE_CANDLES_DIR || 'nse-candles');
  fs.mkdirSync(dir, { recursive: true });
  const get = async f => { const r = await fetch(SCANNER_BASE + '/' + f); return r.ok ? r.text() : ''; };
  const texts = await Promise.all(['daily_backtest_finalized_records.jsonl', 'zone_rebuild_4h.jsonl', 'fib_trendline_alert_records.jsonl', 'fibtl_rebuild_records.jsonl', 'zone_rebuild_htf.jsonl'].map(get));
  const symbols = nseSymbols(texts);
  if (!symbols.length) throw new Error('no NSE symbols in the scanner records');
  const cut = cutOf(now), todo = symbols.slice(), from = {};
  KEYS.forEach(k => { from[k] = istDay(STARTS[k]); });
  // Yahoo keeps 60m candles for 730 days.
  const h1From = Math.max(Math.min(from['60'], from['4H']), istDay(new Date(now - 729 * DAY + IST).toISOString().slice(0, 10)));
  let read = 0, failed = 0, kept = 0;
  const worker = async () => {
    while (todo.length) {
      const s = todo.shift();
      try {
        const [h1, d1] = [await yahoo(s, '60m', h1From, now), await yahoo(s, '1d', from['1M'], now)];
        if (!h1.length && !d1.length) { kept++; continue; }
        const fresh = {
          '60': h1.filter(k => k.t >= from['60']).map(k => [k.t / 1000, k.o, k.h, k.l, k.c]),
          '4H': build(h1.filter(k => k.t >= from['4H']), '4H'),
          '1D': build(d1.filter(k => k.t >= from['1D']), '1D'),
          '1W': build(d1.filter(k => k.t >= from['1W']), '1W'),
          '1M': build(d1.filter(k => k.t >= from['1M']), '1M')
        };
        const old = readOld(dir, s), a = {}, b = {};
        KEYS.forEach(k => { const rows = merge(old[k], fresh[k]); a[k] = rows.filter(r => r[0] < cut); b[k] = rows.filter(r => r[0] >= cut); });
        fs.writeFileSync(fileOf(dir, s, 'a'), encode(s, a));
        fs.writeFileSync(fileOf(dir, s, 'b'), encode(s, b));
        read++;
      } catch (e) { failed++; console.log('skip ' + s + ': ' + e.message); }
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  const have = fs.readdirSync(dir).filter(f => /\.[ab]\.json$/.test(f)).map(f => f.replace(/\.[ab]\.json$/, ''));
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ v: 1, builtAt: new Date(now).toISOString(), cut, starts: STARTS, symbols: [...new Set(have)].sort() }));
  console.log(`${symbols.length} NSE symbols: ${read} read from Yahoo, ${kept} with no candles, ${failed} failed (last run's files kept)`);
  if (!read && failed) throw new Error('every Yahoo read failed');
  return { symbols, read, failed, dir };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
