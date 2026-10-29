// NSE price paths for the Signals tab's "Exit at" what-if, run by GitHub Actions
// in the journal's sync repo.
//
// "Exit at" re-scores every graded alert as if it closed at a fixed target
// (1R-3R, 1-3%) with its own stop. The journal reads crypto prices from Delta
// in the page, but Delta has no NSE stocks and Yahoo (which has them) doesn't
// answer web pages. So this reads each graded NSE alert's candles from Yahoo,
// walks them the way the journal's tgtWalk does, and writes one small summary
// per alert to nse-paths.json next to journal.json. The journal reads that file
// with its sync token.
//
// One summary per alert: m = best move its way before the stop (fraction of
// entry), sl = 1 when stopped, e = move at the window's last close, done = 1
// when the window is over; or { none } when the entry was never reached.
// The window is the scanner's: 20 candles of the alert's own timeframe after
// the fill, counted in NSE candles (4H = 09:15-13:15 and 13:15-15:30), so
// weekends and holidays don't count. A candle that touches both the stop and
// the target counts as the stop; on the fill candle only its close counts.
//
// Environment (GitHub sets the ones marked *):
//   GITHUB_TOKEN                  the job's token (contents: write)
//   GITHUB_REPOSITORY*, GITHUB_API_URL*   where journal.json lives
//   JOURNAL_BRANCH                its branch (main)
//   SCANNER_BASE, YAHOO_BASE      tests point these at fakes
import fs from 'node:fs';

const env = process.env;
const GH_API = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const REPO = env.GITHUB_REPOSITORY || '', BRANCH = env.JOURNAL_BRANCH || 'main';
export const PATHS_FILE = 'nse-paths.json';
const SCANNER_BASE = (env.SCANNER_BASE || 'https://raw.githubusercontent.com/victus2034/victus-indicator-strategy/scanner-runtime-state').replace(/\/+$/, '');
const YAHOO_BASE = (env.YAHOO_BASE || 'https://query1.finance.yahoo.com').replace(/\/+$/, '');
const BARS = 20, DAY = 864e5, MAX_GROUPS = 900;
const OUTCOMES = { SL: 1, '1R': 1, '2R': 1, BE: 1 };

// ---- time on the NSE clock (IST, no daylight saving) ----
const IST = 5.5 * 3600e3;
function istParts(ms) {
  const d = new Date(ms + IST), p = n => String(n).padStart(2, '0');
  return { day: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()), hm: p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay(), month: d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) };
}
export function tfMinutes(tf) {
  const s = String(tf || '').trim();
  if (/^1M$/.test(s) || /^1\s*mo/i.test(s)) return 43200;
  const m = s.match(/^(\d+)\s*([mhdw])$/i);
  return m ? +m[1] * { m: 1, h: 60, d: 1440, w: 10080 }[m[2].toLowerCase()] : null;
}
// Which candle of the alert's timeframe a moment falls in, as NSE draws them.
export function tfBucket(ms, tfMin) {
  const p = istParts(ms), open = 9 * 60 + 15;
  if (tfMin >= 43200) return p.month;
  if (tfMin >= 10080) { const mon = new Date(Date.parse(p.day + 'T00:00:00Z') - ((p.dow + 6) % 7) * DAY); return 'w' + mon.toISOString().slice(0, 10); }
  if (tfMin >= 1440) return p.day;
  return p.day + '#' + Math.floor(Math.max(0, p.min - open) / tfMin);
}
// The key the journal finds an alert's summary by: symbol, side, stop, alert time (IST).
export function pathKey(a) { const p = istParts(a.alertMs); return [a.symbol, a.side, a.stop, p.day + ' ' + p.hm].join('|'); }

