// Opens index.html in headless Chromium and fails on any script error.
// Runs twice: with an empty browser, and with a small made-up journal so the
// charts, tables and stats actually render. Every tab is opened on desktop
// and phone widths. Outside requests (CDN, GitHub, Delta) are blocked, so the
// check never depends on the network. One more pass fills storage to 86%
// and expects the storage warning. The last pass uploads a made-up CoinDCX
// trade report (.xlsx, then the same as .csv), checks every number it shows
// against the report, in Analysis and on the Dashboard, and switches brokers.
// Then a fake CoinDCX API checks that every call is signed as CoinDCX
// documents and sends the same trades back, which must count only once.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { EXPECTED, REPORT_ROWS, backtestXlsx, backtestCsv } from './backtest-fixture.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TABS = ['dashboard', 'signals', 'analysis', 'calculator', 'data'];

function fixture() {
  const day = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const now = new Date().toISOString();
  const accounts = [
    { id: 'acc_nse', name: 'Test NSE', market: 'nse', currency: 'INR', startBalance: 100000, maxRiskPct: 1, dailyLossLimit: 2, maxTradesPerDay: 5, defaultLeverage: 5, updatedAt: now },
    { id: 'acc_cry', name: 'Test Crypto', market: 'crypto', currency: 'USD', startBalance: 100, maxRiskPct: 1.5, dailyLossLimit: 2.5, maxTradesPerDay: 5, defaultLeverage: 10, updatedAt: now },
  ];
  const trades = [];
  for (let i = 0; i < 16; i++) {
    const crypto = i % 2 === 1, long = i % 3 !== 0, win = i % 4 !== 0;
    const entry = crypto ? 100 : 2000, stop = long ? entry * 0.99 : entry * 1.01;
    const move = (win ? 1.5 : -1) * Math.abs(entry - stop);
    const exit = long ? entry + move : entry - move, qty = crypto ? 2 : 10;
    const pnl = (long ? exit - entry : entry - exit) * qty, risk = Math.abs(entry - stop) * qty;
    trades.push({
      id: 'tr' + i, accountId: crypto ? 'acc_cry' : 'acc_nse', date: day(i), exitDate: day(i),
      time: '10:' + String(10 + i).padStart(2, '0'), exitTime: '11:00',
      symbol: crypto ? 'BTCUSD' : 'RELIANCE', direction: long ? 'long' : 'short',
      entry, exit, stop, qty, fees: 0.1, leverage: crypto ? 10 : 5, setup: i % 2 ? 'Breakout' : 'Pullback',
      rules: [true, false, true, false, true], notes: 'smoke test', updatedAt: now,
      playRules: i % 2 ? { 'Volume spike': true, 'Above VWAP': i % 3 !== 0 } : undefined,
      pnl, risk, r: pnl / risk,
    });
  }
  const goals = [{ id: 'g1', title: 'Test goal', target: 20, metric: 'net_pnl', targets: { net_pnl: 20 }, period: 'month', accountId: 'all', days: 'weekdays', updatedAt: now }];
  const playbook = [{ id: 'pb1', name: 'Breakout', rules: ['Volume spike', 'Above VWAP'], updatedAt: now }];
  return { version: 1, savedAt: now, accounts, trades, signals: [], goals, playbook, aliases: [], tombstones: [], reviews: [], reviewsAt: [] };
}

