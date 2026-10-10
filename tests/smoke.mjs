// Opens index.html in headless Chromium and fails on any script error.
// Runs twice: with an empty browser, and with a small made-up journal so the
// charts, tables and stats actually render. Every tab is opened on desktop
// and phone widths. Outside requests (CDN, GitHub, Delta) are blocked, so the
// check never depends on the network. One more pass fills storage to 86%
// and expects the storage warning. The last pass uploads a made-up CoinDCX
// trade report (.xlsx, then the same as .csv), checks every number it shows
// against the report, in Analysis and on the Dashboard, and switches brokers.
// Then the CoinDCX import GitHub runs reads a fake CoinDCX (which checks every
// call is signed as CoinDCX documents) into a fake GitHub's journal.json; the
// journal syncs it, and trades the report already has must count only once.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
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
    // Goals planned for next week / next month wait for their window, then run like any other.
    for (const [pick, period] of [['next_week', 'week'], ['next_month', 'month']]) {
      await page.evaluate(p => { openGoal('new'); document.getElementById('gTitle').value = 'Plan ' + p; document.getElementById('gPeriod').value = p; }, pick);
      await page.click('#modalSheetSaveBtn');
      const ahead = await page.evaluate(([p, per]) => {
        const g = state.goals.find(x => x.title === 'Plan ' + p), d = new Date();
        const want = per === 'week' ? iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7) + 7)) : iso(new Date(d.getFullYear(), d.getMonth() + 1, 1));
        state.ui.goalIdx = state.goals.indexOf(g); updateGoalDisplays();
        openGoal(g.id); const sel = document.getElementById('gPeriod').value; closeModalSheet();
        const past = Object.assign({}, g, { startsOn: '2000-01-03' });
        return { period: g.period, startsOn: g.startsOn, want, start: iso(goalWindowStart(g)), end: iso(goalPeriodEnd(g)), n: goalProgress(g).n,
          days: goalDaysLeft(g), up: goalUpcoming(g), title: document.getElementById('goalTitle').innerText, sel,
          pastStart: iso(goalWindowStart(past)), nowStart: iso(goalWindowStart(per)), kept: (sanitizeState(JSON.parse(JSON.stringify(state))).goals.find(x => x.id === g.id) || {}).startsOn };
      }, [pick, period]);
      const endOk = period === 'week' ? ahead.end > ahead.start && (Date.parse(ahead.end) - Date.parse(ahead.start)) === 6 * 864e5 : ahead.end.slice(0, 7) === ahead.start.slice(0, 7);
      check(ahead.period === period && ahead.startsOn === ahead.want && ahead.start === ahead.want && endOk && ahead.n === 0 && ahead.up && ahead.days >= 5 && ahead.title.includes('starts') && ahead.sel === pick && ahead.pastStart === ahead.nowStart && ahead.kept === ahead.want, pick + ' goal: ' + JSON.stringify(ahead));
    }
    check(!('startsOn' in await page.evaluate(() => cleanGoal({ id: 'z', period: 'year', startsOn: '2099-01-01' }))) && !('startsOn' in await page.evaluate(() => cleanGoal({ id: 'z', period: 'week', startsOn: 'soon' }))), 'a bad start date survived the clean-up');
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