// Pure: walk one alert's candles ({t ms, h, l, c}, `resMin` long each).
// Returns the summary, or null while the entry could still come.
export function walkAlert(a, bars, resMin) {
  const s = a.side === 'short' ? -1 : 1, entry = a.entry, stop = a.stop, tfMin = tfMinutes(a.tf), resMs = resMin * 60000;
  const live = bars.filter(k => k.h > 0 && k.l > 0 && k.c > 0 && k.t + resMs > a.alertMs).sort((x, y) => x.t - y.t);
  let idx = -1, last = null;
  live.forEach(k => { const b = tfBucket(k.t, tfMin); if (b !== last) { idx++; last = b; } k.i = idx; });
  const fi = live.findIndex(k => k.i < BARS && (s > 0 ? k.l <= entry : k.h >= entry));
  if (fi < 0) return live.some(k => k.i >= BARS) ? { none: 'entry not reached' } : null;
  const f = live[fi], end = f.i + BARS, r6 = v => Math.round(v * 1e6) / 1e6;
  const hitSl = k => s > 0 ? k.l <= stop : k.h >= stop, mv = p => s * (p - entry) / entry;
  if (hitSl(f)) return { m: 0, sl: 1, e: 0, done: 1 };
  let m = Math.max(0, mv(f.c)), lastBar = f;
  for (let i = fi + 1; i < live.length; i++) {
    const k = live[i];
    if (k.i >= end) return { m: r6(m), sl: 0, e: r6(mv(lastBar.c)), done: 1 };
    lastBar = k;
    if (hitSl(k)) return { m: r6(m), sl: 1, e: 0, done: 1 };
    m = Math.max(m, mv(s > 0 ? k.h : k.l));
  }
  return { m: r6(m), sl: 0, e: r6(mv(lastBar.c)), done: 0 };
}

// ---- the scanner's graded NSE alerts ----
const sym = v => String(v || '').split('/')[0].replace(/\.NS$/i, '').toUpperCase();
function jsonLines(text) { return String(text || '').split(/\r?\n/).map(l => { try { return l.trim() ? JSON.parse(l) : null; } catch (e) { return null; } }).filter(Boolean); }
// Zone alerts (4H): graded when filled with a net R, as the journal reads them.
export function zoneAlerts(text) {
  return jsonLines(text).filter(r => /^nse$/i.test(r.market || '') && r.filled === true && typeof r.net_realized_r === 'number' && !(r.rebuild && r.news_window)
    && typeof r.stop_price === 'number' && typeof r.zone_bottom === 'number' && typeof r.zone_top === 'number' && !isNaN(Date.parse(r.alert_time)))
    .map(r => {
      const side = r.side === 'short' ? 'short' : 'long';
      return { symbol: sym(r.symbol || r.display_symbol), side, stop: r.stop_price, entry: side === 'long' ? Math.max(r.zone_bottom, r.zone_top) : Math.min(r.zone_bottom, r.zone_top), alertMs: Date.parse(r.alert_time), tf: r.timeframe };
    });
}
// Fib, trendline and 1D+ zone alerts: graded when the results file has an outcome.
export function fibTlAlerts(recText, resText) {
  let res = {}; try { res = JSON.parse(resText || '{}') || {}; } catch (e) { res = {}; }
  return jsonLines(recText).filter(r => r.id && /^nse$/i.test(r.market || '') && r.plan && typeof r.plan.entry === 'number' && typeof r.plan.sl === 'number' && r.sent_ts
    && res[r.id] && res[r.id].filled && OUTCOMES[res[r.id].outcome] && !(r.rebuild && res[r.id].news_window))
    .map(r => ({ symbol: sym(r.symbol), side: r.plan.side === 'short' ? 'short' : 'long', stop: r.plan.sl, entry: r.plan.entry, alertMs: r.sent_ts * 1000, tf: r.tf }));
}

// ---- Yahoo ----
// The finest candles Yahoo keeps for that long: 15m for 60 days, 1h for 2 years.
function pickRes(a, now) {
  const tf = tfMinutes(a.tf), age = now - a.alertMs;
  if (tf <= 240 && age < 55 * DAY) return [15, '15m'];
  if (tf <= 1440 && age < 700 * DAY) return [60, '60m'];
  return [1440, '1d'];
}
const SPAN_DAYS = tf => tf <= 240 ? 45 : tf <= 1440 ? 90 : tf <= 10080 ? 420 : 1300;
async function yahoo(symbol, interval, from, to) {
  const url = YAHOO_BASE + '/v8/finance/chart/' + encodeURIComponent(symbol + '.NS') + '?interval=' + interval + '&period1=' + Math.floor(from / 1000) + '&period2=' + Math.ceil(to / 1000) + '&includePrePost=false';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (victus-journal nse-paths)' } });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error('Yahoo ' + res.status + ' for ' + symbol);
  const j = await res.json(), r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  return r.timestamp.map((t, i) => ({ t: t * 1000, h: q.high && q.high[i], l: q.low && q.low[i], c: q.close && q.close[i] })).filter(k => k.h > 0 && k.l > 0 && k.c > 0);
}