const server = http.createServer((req, res) => {
  const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + server.address().port + '/';

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const failures = [];

async function run(label, viewport, seed, filler = 0) {
  const ctx = await browser.newContext({ viewport });
  if (filler) await ctx.addInitScript(n => { try { localStorage.setItem('tapeAndTarget.test-filler', 'x'.repeat(n)); } catch (e) {} }, filler);
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  if (seed) await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.dismiss());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(500);
  for (const tab of TABS) {
    try { await page.evaluate(t => switchTab(t), tab); }
    catch (e) { errs.push('opening tab "' + tab + '" threw: ' + e.message.split('\n').slice(0, 3).join(' | ')); continue; }
    await page.waitForTimeout(300);
    const shown = await page.evaluate(t => { const v = document.getElementById('view-' + t); return !!v && !v.classList.contains('hidden') && v.offsetHeight > 0; }, tab);
    if (!shown) errs.push('tab "' + tab + '" did not show');
  }
  const warned = await page.evaluate(() => { const w = document.getElementById('storageWarn'); return !!w && !w.classList.contains('hidden'); });
  if (warned !== !!filler) errs.push(filler ? 'storage warning did not show with storage nearly full' : 'storage warning showed with storage nearly empty');
  if (seed) {
    const kept = await page.evaluate(() => (state.trades || []).length);
    if (kept !== seed.trades.length) errs.push('expected ' + seed.trades.length + ' trades after load, found ' + kept);
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Rupees and dollars: one switch shows every book in either currency, each
// converted at its own rate. The expected figures are worked out here from the
// fixture, apart from the app's own sums.
async function currencyRun(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const inr = v => (v < 0 ? '-' : '') + '₹' + Math.abs(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = v => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  // The app's P&L: price move times size, less fees.
  const pnlOf = t => (t.direction === 'long' ? t.exit - t.entry : t.entry - t.exit) * t.qty - (t.fees || 0);
  const net = id => seed.trades.filter(t => t.accountId === id).reduce((s, t) => s + pnlOf(t), 0);
  const nseNet = net('acc_nse'), cryNet = net('acc_cry');
  const nseBal = 100000 + nseNet, cryBal = 100 + cryNet;
  try {
    const look = () => page.evaluate(() => {
      const s = computeStats(statScoped());
      return { n: s.n, net: s.net, cur: viewCur(), bal: document.getElementById('topBalVal').innerText,
        sw: [...document.querySelectorAll('#allCurSwitch button')].map(b => b.innerText + (b.className.includes('amber') ? '*' : '')).join(','),
        ledger: document.getElementById('tradeLedgerTableBody').innerText, maxLoss: document.getElementById('riskDailyMaxLoss').innerText };
    });
    // A dollar book on its own, before the switch is used: its own currency.
    await page.evaluate(() => { delete state.ui.allCur; state.ui.account = 'acc_cry'; renderAll(); });
    let v = await look();
    check(v.cur === 'USD' && v.sw === '₹ INR,$ USD*' && v.n === 8 && near(v.net, cryNet) && v.bal === usd(cryBal), 'Test Crypto in its own dollars: ' + JSON.stringify(v));
    // The switch on a single book turns it into rupees at ₹85.
    await page.click('#allCurSwitch button[data-cur="INR"]');
    v = await look();
    check(v.cur === 'INR' && v.sw === '₹ INR*,$ USD' && v.n === 8 && near(v.net, cryNet * 85) && v.bal === inr(cryBal * 85), 'Test Crypto in rupees: ' + JSON.stringify(v));
    check(v.ledger.includes('₹') && !v.ledger.includes('$'), 'ledger not in rupees: ' + v.ledger.slice(0, 200));
    check(v.maxLoss === inr(2.5 * 85), 'daily loss limit in rupees: ' + v.maxLoss);
    // All books together, either way.
    await page.evaluate(() => { state.ui.account = 'all'; renderAll(); });
    v = await look();
    check(v.n === 16 && near(v.net, nseNet + cryNet * 85) && v.bal === inr(nseBal + cryBal * 85), 'All in rupees: ' + JSON.stringify(v));
    check(v.maxLoss === inr(2 + 2.5 * 85), 'All: daily loss limits added up: ' + v.maxLoss);
    await page.click('#allCurSwitch button[data-cur="USD"]');
    v = await look();
    check(v.n === 16 && near(v.net, nseNet / 85 + cryNet) && v.bal === usd(nseBal / 85 + cryBal), 'All in dollars: ' + JSON.stringify(v));
    // Today's NSE loss breaks that book's own ₹2 limit; the message is in dollars.
    const today = await page.evaluate(() => iso(new Date()));
    const todayNse = seed.trades.filter(t => t.accountId === 'acc_nse' && t.date === today).reduce((s, t) => s + pnlOf(t), 0);
    const lim = await page.evaluate(() => dailyLimitState('USD'));
    check(todayNse < -2 && lim.hit && lim.msg.includes(usd(todayNse / 85)) && lim.msg.includes('Test NSE'), 'daily limit message: ' + JSON.stringify(lim) + ' today ' + todayNse);
    // Converting changes money only: sizes, risk % and mistakes are the same.
    const same = await page.evaluate(() => {
      const key = rows => rows.map(x => [x.t.id, x.xBal, x.riskPct, x.lossPct, x.r, x.flags.join('+')].join('|')).sort().join('\n');
      const native = key(analyzeTrades(allTrades()));
      return ['INR', 'USD'].every(c => { state.ui.allCur = c; return key(analyzeTrades(statScoped())) === native; });
    });
    check(same, 'analysis flags or sizes changed with the currency');
    // A dollar day is held to its own $2.50 limit in either currency: a $1 loss is
    // not a breach when shown as ₹85, a $3 loss is.
    const breach = await page.evaluate(() => {
      const d = iso(new Date()), t0 = state.trades.length;
      const add = (id, exit) => state.trades.push({ id, accountId: 'acc_cry', date: d, exitDate: d, time: '23:58', exitTime: '23:59', symbol: 'ETHUSD', direction: 'long', entry: 100, exit, stop: 0, qty: 1, fees: 0, rules: [] });
      const day = () => tradingDays(statScoped()).find(x => x.accountId === 'acc_cry' && x.date === d);
      const r = {};
      add('lossA', 99); state.ui.allCur = 'INR'; r.small = day().breached;
      add('lossB', 97); r.big = day().breached; state.ui.allCur = 'USD'; r.bigUsd = day().breached;
      state.trades.length = t0;
      return r;
    });
    check(breach.small === false && breach.big === true && breach.bigUsd === true, 'daily limit breach in another currency: ' + JSON.stringify(breach));
    await page.evaluate(() => { state.ui.allCur = 'INR'; renderAll(); switchTab('analysis'); });
    const an = await page.evaluate(() => ({ body: document.getElementById('anBody').innerText, brokers: [...document.querySelectorAll('#anBrokers tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()) }));
    check(an.body.includes('₹') && !an.body.includes('$'), 'Analysis trade list not in rupees: ' + an.body.slice(0, 200));
    check(an.brokers.some(l => l.startsWith('Test Crypto USD @ ₹85 ' + (cryNet >= 0 ? '+' : '') + inr(cryNet * 85))), 'results by broker in rupees: ' + an.brokers.join(' | '));
    // The inspector shows the rupee figure and the book's own dollars.
    const insp = await page.evaluate(() => { const t = statScoped().find(x => x.id === 'tr1'); openInspector(t); return { pnl: document.getElementById('inspPnl').innerText, fees: document.getElementById('inspFees').innerText }; });
    const p1 = pnlOf(seed.trades.find(t => t.id === 'tr1')), sg = p1 >= 0 ? '+' : '';
    check(insp.pnl === sg + inr(p1 * 85) + ' (' + sg + usd(p1) + ')' && insp.fees === inr(0.1 * 85) + ' (' + usd(0.1) + ')', 'inspector: ' + JSON.stringify(insp) + ' expected ' + p1);
    await page.evaluate(() => closeInspector());
    // A book's rate is changed in its editor and used everywhere.
    await page.evaluate(() => { switchTab('data'); openBookEditor('acc_cry'); });
    check(await page.inputValue('#bkFx') === '85', 'rate field: ' + await page.inputValue('#bkFx'));
    await page.fill('#bkFx', '0');
    await page.click('#modalSheetSaveBtn');
    check(await page.evaluate(() => acct('acc_cry').fxRate === undefined && !document.getElementById('modalSheet').classList.contains('hidden')), 'a rate of 0 was accepted');
    await page.fill('#bkFx', '90');
    await page.click('#modalSheetSaveBtn');
    await page.waitForTimeout(100);
    v = await look();
    check(await page.evaluate(() => acct('acc_cry').fxRate) === 90 && near(v.net, nseNet + cryNet * 90) && v.bal === inr(nseBal + cryBal * 90), 'after rate 90: ' + JSON.stringify(v));
    check((await page.innerText('#booksList')).includes('Rate ₹90/$'), 'Books list does not show the rate');
    // Goals: an older all-books goal reads as rupees; a book's goal is in its currency.
    const goals = await page.evaluate(() => {
      state.goals.push({ id: 'g2', title: 'Crypto goal', target: 10, metric: 'net_pnl', targets: { net_pnl: 10, win_rate: 50 }, period: 'month', accountId: 'acc_cry' });
      const t = cur => { state.ui.allCur = cur; return state.goals.map(g => goalFocused(g).target); };
      const r = { inr: t('INR'), usd: t('USD'), win: goalTargetIn(state.goals[1], 'win_rate', 'INR') };
      state.ui.allCur = 'USD'; openGoal('new'); document.getElementById('gTitle').value = 'New dollar goal';
      return r;
    });
    await page.click('#modalSheetSaveBtn');
    check(near(goals.inr[0], 20) && near(goals.usd[0], 20 / 85) && near(goals.inr[1], 900) && near(goals.usd[1], 10) && goals.win === 50, 'goal targets: ' + JSON.stringify(goals));
    check(await page.evaluate(() => (state.goals.find(g => g.title === 'New dollar goal') || {}).cur) === 'USD', 'a new all-books goal did not keep its currency');
    // Editing the older goal while dollars are on screen keeps it in rupees.
    const label = await page.evaluate(() => { state.ui.allCur = 'USD'; openGoal('g1'); return document.getElementById('gk_net_pnl').parentElement.innerText; });
    await page.click('#modalSheetSaveBtn');
    const g1 = await page.evaluate(() => { const g = state.goals.find(x => x.id === 'g1'); return { cur: g.cur, t: g.targets.net_pnl }; });
    check(label.includes('₹ to earn') && g1.cur === 'INR' && g1.t === 20, 'editing an older goal in dollars: ' + JSON.stringify(g1) + ' ' + label);
    // Rates and goal currencies survive a sync clean-up; bad ones don't.
    const kept = await page.evaluate(() => {
      const s = sanitizeState(JSON.parse(JSON.stringify(state)));
      const bad = cleanAccount({ id: 'x', name: 'X', currency: 'USD', fxRate: -5 });
      return { rate: s.accounts.find(a => a.id === 'acc_cry').fxRate, cur: (s.goals.find(g => g.title === 'New dollar goal') || {}).cur, bad: 'fxRate' in bad };
    });
    check(kept.rate === 90 && kept.cur === 'USD' && !kept.bad, 'sanitize: ' + JSON.stringify(kept));
    // Every tab, every book, both currencies: no errors and no NaN on screen.
    for (const cur of ['INR', 'USD']) for (const acc of ['all', 'acc_nse', 'acc_cry']) for (const tab of TABS) {
      const bad = await page.evaluate(([c, a, t]) => { state.ui.allCur = c; state.ui.account = a; switchTab(t); renderAll(); const m = document.getElementById('view-' + t).innerText.match(/.{0,40}(NaN|undefined|Infinity%).{0,40}/); return m ? m[0] : ''; }, [cur, acc, tab]);
      check(!bad, `${cur} ${acc} ${tab} shows: ${bad}`);
    }
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'rupees and dollars: one switch for every book and tab';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Broker report upload: preview, import, grouping into trades, stats, the
// broker's own book (Analysis and Dashboard), the duplicate checks, sync merge
// and removal. Journal trades must stay exactly as they were.
async function backtestRun(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const upload = async (name, mimeType, buffer) => {
    await page.setInputFiles('#btFileInput', { name, mimeType, buffer });
    await page.waitForSelector('#modalSheet:not(.hidden)', { timeout: 5000 });
    return { text: await page.innerText('#modalSheetBody'), button: await page.innerText('#modalSheetSaveBtn'), disabled: await page.isDisabled('#modalSheetSaveBtn') };
  };
  const BOOK = 'rep-coindcx-inr';
  try {
    const view = () => page.evaluate(() => {
      const on = id => { const el = document.getElementById(id); return !!el && !el.classList.contains('hidden') && el.offsetHeight > 0; };
      const rb = anReportBook();
      return { analysis: on('view-analysis'), report: on('anReport'), live: on('anLive'), empty: on('btEmpty'), broker: rb ? rb.reportBroker : '', account: state.ui.account,
        bar: [...document.querySelectorAll('#anBrokerBar [data-anbroker]')].map(b => b.innerText), on: (document.querySelector('#anBrokerBar .text-amber-400') || {}).innerText,
        lines: [...document.querySelectorAll('#anBrokers tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()) };
    });
    await page.evaluate(() => switchTab('analysis'));
    let v = await view();
    check(v.live && !v.report && v.bar.join(',') === 'All books,Test NSE,Test Crypto', 'Analysis before any upload: ' + JSON.stringify(v));
    check(v.lines.length === 2 && v.lines[0].startsWith('Test NSE') && v.lines[1].startsWith('Test Crypto'), 'results by broker before upload: ' + v.lines.join(' | '));
    const before = await page.evaluate(() => ({ nse: computeStats(bookTrades('acc_nse')), usd: computeStats(allTrades().filter(t => acct(t.accountId).currency === 'USD')) }));

    const xlsx = backtestXlsx();
    let pv = await upload('report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx);
    check(pv.text.includes(`${EXPECTED.rows} (${EXPECTED.orders} orders, ${EXPECTED.funding} funding)`), 'preview row counts wrong: ' + pv.text.replace(/\n/g, ' | '));
    check(pv.text.includes('Futures Orders (INR-M)'), 'preview did not name the orders sheet');
    check(pv.text.includes('+₹' + EXPECTED.net.toFixed(2)), 'preview report total wrong');
    check(/Skipped\s+1: row \d+ \(no pair or symbol\)/.test(pv.text), 'Total line under the table was not reported as skipped');
    check(/✓ every row/.test(pv.text), 'net = gross + settlement - fees check did not pass');
    check(pv.button === `Import ${EXPECTED.rows} rows` && !pv.disabled, 'import button wrong: ' + pv.button);
    check(await page.inputValue('#btBrokerInput') === 'CoinDCX', 'broker not read from the report: ' + await page.inputValue('#btBrokerInput'));
    await page.click('#modalSheetSaveBtn');
    await page.waitForTimeout(300);
    v = await view();
    check(v.analysis && v.report && !v.live && v.broker === 'CoinDCX' && v.account === BOOK && v.on === 'CoinDCX', 'after import Analysis did not open on CoinDCX: ' + JSON.stringify(v));
    check(v.bar.join(',') === 'All books,Test NSE,Test Crypto,CoinDCX', 'broker switch: ' + v.bar.join(','));
    const dcx = v.lines.find(l => l.startsWith('CoinDCX')) || '';
    check(dcx.includes('+₹' + EXPECTED.closedNet.toFixed(2)) && dcx.includes(`${EXPECTED.closed.length} +1 open`) && dcx.includes(`${EXPECTED.wins}/${EXPECTED.losses}`) && dcx.includes('Uploaded report'), 'CoinDCX line in results by broker: ' + dcx);
    check((await page.textContent('#btTitle')).startsWith('CoinDCX'), 'report title does not name the broker');
    const book = await page.evaluate(id => state.accounts.find(a => a.id === id) || null, BOOK);
    check(book && book.reportBroker === 'CoinDCX' && book.currency === 'INR' && book.market === 'crypto' && book.startBalance === 0, 'CoinDCX book: ' + JSON.stringify(book));

    const got = await page.evaluate(() => {
      const bt = state.backtest, all = btTrades(bt.rows), s = btStats(all);
      return {
        live: state.trades.length, rows: bt.rows.length, files: bt.files,
        closed: s.closed.map(t => ({ sym: t.sym, start: t.start, end: t.end, legs: t.legs.length, net: t.net, funding: t.funding, fees: t.fees, held: t.held, carried: t.carried })),
        open: s.open.map(t => ({ sym: t.sym, start: t.start, legs: t.legs.length, net: t.net })),
        wins: s.wins, losses: s.losses, net: s.net, total: s.total, maxDD: s.maxDD, fees: s.fees, funding: s.funding,
        check: document.getElementById('btCheck').innerText,
      };
    });
    check(got.live === seed.trades.length, 'journal trades changed: ' + got.live + ' trades');
    check(got.rows === EXPECTED.rows, 'stored ' + got.rows + ' rows');
    check(got.files.length === 1 && got.files[0].checked && got.files[0].cur === 'INR' && got.files[0].broker === 'CoinDCX', 'file record wrong: ' + JSON.stringify(got.files));
    check(got.closed.length === EXPECTED.closed.length, 'closed trades: ' + got.closed.length);
    EXPECTED.closed.forEach((e, i) => {
      const t = got.closed[i] || {};
      Object.keys(e).forEach(k => check(typeof e[k] === 'number' ? near(t[k], e[k]) : t[k] === e[k], `closed trade ${i + 1} ${k}: ${t[k]}, expected ${e[k]}`));
    });
    check(got.open.length === 1 && Object.keys(EXPECTED.open[0]).every(k => typeof EXPECTED.open[0][k] === 'number' ? near(got.open[0][k], EXPECTED.open[0][k]) : got.open[0][k] === EXPECTED.open[0][k]), 'open trade wrong: ' + JSON.stringify(got.open));
    check(got.wins === EXPECTED.wins && got.losses === EXPECTED.losses, `won/lost ${got.wins}/${got.losses}`);
    check(near(got.net, EXPECTED.closedNet) && near(got.total, EXPECTED.net), `net ${got.net}, total ${got.total}`);
    check(near(got.maxDD, EXPECTED.maxDD) && near(got.fees, EXPECTED.fees) && near(got.funding, EXPECTED.fundingTotal), `drawdown ${got.maxDD}, fees ${got.fees}, funding ${got.funding}`);
    check(got.check.startsWith(`✓ All ${EXPECTED.rows} report rows are in 7 trades`), 'row check line: ' + got.check);

    // The Dashboard counts them: CoinDCX's book on its own, and All accounts in rupees.
    const dash = await page.evaluate(() => {
      state.ui.month = 'all'; switchTab('dashboard');
      const s = computeStats(statScoped());
      const rep = reportTrades();
      return { n: s.n, net: s.net, wins: s.wins, losses: s.losses, pnl: document.getElementById('activePnlDeltaText').innerText, count: document.getElementById('activeTradesCountBadge').innerText,
        bal: document.getElementById('topBalVal').innerText, header: document.getElementById('accountsBar').innerText.replace(/\s+/g, ' '),
        ledger: document.getElementById('tradeLedgerTableBody').innerText, bookNet: bookNet('rep-coindcx-inr'),
        dates: rep.map(t => t.date + ' ' + t.time), analyzed: analyzeTrades(allTrades()).some(x => x.t.rep),
        held: rep.map(t => heldMins(t)), slots: document.getElementById('timeOfDayContainer').textContent.replace(/\s+/g, ' ') };
    });
    check(dash.n === EXPECTED.closed.length && near(dash.net, EXPECTED.closedNet) && dash.wins === EXPECTED.wins && dash.losses === EXPECTED.losses, 'dashboard stats for CoinDCX: ' + JSON.stringify(dash));
    check(dash.pnl === '+₹' + EXPECTED.closedNet.toFixed(2) && dash.count === `${EXPECTED.closed.length} trades`, `dashboard headline: ${dash.pnl}, ${dash.count}`);
    check(dash.bal === '₹' + EXPECTED.closedNet.toFixed(2) && near(dash.bookNet, EXPECTED.closedNet), `CoinDCX balance: ${dash.bal}, book net ${dash.bookNet}`);
    check(dash.header.includes('CoinDCX report'), 'header has no CoinDCX book: ' + dash.header);
    check(/REPORT/.test(dash.ledger) && !/SHORT|BUY/.test(dash.ledger), 'ledger rows for report trades: ' + dash.ledger.replace(/\n/g, ' | '));
    check(JSON.stringify(dash.dates.slice().sort()) === JSON.stringify(EXPECTED.closed.map(e => e.end.slice(0, 16)).sort()), 'report trades not dated by their close: ' + dash.dates.join(', '));
    check(!dash.analyzed, 'size and mistake analysis took in report trades');
    check(JSON.stringify(dash.held.slice().sort()) === JSON.stringify(EXPECTED.closed.map(e => (Date.parse(e.end.replace(' ', 'T')) - Date.parse(e.start.replace(' ', 'T'))) / 60000).sort()), 'held time of report trades: ' + dash.held);
    check(/05:30 - 06:00.*1 trade/.test(dash.slots) && /10:00 - 10:30.*3 trades/.test(dash.slots), 'time of day should go by when report trades opened: ' + dash.slots.slice(0, 300));
    const csvOut = await page.evaluate(async () => { let blob = null; const keep = URL.createObjectURL; URL.createObjectURL = b => { blob = b; return 'blob:test'; }; try { exportTradesCsv(); } finally { URL.createObjectURL = keep; } return blob ? (await blob.text()).trim().split('\r\n').length - 1 : -1; });
    check(csvOut === seed.trades.length, 'CSV export should hold journal trades only: ' + csvOut + ' rows');
    check(await page.evaluate(id => sanitizeState(JSON.parse(JSON.stringify(Object.assign({}, state, { accounts: state.accounts.filter(a => !a.reportBroker) })))).accounts.some(a => a.id === id), BOOK), 'loading uploads saved without their book did not make it');
    const all = await page.evaluate(() => {
      const res = cur => { state.ui.account = 'all'; state.ui.allCur = cur; renderAll(); const s = computeStats(statScoped()); return { n: s.n, net: s.net, pnl: document.getElementById('activePnlDeltaText').innerText }; };
      const inr = res('INR'), usd = res('USD');
      return { inr, usd, sw: [...document.querySelectorAll('#allCurSwitch button')].map(b => b.innerText) };
    });
    // Every book counts in either currency: dollar books at ₹85, CoinDCX at ₹99.30.
    const allN = before.nse.n + before.usd.n + EXPECTED.closed.length;
    check(all.inr.n === allN && near(all.inr.net, before.nse.net + before.usd.net * 85 + EXPECTED.closedNet), `All accounts in INR: ${JSON.stringify(all.inr)}, NSE ${JSON.stringify(before.nse)}, USD ${JSON.stringify(before.usd)}`);
    check(all.usd.n === allN && near(all.usd.net, before.nse.net / 85 + before.usd.net + EXPECTED.closedNet / 99.3), 'All accounts in USD: ' + JSON.stringify(all.usd));
    const dcxUsd = await page.evaluate(id => { state.ui.allCur = 'USD'; state.ui.account = id; renderAll(); switchTab('analysis'); return document.getElementById('btStrip').innerText.replace(/\s+/g, ' '); }, BOOK);
    check(dcxUsd.includes('+$' + (EXPECTED.closedNet / 99.3).toFixed(2)), 'CoinDCX report in dollars: ' + dcxUsd.slice(0, 200));
    await page.evaluate(() => { state.ui.account = 'all'; renderAll(); switchTab('dashboard'); });
    check(all.sw.join(',') === '₹ INR,$ USD', 'currency switch: ' + all.sw.join(','));
    check(await page.evaluate(() => computeStats(bookTrades('acc_nse')).n) === before.nse.n, 'Test NSE book changed');
    check(!(await page.evaluate(() => { openTrade(); const o = [...document.querySelectorAll('#mAcc option')].map(x => x.innerText).join(','); closeModalSheet(); return o; })).includes('CoinDCX'), 'trade form offers the report book');

    // A ledger row opens the trade's report rows in Analysis.
    const opened = await page.evaluate(() => { const t = reportTrades().slice().sort(byWhen)[0]; openReportTrade(t); return { account: state.ui.account, sec: state.ui.btSec, open: btOpenTrade, rows: document.getElementById('btBody').innerText }; });
    check(opened.account === BOOK && opened.sec === 'trades' && opened.open && /report rows?/.test(opened.rows), 'opening a report trade from the ledger: ' + JSON.stringify(opened).slice(0, 300));

    for (const sec of ['overview', 'trades', 'files']) {
      await page.evaluate(k => setBtSec(k), sec);
      check(await page.evaluate(k => { const el = document.querySelector('[data-btsec="' + k + '"]'); return !!el && !el.classList.contains('hidden') && el.offsetHeight > 0; }, sec), 'report section "' + sec + '" did not show');
    }
    await page.evaluate(() => setBtSec('trades'));
    await page.click('#btBody tr[data-bttrade]');
    check(/report rows?/.test(await page.innerText('#btBody')), 'clicking a trade did not list its report rows');
    await page.evaluate(() => { btPick('btPair', 'B-AAA_USDT'); });
    check((await page.evaluate(() => btShown.length)) === 2, 'pair filter did not narrow to 2 trades');
    await page.evaluate(() => { btPick('btPair', 'all'); });

    // A journal book from the same switch shows its own analysis; back to the report after.
    await page.evaluate(() => anBrokerPick('acct:acc_nse'));
    v = await view();
    check(v.live && !v.report && v.broker === '' && v.account === 'acc_nse' && v.on === 'Test NSE', 'picking a book: ' + JSON.stringify(v));
    await page.click(`#anBrokers tbody tr[data-anbroker="acct:${BOOK}"]`);
    v = await view();
    check(v.report && !v.live && v.broker === 'CoinDCX', 'clicking CoinDCX in results by broker: ' + JSON.stringify(v));
    // The Analysis period narrows the report too (the made-up report is from early 2026).
    await page.evaluate(() => { state.ui.anPeriod = '7d'; renderAnalysis(); });
    v = await view();
    check((await page.evaluate(() => btShown.length)) === 0 && (v.lines.find(l => l.startsWith('CoinDCX')) || '').startsWith('CoinDCX INR @ ₹99.3 — 0'), 'period 7 days did not narrow the report: ' + v.lines.join(' | '));
    await page.evaluate(() => { state.ui.anPeriod = 'all'; renderAnalysis(); });

    pv = await upload('report.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xlsx);
    check(pv.disabled && pv.button === 'Nothing new' && /New rows to add\s+0/.test(pv.text), 'same .xlsx again was not caught as already uploaded');
    await page.evaluate(() => closeModalSheet());
    pv = await upload('report.csv', 'text/csv', backtestCsv());
    check(pv.disabled && new RegExp('Already uploaded\\s+' + EXPECTED.rows).test(pv.text), 'same report as .csv (no IDs) was not caught as already uploaded: ' + pv.text.replace(/\n/g, ' | '));
    await page.evaluate(() => closeModalSheet());
    pv = await upload('old.xls', 'application/vnd.ms-excel', Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0, 0, 0, 0]));
    check(/old-style \.xls/.test(pv.text) && pv.disabled, 'old .xls file was not explained');
    await page.evaluate(() => closeModalSheet());

    // Sync: the payload carries it, a device without it merges it in (its
    // book too, even from a build that never sent one), and a removal
    // travels as a tombstone.
    const sync = await page.evaluate(id => {
      const payload = JSON.parse(JSON.stringify(syncPayload(state)));
      const bare = sanitizeState({ accounts: state.accounts.filter(a => !a.reportBroker), trades: [], signals: [], goals: [] });
      const fresh = mergeState(bare, payload);
      const oldBuild = mergeState(bare, Object.assign({}, payload, { accounts: payload.accounts.filter(a => !a.reportBroker) }));
      const fileId = state.backtest.files[0].id;
      removeBacktestFile(fileId);
      const after = mergeState(state, payload);
      return { sent: (payload.backtest || { rows: [] }).rows.length, merged: fresh.backtest.rows.length, broker: fresh.backtest.files[0].broker,
        book: fresh.accounts.some(a => a.id === id), oldBook: oldBuild.accounts.some(a => a.id === id && a.reportBroker === 'CoinDCX'),
        tomb: !!state.tombstones['backtest:' + fileId], afterRemove: after.backtest.rows.length + after.backtest.files.length, emptyPayload: 'backtest' in syncPayload(state) };
    }, BOOK);
    check(sync.sent === EXPECTED.rows && sync.merged === EXPECTED.rows && sync.broker === 'CoinDCX', `sync carried ${sync.sent} rows, merged ${sync.merged}, broker ${sync.broker}`);
    check(sync.book && sync.oldBook, `CoinDCX book after merge: ${sync.book}, from an older build: ${sync.oldBook}`);
    check(sync.tomb && sync.afterRemove === 0, 'removed file came back from the synced copy');
    check(!sync.emptyPayload, 'empty backtest still written to the synced file');
    v = await view();
    const gone = await page.evaluate(() => ({ rep: reportTrades().length, dash: computeStats(bookTrades('rep-coindcx-inr')).n }));
    check(v.report && v.empty && v.account === BOOK && gone.rep === 0 && gone.dash === 0, 'after removing the only file: ' + JSON.stringify(v) + JSON.stringify(gone));

    // The .csv on its own gives the same trades as the .xlsx.
    pv = await upload('report.csv', 'text/csv', backtestCsv());
    check(pv.button === `Import ${EXPECTED.rows} rows`, 'CSV import button: ' + pv.button);
    check(await page.inputValue('#btBrokerInput') === 'CoinDCX', 'CoinDCX not known from its pair names in a CSV: ' + await page.inputValue('#btBrokerInput'));
    await page.fill('#btBrokerInput', 'Dhan');
    await page.click('#modalSheetSaveBtn');
    await page.waitForTimeout(300);
    const csv = await page.evaluate(() => { const s = btStats(btTrades(state.backtest.rows)); return { n: s.n, open: s.open.length, net: s.net, total: s.total, checked: state.backtest.files[0].checked, live: state.trades.length, book: state.accounts.find(a => a.id === 'rep-dhan-inr') || null }; });
    check(csv.n === EXPECTED.closed.length && csv.open === 1 && near(csv.net, EXPECTED.closedNet) && near(csv.total, EXPECTED.net) && csv.checked, 'CSV import differs from .xlsx: ' + JSON.stringify(csv));
    check(csv.live === seed.trades.length, 'journal trades changed after CSV import');
    check(csv.book && csv.book.market === 'nse' && csv.book.name === 'Dhan', 'Dhan book: ' + JSON.stringify(csv.book));
    v = await view();
    check(v.report && v.broker === 'Dhan' && v.account === 'rep-dhan-inr' && v.bar.join(',') === 'All books,Test NSE,Test Crypto,CoinDCX,Dhan', 'typed broker not used: ' + JSON.stringify(v));

    // A second broker, named like a journal book: each shows only its own rows,
    // and "Delete this broker's report data" leaves the other alone.
    await page.evaluate(() => {
      const bt = btState(), now = new Date().toISOString();
      bt.files.push({ id: 'btother', name: 'other.csv', sheet: 'Sheet1', broker: 'Test Crypto', importedAt: now, updatedAt: now, rows: 1, added: 1, net: 5, cur: 'USD', checked: true });
      bt.rows.push({ id: 'other-1', file: 'btother', sym: 'BTCUSD', at: '2026-01-02 10:00:00', kind: 'order', type: 'Order', gross: 5, settle: 0, fee: 0, net: 5, cur: 'USD' },
        { id: 'other-2', file: 'btother', sym: 'ETHINR', at: '2026-01-03 10:00:00', kind: 'order', type: 'Order', gross: 7, settle: 0, fee: 0, net: 7, cur: 'INR' });
      ensureReportBooks(state); state.ui.allCur = 'INR'; renderAnalysis();
    });
    v = await view();
    check(v.bar.join(',') === 'All books,Test NSE,Test Crypto,CoinDCX,Dhan,Test Crypto report,Test Crypto report INR', 'report broker named like a book, in two currencies: ' + v.bar.join(','));
    check((v.lines.find(l => l.startsWith('Dhan')) || '').includes('+₹' + EXPECTED.closedNet.toFixed(2)) && v.lines.some(l => l.startsWith('Test Crypto report USD @ ₹85 +₹425.00 1 ')) && v.lines.some(l => l.startsWith('Test Crypto report INR +₹7.00 1 ')), 'results by broker mixed brokers: ' + v.lines.join(' | '));
    check((await page.textContent('#btSub')).startsWith(`1 file · ${EXPECTED.rows} rows`), 'Dhan view counts other brokers: ' + await page.textContent('#btSub'));
    await page.evaluate(() => anBrokerPick('acct:rep-test-crypto-usd'));
    check((await page.textContent('#btSub')).startsWith('1 file · 1 row ·') && (await page.evaluate(() => btShown.map(t => t.sym).join(','))) === 'BTCUSD', 'second broker, dollar book: ' + await page.textContent('#btSub'));
    await page.evaluate(() => anBrokerPick('acct:rep-dhan-inr'));
    const del = await page.evaluate(() => {
      deleteAllBacktest();
      return { files: cleanBacktest(btState()).files.map(f => f.broker), rows: btState().rows.length, account: state.ui.account, books: state.accounts.filter(a => a.reportBroker).map(a => a.id).join(','), tomb: !!state.tombstones['accounts:rep-dhan-inr'] };
    });
    check(del.files.join(',') === 'Test Crypto' && del.rows === 2 && del.account === 'all' && del.books === 'rep-coindcx-inr,rep-test-crypto-usd,rep-test-crypto-inr' && del.tomb, 'deleting Dhan touched other brokers: ' + JSON.stringify(del));
    await page.setViewportSize({ width: 390, height: 844 });
    for (const tab of TABS) { await page.evaluate(t => switchTab(t), tab); await page.waitForTimeout(150); }
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 3).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'broker report upload: Analysis and Dashboard (.xlsx and .csv)');
  errs.forEach(e => { console.log('     ' + e); failures.push('backtest: ' + e); });
}

// CoinDCX's API, played by a fake server that checks every request's signature
// the way CoinDCX documents it (HMAC-SHA256 hex of the exact JSON body). It
// sends back the made-up report's own transactions (to be counted once), new
// trades after it, a USDT-margined trade and a broken row, over two pages.
async function coindcxRun(seed) {
  const KEY = 'test-key-123', SECRET = 'test-secret-456';
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const near = (a, b) => Math.abs(a - b) < 1e-6;
  const ist = (at, extra = 0) => Date.parse(at.replace(' ', 'T') + '+05:30') + extra;
  const tx = (pair, at, stage, amount, fee, extra = 0.8374, mc = 'INR') => ({ pair, stage, amount, fee_amount: fee, price_in_inr: 1, source: 'user', parent_type: 'Derivatives::Futures::Order', parent_id: 'ord-' + pair + at + amount, settlement_amount: 0, margin_currency_short_name: mc, position_id: 'pos-' + pair, created_at: ist(at, extra), updated_at: ist(at, extra) });
  // The report's rows again: one with the report's own ID, one order split into two fills.
  const inr = [];
  REPORT_ROWS.forEach((r, i) => {
    const stage = r.type === 'By Funding' ? 'funding' : 'default';
    if (r.pair === 'B-AAA_USDT' && r.gross === 100) { inr.push(tx(r.pair, r.at, stage, 60, 2.4, 200), tx(r.pair, r.at, stage, 40, 1.6, 1100)); return; }
    const t = tx(r.pair, r.at, stage, r.gross, r.fee, 400 + i);
    if (r.pair === 'B-BBB_USDT' && r.gross === -80) t.id = r.id;
    inr.push(t);
  });
  const dupStored = REPORT_ROWS.length; // 18 rows: one more fill, one skipped by its ID
  // After the report: DDD (left open in it) closes, FFF is a whole trade, 55 small wins.
  inr.push(tx('B-DDD_USDT', '2026-09-05 09:00:00', 'default', 30, 3));
  inr.push(tx('B-FFF_USDT', '2026-09-06 10:00:00', 'default', 0, 2), tx('B-FFF_USDT', '2026-09-06 11:00:00', 'funding', -1, 0), tx('B-FFF_USDT', '2026-09-06 12:00:00', 'exit', 50, 2));
  for (let i = 0; i < 55; i++) {
    const d = '2026-09-' + String(7 + Math.floor(i / 10)).padStart(2, '0') + ' ' + String(10 + i % 10).padStart(2, '0') + ':';
    inr.push(tx('B-PAG_USDT', d + '00:00', 'default', 0, 0.5), tx('B-PAG_USDT', d + '30:00', 'default', 2, 0.5));
  }
  inr.push({ stage: 'default', amount: 5, fee_amount: 0, created_at: ist('2026-09-08 10:00:00'), margin_currency_short_name: 'INR' }); // no pair
  const usdt = [tx('B-GGG_USDT', '2026-09-06 10:00:00', 'default', 0, 0.1, 0, 'USDT'), tx('B-GGG_USDT', '2026-09-06 14:00:00', 'default', 5, 0.1, 0, 'USDT')];
  usdt[1].created_at = '2026-09-06T08:30:00.000Z'; // a time written out instead of milliseconds
  const API_NET = 99.3 + 20 + 45 + 55; // report trades, DDD now closed (-7 + 27), FFF, PAG
  const API_CLOSED = 6 + 1 + 1 + 55;

  const mock = { mode: 'ok', calls: [], bad: [] };
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.coindcx.com/'), r => r.abort());
  await ctx.route('https://api.coindcx.com/**', async route => {
    const req = route.request(), body = req.postData() || '', path = new URL(req.url()).pathname, h = req.headers();
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    const reply = (status, data) => route.fulfill({ status, headers: cors, body: JSON.stringify(data) });
    if (mock.mode === 'blocked') return route.abort('failed');
    let p = {};
    try { p = JSON.parse(body); } catch (e) {}
    mock.calls.push({ path, p });
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    if (req.method() !== 'POST' || h['content-type'] !== 'application/json' || h['x-auth-apikey'] !== KEY || h['x-auth-signature'] !== sig) {
      if (h['x-auth-apikey'] === KEY && h['x-auth-signature'] !== sig) return reply(401, { code: 401, message: 'Invalid credentials', status: 'error' });
      mock.bad.push(req.method() + ' ' + path + ' ' + JSON.stringify(h));
      return reply(401, { code: 401, message: 'Invalid credentials', status: 'error' });
    }
    if (!(Math.abs(p.timestamp - Date.now()) < 60000) || !Array.isArray(p.margin_currency_short_name) || typeof p.page !== 'string' || typeof p.size !== 'string') {
      mock.bad.push('body ' + path + ' ' + body);
      return reply(400, { code: 400, message: 'Invalid Request', status: 'error' });
    }
    const mc = p.margin_currency_short_name[0], page = +p.page, size = +p.size, slice = list => list.slice((page - 1) * size, page * size);
    if (path === '/exchange/v1/derivatives/futures/positions' && ((mock.mode === 'noUsdt' && mc === 'USDT') || mock.mode === 'all400')) return reply(400, { code: 400, message: 'Invalid margin', status: 'error' });
    if (path === '/exchange/v1/derivatives/futures/positions') return reply(200, slice(mc === 'INR' ? [...new Set(inr.map(t => t.position_id))].filter(Boolean).map(id => ({ id, pair: id.slice(4), active_pos: 0, margin_currency_short_name: 'INR' })) : [{ id: 'pos-B-GGG_USDT', pair: 'B-GGG_USDT', active_pos: 0, margin_currency_short_name: 'USDT' }]));
    if (path !== '/exchange/v1/derivatives/futures/positions/transactions') return reply(404, { message: 'Not found' });
    if (p.stage !== 'all') { mock.bad.push('stage ' + p.stage); return reply(400, { message: 'Invalid Request' }); }
    if ((mock.mode === 'noUsdt' && mc === 'USDT') || mock.mode === 'all400') return reply(400, { code: 400, message: 'Invalid margin', status: 'error' });
    let list = mc === 'INR' ? inr : mc === 'USDT' ? usdt : [];
    // The older form: refused without position ids, then only those positions.
    if (mock.mode === 'needIds') {
      if (!p.position_ids) return reply(400, { code: 400, message: 'position_ids is required', status: 'error' });
      const ids = p.position_ids.split(',');
      list = list.filter(t => ids.includes(t.position_id));
    }
    return reply(200, mock.mode === 'noPaging' ? list : slice(list));
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const badge = () => page.innerText('#cdxStatusBadge');
  const settled = async () => { await page.waitForFunction(() => !cdxBusy && !/^(Reading|Checking)/.test(document.getElementById('cdxStatusBadge').innerText), null, { timeout: 15000 }); return badge(); };
  const books = () => page.evaluate(() => {
    const s = id => { const st = computeStats(bookTrades(id)); return { n: st.n, net: st.net }; };
    const usd = state.accounts.find(a => a.id === 'rep-coindcx-usd');
    return { inr: s('rep-coindcx-inr'), usd: s('rep-coindcx-usd'), usdBook: usd ? [usd.name, usd.currency, usd.reportBroker] : null,
      api: state.backtest.rows.filter(r => r.file === 'cdx-api').length, rows: state.backtest.rows.length, journal: state.trades.length };
  });
  try {
    // The report first, as lakky has it.
    await page.setInputFiles('#btFileInput', { name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: backtestXlsx() });
    await page.waitForSelector('#modalSheet:not(.hidden)', { timeout: 5000 });
    await page.click('#modalSheetSaveBtn');
    await page.waitForTimeout(300);
    let b = await books();
    check(b.inr.n === EXPECTED.closed.length && near(b.inr.net, EXPECTED.closedNet), 'report alone: ' + JSON.stringify(b));

    // A wrong secret is refused and says so; nothing is imported.
    await page.evaluate(() => switchTab('data'));
    await page.fill('#cdxKeyInput', KEY);
    await page.fill('#cdxSecretInput', 'wrong-secret');
    await page.click('button[onclick="saveCoindcxSettings()"]');
    let msg = await settled();
    check(/refused the key \(401\)/.test(msg) && (await books()).api === 0 && mock.calls.length === 1, 'wrong secret: ' + msg + ' after ' + mock.calls.length + ' calls');

    // The right one: checked, then every transaction read, two pages of rupee futures and one of USDT.
    mock.calls = [];
    await page.fill('#cdxSecretInput', SECRET);
    await page.click('button[onclick="saveCoindcxSettings()"]');
    msg = await settled();
    const want = `Imported ${inr.length - 2 + usdt.length} new rows from CoinDCX · ${dupStored} already in your uploaded report, counted once · 1 unreadable transaction skipped`;
    check(msg === want, 'status after import: "' + msg + '", expected "' + want + '"');
    check(mock.bad.length === 0, 'requests CoinDCX would refuse: ' + mock.bad.join(' | '));
    const paths = mock.calls.map(c => c.path.split('/').pop() + ':' + c.p.margin_currency_short_name + ':' + c.p.page);
    check(paths.join(',') === 'positions:INR:1,transactions:INR:1,transactions:INR:2,transactions:USDT:1', 'calls made: ' + paths.join(','));
    b = await books();
    check(b.journal === seed.trades.length, 'journal trades changed: ' + b.journal);
    check(b.api === inr.length - 2 + usdt.length, 'API rows stored: ' + b.api);
    check(b.inr.n === API_CLOSED && near(b.inr.net, API_NET), 'CoinDCX book after the API: ' + JSON.stringify(b.inr) + ', expected ' + API_CLOSED + ' trades, ' + API_NET);
    check(b.usd.n === 1 && near(b.usd.net, 4.8) && JSON.stringify(b.usdBook) === '["CoinDCX USD","USD","CoinDCX"]', 'USDT futures book: ' + JSON.stringify(b));

    // The key never travels: not in the synced file, the backup or the settings copy.
    const leak = await page.evaluate(([k, s]) => {
      const out = [JSON.stringify(syncPayload(state)), localStorage.getItem(SAFE_KEY) || ''];
      return { kept: state.coindcx.key === k && state.coindcx.secret === s, leaks: out.filter(x => x.includes(k) || x.includes(s)).length };
    }, [KEY, SECRET]);
    check(leak.kept && leak.leaks === 0, 'CoinDCX key: ' + JSON.stringify(leak));

    // Analysis, results by broker and Files say where the rows came from.
    const an = await page.evaluate(() => {
      state.ui.account = 'rep-coindcx-inr'; state.ui.anPeriod = 'all'; state.ui.btSec = 'files'; switchTab('analysis'); renderAll();
      return { check: document.getElementById('btCheck').innerText, title: document.getElementById('btTitle').textContent,
        line: [...document.querySelectorAll('#anBrokers tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()).find(l => l.startsWith('CoinDCX ')) || '',
        files: document.getElementById('btFiles').innerText };
    });
    check(an.check.startsWith('✓ All ') && an.check.includes(`${dupStored} rows from the API are already in an uploaded report and count once.`), 'Analysis check line: ' + an.check);
    check(an.title === 'CoinDCX · trades from its report and API', 'Analysis title: ' + an.title);
    check(an.line.includes('+₹' + API_NET.toFixed(2)) && an.line.endsWith('Report + API'), 'results by broker: ' + an.line);
    check(an.files.includes('CoinDCX API') && an.files.includes('✓ Every transaction CoinDCX sent is stored once'), 'Files: ' + an.files.slice(0, 300));

    // Importing again adds nothing.
    await page.evaluate(() => switchTab('data'));
    await page.click('button[onclick="coindcxSyncNow()"]');
    msg = await settled();
    b = await books();
    check(msg.startsWith('Up to date, nothing new from CoinDCX') && b.api === inr.length - 2 + usdt.length && near(b.inr.net, API_NET), 'second import: ' + msg + ' ' + JSON.stringify(b));
    // An answer that ignores paging (the whole list on every page) still ends.
    mock.mode = 'noPaging'; mock.calls = [];
    await page.click('button[onclick="coindcxSyncNow()"]');
    msg = await settled();
    b = await books();
    check(msg.startsWith('Up to date, nothing new from CoinDCX') && mock.calls.length === 3 && b.api === inr.length - 2 + usdt.length, 'paging ignored: ' + msg + ' after ' + mock.calls.length + ' calls');
    // A margin type CoinDCX won't list is skipped and named; the other still comes in.
    mock.mode = 'noUsdt';
    await page.click('button[onclick="coindcxSyncNow()"]');
    msg = await settled();
    check(msg === `Up to date, nothing new from CoinDCX · ${dupStored} already in your uploaded report, counted once · 1 unreadable transaction skipped · USDT futures not read (CoinDCX answered 400: Invalid margin)`, 'USDT refused: ' + msg);
    // Neither one read is an error, not an empty import.
    mock.mode = 'all400';
    await page.click('button[onclick="coindcxSyncNow()"]');
    msg = await settled();
    check(msg === 'CoinDCX answered 400: Invalid margin.' && await page.evaluate(() => document.getElementById('cdxStatusBadge').className.includes('rose')), 'both refused: ' + msg);
    mock.mode = 'ok';

    // Without the report the API alone gives the same book (once the transaction
    // it held back by ID comes in), read the older way, with position ids.
    await page.evaluate(() => removeBacktestFile(state.backtest.files.find(f => f.id !== 'cdx-api').id));
    mock.mode = 'needIds'; mock.calls = [];
    await page.evaluate(() => coindcxSyncNow());
    msg = await settled();
    b = await books();
    // (The broken row has no position, so this form doesn't send it.)
    check(msg === 'Imported 1 new row from CoinDCX', 'import after removing the report: ' + msg);
    check(b.inr.n === API_CLOSED && near(b.inr.net, API_NET) && b.rows === b.api, 'API alone: ' + JSON.stringify(b));
    check(mock.calls.some(c => c.path.endsWith('/positions') && c.p.margin_currency_short_name[0] === 'INR') && mock.calls.some(c => c.p.position_ids), 'position ids were not tried: ' + mock.calls.map(c => c.path).join(','));

    // Undo takes the API rows out; opening the page brings new ones in on its own.
    mock.mode = 'ok';
    await page.evaluate(() => undoCoindcxImport());
    b = await books();
    check(b.api === 0 && b.inr.n === 0 && b.usd.n === 0, 'after undo: ' + JSON.stringify(b));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => state.backtest.rows.some(r => r.file === 'cdx-api'), null, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => !cdxBusy, null, { timeout: 10000 }).catch(() => {});
    b = await books();
    check(b.inr.n === API_CLOSED && near(b.inr.net, API_NET), 'automatic import on opening the page: ' + JSON.stringify(b));

    // CoinDCX not answering the page (no CORS, or offline) is said plainly.
    mock.mode = 'blocked';
    await page.evaluate(() => switchTab('data'));
    await page.click('button[onclick="coindcxSyncNow()"]');
    msg = await settled();
    check(/^Could not reach CoinDCX from this page\./.test(msg), 'blocked call: ' + msg);

    // Forget Key clears it from this device; imported trades stay.
    await page.click('button[onclick="forgetCoindcxKey()"]');
    await page.waitForTimeout(100);
    const gone = await page.evaluate(() => ({ key: state.coindcx.key, secret: state.coindcx.secret, input: document.getElementById('cdxKeyInput').value, badge: document.getElementById('cdxStatusBadge').innerText }));
    b = await books();
    check(!gone.key && !gone.secret && !gone.input && gone.badge.startsWith('Not connected') && b.inr.n === API_CLOSED, 'Forget Key: ' + JSON.stringify(gone) + ' ' + JSON.stringify(b));

    // Every tab still draws with the API rows in.
    for (const tab of TABS) {
      const bad = await page.evaluate(t => { switchTab(t); renderAll(); const m = document.getElementById('view-' + t).innerText.match(/.{0,40}(NaN|undefined|Infinity%).{0,40}/); return m ? m[0] : ''; }, tab);
      check(!bad, `${tab} shows: ${bad}`);
    }
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'CoinDCX API key: signed calls, import, counted once with the report';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

const data = fixture();
for (const [name, vp] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  await run(name + ', empty journal', vp, null);
  await run(name + ', sample journal', vp, data);
}
await run('desktop, storage nearly full', { width: 1366, height: 900 }, data, 4300000);
await currencyRun(data);
await backtestRun(data);
await coindcxRun(data);

await browser.close();
server.close();
if (failures.length) { console.log('\n' + failures.length + ' problem(s) found'); process.exit(1); }
console.log('\nAll checks passed');
