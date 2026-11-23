// Runs the journal's own Signals tab on a saved snapshot of real data and writes what it shows,
// for tools/signals-retest.py to check alert by alert (lakky, 2026-11-23: "do a backtest of all the
// alerts and make sure it matches with the backtest of journal with all conditions").
//
// The snapshot: the scanner's alert files and the Delta candles the tab reads, taken at one moment
// (victus-indicator-strategy research/signals_parity_data.py, part signals-parity of
// bitunix_research.yml), the NSE job's candle files (the sync repo's nse-candles branch) and the
// scanner's config.py (its watchlist). Every request the page makes is answered from those files,
// with the page's clock at the snapshot's moment, so the tab sees exactly what the retest sees.
//
//   node tools/signals-audit.mjs --data DIR --nse DIR --config config.py --combos combos.json --out app.json
//
// DIR: state/<file>.gz, candles/<SYM>_<res>.json.gz, products.json, meta.json ({end}).
// combos.json: [{name, kind, ...}] as tools/signals-retest.py reads them.
// app.json: {combo name: {rows: {alert key: [R or null, filled true/false/null]}, strip: {...}}}.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : null; };
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA = arg('data'), NSE = arg('nse'), CONFIG = arg('config'), OUT = arg('out');
const combos = JSON.parse(fs.readFileSync(arg('combos'), 'utf8'));
const only = arg('only');
const meta = JSON.parse(fs.readFileSync(path.join(DATA, 'meta.json'), 'utf8'));
const gz = f => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');