// CoinDCX's API doesn't answer web pages, so GitHub reads it for the journal:
// tools/coindcx-import.mjs runs here against a fake CoinDCX, which checks every
// request's signature the way CoinDCX documents it (HMAC-SHA256 hex of the
// exact JSON body), and a fake GitHub holding journal.json. CoinDCX sends the
// made-up report's own transactions (to be counted once), new trades after it,
// a USDT-margined trade and a broken row, over two pages. The journal then
// syncs that file and must show the same book an uploaded report would.
async function coindcxRun(seed) {
  const KEY = 'test-key-123', SECRET = 'test-secret-456', REPO = 'victus/sync';
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
  // Five days ago (whatever today is), two trades whose fills come in too: LNK
  // bought at 11.99 and 12.015 (12.00 on average) and sold at 12.05 and 12.15
  // (12.10), and ORF shorted at 2.00, closed at 2.004 (its closing fills come
  // in later: two halves of one order alike in every field, as CoinDCX's carry
  // no id). One more fill 20 days back, which only the first read reaches.
  const D = new Date(Date.now() - 5 * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  inr.push(tx('B-LNK_USDT', D + ' 10:05:00', 'default', 0, 1, 0), tx('B-LNK_USDT', D + ' 14:00:00', 'exit', 993, 1, 0));
  inr.push(tx('B-ORF_USDT', D + ' 11:00:00', 'default', 0, 0.5, 0), tx('B-ORF_USDT', D + ' 11:30:00', 'tpsl_exit', -20, 0.5, 0));
  const fill = (pair, at, side, price, quantity, extra = 0.8374) => ({ price, quantity, is_maker: false, fee_amount: 0.1, pair, side, timestamp: ist(at, extra), order_id: 'ord-' + pair + at + side });
  const OLD = new Date(Date.now() - 20 * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  const fills = [fill('B-LNK_USDT', D + ' 10:05:00', 'buy', '11.99', 60), fill('B-LNK_USDT', D + ' 10:05:00', 'buy', 12.015, '40', 400),
    fill('B-LNK_USDT', D + ' 14:00:00', 'sell', 12.05, 50), fill('B-LNK_USDT', D + ' 14:00:00', 'sell', 12.15, 50, 900),
    fill('B-ORF_USDT', D + ' 11:00:00', 'sell', 2, 50), fill('B-OLD_USDT', OLD + ' 09:00:00', 'buy', 1, 10)];
  const orfClose = [fill('B-ORF_USDT', D + ' 11:30:00', 'buy', 2.004, 25), fill('B-ORF_USDT', D + ' 11:30:00', 'buy', 2.004, 25)];
  // One without a side: counted as unreadable, its field names shown.
  const noSide = Object.assign({}, fill('B-LNK_USDT', D + ' 12:00:00', 'buy', 12, 1));
  delete noSide.side;
  fills.push(noSide);
  const F = ' · 5 fills read, 1 unreadable (fields: price, quantity, is_maker, fee_amount, pair, timestamp, order_id)', F1 = F.replace('5 fills', '6 fills');
  let API_NET = 99.3 + 20 + 45 + 55 + 991 - 21; // report trades, DDD now closed (-7 + 27), FFF, PAG, LNK, ORF
  let API_CLOSED = 6 + 1 + 1 + 55 + 2;
  const NEW_ROWS = inr.length - 2 + usdt.length;

  // ---- the fake CoinDCX ----
  // Futures wallets: rupees 8000.5 free + 144.28 locked; USDT 80 + 0.02 + 2 in cross margin.
  const mock = { mode: 'ok', calls: [], bad: [], wallets: [
    { id: 'w-inr', currency_short_name: 'INR', balance: '8000.5', locked_balance: '144.28', cross_order_margin: '0.0', cross_user_margin: '0.0' },
    { id: 'w-usdt', currency_short_name: 'USDT', balance: '80', locked_balance: '0.0', cross_order_margin: '0.02', cross_user_margin: '2' }] };
  const W = ' · wallet INR 8144.78, USDT 82.02';
  function coindcx(req, body) {
    const p0 = new URL(req.url, 'http://x').pathname.replace(/^\/cdx/, ''), h = req.headers;
    let p = {};
    try { p = JSON.parse(body); } catch (e) {}
    mock.calls.push({ path: p0, p });
    const sig = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    // CoinDCX's firewall turning a server away, before any key is looked at.
    if (mock.mode === 'forbidden') return [403, '<html><head><title>403 Forbidden</title></head><body><h1>Access denied</h1><p>' + 'Request blocked. '.repeat(12) + '</p></body></html>', 'text/html'];
    // The wallets are a GET that still carries the signed body, as CoinDCX's own example sends it.
    const wantMethod = p0 === '/exchange/v1/derivatives/futures/wallets' ? 'GET' : 'POST';
    if (req.method !== wantMethod || h['content-type'] !== 'application/json' || h['x-auth-apikey'] !== KEY || h['x-auth-signature'] !== sig) {
      if (!(h['x-auth-apikey'] === KEY && h['x-auth-signature'] !== sig)) mock.bad.push(req.method + ' ' + p0 + ' ' + JSON.stringify(h));
      return [401, { code: 401, message: 'Invalid credentials', status: 'error' }];
    }
    if (p0 === '/exchange/v1/derivatives/futures/wallets') {
      if (!(Math.abs(p.timestamp - Date.now()) < 60000)) { mock.bad.push('body ' + p0 + ' ' + body); return [400, { code: 400, message: 'Invalid Request', status: 'error' }]; }
      return mock.mode === 'noWallet' ? [404, { message: 'Not found' }] : [200, mock.wallets];
    }
    if (!(Math.abs(p.timestamp - Date.now()) < 60000) || !Array.isArray(p.margin_currency_short_name) || typeof p.page !== 'string' || typeof p.size !== 'string') {
      mock.bad.push('body ' + p0 + ' ' + body);
      return [400, { code: 400, message: 'Invalid Request', status: 'error' }];
    }
    const mc = p.margin_currency_short_name[0], page = +p.page, size = +p.size, slice = list => list.slice((page - 1) * size, page * size);
    if (p0 === '/exchange/v1/derivatives/futures/positions') {
      if ((mock.mode === 'noUsdt' && mc === 'USDT') || mock.mode === 'all400') return [400, { code: 400, message: 'Invalid margin', status: 'error' }];
      return [200, slice(mc === 'INR' ? [...new Set(inr.map(t => t.position_id))].filter(Boolean).map(id => ({ id, pair: id.slice(4), active_pos: 0, margin_currency_short_name: 'INR' })) : [{ id: 'pos-B-GGG_USDT', pair: 'B-GGG_USDT', active_pos: 0, margin_currency_short_name: 'USDT' }])];
    }
    // Fills: within the dates asked for (UTC days, both ends included), a page at a time.
    if (p0 === '/exchange/v1/derivatives/futures/trades') {
      if (mock.fillsMode === 'none') return [404, { message: 'Not found' }];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.to_date || '') || p.to_date < p.from_date) { mock.bad.push('fill dates ' + body); return [400, { message: 'Invalid Request' }]; }
      // As the real one: at most 7 days (both ends counted) a call, and only 30 days back.
      const span = (Date.parse(p.to_date) - Date.parse(p.from_date)) / 864e5, oldest = new Date(Date.now() - 30 * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
      if (span > 6 || p.from_date < oldest || mock.fillsMode === 'range') return [400, { code: 400, message: 'From Date not in range', status: 'error' }];
      if ((mock.mode === 'noUsdt' && mc === 'USDT') || mock.mode === 'all400') return [400, { code: 400, message: 'Invalid margin', status: 'error' }];
      const day = x => new Date(x.timestamp).toISOString().slice(0, 10);
      return [200, slice(mc === 'INR' ? fills.filter(x => mock.fillsMode === 'allDates' || (day(x) >= p.from_date && day(x) <= p.to_date)) : [])];
    }
    if (p0 !== '/exchange/v1/derivatives/futures/positions/transactions') return [404, { message: 'Not found' }];
    if (p.stage !== 'all') { mock.bad.push('stage ' + p.stage); return [400, { message: 'Invalid Request' }]; }
    if ((mock.mode === 'noUsdt' && mc === 'USDT') || mock.mode === 'all400') return [400, { code: 400, message: 'Invalid margin', status: 'error' }];
    let list = mc === 'INR' ? inr : mc === 'USDT' ? usdt : [];
    // The older form: refused without position ids, then only those positions.
    if (mock.mode === 'needIds') {
      if (!p.position_ids) return [400, { code: 400, message: 'position_ids is required', status: 'error' }];
      const ids = p.position_ids.split(',');
      list = list.filter(t => ids.includes(t.position_id));
    }
    // A transaction arriving while it pages pushes the list one row down: page 2 repeats page 1's last row.
    if (mock.mode === 'shift' && page > 1) return [200, list.slice((page - 1) * size - 1, page * size - 1)];
    return [200, mock.mode === 'noPaging' ? list : slice(list)];
  }

  // ---- the fake GitHub: journal.json of each repo, with its sha ----
  const gh = { files: {}, puts: [], conflicts: 0, rawReads: 0, big: false, beforePut: null, bad: [] };
  const b64lines = s => Buffer.from(s).toString('base64').replace(/.{60}/g, '$&\n');
  function github(method, url, headers, body) {
    const u = new URL(url), m = u.pathname.match(/^(?:\/gh)?\/repos\/([^/]+\/[^/]+)\/contents\/journal\.json$/);
    if (!m) return [404, { message: 'Not Found' }];
    if (!/^Bearer (gh-token|app-token)$/.test(headers.authorization || '')) { gh.bad.push(method + ' auth ' + headers.authorization); return [401, { message: 'Bad credentials' }]; }
    const f = gh.files[m[1]];
    if (method === 'GET') {
      if (!f || u.searchParams.get('ref') !== 'main') return [404, { message: 'Not Found' }];
      if (/raw/.test(headers.accept || '')) { gh.rawReads++; return [200, f.text, 'text/plain']; }
      return [200, { name: 'journal.json', path: 'journal.json', sha: f.sha, size: Buffer.byteLength(f.text), encoding: gh.big ? 'none' : 'base64', content: gh.big ? '' : b64lines(f.text) }];
    }
    if (method === 'PUT') {
      let p = {};
      try { p = JSON.parse(body); } catch (e) {}
      if (gh.beforePut) { const fn = gh.beforePut; gh.beforePut = null; fn(); }
      const cur = gh.files[m[1]];
      if (p.branch !== 'main' || (cur ? p.sha !== cur.sha : !!p.sha)) { if (cur && p.sha !== cur.sha) gh.conflicts++; return [409, { message: 'journal.json does not match ' + (p.sha || '') }]; }
      const text = Buffer.from(String(p.content || ''), 'base64').toString('utf8');
      try { JSON.parse(text); } catch (e) { gh.bad.push('PUT not JSON'); return [422, { message: 'bad' }]; }
      const sha = crypto.createHash('sha1').update(text).digest('hex');
      gh.files[m[1]] = { text, sha };
      gh.puts.push({ message: p.message, by: headers.authorization.slice(7) });
      return [cur ? 200 : 201, { content: { sha } }];
    }
    return [405, { message: 'no' }];
  }
  const stored = () => JSON.parse(gh.files[REPO].text);
  // A device saving between the import's read and its write.
  const phoneSaves = () => {
    const j = stored();
    j.trades.push(Object.assign({}, j.trades[0], { id: 'tr-phone', notes: 'saved on the phone', updatedAt: new Date().toISOString() }));
    const text = JSON.stringify(j, null, 2);
    gh.files[REPO] = { text, sha: crypto.createHash('sha1').update(text).digest('hex') };
  };

  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url.startsWith('/cdx/') && mock.mode === 'blocked') return req.socket.destroy();
      const [status, data, type] = req.url.startsWith('/cdx/') ? coindcx(req, body) : github(req.method, 'http://x' + req.url, req.headers, body);
      res.writeHead(status, { 'Content-Type': type || 'application/json' });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakeBase = 'http://127.0.0.1:' + fake.address().port;
  const summary = path.join(os.tmpdir(), 'cdx-summary-' + process.pid + '.md');
  // The script as the workflow runs it, on a server whose clock is UTC.
  const runImport = (extra = {}) => new Promise(resolve => {
    const before = gh.puts.length;
    mock.calls = [];
    try { fs.writeFileSync(summary, ''); } catch (e) {}
    execFile(process.execPath, [path.join(ROOT, 'tools', 'coindcx-import.mjs')], {
      env: Object.assign({ PATH: process.env.PATH, TZ: 'UTC', COINDCX_API_KEY: KEY, COINDCX_API_SECRET: SECRET, GITHUB_TOKEN: 'gh-token', GITHUB_REPOSITORY: REPO,
        GITHUB_API_URL: fakeBase + '/gh', COINDCX_BASE: fakeBase + '/cdx', GITHUB_STEP_SUMMARY: summary }, extra),
      timeout: 60000
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: (stdout + stderr).trim(), puts: gh.puts.slice(before).map(p => p.message), summary: fs.readFileSync(summary, 'utf8').trim() }));
  });

  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.github.com/'), r => r.abort());
  await ctx.route('https://api.github.com/**', async route => {
    const req = route.request();
    const [status, data, type] = github(req.method(), req.url(), await req.allHeaders(), req.postData() || '');
    return route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': type || 'application/json' }, body: typeof data === 'string' ? data : JSON.stringify(data) });
  });
  // A key the earlier in-page import saved on this device.
  const seeded = Object.assign({}, seed, { coindcx: { key: KEY, secret: SECRET, lastAt: '' } });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const books = () => page.evaluate(() => {
    const s = id => { const st = computeStats(bookTrades(id)); return { n: st.n, net: st.net }; };
    const usd = state.accounts.find(a => a.id === 'rep-coindcx-usd');
    return { inr: s('rep-coindcx-inr'), usd: s('rep-coindcx-usd'), usdBook: usd ? [usd.name, usd.currency, usd.reportBroker] : null,
      api: state.backtest.rows.filter(r => r.file === 'cdx-api').length, rows: state.backtest.rows.length, journal: state.trades.length };
  });
  const sync = () => page.evaluate(() => syncNow({ quiet: true }));
  const card = () => page.evaluate(() => { switchTab('data'); renderDataView(); return {
    badge: document.getElementById('cdxStatusBadge').innerText, bad: document.getElementById('cdxStatusBadge').className.includes('rose'),
    status: document.getElementById('cdxStatus').innerText, links: [...document.querySelectorAll('#cdxSteps a')].map(a => a.href) }; });
  try {
    // The key typed into the page before is gone from this device.
    const wiped = await page.evaluate(([k, s]) => ({ inState: 'coindcx' in state, stored: [localStorage.getItem('tapeAndTarget.v2') || '', localStorage.getItem(SAFE_KEY) || ''].filter(x => x.includes(k) || x.includes(s)).length }), [KEY, SECRET]);
    check(!wiped.inState && wiped.stored === 0, 'old CoinDCX key on this device: ' + JSON.stringify(wiped));
    let c = await card();
    check(c.badge === 'Not set up' && c.status.startsWith('Nothing from CoinDCX yet') && c.links.length === 0, 'card before sync: ' + JSON.stringify(c));

    // The report first, as lakky has it, then synced to (fake) GitHub.
    await page.setInputFiles('#btFileInput', { name: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: backtestXlsx() });
    await page.waitForSelector('#modalSheet:not(.hidden)', { timeout: 5000 });
    await page.click('#modalSheetSaveBtn');
    await page.waitForTimeout(300);
    let b = await books();
    check(b.inr.n === EXPECTED.closed.length && near(b.inr.net, EXPECTED.closedNet), 'report alone: ' + JSON.stringify(b));
    await page.evaluate(r => { state.sync = { token: 'app-token', repo: r, branch: 'main', auto: false, lastAt: '', lastSha: '' }; save(); }, REPO);
    let s = await sync();
    check(s.ok && gh.puts.length === 1 && stored().backtest.rows.length === EXPECTED.rows, 'first sync: ' + JSON.stringify(s) + ' ' + gh.puts.length);
    c = await card();
    check(JSON.stringify(c.links) === JSON.stringify([`https://github.com/${REPO}/settings/secrets/actions`, `https://github.com/${REPO}/actions/workflows/coindcx.yml`]), 'setup links: ' + JSON.stringify(c.links));

    // No secrets yet: says what to add, asks nothing of CoinDCX, changes nothing.
    let r = await runImport({ COINDCX_API_KEY: '' });
    check(r.code === 1 && /Add the COINDCX_API_KEY and COINDCX_API_SECRET secrets/.test(r.out) && mock.calls.length === 0 && !r.puts.length, 'no secrets: ' + JSON.stringify(r));
    // A wrong secret is refused on the first call; with nothing imported yet there is nothing to write.
    r = await runImport({ COINDCX_API_SECRET: 'wrong-secret' });
    check(r.code === 1 && /^::error::CoinDCX refused the key \(401\)/.test(r.out) && mock.calls.length === 1 && !r.puts.length, 'wrong secret: ' + JSON.stringify(r) + ' after ' + mock.calls.length + ' calls');
    check(!r.out.includes(KEY) && !r.out.includes('wrong-secret'), 'the run printed the key');

    // The right one: two pages of rupee futures and one of USDT, the wallets and
    // 90 days of fills a week at a time, saved in one commit.
    const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
    r = await runImport();
    const want = `Imported ${NEW_ROWS} new rows from CoinDCX · 1 unreadable transaction skipped` + W + F1;
    check(r.code === 0 && r.out === want && r.summary === want, 'import: ' + JSON.stringify(r) + ', expected "' + want + '"');
    check(JSON.stringify(r.puts) === JSON.stringify([`CoinDCX: ${NEW_ROWS} new rows`]), 'commits: ' + JSON.stringify(r.puts));
    check(mock.bad.length === 0 && gh.bad.length === 0, 'requests CoinDCX or GitHub would refuse: ' + mock.bad.concat(gh.bad).join(' | '));
    const isFill = x => x.path.endsWith('/trades');
    const paths = mock.calls.filter(x => !isFill(x)).map(x => [x.path.split('/').pop(), x.p.margin_currency_short_name, x.p.page].filter(v => v != null).join(':'));
    check(paths.join(',') === 'transactions:INR:1,transactions:INR:2,transactions:USDT:1,wallets', 'calls made: ' + paths.join(','));
    // Fill windows: from today (Indian date) back, 7 days each, every day covered,
    // for both margins, until CoinDCX says the dates are out of its range (30 days here).
    const weeks = mc => mock.calls.filter(x => isFill(x) && x.p.margin_currency_short_name[0] === mc).map(x => [x.p.from_date, x.p.to_date, x.p.page]);
    const wk = weeks('INR'), dayMs = d => Date.parse(d + 'T00:00:00Z');
    const covered = wk.length && wk[0][1] === today && wk.every((w, i) => w[2] === '1' && dayMs(w[1]) - dayMs(w[0]) === 6 * 864e5 && (!i || w[1] === wk[i - 1][0]))
      && JSON.stringify(weeks('USDT')) === JSON.stringify(wk);
    check(covered && wk.length === 6 && dayMs(wk[4][0]) === dayMs(today) - 30 * 864e5, 'fill windows: ' + JSON.stringify(wk));
    let j = stored();
    const ddd = j.backtest.rows.find(x => x.file === 'cdx-api' && x.sym === 'B-DDD_USDT' && x.gross === 30);
    check(ddd && ddd.at === '2026-09-05 09:00:00' && ddd.fee === 3 && ddd.net === 27 && ddd.kind === 'order' && ddd.cur === 'INR', 'stored in Indian time on a UTC server: ' + JSON.stringify(ddd));
    check(!gh.files[REPO].text.includes(KEY) && !gh.files[REPO].text.includes(SECRET), 'the key went into journal.json');
    const written = JSON.stringify(j.backtest);

    // The journal syncs it in: same book as before, counted once with the report.
    s = await sync();
    b = await books();
    check(s.ok && b.journal === seed.trades.length && b.api === NEW_ROWS, 'sync in: ' + JSON.stringify(s) + ' ' + JSON.stringify(b));
    check(b.inr.n === API_CLOSED && near(b.inr.net, API_NET), 'CoinDCX book after the import: ' + JSON.stringify(b.inr) + ', expected ' + API_CLOSED + ' trades, ' + API_NET);
    check(b.usd.n === 1 && near(b.usd.net, 4.8) && JSON.stringify(b.usdBook) === '["CoinDCX USD","USD","CoinDCX"]', 'USDT futures book: ' + JSON.stringify(b));
    // It writes them exactly as the journal does: its push back changes no row or file record...
    check(JSON.stringify(stored().backtest) === written, 'the journal rewrote what the import wrote');
    // ...and the next sync has nothing to send.
    s = await sync();
    check(s.ok && s.changed === false, 'second sync: ' + JSON.stringify(s));
    c = await card();
    check(c.badge === 'Importing' && !c.bad && c.status.startsWith(`${NEW_ROWS} CoinDCX rows in the journal, last changed `) && c.status.endsWith(' Wallet: ₹8,144.78 INR futures · $82.02 USDT futures.'), 'card after import: ' + JSON.stringify(c));

    // CoinDCX's own wallet is the CoinDCX books' balance, not one worked out from the trades.
    const wal = stored().backtest.files.find(f => f.id === 'cdx-api').wallet;
    check(wal && wal.INR === 8144.78 && wal.USD === 82.02 && Object.keys(wal).join() === 'at,INR,USD', 'wallet on the file: ' + JSON.stringify(wal));
    const balances = () => page.evaluate(() => {
      switchTab('dashboard');
      const head = id => { state.ui.account = id; renderAll(); const tag = document.getElementById('topBalLive');
        return { top: document.getElementById('topBalVal').innerText, chart: document.getElementById('chartBalLabel').innerText, tag: tag.classList.contains('hidden') ? '' : tag.innerText, title: tag.title }; };
      const out = { inr: bookBalance(acct('rep-coindcx-inr')), usd: bookBalance(acct('rep-coindcx-usd')), nse: bookBalance(acct('acc_nse')), nseComputed: bookComputedBalance(acct('acc_nse')),
        want: money(bookBalance(acct('rep-coindcx-inr')), 'INR'), nseWant: money(bookComputedBalance(acct('acc_nse')), 'INR'), cdx: head('rep-coindcx-inr'), other: head('acc_nse') };
      state.ui.account = 'all'; switchTab('data'); renderAll();
      out.books = [...document.querySelectorAll('#booksList > div')].map(d => d.innerText.replace(/\s+/g, ' ')).filter(t => /CoinDCX/.test(t)).join(' | ');
      return out;
    });
    let bal = await balances();
    check(bal.inr === 8144.78 && bal.usd === 82.02 && bal.nse === bal.nseComputed, 'book balances: ' + JSON.stringify(bal));
    check(bal.cdx.top === bal.want && bal.cdx.chart === bal.want && bal.cdx.tag === 'WALLET' && /CoinDCX futures wallet/.test(bal.cdx.title), 'header on the CoinDCX book: ' + JSON.stringify(bal.cdx));
    check(bal.other.top === bal.nseWant && bal.other.tag === '', 'header on another book: ' + JSON.stringify(bal.other));
    // Another broker's report book keeps the balance worked out from its trades (tried, then taken out again).
    const dhanBal = await page.evaluate(() => {
      const bt = state.backtest, accounts = state.accounts.slice();
      bt.files.push({ id: 'dhan1', name: 'dhan.csv', sheet: 'Trades', broker: 'Dhan', importedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', rows: 1, added: 1, net: 5, cur: 'INR', checked: true });
      bt.rows.push({ id: 'd1', file: 'dhan1', sym: 'RELIANCE', at: '2026-09-01 10:00:00', kind: 'order', type: 'By Order', gross: 5, settle: 0, fee: 0, net: 5, cur: 'INR' });
      ensureReportBooks(state);
      const a = acct('rep-dhan-inr'), out = { id: a.id, bal: bookBalance(a), computed: bookComputedBalance(a) };
      bt.files = bt.files.filter(f => f.id !== 'dhan1'); bt.rows = bt.rows.filter(r => r.file !== 'dhan1'); state.accounts = accounts;
      return out;
    });
    check(dhanBal.id === 'rep-dhan-inr' && dhanBal.bal === dhanBal.computed && dhanBal.bal === 5, 'a Dhan report book: ' + JSON.stringify(dhanBal));
    check((bal.books.match(/· CoinDCX wallet/g) || []).length === 2 && bal.books.includes('₹8,144.78') && bal.books.includes('$82.02'), 'Trading Books: ' + bal.books);

    // The fills sit on the file after the wallet, each in the journal's own shape and on the Indian clock.
    const cdxRec = stored().backtest.files.find(f => f.id === 'cdx-api'), fl = cdxRec.fills || [];
    check(Object.keys(cdxRec).slice(-2).join() === 'wallet,fills' && fl.length === 6 && fl.every(x => Object.keys(x).join() === 'id,at,sym,side,price,qty,cur')
      // Oldest first; two in the same second go by their ID.
      && fl.every((x, i) => !i || fl[i - 1].at < x.at || (fl[i - 1].at === x.at && fl[i - 1].id < x.id))
      && JSON.stringify(fl.map(x => [x.at, x.sym, x.side, x.price, x.qty, x.cur]).sort()) === JSON.stringify([[D + ' 10:05:00', 'B-LNK_USDT', 'buy', 11.99, 60, 'INR'], [D + ' 10:05:00', 'B-LNK_USDT', 'buy', 12.015, 40, 'INR'],
        [D + ' 11:00:00', 'B-ORF_USDT', 'sell', 2, 50, 'INR'], [D + ' 14:00:00', 'B-LNK_USDT', 'sell', 12.05, 50, 'INR'], [D + ' 14:00:00', 'B-LNK_USDT', 'sell', 12.15, 50, 'INR'], [OLD + ' 09:00:00', 'B-OLD_USDT', 'buy', 1, 10, 'INR']].sort()), 'fills on the file: ' + JSON.stringify(cdxRec).slice(-700));
    // With them, the alert LNK was bought off finds the trade: its side, entry and
    // exit from the fills, dated when it opened, and R in the alert's own R: its
    // entry 12.11 to its stop 12.01, on the trade's size (₹991 is $9.98 at ₹99.30;
    // 100 × 0.10 is $10). Bought at 12.00, past that stop, it still has an R.
    // ORF (a short, its close not in yet) has no prices, so no alert can claim it.
    const sigs = () => page.evaluate(([D]) => {
      const sg = (id, sym, time, side, entry, stop) => ({ id, key: 'tl|' + sym, kind: 'trendline', date: D, time, symbol: sym, side, score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: '+2R', resultR: 1.9, hasReportR: true, price: entry, stop, entry });
      state.signals = [sg('sg-lnk', 'LNKUSD', '09:50', 'long', 12.11, 12.01), sg('sg-orf', 'ORFUSD', '10:30', 'long', 2, 1.98),
        Object.assign(sg('sg-lnk-zone', 'LNKUSD', '09:55', 'long', 12, 11.9), { kind: undefined, key: 'zone|LNKUSD' })];
      // "Fill stops from signals" only touches journal trades: a CoinDCX trade has no stop of its own to fill.
      const said = [], realToast = toast;
      toast = m => said.push(m);
      fillStopsFromSignals();
      toast = realToast;
      const pairs = matchSignals('trendline'), p = pairs.find(x => x.signal.id === 'sg-lnk'), q = pairs.find(x => x.signal.id === 'sg-orf'), t = p.trade;
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'vsme', sigFilter: 'orphans' });
      switchTab('signals'); renderAll();
      const text = id => document.getElementById(id).innerText.replace(/\s+/g, ' ');
      return { t: t && [t.rep, t.symbol, t.direction, +t.entry.toFixed(6), +t.exit.toFixed(6), t.qty, t.date, t.time], r: myOutcome(p) && myOutcome(p).r, orf: !!q.trade, said,
        strip: text('sigEdgeStrip'), vs: text('sigVsMine'), orphans: text('signalsTableBody'),
        refused: [btPrices({ closed: true, carried: false, start: D + ' 10:05:00', end: D + ' 14:00:00' }, [{ at: D + ' 10:05:00', side: 'buy', price: 12, qty: 100 }, { at: D + ' 14:00:00', side: 'sell', price: 12.1, qty: 60 }]),
          btPrices({ closed: true, carried: true, start: D + ' 10:05:00', end: D + ' 14:00:00' }, [{ at: D + ' 10:05:00', side: 'buy', price: 12, qty: 100 }, { at: D + ' 14:00:00', side: 'sell', price: 12.1, qty: 100 }])] };
    }, [D]);
    let v = await sigs();
    check(JSON.stringify(v.t) === JSON.stringify([true, 'LNK/USDT', 'long', 12, 12.1, 100, D, '10:05']) && near(v.r, 991 / 99.3 / 10) && !v.orf, 'alert matched to a CoinDCX trade: ' + JSON.stringify(v));
    check(v.strip.includes('1 taken by you') && /LNK\/USDT LONG .*\+1\.00R \(\+0\.83%\)/.test(v.vs) && !v.orphans.includes('ORF') && JSON.stringify(v.refused) === '[null,null]', 'Signals tab: ' + JSON.stringify(v));
    check(JSON.stringify(v.said) === '["No matched trades are missing a stop"]', 'fill stops from signals: ' + JSON.stringify(v.said));

    // Analysis, results by broker and Files say where the rows came from.
    const an = await page.evaluate(() => {
      state.ui.account = 'rep-coindcx-inr'; state.ui.anPeriod = 'all'; state.ui.btSec = 'files'; switchTab('analysis'); renderAll();
      return { check: document.getElementById('btCheck').innerText, title: document.getElementById('btTitle').textContent,
        line: [...document.querySelectorAll('#anBrokers tbody tr')].map(x => x.innerText.replace(/\s+/g, ' ').trim()).find(l => l.startsWith('CoinDCX ')) || '',
        files: document.getElementById('btFiles').innerText };
    });
    check(an.check.startsWith('✓ All ') && an.check.includes(`${dupStored} rows from the API are already in an uploaded report and count once.`), 'Analysis check line: ' + an.check);
    check(an.title === 'CoinDCX · trades from its report and API', 'Analysis title: ' + an.title);
    check(an.line.includes('+₹' + API_NET.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) && an.line.endsWith('Report + API'), 'results by broker: ' + an.line);
    check(an.files.includes('CoinDCX API') && an.files.includes('✓ Every transaction CoinDCX sent is stored once') && an.files.includes("Added by GitHub's hourly CoinDCX import"), 'Files: ' + an.files.slice(0, 400));

    // The next hour: nothing new, no commit.
    r = await runImport();
    check(r.code === 0 && r.out === 'Up to date, nothing new from CoinDCX · 1 unreadable transaction skipped' + W + F && !r.puts.length, 'second run: ' + JSON.stringify(r));
    // Later runs read the fills from three days before the newest one kept.
    const later = mock.calls.filter(x => isFill(x) && x.p.margin_currency_short_name[0] === 'INR').map(x => x.p.from_date);
    check(later.length === 2 && later[1] <= new Date(Date.parse(D + 'T08:30:00Z') - 3 * 864e5).toISOString().slice(0, 10) && later[0] > later[1], 'later fill reads: ' + JSON.stringify(later));
    // An answer that ignores paging (the whole list on every page) still ends.
    mock.mode = 'noPaging';
    r = await runImport();
    check(r.code === 0 && r.out.startsWith('Up to date') && mock.calls.filter(x => !isFill(x)).length === 4 && !r.puts.length, 'paging ignored: ' + r.out + ' after ' + mock.calls.length + ' calls');
    // A margin type CoinDCX won't list is skipped and named; the other still comes in.
    mock.mode = 'noUsdt';
    r = await runImport();
    check(r.code === 0 && r.out === 'Up to date, nothing new from CoinDCX · 1 unreadable transaction skipped · USDT futures not read (CoinDCX answered 400: Invalid margin)' + W + F && !r.puts.length, 'USDT refused: ' + JSON.stringify(r));
    // Neither one read fails the run and leaves the reason for the journal, once.
    mock.mode = 'all400';
    r = await runImport();
    check(r.code === 1 && r.out === '::error::CoinDCX answered 400: Invalid margin.' && JSON.stringify(r.puts) === '["CoinDCX import failed"]', 'both refused: ' + JSON.stringify(r));
    check(stored().backtest.files.find(f => f.id === 'cdx-api').note === 'CoinDCX answered 400: Invalid margin.' && stored().backtest.rows.length === EXPECTED.rows + NEW_ROWS, 'note on the file: ' + JSON.stringify(stored().backtest.files));
    r = await runImport();
    check(r.code === 1 && !r.puts.length, 'the same failure again: ' + JSON.stringify(r));
    // The reason and the wallet sit on the file as the journal keeps them: its sync has nothing to send.
    s = await sync();
    check(s.ok && s.changed === false, 'sync after a failed run: ' + JSON.stringify(s));
    c = await card();
    check(c.badge === 'Last run failed' && c.bad && c.status.startsWith("GitHub's last run failed: CoinDCX answered 400: Invalid margin. " + NEW_ROWS + ' CoinDCX rows'), 'card after a failed run: ' + JSON.stringify(c));
    b = await books();
    check(b.inr.n === API_CLOSED && near(b.inr.net, API_NET), 'book after a failed run: ' + JSON.stringify(b));
    // Working again clears it.
    mock.mode = 'ok';
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["CoinDCX import working again"]' && !('note' in stored().backtest.files.find(f => f.id === 'cdx-api')), 'recovered: ' + JSON.stringify(r));
    await sync();
    c = await card();
    check(c.badge === 'Importing' && !c.bad, 'card after recovering: ' + JSON.stringify(c));

    // A device saves between the import's read and write: read again, merge, nothing lost.
    inr.push(tx('B-HHH_USDT', '2026-09-20 10:00:00', 'default', 0, 1), tx('B-HHH_USDT', '2026-09-20 12:00:00', 'default', 11, 1));
    API_NET += 9; API_CLOSED += 1;
    gh.beforePut = phoneSaves;
    const conflictsBefore = gh.conflicts;
    r = await runImport();
    j = stored();
    check(r.code === 0 && r.out.startsWith('Imported 2 new rows from CoinDCX') && gh.conflicts === conflictsBefore + 1 && JSON.stringify(r.puts) === '["CoinDCX: 2 new rows"]', 'save during the import: ' + JSON.stringify(r));
    check(j.trades.some(t => t.id === 'tr-phone') && j.backtest.rows.filter(x => x.sym === 'B-HHH_USDT').length === 2, 'after the conflict: phone trade ' + j.trades.some(t => t.id === 'tr-phone') + ', HHH rows ' + j.backtest.rows.filter(x => x.sym === 'B-HHH_USDT').length);
    // A journal file over 1 MB comes without content; it is read raw.
    gh.big = true;
    const raws = gh.rawReads;
    r = await runImport();
    gh.big = false;
    check(r.code === 0 && r.out.startsWith('Up to date') && gh.rawReads === raws + 1 && !r.puts.length, 'large journal file: ' + JSON.stringify(r) + ' raw reads ' + (gh.rawReads - raws));
    // No journal file in the repo yet: says so.
    r = await runImport({ GITHUB_REPOSITORY: 'victus/empty' });
    check(r.code === 1 && /journal\.json isn't in victus\/empty \(branch main\) yet\. Turn on GitHub Sync/.test(r.out) && mock.calls.length === 0, 'no journal file: ' + JSON.stringify(r));
    // CoinDCX not answering (or refusing GitHub's servers) is said plainly.
    mock.mode = 'blocked';
    r = await runImport();
    check(r.code === 1 && /^::error::Could not reach CoinDCX \(.+\)\. If this keeps happening, CoinDCX may not accept GitHub's servers\.$/.test(r.out), 'blocked: ' + JSON.stringify(r));
    mock.mode = 'ok';
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["CoinDCX import working again"]', 'after blocked: ' + JSON.stringify(r));

    // Without the report the API alone gives the same book (once the transaction
    // it held back by ID comes in), read the older way, with position ids.
    await sync();
    await page.evaluate(() => removeBacktestFile(state.backtest.files.find(f => f.id !== 'cdx-api').id));
    await sync();
    mock.mode = 'needIds';
    r = await runImport();
    // (The broken row has no position, so this form doesn't send it.)
    check(r.code === 0 && r.out === 'Imported 1 new row from CoinDCX' + W + F, 'import after removing the report: ' + JSON.stringify(r));
    check(mock.calls.some(x => x.path.endsWith('/positions') && x.p.margin_currency_short_name[0] === 'INR') && mock.calls.some(x => x.p.position_ids), 'position ids were not tried: ' + mock.calls.map(x => x.path).join(','));
    mock.mode = 'ok';
    await sync();
    b = await books();
    check(b.inr.n === API_CLOSED && near(b.inr.net, API_NET) && b.rows === b.api && b.journal === seed.trades.length + 1, 'API alone: ' + JSON.stringify(b));

    // A journal with only another broker's report, while the pages shift: each
    // transaction once, in a CoinDCX book of its own.
    const dhan = { id: 'dhan1', name: 'dhan.csv', sheet: 'Trades', broker: 'Dhan', importedAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', rows: 1, added: 1, net: 5, cur: 'INR', checked: true };
    const bare = { version: 1, savedAt: new Date().toISOString(), accounts: [], trades: [], signals: [], goals: [], playbook: [], aliases: {}, tombstones: {}, reviews: {}, reviewsAt: {},
      backtest: { files: [dhan], rows: [{ id: 'd1', file: 'dhan1', sym: 'RELIANCE', at: '2026-09-01 10:00:00', kind: 'order', type: 'By Order', gross: 5, settle: 0, fee: 0, net: 5, cur: 'INR' }] } };
    gh.files['victus/fresh'] = { text: JSON.stringify(bare, null, 2), sha: 'f0' };
    mock.mode = 'shift';
    r = await runImport({ GITHUB_REPOSITORY: 'victus/fresh' });
    mock.mode = 'ok';
    const fj = JSON.parse(gh.files['victus/fresh'].text), all = inr.length - 1 + usdt.length;
    const fileRec = fj.backtest.files[1] || {};
    check(r.code === 0 && r.out === `Imported ${all} new rows from CoinDCX · 1 unreadable transaction skipped` + W + F1 && fj.backtest.rows.length === all + 1 && new Set(fj.backtest.rows.map(x => x.id)).size === all + 1, 'fresh journal, shifting pages: ' + JSON.stringify(r) + ' rows ' + fj.backtest.rows.length);
    check(fileRec.broker === 'CoinDCX' && fileRec.checked === true && JSON.stringify(fj.backtest.files[0]) === JSON.stringify(dhan) && JSON.stringify(Object.assign({}, fj, { backtest: bare.backtest, savedAt: bare.savedAt })) === JSON.stringify(bare), 'journal with a Dhan report: ' + JSON.stringify(fj.backtest.files));
    // A journal that never had an upload has no backtest part yet: it is added, last, as the journal writes it.
    const none = Object.assign({}, bare);
    delete none.backtest;
    gh.files['victus/none'] = { text: JSON.stringify(none, null, 2), sha: 'n0' };
    r = await runImport({ GITHUB_REPOSITORY: 'victus/none' });
    const nj = JSON.parse(gh.files['victus/none'].text);
    check(r.code === 0 && r.out === `Imported ${all} new rows from CoinDCX · 1 unreadable transaction skipped` + W + F1 && nj.backtest && nj.backtest.rows.length === all && Object.keys(nj).pop() === 'backtest', 'journal with no uploads: ' + JSON.stringify(r) + ' ' + JSON.stringify(Object.keys(nj)));

    // CoinDCX turning GitHub's servers away stops at the first call and says so,
    // without the page's HTML. The reason is long: the journal keeps 300
    // characters of it, and so does the file, so neither keeps rewriting it.
    mock.mode = 'forbidden';
    r = await runImport();
    const said = ("CoinDCX refused the request (403: 403 Forbidden Access denied " + 'Request blocked. '.repeat(12)).slice(0, 160 + 34) + "). Either the key is bound to an IP address, or CoinDCX doesn't accept GitHub's servers, which are outside India.";
    check(r.code === 1 && r.out === '::error::' + said && mock.calls.length === 1 && JSON.stringify(r.puts) === '["CoinDCX import failed"]', 'refused by CoinDCX: ' + JSON.stringify(r) + ' after ' + mock.calls.length + ' calls');
    check(said.length > 300 && stored().backtest.files.find(f => f.id === 'cdx-api').note === said.slice(0, 300), 'long reason on the file: ' + said.length);
    s = await sync();
    r = await runImport();
    check(s.ok && r.code === 1 && !r.puts.length, 'the long reason again, after a sync: ' + JSON.stringify(s) + ' ' + JSON.stringify(r));
    mock.mode = 'ok';
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["CoinDCX import working again"]', 'after refused: ' + JSON.stringify(r));

    // The wallet moves (a deposit, say): one commit, and the journal follows it.
    // The same figure again changes nothing; a wallet CoinDCX won't show keeps the last one.
    mock.wallets[0].balance = '9000.5';
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["CoinDCX wallet balance"]' && r.out.endsWith(' · wallet INR 9144.78, USDT 82.02' + F), 'wallet moved: ' + JSON.stringify(r));
    r = await runImport();
    check(r.code === 0 && !r.puts.length, 'the same wallet again: ' + JSON.stringify(r));
    mock.mode = 'noWallet';
    r = await runImport();
    mock.mode = 'ok';
    check(r.code === 0 && r.out.endsWith(' · wallet balance not read (CoinDCX answered 404: Not found)' + F) && !r.puts.length && stored().backtest.files.find(f => f.id === 'cdx-api').wallet.INR === 9144.78, 'wallet not shown: ' + JSON.stringify(r));
    s = await sync();
    bal = await balances();
    check(s.ok && bal.inr === 9144.78 && bal.cdx.top === bal.want, 'balance after the wallet moved: ' + JSON.stringify(bal));

    // ORF's closing fill comes in on its own: one commit; synced, ORF has its prices
    // and shows as a trade no alert explains (a short; the only ORF alert is a long).
    fills.push(...orfClose);
    const F2 = F.replace('5 fills', '7 fills');
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["CoinDCX trade prices"]' && r.out.endsWith(F2) && stored().backtest.files.find(f => f.id === 'cdx-api').fills.length === 8, 'new fills: ' + JSON.stringify(r));
    s = await sync();
    v = await sigs();
    check(s.ok && /ORF\/USDT SHORT 2 .*No alert/.test(v.orphans) && !v.orf && v.strip.includes('1 taken by you'), 'a CoinDCX trade with no alert: ' + JSON.stringify(v));
    // Its row opens the trade in Analysis, under its book. Fills changing alone
    // (no new rows) are seen too, as the trades are worked out again.
    const orf = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#signalsTableBody tr')].find(tr => tr.innerText.includes('ORF/USDT'));
      row.click();
      const out = { account: state.ui.account, analysis: !document.getElementById('view-analysis').classList.contains('hidden') };
      const f = state.backtest.files.find(x => x.id === 'cdx-api'), all = f.fills, px = () => !!reportTrades().find(t => t.symbol === 'ORF/USDT').px;
      f.fills = all.filter(x => !(x.sym === 'B-ORF_USDT' && x.side === 'buy'));
      out.without = px();
      f.fills = all;
      out.with = px();
      state.ui.account = 'all'; renderAll();
      return out;
    });
    check(JSON.stringify(orf) === '{"account":"rep-coindcx-inr","analysis":true,"without":false,"with":true}', 'ORF row and its prices: ' + JSON.stringify(orf));
    s = await sync();
    check(s.ok && s.changed === false, 'sync after the new fill: ' + JSON.stringify(s));
    // Fills CoinDCX won't show: said, nothing written, the ones kept stay.
    mock.fillsMode = 'none';
    r = await runImport();
    mock.fillsMode = '';
    check(r.code === 0 && r.out.endsWith(' · trade prices not read (CoinDCX answered 404: Not found)') && !r.puts.length && stored().backtest.files.find(f => f.id === 'cdx-api').fills.length === 8, 'fills not shown: ' + JSON.stringify(r));
    // Even this week's dates refused: said with CoinDCX's words, nothing written.
    mock.fillsMode = 'range';
    r = await runImport();
    mock.fillsMode = '';
    check(r.code === 0 && r.out.endsWith(' · trade prices not read (CoinDCX answered 400: From Date not in range)') && !r.puts.length, 'fill dates refused: ' + JSON.stringify(r));
    // An answer that ignores the dates (every fill for every week) still keeps each
    // one once, ORF's two alike halves included.
    mock.fillsMode = 'allDates';
    r = await runImport();
    mock.fillsMode = '';
    check(r.code === 0 && r.out.endsWith(F2.replace('7 fills', '8 fills')) && !r.puts.length, 'fill dates ignored: ' + JSON.stringify(r));

    // Every tab still draws with the API rows in.
    for (const tab of TABS) {
      const bad = await page.evaluate(t => { switchTab(t); renderAll(); const m = document.getElementById('view-' + t).innerText.match(/.{0,40}(NaN|undefined|Infinity%).{0,40}/); return m ? m[0] : ''; }, tab);
      check(!bad, `${tab} shows: ${bad}`);
    }
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  fake.close();
  try { fs.unlinkSync(summary); } catch (e) {}
  const label = 'CoinDCX import on GitHub: signed calls, journal.json, counted once with the report';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Fixes from the 11 Oct audit: a CoinDCX book with only its wallet (no starting
// balance typed) still has a % return; the month headline is coloured by its
// sign; a time-of-day card lists the report trades it counts; the ledger's book
// filter survives a re-render; the trade form refuses a stop on the wrong side.
async function fixesRun(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  try {
    const v = await page.evaluate(() => {
      const d = iso(new Date()), old = '2024-12-02';
      // An old losing trade (before this month) and this month's winner: opened 10:05, closed 11:40.
      const row = (id, at, kind, gross, fee) => ({ id, file: 'cdx-api', sym: 'B-ETH_USDT', at, kind, type: kind, gross, settle: 0, fee, net: gross - fee, cur: 'INR' });
      state.backtest = cleanBacktest({ files: [{ id: 'cdx-api', name: 'CoinDCX API', broker: 'CoinDCX', importedAt: new Date().toISOString(), cur: 'INR', wallet: { at: new Date().toISOString(), INR: 5000 } }],
        rows: [row('o1', old + ' 09:00:00', 'order', 0, 10), row('c1', old + ' 12:00:00', 'order', -3000, 10),
          row('o2', d + ' 10:05:00', 'order', 0, 5), row('c2', d + ' 11:40:00', 'order', 505, 5)] });
      ensureReportBooks(state);
      Object.assign(state.ui, { account: 'rep-coindcx-inr', allCur: 'INR', month: 'current', kpiGreenDays: false, dashSec: 'habits' });
      switchTab('dashboard'); renderAll();
      const ret = [...document.querySelectorAll('#kpiRibbon > div')].find(c => /RETURN/.test(c.innerText)).innerText.replace(/\s+/g, ' ');
      const head = document.getElementById('activePnlDeltaText');
      const headLine = head.parentElement.innerText;
      // The 10:00 card: clicking it lists the report trade that opened then.
      const slot = [...document.querySelectorAll('#timeOfDayContainer > div')].find(c => c.innerText.includes('10:00 - 10:30'));
      slot && slot.click();
      const focused = document.getElementById('tradeLedgerTableBody').innerText;
      clearLedgerFocus();
      // Book filter in the ledger, then something re-renders.
      state.ui.account = 'all'; renderAll();
      const sel = document.getElementById('filterAccountSelect');
      sel.value = 'rep-coindcx-inr'; renderAll();
      const kept = sel.value;
      // Trade form: a long with its stop above the entry is refused.
      const said = [], realToast = toast; toast = m => said.push(m);
      openTrade(null, { accountId: state.accounts.find(a => !a.reportBroker).id, symbol: 'TEST', direction: 'long', entry: 100, exit: 101, qty: 1, stop: 102 });
      const n0 = state.trades.length;
      const saveBtn = document.getElementById('modalSheetSaveBtn');
      saveBtn && saveBtn.click();
      const refused = state.trades.length === n0;
      document.getElementById('mStop').value = '99'; document.getElementById('mExitTime').value = '11:30';
      saveBtn && saveBtn.click();
      const added = state.trades.length === n0 + 1 ? state.trades[0] : null;
      toast = realToast;
      return { ret, headLine, headCls: head.className, focused, kept, said, refused, saved: !!saveBtn, added: added && [added.stop, added.exitTime] };
    });
    // Opening balance: wallet 5000 less this month's 495 = 4505; 495 on it is +10.99%.
    check(/RETURN \+10\.99% \+₹495\.00 on ₹4,505\.00/.test(v.ret), 'CoinDCX return from its wallet: ' + v.ret);
    check(/^Net P&L: \+₹495\.00/.test(v.headLine) && v.headCls.includes('emerald'), 'month headline: ' + v.headLine + ' ' + v.headCls);
    check(/ETH\/USDT/.test(v.focused), 'time-of-day card lists its report trade: ' + v.focused.replace(/\s+/g, ' ').slice(0, 200));
    check(v.kept === 'rep-coindcx-inr', 'ledger book filter reset to ' + v.kept);
    check(v.saved && v.refused && v.said.some(m => /stop must be below/.test(m)), 'wrong-side stop: ' + JSON.stringify(v.said));
    check(JSON.stringify(v.added) === '[99,"11:30"]', 'trade with exit time: ' + JSON.stringify(v.added));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'audit fixes: wallet return, headline, time slot, ledger filter, trade form';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// The header fits on one line on wide screens whatever book is picked, and a
// trade's review (rules kept, what went right, mistakes) is marked from the
// inspector, saved, and still there after a reload.
async function reviewRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  for (const width of [1520, 1920]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    for (const id of ['all', 'acc_nse', 'acc_cry']) {
      const h = await page.evaluate(id => { state.ui.account = id; renderAll(); const t = document.getElementById('topBalLive'); t.classList.remove('hidden'); t.innerText = 'LAST KNOWN'; document.getElementById('topBalVal').innerText = '₹88,008.57';
        const ab = document.getElementById('accountsBar'); return { h: document.querySelector('header').offsetHeight, cut: ab.scrollWidth - ab.clientWidth }; }, id);
      check(h.h < 80 && h.cut === 0, width + 'px, ' + id + ': header not on one line ' + JSON.stringify(h));
    }
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.evaluate(() => openInspector(allTrades().find(t => t.id === 'tr1')));
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#inspChecklist button')].map(b => b.innerText.replace(/\s+/g, ' ')));
    const before = await rows();
    await page.click('#inspChecklist button:nth-of-type(2)'); // Risk within limit: missed -> kept
    await page.click('#inspChecklist button:nth-of-type(1)'); // Traded a planned setup: kept -> missed
    await page.click('#inspTagsPositive button:has-text("Trailed Stop Loss")');
    await page.click('#inspTagsMistake button:has-text("FOMO Entry")');
    await page.click('#inspChecklist button:has-text("Volume spike")');
    const after = await rows();
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    const saved = await page.evaluate(() => { const t = state.trades.find(x => x.id === 'tr1'); return { rules: t.rules, pos: t.tagsPositives, mis: t.tagsMistakes, play: t.playRules, notes: t.notes }; });
    check(before.length === 7 && after.length === 7 && after[1].startsWith('✓') && after[0].startsWith('✕'), 'inspector rows: ' + JSON.stringify({ before, after }));
    check(JSON.stringify(saved.rules) === '[false,true,true,false,true]' && JSON.stringify(saved.pos) === '["Trailed Stop Loss"]' && JSON.stringify(saved.mis) === '["FOMO Entry"]'
      && saved.play['Volume spike'] === false && saved.play['Above VWAP'] === true && saved.notes === 'smoke test', 'review not saved: ' + JSON.stringify(saved));
    // Tapping a tag again takes it off.
    await page.evaluate(() => openInspector(allTrades().find(t => t.id === 'tr1')));
    await page.click('#inspTagsMistake button:has-text("FOMO Entry")');
    check(JSON.stringify(await page.evaluate(() => state.trades.find(x => x.id === 'tr1').tagsMistakes)) === '[]', 'a mistake tag did not come off');
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'one-line header, trade review marked from the inspector';
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
await fixesRun(data);
await reviewRun(data);

await browser.close();
server.close();
if (failures.length) { console.log('\n' + failures.length + ' problem(s) found'); process.exit(1); }
console.log('\nAll checks passed');