// ---- GitHub contents ----
function gh(path, opts = {}) {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opts.headers || {});
  return fetch(GH_API + '/repos/' + REPO + path, opts);
}
async function readPaths() {
  const meta = await gh('/contents/' + PATHS_FILE + '?ref=' + encodeURIComponent(BRANCH));
  if (meta.status === 404) return { sha: null, data: null };
  if (!meta.ok) throw new Error('GitHub ' + meta.status + ' reading ' + PATHS_FILE);
  const sha = (await meta.json()).sha;
  const raw = await gh('/contents/' + PATHS_FILE + '?ref=' + encodeURIComponent(BRANCH), { headers: { Accept: 'application/vnd.github.raw' } });
  let data = null; try { data = JSON.parse(await raw.text()); } catch (e) { data = null; }
  return { sha, data };
}

export async function main(now = Date.now()) {
  if (!REPO || !env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed');
  const get = async f => { const r = await fetch(SCANNER_BASE + '/' + f); return r.ok ? r.text() : ''; };
  const [fin, zr4h, ftRec, ftRes, ftrRec, ftrRes, zrHtf, zrHtfRes] = await Promise.all(['daily_backtest_finalized_records.jsonl', 'zone_rebuild_4h.jsonl', 'fib_trendline_alert_records.jsonl', 'fib_trendline_results.json', 'fibtl_rebuild_records.jsonl', 'fibtl_rebuild_results.json', 'zone_rebuild_htf.jsonl', 'zone_rebuild_htf_results.json'].map(get));
  const all = [...zoneAlerts(fin), ...zoneAlerts(zr4h), ...fibTlAlerts(ftRec, ftRes), ...fibTlAlerts(ftrRec, ftrRes), ...fibTlAlerts(zrHtf, zrHtfRes)].filter(a => tfMinutes(a.tf));
  const { sha, data } = await readPaths();
  const paths = (data && data.paths && typeof data.paths === 'object') ? data.paths : {};
  const before = JSON.stringify(paths);
  // Only alerts whose window isn't settled yet, grouped so one Yahoo read serves a symbol.
  const todo = {}, seen = {};
  all.forEach(a => {
    const k = pathKey(a);
    if (seen[k]) return; seen[k] = 1;
    const p = paths[k];
    if (p && (p.done || p.none)) return;
    const [resMin, interval] = pickRes(a, now);
    const g = todo[a.symbol + '|' + interval] = todo[a.symbol + '|' + interval] || { symbol: a.symbol, interval, resMin, list: [] };
    g.list.push(Object.assign({ key: k }, a));
  });
  const groups = Object.values(todo).slice(0, MAX_GROUPS);
  let failed = 0, read = 0;
  const worker = async () => {
    while (groups.length) {
      const g = groups.shift();
      const from = Math.min(...g.list.map(a => a.alertMs)) - DAY;
      let to = Math.min(now, Math.max(...g.list.map(a => a.alertMs + SPAN_DAYS(tfMinutes(a.tf)) * DAY)));
      const start = g.interval === '15m' ? Math.max(from, now - 59 * DAY) : g.interval === '60m' ? Math.max(from, now - 729 * DAY) : from;
      try {
        const bars = await yahoo(g.symbol, g.interval, start, to);
        read++;
        g.list.forEach(a => {
          const w = bars.length ? walkAlert(a, bars.map(b => Object.assign({}, b)), g.resMin) : { none: 'no candles on Yahoo' };
          if (w) paths[a.key] = w;
        });
      } catch (e) { failed++; console.log('skip ' + g.symbol + ' ' + g.interval + ': ' + e.message); }
    }
  };
  await Promise.all([1, 2, 3, 4].map(worker));
  console.log(`${all.length} graded NSE alerts, ${Object.keys(todo).length} symbol reads needed, ${read} read, ${failed} failed`);
  if (JSON.stringify(paths) === before) { console.log('nothing new'); return { changed: false, paths }; }
  const body = JSON.stringify({ v: 1, builtAt: new Date(now).toISOString(), paths });
  const put = await gh('/contents/' + PATHS_FILE, { method: 'PUT', body: JSON.stringify({ message: 'NSE price paths: ' + Object.keys(paths).length + ' alerts', content: Buffer.from(body).toString('base64'), branch: BRANCH, sha: sha || undefined }) });
  if (!put.ok) throw new Error('GitHub ' + put.status + ' writing ' + PATHS_FILE + ': ' + (await put.text()).slice(0, 200));
  console.log('wrote ' + PATHS_FILE + ' (' + Object.keys(paths).length + ' alerts)');
  return { changed: true, paths };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