const stateFiles = {};
fs.readdirSync(path.join(DATA, 'state')).forEach(f => { stateFiles[f.replace(/\.gz$/, '')] = gz(path.join(DATA, 'state', f)); });
const candles = {};
fs.readdirSync(path.join(DATA, 'candles')).forEach(f => { candles[f.replace(/\.json\.gz$/, '')] = JSON.parse(gz(path.join(DATA, 'candles', f))); });
const products = fs.readFileSync(path.join(DATA, 'products.json'), 'utf8');
const configPy = CONFIG ? fs.readFileSync(CONFIG, 'utf8') : '';
const nseBlobs = {};
if (NSE) fs.readdirSync(NSE).filter(f => /\.(a|b)\.json$|^index\.json$/.test(f)).forEach(f => {
  const text = fs.readFileSync(path.join(NSE, f), 'utf8');
  nseBlobs[crypto.createHash('sha1').update(text).digest('hex')] = { path: f, text };
});

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, req.url.split('?')[0] === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
let reads = 0;
const json = (r, body) => r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body });
await ctx.route(url => !url.href.startsWith(base), r => {
  const u = r.request().url();
  if (u.includes('/scanner-runtime-state/')) {
    const f = u.split('/').pop().split('?')[0];
    return f in stateFiles ? r.fulfill({ status: 200, contentType: 'text/plain', body: stateFiles[f] }) : r.fulfill({ status: 404, body: '' });
  }
  if (u.includes('/victus-indicator-strategy/main/config.py')) return configPy ? r.fulfill({ status: 200, contentType: 'text/plain', body: configPy }) : r.fulfill({ status: 404, body: '' });
  if (u.startsWith('https://api.github.com/repos/victus/sync/git/trees/nse-candles')) { reads++; return json(r, JSON.stringify({ tree: Object.keys(nseBlobs).map(sha => ({ path: nseBlobs[sha].path, type: 'blob', sha })) })); }
  if (u.startsWith('https://api.github.com/repos/victus/sync/git/blobs/')) {
    const b = nseBlobs[u.split('/').pop()];
    reads++;
    return r.fulfill({ status: b ? 200 : 404, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain' }, body: b ? b.text : '{}' });
  }
  if (u.startsWith('https://api.india.delta.exchange/v2/products')) return json(r, products);
  if (u.startsWith('https://api.india.delta.exchange/v2/history/candles')) {
    const q = new URL(u).searchParams, a = +q.get('start'), b = +q.get('end');
    const ser = candles[q.get('symbol') + '_' + q.get('resolution')];
    reads++;
    const rows = (ser || []).filter(x => x[0] >= a && x[0] <= b && x[0] <= meta.end);
    return json(r, JSON.stringify({ success: true, result: rows.map(([time, open, high, low, close]) => ({ time, open, high, low, close, volume: 1 })) }));
  }
  return r.abort();
});
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('page error: ' + e.message));
page.on('dialog', d => d.dismiss());
await page.clock.install({ time: new Date(meta.end * 1000) });
await page.clock.resume();
await page.goto(base, { waitUntil: 'load' });
await page.waitForFunction(() => typeof tgtReady !== 'undefined' && tgtReady && typeof signalsReady !== 'undefined', null, { timeout: 60000 });
await page.evaluate(async () => {
  await signalsReady; while (sigAutoBusy) await new Promise(r => setTimeout(r, 100));
  state.ui.sigMkt = 'all';
  state.sync = { token: 'tok', repo: 'victus/sync', branch: 'main', auto: false, lastAt: '', lastSha: '' };
  await autoRefreshAlerts(true); switchTab('signals');
});
const out = fs.existsSync(OUT) && arg('resume') ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const busy = () => page.evaluate(() => tgtBusy || slcBusy || tgtQ.length > 0 || slcQ.length > 0 || (typeof nseBusy !== 'undefined' && nseBusy) || mktLoading || mvLoading || demoLiveBusy);
let done = 0;
for (const c of combos) {
  if (only && !new RegExp(only).test(c.name)) continue;
  if (out[c.name]) { done++; continue; }
  const t0 = Date.now();
  await page.evaluate(c => {
    const u = state.ui;
    Object.assign(u, {
      sigKind: c.kind, sigChan: c.chan || '', sigMkt: 'all', sigMarket: c.market || '', sigAsset: c.asset || '', sigCoins: c.coins || '', sigCoinRank: c.coinRank || 'cap', sigCoinPicks: c.picks || ['BTC', 'ETH', 'SOL'],
      sigPeriod: c.period ? { mode: c.period, from: '', to: '' } : { mode: 'custom', from: c.from || '2000-01-01', to: c.to || '2099-12-31' }, sigDay: '',
      mktFilter: c.btc || '', mvFilter: c.mv || '', sigSkipTiny: !!c.skipTiny,
      sigTgt: c.tgt || '', sigHold: c.hold || 'tp', sigNoFee: !!c.nofee, sigLvl: c.lvl || '', sigLvlOff: c.lvlOff || [], sigTlType: c.tl || '', sigSec: 'edge', sigEarly: c.early || 0
    });
    u.sigSl = Object.assign({ mode: '', gap: 0.75, pct: 1 }, c.sl || {});
    u.sigStop = Object.assign({ mode: 'off', beAt: 1, shAt: 1, shTo: 0.75, beAtP: 1, shAtP: 1, shToP: 0.5 }, c.stop || {});
    u.sigTrail = Object.assign({ on: false, step: 0.25, gap: 0.25, stepP: 0.25, gapP: 0.25 }, c.trail || {});
    u.sigPart = Object.assign({ q: 0, at: 1, atP: 0.5, beQ: 0 }, c.part || {});
    save(); renderSignalsTable();
  }, c);
  // Until the tab's own reads settle and a redraw asks for nothing more.
  for (let i = 0, quiet = 0; i < 4000; i++) {
    await page.waitForTimeout(150);
    if (await busy()) { quiet = 0; continue; }
    if (++quiet < 2) continue;
    const r0 = reads;
    await page.evaluate(() => renderSignalsTable());
    await page.waitForTimeout(250);
    if (reads === r0 && !(await busy())) break;
    quiet = 0;
  }
  const d = await page.evaluate(() => withOutcomeCache(() => inSigScope(() => {
    const strip = {};
    document.querySelectorAll('#sigEdgeStrip > div').forEach(card => {
      const lab = card.querySelector('span'), val = card.querySelector('.mono-num'), sub = card.querySelector('.my-0\\.5 > .text-\\[10px\\]');
      if (lab && val) strip[lab.innerText.trim()] = { val: val.innerText.trim(), sub: sub ? sub.innerText.trim() : '' };
    });
    const rows = {};
    sigView.pairs.forEach(pr => { const o = outcomeOf(pr), k = pr.signal.key; rows[k] = [o ? o.r : null, tgtFilled(pr), o ? (o.label || pr.signal.outcome || '') : '']; });
    return { n: sigView.pairs.length, dup: sigView.pairs.length - Object.keys(rows).length, rows, strip,
      banner: (document.getElementById('sigNotFinal') || {}).innerText || '', empty: sigView.empty ? sigView.empty.why : '',
      ui: { coins: state.ui.sigCoins, chan: state.ui.sigChan, market: state.ui.sigMarket, tgt: state.ui.sigTgt } };
  })));
  out[c.name] = d;
  done++;
  console.log(`${done}/${combos.length} ${c.name}: ${d.n} alerts${d.dup ? ', ' + d.dup + ' DUPLICATE KEYS' : ''}, ${((Date.now() - t0) / 1000).toFixed(1)}s${d.banner ? ' | ' + d.banner : ''}`);
  if (done % 10 === 0) fs.writeFileSync(OUT, JSON.stringify(out));
}
fs.writeFileSync(OUT, JSON.stringify(out));
if (errs.length) console.log('page errors:\n  ' + errs.slice(0, 10).join('\n  '));
await browser.close();
server.close();
