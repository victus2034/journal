// Opens index.html in headless Chromium and fails on any script error.
// Runs twice: with an empty browser, and with a small made-up journal so the
// charts, tables and stats actually render. Every tab is opened on desktop
// and phone widths. Outside requests (CDN, GitHub, Delta) are blocked, so the
// check never depends on the network. One more pass fills storage to 86%
// and expects the storage warning. The last pass uploads a made-up CoinDCX
// trade report (.xlsx, then the same as .csv), checks every number it shows
// against the report, in Analysis and on the Dashboard, and switches brokers.
// The goal planner turns a target, days and trades a day into per-day and per-trade amounts.
// Then the CoinDCX import GitHub runs reads a fake CoinDCX (which checks every
// call is signed as CoinDCX documents) into a fake GitHub's journal.json; the
// journal syncs it, and trades the report already has must count only once.
// Last, the journal loads the scanner's alerts by itself and a fresh trade matches one.
// Delta and Gemini keys travel locked in journal.json between several devices, and a
// setup link / code / QR connects a new one (the QR is read back with jsQR).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { EXPECTED, REPORT_ROWS, backtestXlsx, backtestCsv } from './backtest-fixture.mjs';
import { createRequire } from 'node:module';
const jsQR = createRequire(import.meta.url)('jsqr');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TABS = ['dashboard', 'signals', 'analysis', 'calculator', 'data'];

function fixture() {
  // Trading days on this machine's clock: the journal's day rolls over at 05:30.
  const day = n => { const d = new Date(Date.now() - 5.5 * 3600e3); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
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
  // Phones: the bottom bar is tabs only; logging a trade lives in Settings.
  if (viewport.width < 768) {
    const nav = await page.evaluate(() => ({ shown: getComputedStyle(document.getElementById('mobileNav')).display !== 'none', add: !!document.querySelector('#mobileNav [onclick*="openTrade"]') }));
    if (!nav.shown || nav.add) errs.push('mobile bar should show without a log-trade button: ' + JSON.stringify(nav));
    try {
      // A day past its loss limit asks first (dismissed here), so no form is right then.
      const limHit = await page.evaluate(() => { switchTab('data'); return dailyLimitState(viewCur()).hit; });
      await page.locator('#view-data button:has-text("Log trade")').click({ timeout: 2000 });
      await page.waitForTimeout(200);
      const form = await page.evaluate(() => ({ open: !document.getElementById('modalSheet').classList.contains('hidden'), title: document.getElementById('modalSheetTitle').textContent }));
      if (limHit ? form.open : (!form.open || form.title !== 'Log Trade to Journal')) errs.push('Settings Log trade did not open the trade form: ' + JSON.stringify(form));
      await page.keyboard.press('Escape');
    } catch (e) { errs.push('Settings Log trade: ' + e.message.split('\n')[0]); }
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
    const today = await page.evaluate(() => todayDay());
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
    // A % of capital goal is the same % in ₹ and $ (each book at its own rate), not one figure moved at ₹85.
    const pctGoal = await page.evaluate(() => {
      const g = { id: 'gp', title: 'Pct goal', metric: 'net_pnl', targets: { net_pnl: 1 }, pnlPct: 10, period: 'month', accountId: 'all', cur: 'INR' };
      return { inr: goalTargetIn(g, 'net_pnl', 'INR'), usd: goalTargetIn(g, 'net_pnl', 'USD'), capInr: goalStartCapital(g, 'INR'), capUsd: goalStartCapital(g, 'USD') };
    });
    check(pctGoal.capInr > 0 && Math.abs(pctGoal.inr - pctGoal.capInr / 10) <= 0.01 && Math.abs(pctGoal.usd - pctGoal.capUsd / 10) <= 0.01, '% of capital goal: ' + JSON.stringify(pctGoal));
    // Today card on All accounts: max risk is every book's, the same in ₹ and $.
    const riskMax = await page.evaluate(() => {
      const prev = [state.ui.account, state.ui.allCur]; state.ui.account = 'all';
      const read = cur => { state.ui.allCur = cur; updateRiskStatusStrip(cur); return document.getElementById('riskPctUsed').innerText; };
      const r = { inr: read('INR'), usd: read('USD') };
      state.ui.account = prev[0]; state.ui.allCur = prev[1];
      return r;
    });
    check(riskMax.inr.includes('1–1.5% max') && riskMax.usd.includes('1–1.5% max'), 'max risk on All accounts: ' + JSON.stringify(riskMax));
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
        const g = state.goals.find(x => x.title === 'Plan ' + p), d = parseDay(todayDay()); // the trading day, which starts at 05:30
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

// Goal profit as a % of capital: typed in the goal editor, worked out from the
// balance each window opens with, shown on the card, kept through sync.
async function goalPctRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.evaluate(() => { state.ui.allCur = 'INR'; state.ui.account = 'acc_nse'; switchTab('dashboard'); renderAll(); openGoal('new'); document.getElementById('gTitle').value = 'Grow 10%'; });
    await page.selectOption('#gAccount', 'acc_nse');
    await page.selectOption('#gPeriod', 'week');
    await page.selectOption('#gu_net_pnl', 'pct');
    await page.fill('#gv_net_pnl', '10');
    const hint = await page.innerText('#gPctHint');
    const [B, want] = await page.evaluate(() => { const b = balanceAtStart(acct('acc_nse'), iso(goalWindowStart('week'))); return [b, money(b * 0.1, 'INR')]; });
    check(B > 0 && hint.includes('10% of') && hint.includes('= ' + want), 'editor hint: ' + hint + ' want ' + want);
    await page.click('#modalSheetSaveBtn');
    const r = await page.evaluate(() => {
      const g = state.goals.find(x => x.title === 'Grow 10%');
      state.ui.goalIdx = state.goals.indexOf(g); updateGoalDisplays();
      const t1 = goalTargets(g).net_pnl;
      acct('acc_nse').startBalance = (acct('acc_nse').startBalance || 0) + 1000; // more capital at the window's start
      const t2 = goalTargets(g).net_pnl;
      acct('acc_nse').startBalance -= 1000;
      const back = sanitizeState(JSON.parse(JSON.stringify(state))).goals.find(x => x.id === g.id);
      return { pct: g.pnlPct, t1, t2, card: document.getElementById('goalTarget').innerText, kept: back.pnlPct, plain: cleanGoal({ id: 'z', pnlPct: 5, targets: { win_rate: 50 } }).pnlPct };
    });
    check(r.pct === 10 && Math.abs(r.t1 - B * 0.1) < 0.01 && Math.abs(r.t2 - r.t1 - 100) < 0.01, '% target: ' + JSON.stringify(r) + ' B=' + B);
    check(r.card.includes('10% of capital') && r.kept === 10 && r.plain === undefined, 'card / sync: ' + JSON.stringify(r));
    // Reopening shows the %; switching back to ₹ turns it into the amount.
    const re = await page.evaluate(() => { openGoal(state.goals.find(x => x.title === 'Grow 10%').id); return { u: document.getElementById('gu_net_pnl').value, v: document.getElementById('gv_net_pnl').value }; });
    await page.selectOption('#gu_net_pnl', 'amt');
    const amt = parseFloat(await page.inputValue('#gv_net_pnl'));
    await page.click('#modalSheetSaveBtn');
    const off = await page.evaluate(() => { const g = state.goals.find(x => x.title === 'Grow 10%'); return { pct: g.pnlPct, t: goalTargets(g).net_pnl }; });
    check(re.u === 'pct' && re.v === '10' && Math.abs(amt - B * 0.1) < 0.01 && off.pct === undefined && Math.abs(off.t - amt) < 0.01, 'back to amount: ' + JSON.stringify({ re, amt, off }));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'goal profit as a % of capital';
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
    check(v.analysis && v.report && v.live && v.broker === 'CoinDCX' && v.account === BOOK && v.on === 'CoinDCX' && await page.evaluate(() => anCurSec()) === 'report', 'after import Analysis did not open on CoinDCX\'s report: ' + JSON.stringify(v));
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
    check(dash.analyzed, 'size and mistake analysis left out the report trades');
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
    const opened = await page.evaluate(() => { const t = reportTrades().slice().sort(byWhen)[0]; openReportTrade(t); return { account: state.ui.account, sec: state.ui.anSec, open: btOpenTrade, rows: document.getElementById('btBody').innerText }; });
    check(opened.account === BOOK && opened.sec === 'trades' && opened.open && /report rows?/.test(opened.rows), 'opening a report trade from the ledger: ' + JSON.stringify(opened).slice(0, 300));

    // Files live in Settings → Connections: Analysis has no Files tab, the Data tab lists them.
    // A report book has one row of sections: its Report first, then the ones every book has.
    check(/^Report Overview Demo vs you Review( \d+)? Position size Trades Market days AI review$/.test((await page.innerText('#anSecBar')).replace(/\s+/g, ' ').trim()) && !(await page.$('[data-btsec]')), 'report book sections: ' + await page.innerText('#anSecBar'));
    const dataFiles = await page.evaluate(() => { switchTab('data'); return document.getElementById('btFiles').innerText; });
    check(/Delete CoinDCX's report data/.test(dataFiles) && /Remove/.test(dataFiles), 'Sync & Settings does not list the report files: ' + JSON.stringify(dataFiles.slice(0, 400)));
    await page.evaluate(() => switchTab('analysis'));
    for (const sec of ['report', 'overview', 'size', 'trades', 'market', 'ai']) {
      await page.evaluate(k => setAnSec(k), sec);
      check(await page.evaluate(k => { const el = document.querySelector('[data-ansec="' + k + '"]'); return !!el && !el.classList.contains('hidden') && el.offsetHeight > 0; }, sec), 'report book section "' + sec + '" did not show');
    }
    // The old section names still land in the right place.
    check(await page.evaluate(() => { setBtSec('overview'); const a = anCurSec(); setBtSec('checks'); const b = anCurSec(); return a + ',' + b; }) === 'report,overview', 'old report section names');
    await page.evaluate(() => setAnSec('trades'));
    check(await page.evaluate(() => !document.getElementById('btTradesWrap').classList.contains('hidden') && document.getElementById('anAllTrades').classList.contains('hidden')), 'report book Trades: its report table, not the journal list');
    await page.click('#btBody tr[data-bttrade]');
    check(/report rows?/.test(await page.innerText('#btBody')), 'clicking a trade did not list its report rows');
    // A report trade gets its own review from its row, kept apart from the report and synced.
    const btnId = await page.getAttribute('#btBody [data-repreview]', 'data-repreview');
    // Its Review button opens the same Trade Inspector a journal trade does; Edit Trade there opens the form.
    await page.click('#btBody [data-repreview]');
    const insp = await page.evaluate(() => ({ open: !document.getElementById('tradeInspectorDrawer').classList.contains('translate-x-full'), del: document.getElementById('inspDelBtn').innerText,
      rows: document.querySelectorAll('#inspChecklist button:not([data-setup])').length, tags: document.querySelectorAll('#inspTagsMistake button').length, id: activeInspectTrade && activeInspectTrade.id }));
    check(insp.open && insp.del === 'Report rows' && insp.rows === 5 && insp.tags > 5 && insp.id === btnId, 'report trade inspector: ' + JSON.stringify(insp));
    await page.click('#inspChecklist button:not([data-setup]):nth-of-type(2)'); // tap: Risk within limit on
    check(await page.evaluate(id => JSON.stringify(state.repReviews[id].rules), btnId) === '[false,true,false,false,false]', 'tapping a rule on a report trade did not save');
    await page.click('#inspChecklist button:not([data-setup]):nth-of-type(2)'); // and off again
    await page.evaluate(() => editActiveTrade());
    await page.waitForSelector('#modalSheet:not(.hidden)');
    await page.check('#mRule0'); await page.check('#mRule2');
    await page.click('#modalSheetBody [data-tag="FOMO Entry"]'); await page.click('#modalSheetBody [data-tag="Trailed Stop Loss"]');
    await page.fill('#mNotes', 'chased it'); await page.click('#mConfRow [data-conf="4"]');
    await page.click('#modalSheetSaveBtn');
    const rv = await page.evaluate(id => {
      const t = reportTrades().find(x => x.id === id), sp = syncPayload(state), back = sanitizeState(JSON.parse(JSON.stringify(sp)));
      const merged = mergeState(JSON.parse(JSON.stringify(state)), { accounts: state.accounts, trades: [], repReviews: { [id]: Object.assign({}, sp.repReviews[id], { notes: 'older', updatedAt: '2000-01-01' }) } });
      return { rules: t && t.rules, mis: t && t.tagsMistakes, pos: t && t.tagsPositives, notes: t && t.notes, conf: t && t.confidence, btn: document.querySelector('#btBody [data-repreview="' + id + '"]').innerText,
        synced: !!(sp.repReviews && sp.repReviews[id]), back: (back.repReviews[id] || {}).notes, merged: merged.repReviews[id].notes, net: t && t.pnl };
    }, btnId);
    check(JSON.stringify(rv.rules) === '[true,false,true,false,false]' && rv.mis[0] === 'FOMO Entry' && rv.pos[0] === 'Trailed Stop Loss' && rv.notes === 'chased it' && rv.conf === 4
      && rv.btn.includes('2/5') && rv.synced && rv.back === 'chased it' && rv.merged === 'chased it', 'report trade review: ' + JSON.stringify(rv));
    await page.evaluate(() => { btPick('btPair', 'B-AAA_USDT'); });
    check((await page.evaluate(() => btShown.length)) === 2, 'pair filter did not narrow to 2 trades');
    await page.evaluate(() => { btPick('btPair', 'all'); });

    // A journal book's Analysis table has a Review button too, opening the inspector.
    const anRv = await page.evaluate(() => { state.ui.account = 'acc_cry'; state.ui.anPeriod = 'all'; switchTab('analysis'); renderAll(); const b = document.querySelector('#anBody [data-anreview]'); if (!b) return null; b.click();
      return { label: b.innerText, open: !document.getElementById('tradeInspectorDrawer').classList.contains('translate-x-full'), id: activeInspectTrade.id === b.getAttribute('data-anreview'), del: document.getElementById('inspDelBtn').innerText }; });
    check(anRv && anRv.open && anRv.id && anRv.del === 'Delete' && /Review|rules/.test(anRv.label), 'Analysis review button for a journal trade: ' + JSON.stringify(anRv));
    await page.evaluate(() => { closeInspector(); state.ui.account = 'rep-coindcx-inr'; renderAll(); });
    // A journal book from the same switch shows its own analysis; back to the report after.
    await page.evaluate(() => anBrokerPick('acct:acc_nse'));
    v = await view();
    check(v.live && !v.report && v.broker === '' && v.account === 'acc_nse' && v.on === 'Test NSE', 'picking a book: ' + JSON.stringify(v));
    // Results by broker sits in Overview; a click on CoinDCX opens its report.
    await page.evaluate(() => setAnSec('overview'));
    await page.click(`#anBrokers tbody tr[data-anbroker="acct:${BOOK}"]`);
    v = await view();
    check(v.report && v.live && v.broker === 'CoinDCX' && await page.evaluate(() => anCurSec()) === 'report', 'clicking CoinDCX in results by broker: ' + JSON.stringify(v));
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
    check(v.report && v.broker === 'Dhan' && v.account === 'rep-dhan-inr' && v.bar.join(',') === 'All books,Test NSE,Test Crypto,Dhan', 'typed broker not used (CoinDCX, emptied above, is off the bar like the header\'s): ' + JSON.stringify(v));

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
    check(v.bar.join(',') === 'All books,Test NSE,Test Crypto,Dhan,Test Crypto report,Test Crypto report INR', 'report broker named like a book, in two currencies: ' + v.bar.join(','));
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
  const mock = { mode: 'ok', calls: [], bad: [], ip: '203.0.113.7', ipReads: 0, wallets: [
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
    // Fills: from the start of from_date up to the start of to_date (UTC days), a page at a time.
    // The real CoinDCX left out a day's fills while that day was to_date.
    if (p0 === '/exchange/v1/derivatives/futures/trades') {
      if (mock.fillsMode === 'none') return [404, { message: 'Not found' }];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.from_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(p.to_date || '') || p.to_date < p.from_date) { mock.bad.push('fill dates ' + body); return [400, { message: 'Invalid Request' }]; }
      // As the real one: at most 7 days (both ends counted) a call, and only 30 days back.
      const span = (Date.parse(p.to_date) - Date.parse(p.from_date)) / 864e5, oldest = new Date(Date.now() - 30 * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
      if (span > 6 || p.from_date < oldest || mock.fillsMode === 'range') return [400, { code: 400, message: 'From Date not in range', status: 'error' }];
      if ((mock.mode === 'noUsdt' && mc === 'USDT') || mock.mode === 'all400') return [400, { code: 400, message: 'Invalid margin', status: 'error' }];
      const day = x => new Date(x.timestamp).toISOString().slice(0, 10);
      return [200, slice(mc === 'INR' ? fills.filter(x => mock.fillsMode === 'allDates' || (day(x) >= p.from_date && day(x) < p.to_date)) : [])];
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
      // api.ipify.org: the PC's public IP, read only when CoinDCX refuses the key.
      if (req.url === '/ip') { mock.ipReads++; res.writeHead(mock.ip ? 200 : 500, { 'Content-Type': 'text/plain' }); return res.end(mock.ip || '<html>busy</html>'); }
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
        GITHUB_API_URL: fakeBase + '/gh', COINDCX_BASE: fakeBase + '/cdx', IP_URL: fakeBase + '/ip', GITHUB_STEP_SUMMARY: summary }, extra),
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
    // The key is locked to the PC's IP (CoinDCX, since 2026-10-29): the reason names the IP the PC has now.
    let ips = mock.ipReads;
    r = await runImport({ COINDCX_API_SECRET: 'wrong-secret' });
    check(r.code === 1 && r.out === "::error::CoinDCX refused the key (401) from this PC's IP 203.0.113.7. The key is locked to one IP: if it isn't 203.0.113.7, make a CoinDCX key for 203.0.113.7 and put it in the two secrets. Or a secret was copied short." && mock.calls.length === 1 && !r.puts.length && mock.ipReads === ips + 1, 'wrong secret: ' + JSON.stringify(r) + ' after ' + mock.calls.length + ' calls');
    // The IP can't be read (or comes back as a page): the reason says how to find it instead.
    mock.ip = '';
    r = await runImport({ COINDCX_API_SECRET: 'wrong-secret' });
    check(r.code === 1 && r.out === "::error::CoinDCX refused the key (401). The key is locked to one IP: if the PC's IP changed (open api.ipify.org on it), make a CoinDCX key for the new IP and put it in the two secrets. Or a secret was copied short.", 'wrong secret, no IP: ' + JSON.stringify(r));
    mock.ip = '203.0.113.7';
    check(!r.out.includes(KEY) && !r.out.includes('wrong-secret'), 'the run printed the key');

    // The right one: two pages of rupee futures and one of USDT, the wallets and
    // 90 days of fills a week at a time, saved in one commit.
    const tomorrow = new Date(Date.now() + 29.5 * 3600e3).toISOString().slice(0, 10);
    r = await runImport();
    const want = `Imported ${NEW_ROWS} new rows from CoinDCX · 1 unreadable transaction skipped` + W + F1;
    check(r.code === 0 && r.out === want && r.summary === want, 'import: ' + JSON.stringify(r) + ', expected "' + want + '"');
    check(JSON.stringify(r.puts) === JSON.stringify([`CoinDCX: ${NEW_ROWS} new rows`]), 'commits: ' + JSON.stringify(r.puts));
    check(mock.bad.length === 0 && gh.bad.length === 0, 'requests CoinDCX or GitHub would refuse: ' + mock.bad.concat(gh.bad).join(' | '));
    const isFill = x => x.path.endsWith('/trades');
    const paths = mock.calls.filter(x => !isFill(x)).map(x => [x.path.split('/').pop(), x.p.margin_currency_short_name, x.p.page].filter(v => v != null).join(':'));
    check(paths.join(',') === 'transactions:INR:1,transactions:INR:2,transactions:USDT:1,wallets', 'calls made: ' + paths.join(','));
    // Fill windows: from tomorrow (Indian date) back, 7 days each, every day covered,
    // for both margins, until CoinDCX says the dates are out of its range (30 days here).
    // CoinDCX stops at the start of to_date, so ending at today would miss today's fills.
    const weeks = mc => mock.calls.filter(x => isFill(x) && x.p.margin_currency_short_name[0] === mc).map(x => [x.p.from_date, x.p.to_date, x.p.page]);
    const wk = weeks('INR'), dayMs = d => Date.parse(d + 'T00:00:00Z');
    const covered = wk.length && wk[0][1] === tomorrow && wk.every((w, i) => w[2] === '1' && dayMs(w[1]) - dayMs(w[0]) === 6 * 864e5 && (!i || w[1] === wk[i - 1][0]))
      && JSON.stringify(weeks('USDT')) === JSON.stringify(wk);
    check(covered && wk.length === 6 && dayMs(wk[4][0]) === dayMs(tomorrow) - 30 * 864e5, 'fill windows: ' + JSON.stringify(wk));
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
    // The calculator sizes from that same wallet, not "No balance to size from yet".
    const calcCdx = await page.evaluate(() => { switchTab('calculator'); calcApplyAccount('rep-coindcx-inr'); calcUpdate({ stopLossPercent: 0.75 }); return { cap: calcSettings().capital, note: document.getElementById('quickNote').innerText, margin: document.getElementById('quickMargin').innerText }; });
    check(calcCdx.cap === 8144.78 && !/No balance/.test(calcCdx.note) && calcCdx.margin !== '—', 'calculator ignores the CoinDCX wallet: ' + JSON.stringify(calcCdx));
    // Quick size: ₹150 risk typed in INR follows the header to $ at the book's rate; capital used × leverage = position.
    const qs = await page.evaluate(() => {
      const box = () => ({ risk: calcSettings().quickRisk, label: document.getElementById('quickRiskCur').innerText, margin: document.getElementById('quickMargin').innerText,
        pos: document.getElementById('quickPos').innerText, lev: document.getElementById('quickPosLev').innerText, m: calcRecommend({ capital: calcSettings().capital, riskAmount: Number(calcSettings().quickRisk), stopLossPercent: 0.75, leverage: 5, costPercent: calcSettings().costPercent, takeProfitPercent: 0 }) });
      state.ui.allCur = 'INR'; renderAll(); calcUpdate({ quickRisk: 150, leverage: 5, stopLossPercent: 0.75 });
      const inr = box(), rate = fxRate(acct('rep-coindcx-inr'));
      state.ui.allCur = 'USD'; renderAll();
      const usd = box();
      state.ui.allCur = 'INR'; renderAll();
      return { inr, usd, back: box(), rate };
    });
    const qnear = (a, b) => Math.abs(a - b) < 0.011;
    check(qs.inr.label === '₹' && qs.usd.label === '$' && qnear(qs.usd.risk, 150 / qs.rate) && qnear(qs.back.risk, 150), 'quick risk does not follow ₹/$: ' + JSON.stringify(qs));
    check(qnear(qs.inr.m.positionValue, qs.inr.m.margin * 5) && qs.inr.lev.toLowerCase() === 'at 5×' && qs.inr.pos.startsWith('₹') && qs.usd.pos.startsWith('$') && qs.inr.margin !== qs.inr.pos, 'quick size margin vs position: ' + JSON.stringify(qs));
    await page.evaluate(() => { state.ui.allCur = ''; calcUpdate({ accountId: '', quickRisk: '', leverage: 1 }); });
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
      const pairs = matchSignals('trendline'), p = pairs.find(x => x.signal.id === 'sg-lnk'), q = pairs.find(x => x.signal.id === 'sg-orf'), t = p.trade;
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'vsme', sigFilter: 'orphans' });
      switchTab('signals'); renderAll();
      const text = id => document.getElementById(id).innerText.replace(/\s+/g, ' ');
      return { t: t && [t.rep, t.symbol, t.direction, +t.entry.toFixed(6), +t.exit.toFixed(6), t.qty, t.date, t.time], r: myOutcome(p) && myOutcome(p).r, orf: !!q.trade,
        strip: text('sigEdgeStrip'), vs: text('sigVsMine'), orphans: text('signalsTableBody'),
        refused: [btPrices({ closed: true, carried: false, start: D + ' 10:05:00', end: D + ' 14:00:00' }, [{ at: D + ' 10:05:00', side: 'buy', price: 12, qty: 100 }, { at: D + ' 14:00:00', side: 'sell', price: 12.1, qty: 60 }]),
          btPrices({ closed: true, carried: true, start: D + ' 10:05:00', end: D + ' 14:00:00' }, [{ at: D + ' 10:05:00', side: 'buy', price: 12, qty: 100 }, { at: D + ' 14:00:00', side: 'sell', price: 12.1, qty: 100 }])] };
    }, [D]);
    let v = await sigs();
    check(JSON.stringify(v.t) === JSON.stringify([true, 'LNK/USDT', 'long', 12, 12.1, 100, D, '10:05']) && near(v.r, 991 / 99.3 / 10) && !v.orf, 'alert matched to a CoinDCX trade: ' + JSON.stringify(v));
    check(v.strip.includes('1 taken by you') && /LNK\/USDT LONG .*\+1\.00R \(\+0\.83%\)/.test(v.vs) && !v.orphans.includes('ORF') && JSON.stringify(v.refused) === '[null,null]', 'Signals tab: ' + JSON.stringify(v));
    // Matched trades took their alert's setup on their own (stops too, for journal trades): send that, so the run below starts level.
    // Both LNK alerts paired with it; the zone alert's 12.00 is its entry exactly, the trendline's 12.11 is not.
    check((await page.evaluate(() => reportTrades().find(t => t.symbol === 'LNK/USDT' || /LNK/.test(t.symbol)) || {})).setup === 'ZONE', 'setup from the alert on a CoinDCX trade (the closest price)');
    await sync();

    // Analysis, results by broker and Files say where the rows came from.
    const an = await page.evaluate(() => {
      state.ui.account = 'rep-coindcx-inr'; state.ui.anPeriod = 'all'; switchTab('analysis'); renderAll();
      const o = { check: document.getElementById('btCheck').innerText, title: document.getElementById('btTitle').textContent,
        line: [...document.querySelectorAll('#anBrokers tbody tr')].map(x => x.innerText.replace(/\s+/g, ' ').trim()).find(l => l.startsWith('CoinDCX ')) || '' };
      switchTab('data'); o.files = document.getElementById('btFiles').innerText; switchTab('analysis');
      return o;
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
    // While it fails, the wallet is the last one read, not today's: the header, Trading Books
    // and the card say so (lakky's ₹3,704.85 vs CoinDCX's ₹6,705.82 on 3 Nov, a refused key).
    check(/Last known wallet \(from before the failure/.test(c.status), 'card wallet while failing: ' + c.status);
    bal = await balances();
    check(bal.inr === 8144.78 && bal.cdx.top === bal.want && bal.cdx.tag === 'LAST KNOWN' && /GitHub's import is failing/.test(bal.cdx.title) && /Why: CoinDCX answered 400: Invalid margin\. Journal-computed balance: /.test(bal.cdx.title)
      && (bal.books.match(/· CoinDCX wallet, last known \(import failing\)/g) || []).length === 2, 'wallet while the import fails: ' + JSON.stringify(bal));
    check(await page.evaluate(() => document.getElementById('topBalLive').className.includes('amber')), 'last known wallet tag is not amber');
    // Working again clears it.
    mock.mode = 'ok';
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["CoinDCX import working again"]' && !('note' in stored().backtest.files.find(f => f.id === 'cdx-api')), 'recovered: ' + JSON.stringify(r));
    await sync();
    c = await card();
    check(c.badge === 'Importing' && !c.bad && / Wallet: ₹8,144\.78 INR futures/.test(c.status), 'card after recovering: ' + JSON.stringify(c));
    bal = await balances();
    check(bal.cdx.tag === 'WALLET' && !/failing/.test(bal.cdx.title) && !/import failing/.test(bal.books) && (bal.books.match(/· CoinDCX wallet/g) || []).length === 2, 'wallet after recovering: ' + JSON.stringify(bal));
    check(await page.evaluate(() => { state.ui.account = 'rep-coindcx-inr'; renderAll(); const on = document.getElementById('topBalLive').className.includes('emerald'); state.ui.account = 'all'; renderAll(); return on; }), 'wallet tag is not green again');

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
    // CoinDCX not answering is said plainly (no IP read: the key wasn't refused).
    mock.mode = 'blocked';
    ips = mock.ipReads;
    r = await runImport();
    check(r.code === 1 && /^::error::Could not reach CoinDCX \(.+\)\. If this keeps happening, check the PC's internet\.$/.test(r.out) && mock.ipReads === ips, 'blocked: ' + JSON.stringify(r) + ', IP read ' + (mock.ipReads - ips) + ' times');
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

    // CoinDCX turning the PC away stops at the first call and says so, with its IP,
    // without the page's HTML. The reason is long: the journal keeps 300
    // characters of it, and so does the file, so neither keeps rewriting it.
    mock.mode = 'forbidden';
    r = await runImport();
    const pre = 'CoinDCX refused the request (403, PC IP 203.0.113.7: ';
    const said = (pre + '403 Forbidden Access denied ' + 'Request blocked. '.repeat(12)).slice(0, pre.length + 160) + "). The key is locked to one IP: if it isn't 203.0.113.7, make a CoinDCX key for 203.0.113.7 and put it in the two secrets.";
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
    // Its row opens the trade in the Trade Inspector, like any trade. Fills changing alone
    // (no new rows) are seen too, as the trades are worked out again.
    const orf = await page.evaluate(() => {
      const row = [...document.querySelectorAll('#signalsTableBody tr')].find(tr => tr.innerText.includes('ORF/USDT'));
      row.click();
      const out = { inspector: !document.getElementById('tradeInspectorDrawer').classList.contains('translate-x-full') && activeInspectTrade.symbol === 'ORF/USDT', side: document.getElementById('inspSide').innerText };
      closeInspector();
      const f = state.backtest.files.find(x => x.id === 'cdx-api'), all = f.fills, px = () => !!reportTrades().find(t => t.symbol === 'ORF/USDT').px;
      f.fills = all.filter(x => !(x.sym === 'B-ORF_USDT' && x.side === 'buy'));
      out.without = px();
      f.fills = all;
      out.with = px();
      state.ui.account = 'all'; renderAll();
      return out;
    });
    check(JSON.stringify(orf) === '{"inspector":true,"side":"' + orf.side + '","without":false,"with":true}' && /BUY|SHORT/.test(orf.side), 'ORF row and its prices: ' + JSON.stringify(orf));
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
      const d = todayDay(), old = '2024-12-02';
      // An old losing trade (before this month) and this month's winner: opened 10:05, closed 11:40.
      const row = (id, at, kind, gross, fee) => ({ id, file: 'cdx-api', sym: 'B-ETH_USDT', at, kind, type: kind, gross, settle: 0, fee, net: gross - fee, cur: 'INR' });
      state.backtest = cleanBacktest({ files: [{ id: 'cdx-api', name: 'CoinDCX API', broker: 'CoinDCX', importedAt: new Date().toISOString(), cur: 'INR', wallet: { at: new Date().toISOString(), INR: 5000 } }],
        rows: [row('o1', old + ' 09:00:00', 'order', 0, 10), row('c1', old + ' 12:00:00', 'order', -3000, 10),
          row('o2', d + ' 10:05:00', 'order', 0, 5), row('c2', d + ' 11:40:00', 'order', 505, 5)] });
      ensureReportBooks(state);
      Object.assign(state.ui, { account: 'rep-coindcx-inr', allCur: 'INR', month: 'current', kpiGreenDays: false, dashSec: 'habits' });
      switchTab('dashboard'); renderAll();
      const ret = [...document.querySelectorAll('#kpiRibbon > div')].find(c => /RETURN/i.test(c.innerText)).innerText.replace(/\s+/g, ' ');
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
    check(/RETURN \+10\.99% \+₹495\.00 on ₹4,505\.00/i.test(v.ret), 'CoinDCX return from its wallet: ' + v.ret);
    check(/^Net P&L:? \+₹495\.00/.test(v.headLine) && v.headCls.includes('emerald'), 'month headline: ' + v.headLine + ' ' + v.headCls);
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

// CoinDCX trades in the size and mistake analysis. A report has no prices, but
// CoinDCX's fee is a fixed share of each order's value, so the fees give each
// trade's side and size. The fees here are built from sizes picked in this file;
// the app has to find those sizes again, and the balance before each trade is
// worked out here from the wallet, apart from the app's own sums.
async function cdxSizeRun(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol;
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.dismiss());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const TAKER = 0.0005 * 1.18, MAKER = 0.0002 * 1.18, WALLET = 20000;
  // [id, at, gross, fee]: a long (taker in, maker out), a short closed in two
  // parts, a trade from the old 0.1% rate, one with a fee-less close (size
  // unknown), and one whose prices come from fills only.
  const T = [
    { id: 'L', side: 'long', open: 10000, rows: [['L1', '2026-09-10 10:00:00', 0, 10000 * TAKER], ['L2', '2026-09-10 11:00:00', 150, 10150 * MAKER]] },
    { id: 'S', side: 'short', open: 20000, rows: [['S1', '2026-09-11 09:00:00', 0, 20000 * MAKER], ['S2', '2026-09-11 09:30:00', 100, 9900 * TAKER], ['S3', '2026-09-11 09:40:00', 100, 9900 * TAKER]] },
    { id: 'O', side: 'long', open: 5000, rows: [['O1', '2024-12-10 10:00:00', 0, 5000 * 0.001], ['O2', '2024-12-10 12:00:00', -100, 4900 * 0.001]] },
    { id: 'U', side: '', open: null, rows: [['U1', '2026-09-12 10:00:00', 0, 3], ['U2', '2026-09-12 10:05:00', -40, 0]] },
  ];
  const net = t => t.rows.reduce((s, r) => s + r[2] - r[3], 0);
  // By close: O, L, S, U. Balance before = wallet - every trade's net + the nets before it.
  const order = ['O', 'L', 'S', 'U'].map(id => T.find(t => t.id === id));
  const total = order.reduce((s, t) => s + net(t), 0);
  let prior = 0;
  const want = order.map(t => { const before = WALLET - total + prior; prior += net(t); return { id: t.id, side: t.side, before, x: t.open != null ? t.open / before : null }; });
  try {
    const v = await page.evaluate(({ T, WALLET }) => {
      const rows = [];
      T.forEach(t => t.rows.forEach(([id, at, gross, fee]) => rows.push({ id, file: 'cdx-api', sym: 'B-' + t.id + 'X_USDT', at, kind: 'order', type: 'By Order', gross, settle: 0, fee, net: gross - fee, cur: 'INR' })));
      state.backtest = cleanBacktest({ files: [{ id: 'cdx-api', name: 'CoinDCX API', broker: 'CoinDCX', importedAt: new Date().toISOString(), cur: 'INR', wallet: { at: new Date().toISOString(), INR: WALLET } }], rows });
      ensureReportBooks(state);
      const book = state.accounts.find(a => a.id === 'rep-coindcx-inr');
      Object.assign(book, { maxRiskPct: 1, maxNotionalX: 1, maxTradesPerDay: 0, dailyLossLimit: 0 });
      const byId = {}; reportTrades().forEach(t => { byId[t.symbol.split('X/')[0]] = t; });
      const sizes = {}; Object.keys(byId).forEach(k => { const z = byId[k].size; sizes[k] = z && { d: z.direction, open: z.open, from: z.from }; });
      // Straight from btSize: two parts that agree in every way can't tell a side.
      const flat = btSize({ closed: true, carried: false, gross: 0, legs: [{ kind: 'order', gross: 0, settle: 0, fee: 1 }, { kind: 'order', gross: 0.0000001, settle: 0, fee: 1 }] }, null, 'rep-coindcx-inr');
      const fills = btSize({ closed: true, carried: false, gross: 5, legs: [{ kind: 'order', gross: 0, settle: 0, fee: 0 }, { kind: 'order', gross: 5, settle: 0, fee: 0 }] }, { direction: 'short', entry: 2, exit: 1.9, qty: 50 }, 'rep-coindcx-inr');
      // The CoinDCX book in Analysis: Overview is the report; Size & mistakes is the journal analysis on its trades.
      Object.assign(state.ui, { account: 'rep-coindcx-inr', allCur: 'INR', anPeriod: 'all', anSec: 'report', btPair: 'all' });
      switchTab('analysis'); renderAnalysis();
      const shown = id => !document.getElementById(id).classList.contains('hidden');
      const sec = k => !document.querySelector('[data-ansec="' + k + '"]').classList.contains('hidden');
      const overview = { live: shown('anLive'), report: shown('anReport'), repSec: sec('report'), ovSec: sec('overview') };
      setAnSec('trades');
      const checks = { live: shown('anLive'), report: shown('anReport'), bar: document.getElementById('anSecBar').innerText };
      anVisible = 99; renderAnalysis();
      const table = [...document.querySelectorAll('#anBody tr')].map(tr => [...tr.children].map(td => td.innerText.trim()));
      const rows2 = analyzeTrades(statScoped()).map(x => ({ id: x.t.symbol.split('X/')[0], side: tradeSide(x.t), before: x.before, x: x.xBal, flags: x.flags }));
      const strip = [...document.querySelectorAll('#anStrip > div')].map(d => d.firstElementChild.textContent + ' ' + d.querySelector('.mono-num').textContent).join(' | ');
      // The pair picked in the report narrows the analysis too.
      state.ui.btPair = 'B-LX_USDT'; renderAnalysis();
      const onePair = document.querySelectorAll('#anBody tr').length;
      state.ui.btPair = 'all';
      // A journal book still shows only the journal analysis.
      state.ui.account = state.accounts.find(a => !a.reportBroker && a.market === 'crypto').id; renderAnalysis();
      const journal = { live: shown('anLive'), report: shown('anReport') };
      // No fills yet (CoinDCX lists them a day late): Signals still holds the trade
      // against the alerts, on the side its fees give, dated when it opened.
      const sigT = {}; signalTrades().filter(t => t.rep).forEach(t => { sigT[t.symbol.split('X/')[0]] = [t.direction, t.date, t.time]; });
      return { sizes, flat, fills, overview, checks, table, rows: rows2, strip, onePair, journal, sigT, k: fxk(book, 'USD') };
    }, { T, WALLET });
    for (const t of T) {
      const got = v.sizes[t.id];
      if (t.open == null) check(got == null, t.id + ': size should be unknown, got ' + JSON.stringify(got));
      else check(got && got.d === t.side && near(got.open, t.open) && got.from === 'fees', t.id + ': size from fees ' + JSON.stringify(got) + ' want ' + t.side + ' ' + t.open);
    }
    check(v.flat === null, 'two alike fees should not give a side: ' + JSON.stringify(v.flat));
    check(v.fills && v.fills.direction === 'short' && v.fills.from === 'fills' && near(v.fills.open, 100 / v.k), 'size from fills when fees are missing: ' + JSON.stringify(v.fills));
    check(v.overview.report && v.overview.repSec && !v.overview.ovSec, 'CoinDCX opens on its report section: ' + JSON.stringify(v.overview));
    check(v.checks.report && v.checks.live && /^Report/.test(v.checks.bar.trim()) && /Overview/.test(v.checks.bar), 'the checks run on the report book too: ' + JSON.stringify(v.checks));
    check(v.journal.live && !v.journal.report, 'journal book in Analysis: ' + JSON.stringify(v.journal));
    check(v.rows.length === 4, 'report trades analysed: ' + v.rows.length);
    for (const w of want) {
      const r = v.rows.find(x => x.id === w.id);
      if (!r) { check(false, w.id + ' not analysed'); continue; }
      check(r.side === w.side && near(r.before, w.before) && (w.x == null ? r.x == null : near(r.x, w.x, 1e-6)), w.id + ': ' + JSON.stringify(r) + ' want ' + JSON.stringify(w));
      // maxNotionalX 1: every sized trade is bigger than the balance only if x > 1.
      check((r.flags.indexOf('oversize') !== -1) === (w.x != null && w.x > 1), w.id + ' oversize flag: ' + r.flags.join());
    }
    const line = id => v.table.find(r => r[1] === id + 'X/USDT') || [];
    check(line('L')[2] === 'LONG' && line('S')[2] === 'SHORT' && line('U')[2] === 'REPORT', 'side column: ' + JSON.stringify(v.table.map(r => r.slice(1, 3))));
    check(line('L')[4] === '₹10,000.00' && line('U')[4] === '—' && line('U')[5] === '—', 'position column: ' + JSON.stringify(v.table.map(r => r.slice(1, 6))));
    check(/(^| \| )TRADES CHECKED 4 \|/i.test(v.strip), 'headline: ' + v.strip);
    check(v.onePair === 1, 'pair filter in the analysis: ' + v.onePair + ' rows');
    check(JSON.stringify(v.sigT) === JSON.stringify({ O: ['long', '2024-12-10', '10:00'], L: ['long', '2026-09-10', '10:00'], S: ['short', '2026-09-11', '09:00'] }), 'report trades on Signals, side from fees: ' + JSON.stringify(v.sigT));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'CoinDCX size and mistakes: side and size from fees, balance from wallet';
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
    const rows = () => page.evaluate(() => [...document.querySelectorAll('#inspChecklist button:not([data-setup])')].map(b => b.innerText.replace(/\s+/g, ' ')));
    const before = await rows();
    await page.click('#inspChecklist button:not([data-setup]):nth-of-type(2)'); // Risk within limit: missed -> kept
    await page.click('#inspChecklist button:not([data-setup]):nth-of-type(1)'); // Traded a planned setup: kept -> missed
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

// Withdrawals: money taken out is logged from the goal card, counts toward a
// "Money withdrawn" target, lowers the book's worked-out balance, syncs, and
// can be removed again.
async function tradingDayRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  const t = (id, date, time, exit) => ({ id, accountId: 'acc_cry', date, exitDate: date, time, exitTime: time, symbol: 'ETHUSD', direction: 'long', entry: 100, exit, stop: 99, qty: 1, fees: 0, rules: [], updatedAt: seed.savedAt });
  const journal = Object.assign({}, seed, { trades: [
    t('late1', '2026-10-11', '22:00', 99), t('late2', '2026-10-12', '01:30', 98), t('next', '2026-10-12', '05:30', 101), t('sep', '2026-10-01', '01:00', 102),
  ], goals: [] });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(journal));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  try {
    await page.clock.setFixedTime(new Date('2026-10-12T05:15:00+05:30'));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const look = () => page.evaluate(() => {
      const day = id => dayOf(state.trades.find(x => x.id === id));
      const days = tradingDays(statScoped()).filter(d => d.accountId === 'acc_cry').map(d => d.date + ':' + d.count + (d.breached ? '!' : '')).join(',');
      return { today: todayDay(), month: curMonthKey(), late2: day('late2'), next: day('next'), sep: day('sep'), days, stored: state.trades.find(x => x.id === 'late2').date + ' ' + state.trades.find(x => x.id === 'late2').time,
        lim: dailyLimitState('USD', 'acc_cry').hit, inMonth: monthFilter(scoped()).filter(x => x.accountId === 'acc_cry').length, goalN: goalProgress({ period: 'day', accountId: 'acc_cry' }).n };
    });
    let v = await look();
    // 05:15: still the 11th. The 01:30 trade joins the 22:00 one; together they break the $2.50 limit.
    check(v.today === '2026-10-11' && v.month === '2026-10' && v.late2 === '2026-10-11' && v.next === '2026-10-12' && v.sep === '2026-09-30' && v.stored === '2026-10-12 01:30', '05:30 day: ' + JSON.stringify(v));
    check(v.days === '2026-09-30:1,2026-10-11:2!,2026-10-12:1' && v.lim === true && v.inMonth === 3 && v.goalN === 2, '05:30 day buckets: ' + JSON.stringify(v));
    // A CoinDCX trade closed at 01:10 counts for the day before too, in its report and on the dashboard.
    const rep = await page.evaluate(() => {
      const row = (id, at, gross, fee) => ({ id, file: 'cdx-api', sym: 'B-ETH_USDT', at, kind: 'order', type: 'order', gross, settle: 0, fee, net: gross - fee, cur: 'INR' });
      state.backtest = cleanBacktest({ files: [{ id: 'cdx-api', name: 'CoinDCX API', broker: 'CoinDCX', importedAt: new Date().toISOString(), cur: 'INR' }],
        rows: [row('o1', '2026-10-11 23:50:00', 0, 5), row('c1', '2026-10-12 01:10:00', 105, 5)] });
      ensureReportBooks(state);
      const r = reportTrades()[0], b = btTrades(btState().rows)[0];
      return { date: r.date, time: r.time, day: dayOf(r), btDay: b.day };
    });
    check(rep.date === '2026-10-12' && rep.time === '01:10' && rep.day === '2026-10-11' && rep.btDay === '2026-10-11', 'report trade day: ' + JSON.stringify(rep));
    await page.evaluate(() => { state.backtest = { files: [], rows: [] }; ensureReportBooks(state); });
    // 05:45: the 12th has begun.
    await page.clock.setFixedTime(new Date('2026-10-12T05:45:00+05:30'));
    v = await look();
    check(v.today === '2026-10-12' && v.lim === false && v.goalN === 1, 'after 05:30: ' + JSON.stringify(v));
    // The setting: midnight puts every trade back on its calendar day, and survives a reload.
    await page.evaluate(() => openSettings('books'));
    check(await page.inputValue('#dayCutoffSel') === '330', 'setting does not show 05:30: ' + await page.inputValue('#dayCutoffSel'));
    await page.selectOption('#dayCutoffSel', '0');
    v = await look();
    check(v.late2 === '2026-10-12' && v.sep === '2026-10-01' && v.days === '2026-10-01:1,2026-10-11:1,2026-10-12:2', 'midnight cutoff: ' + JSON.stringify(v));
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(300);
    check(await page.evaluate(() => dayCutoff()) === 0, 'cutoff not kept after reload');
    check(await page.evaluate(() => sanitizeState({ accounts: [], trades: [], ui: { dayCutoff: 99, dayCutoffMin: 999 } }).ui.dayCutoffMin === undefined && dayCutoff() === 0), 'a bad cutoff survived the clean-up');
    // An hour saved before minutes were kept: the old 2 AM default moves to 05:30, any other hour stays.
    const old = await page.evaluate(() => { const keep = Object.assign({}, state.ui); delete state.ui.dayCutoffMin; state.ui.dayCutoff = 2; const a = dayCutoff(); state.ui.dayCutoff = 4; const b = dayCutoff(); state.ui = keep; return [a, b]; });
    check(old[0] === 330 && old[1] === 240, 'old hour setting: ' + JSON.stringify(old));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'trading day rolls over at 05:30 (00:00 UTC)';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Goal planner: target, days and trades a day in; per day, per trade and trades in all out.
async function goalPlannerRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  for (const vp of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(vp.width + 'px page error: ' + (e.stack || e.message)));
    // A goal needs trading days left: near a month's end there are none, and before the
    // day's cutoff on the 1st the trading day is still last month's. Run as of the 15th, noon.
    { const d = new Date(); d.setDate(15); d.setHours(12, 0, 0, 0); await page.clock.setFixedTime(d); }
    try {
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      await page.evaluate(() => { switchTab('calculator'); state.ui.allCur = 'INR'; renderAll(); switchTab('calculator'); calcUpdate({ view: 'planner', accountId: 'acc_nse' }); });
      await page.selectOption('#gpGoal', 'custom');
      await page.fill('#gpTarget', '600'); await page.fill('#gpDays', '2'); await page.fill('#gpTrades', '3');
      const out = await page.innerText('#gpPlan');
      check(/PER DAY[\s\S]*₹300\.00/i.test(out) && /PER TRADE[\s\S]*₹100\.00/i.test(out) && /TRADES IN ALL\s*6\b/i.test(out) && /6 trades × ₹100\.00 = ₹600\.00/.test(out), vp.width + 'px 600 in 2 days at 3 a day: ' + JSON.stringify(out));
      // Uneven numbers: 1000 over 3 days at 2 a day.
      await page.fill('#gpTarget', '1000'); await page.fill('#gpDays', '3'); await page.fill('#gpTrades', '2');
      const out2 = await page.innerText('#gpPlan');
      check(/₹333\.33/.test(out2) && /₹166\.67/.test(out2) && /TRADES IN ALL\s*6\b/i.test(out2), vp.width + 'px 1000 in 3 days at 2 a day: ' + JSON.stringify(out2));
      // Target as % of capital: 10% of the balance, and switching back converts it to the amount.
      await page.click('#gpUnitPct');
      await page.fill('#gpTarget', '10');
      const pc = await page.evaluate(() => { const B = gpContext().balance; return { B, want: +(B * 0.1).toFixed(2), plan: document.getElementById('gpPlan').innerText, hint: document.getElementById('gpTargetHint').innerText, money: calcMoney(+(B * 0.1).toFixed(2), viewCur()) }; });
      check(pc.B > 0 && pc.plan.includes(pc.money) && pc.hint.includes(pc.money) && pc.hint.includes('10% of'), vp.width + 'px 10% of capital: ' + JSON.stringify(pc));
      await page.click('#gpUnitAmt');
      check(+(await page.inputValue('#gpTarget')) === pc.want && (await page.innerText('#gpTargetHint')).includes('10% of your'), vp.width + 'px % back to amount: ' + await page.inputValue('#gpTarget'));
      await page.fill('#gpTarget', '1000');
      // Advanced stays folded (and empty) until opened, then shows the edge check.
      check(await page.evaluate(() => !document.getElementById('gpAdvanced').open && document.getElementById('gpAdvOut').innerHTML === ''), vp.width + 'px advanced not folded');
      await page.click('#gpAdvanced summary');
      await page.waitForTimeout(100);
      const adv = await page.innerText('#gpAdvOut');
      check(/Position needed per trade/i.test(adv) && /₹166\.67/.test(adv), vp.width + 'px advanced plan: ' + adv.slice(0, 200));
      // Picking a goal fills in what is left and the trading days; typing a target goes back to your own.
      await page.selectOption('#gpGoal', 'g1');
      const g = await page.evaluate(() => { const gl = gpMoneyGoals().find(x => x.id === 'g1'); return { need: +Math.max(0, gl.target - goalProgress(gl).net).toFixed(2), days: goalDaysLeft(gl), t: document.getElementById('gpTarget').value, d: document.getElementById('gpDays').value }; });
      check(+g.t === g.need && +g.d === g.days, vp.width + 'px goal fill: ' + JSON.stringify(g));
      // The planner follows the header's ₹ / $ (the calculator has no switch of its own).
      check(await page.evaluate(() => !document.getElementById('calcCurrencySeg')), vp.width + 'px calculator still has its own currency switch');
      for (const c of ['USD', 'INR']) {
        await page.evaluate(() => { const g1 = state.goals.find(x => x.id === 'g1'); g1.target = g1.targets.net_pnl = 100000; calcUpdate({ accountId: '' }); gpSet('gpGoalId', 'g1'); });
        // The header's own button, clicked while the calculator is open.
        await page.click('#accountsBar button[data-cur="' + c + '"]');
        const mix = await page.evaluate(c => { const g0 = state.goals.find(x => x.id === 'g1'); return { want: +Math.max(0, goalTargetIn(g0, 'net_pnl', c) - goalProgress(g0, c).net).toFixed(2), t: +document.getElementById('gpTarget').value, sym: document.getElementById('gpCur').innerText, calc: calcSettings().currency, plan: document.getElementById('gpOut').innerText }; }, c);
        const sym = c === 'INR' ? '₹' : '$', other = c === 'INR' ? '$' : '₹';
        check(mix.want > 0 && mix.t === mix.want && mix.sym === sym && mix.calc === c && mix.plan.includes(sym) && !mix.plan.includes(other), vp.width + 'px header ' + c + ': ' + JSON.stringify(mix));
      }
      // A linked book's balance converts too: the ₹1,00,000 book in dollars.
      const conv = await page.evaluate(() => { state.ui.allCur = 'USD'; renderAll(); switchTab('calculator'); calcApplyAccount('acc_nse'); const s = calcSettings(); return { cur: s.currency, cap: s.capital, want: +(calcAccountBalance(acct('acc_nse')) / fxRate(acct('acc_nse'))).toFixed(2) }; });
      check(conv.cur === 'USD' && conv.cap === conv.want, vp.width + 'px linked book not converted: ' + JSON.stringify(conv));
      await page.evaluate(() => { state.ui.allCur = 'INR'; renderAll(); switchTab('calculator'); calcUpdate({ accountId: '' }); });
      await page.fill('#gpTarget', '900');
      check(await page.inputValue('#gpGoal') === 'custom' && await page.inputValue('#gpTarget') === '900', vp.width + 'px typing a target did not switch to own target');
      // Kept after a reload, advanced still open.
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
      await page.evaluate(() => switchTab('calculator'));
      check(await page.inputValue('#gpTarget') === '900' && await page.evaluate(() => document.getElementById('gpAdvanced').open), vp.width + 'px not kept after reload');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (vp.width > 640) for (const w of [1366, 1024]) {
        await page.setViewportSize({ width: w, height: 900 });
        const hh = await page.evaluate(() => document.querySelector('header').offsetHeight);
        check(hh < 80, w + 'px header not on one line: ' + hh);
      }
      check(wide <= 1, vp.width + 'px page scrolls sideways by ' + wide);
    } catch (e) {
      errs.push(vp.width + 'px threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
    }
    await ctx.close();
  }
  const label = 'goal planner: per day, per trade, trades in all';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

async function withdrawRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const before = await page.evaluate(() => {
      state.goals.push({ id: 'gw', title: 'Bank it', target: 1000, metric: 'withdraw', targets: { withdraw: 1000, net_pnl: 50 }, period: 'month', accountId: 'acc_nse' });
      state.ui.goalIdx = state.goals.length - 1; state.ui.account = 'acc_nse'; save(); switchTab('dashboard'); renderAll();
      return { bal: bookBalance(acct('acc_nse')), start: balanceAtStart(acct('acc_nse'), todayDay()) };
    });
    await page.click('button:has-text("Withdraw")');
    await page.waitForSelector('#modalSheet:not(.hidden)');
    await page.selectOption('#wdAcc', 'acc_nse');
    await page.fill('#wdAmt', '400');
    await page.fill('#wdNote', 'payout');
    await page.click('#modalSheetSaveBtn');
    const after = await page.evaluate(() => {
      const g = state.goals.find(x => x.id === 'gw'); state.ui.goalFocus = { gw: 'withdraw' }; updateGoalDisplays();
      const sp = syncPayload(state), back = sanitizeState(JSON.parse(JSON.stringify(sp)));
      return { bal: bookBalance(acct('acc_nse')), start: balanceAtStart(acct('acc_nse'), todayDay()), got: goalWithdrawn(g, 'INR'), card: document.getElementById('goalCurrent').innerText,
        chip: document.getElementById('goalChips').innerText.replace(/\s+/g, ' '), synced: (sp.withdrawals || []).length, back: back.withdrawals.length, note: (state.withdrawals[0] || {}).note };
    });
    check(Math.abs(after.bal - (before.bal - 400)) < 1e-6 && Math.abs(after.start - before.start) < 1e-6 && after.got === 400 && after.card.includes('400') && /withdrawn/i.test(after.chip)
      && after.synced === 1 && after.back === 1 && after.note === 'payout', 'withdrawal: ' + JSON.stringify({ before, after }));
    // A withdrawal deleted here stays deleted when an older copy comes back from GitHub.
    await page.click('button:has-text("Withdraw")');
    await page.waitForSelector('#modalSheet:not(.hidden)');
    const old = await page.evaluate(() => JSON.parse(JSON.stringify(state.withdrawals)));
    await page.click('#wdList [data-wdrm]');
    await page.waitForTimeout(200);
    const gone = await page.evaluate(old => { closeModalSheet(); const m = mergeState(JSON.parse(JSON.stringify(state)), { accounts: state.accounts, trades: [], withdrawals: old });
      return { left: state.withdrawals.length, merged: m.withdrawals.length, bal: bookBalance(acct('acc_nse')) }; }, old);
    check(gone.left === 0 && gone.merged === 0 && Math.abs(gone.bal - before.bal) < 1e-6, 'removing a withdrawal: ' + JSON.stringify(gone));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'withdrawals: logged, counted toward the goal, in the balance, synced, removable';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Delta's wallet figure comes from the PC's import (journal.json `deltaBalance`),
// never from a key in the browser: every device shows it, the header says how
// old it is, an older figure never replaces a newer one. A Delta key an older
// build saved can be copied into GitHub's secrets, and goes once the PC import works.
async function deltaShareRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const deltaAsks = [];
  const open = async (vp, s) => {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.route(url => !url.href.startsWith(base), r => { if (/delta\.exchange\/v2\/(wallet|fills)/.test(r.request().url())) deltaAsks.push(r.request().url()); return r.abort(); });
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(s || seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
    page.on('dialog', d => d.accept());
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    return { ctx, page };
  };
  const phone = await open({ width: 390, height: 844 });
  try {
    const at = await phone.page.evaluate(() => Date.now());
    const p = await phone.page.evaluate(at => Object.assign(syncPayload(state), { deltaBalance: { value: 0.01, field: 'net equity', at: at - 20 * 60e3 } }), at);
    const got = await phone.page.evaluate(p => {
      const before = bookBalance(acct(deltaAccountId()));
      state = mergeState(state, p); adoptSyncedBalance(); save();
      state.ui.account = deltaAccountId(); renderAll(); applyLiveBalance();
      const tag = document.getElementById('topBalLive');
      // An older figure from GitHub never replaces the newer one held here.
      const stale = mergeState(JSON.parse(JSON.stringify(state)), Object.assign({}, p, { deltaBalance: { value: 33.23, field: 'net equity', at: p.deltaBalance.at - 3600e3 } }));
      return { before, after: bookBalance(acct(deltaAccountId())), top: document.getElementById('topBalVal').innerText, tag: tag.classList.contains('hidden') ? '' : tag.innerText,
        title: tag.title, stale: stale.delta.liveBalance.value, key: !!(state.delta && state.delta.key) };
    }, p);
    check(got.after === 0.01 && got.before !== 0.01 && got.top.includes('0.01') && got.tag === 'WALLET' && /by your PC's import/.test(got.title) && got.stale === 0.01 && !got.key,
      'phone after sync: ' + JSON.stringify(got));
    // Three hours with nothing newer (PC off): still shown, marked last known.
    const old = await phone.page.evaluate(() => { liveDeltaBalance = Object.assign({}, liveDeltaBalance, { at: Date.now() - 3 * 3600e3 }); applyLiveBalance(); const t = document.getElementById('topBalLive'); return { tag: t.innerText, title: t.title }; });
    check(old.tag === 'LAST KNOWN' && /is the PC on\?/.test(old.title), 'old figure: ' + JSON.stringify(old));
    // The phone keeps it after a reload.
    await phone.page.reload({ waitUntil: 'load' }); await phone.page.waitForTimeout(300);
    const kept = await phone.page.evaluate(() => bookBalance(acct(deltaAccountId())));
    check(kept === 0.01, 'phone after reload: ' + kept);

    // A PC with a key from an older build, the PC import not set up yet: no key boxes,
    // the key is never used here, and the steps offer it for copying into the secrets.
    const sync = { token: 'gh-token', repo: 'victus/sync', branch: 'main', auto: false, lastAt: '', lastSha: '' };
    const pc = await open({ width: 1366, height: 900 }, Object.assign({}, seed, { sync, delta: { key: 'dk-OLD', secret: 'ds-OLD', lastAt: '2026-10-26T10:00:00Z', lastFillTime: 5, liveBalance: { value: 0.02, field: 'net equity', at: Date.now() - 3600e3 } } }));
    await pc.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
    await pc.page.waitForTimeout(2500);
    const v = await pc.page.evaluate(() => { openSettings('connect'); renderDataView(); return {
      boxes: !!document.getElementById('deltaKeyInput') || !!document.getElementById('deltaSecretInput') || /Test & Connect|Import Full History/.test(document.body.innerText),
      badge: document.getElementById('deltaStatusBadge').innerText, steps: document.getElementById('dxPcSteps').innerText, key: state.delta.key,
      inSync: JSON.stringify(syncPayload(state)).includes('dk-OLD') || JSON.stringify(syncPayload(state)).includes('ds-OLD'), live: liveDeltaBalance && liveDeltaBalance.value }; });
    check(!v.boxes && v.badge === 'Not set up' && /Saved on this device:\s*Copy key\s*Copy secret/.test(v.steps) && v.key === 'dk-OLD' && !v.inSync && v.live === 0.02, 'old key, PC not set up: ' + JSON.stringify(v));
    check(!deltaAsks.length, 'the browser still asked Delta with a key: ' + deltaAsks.join(' '));
    await pc.page.click('#dxOldKey button:has-text("Copy secret")');
    await pc.page.waitForTimeout(200);
    check((await pc.page.evaluate(() => navigator.clipboard.readText())) === 'ds-OLD', 'Copy secret did not copy the secret');
    await pc.page.click('#dxOldKey button:has-text("Copy key")');
    await pc.page.waitForTimeout(200);
    check((await pc.page.evaluate(() => navigator.clipboard.readText())) === 'dk-OLD', 'Copy key did not copy the key');
    // A failed PC run (IP refused) keeps it; the first good one deletes it from this device.
    let k = await pc.page.evaluate(() => { state.deltaImport = { lastFillTime: 0, openPositions: {}, note: 'Delta refused the IP', updatedAt: new Date().toISOString() }; renderDataView(); return state.delta.key || ''; });
    check(k === 'dk-OLD', 'a failed PC run deleted the key');
    k = await pc.page.evaluate(() => { state.deltaImport = { lastFillTime: 9, openPositions: {}, updatedAt: new Date().toISOString() }; renderDataView();
      return { key: state.delta.key || '', sec: state.delta.secret || '', stored: localStorage.getItem('tapeAndTarget.v2').includes('dk-OLD'), live: state.delta.liveBalance && state.delta.liveBalance.value, steps: document.getElementById('dxPcSteps').innerText, badge: document.getElementById('deltaStatusBadge').innerText }; });
    check(!k.key && !k.sec && !k.stored && k.live === 0.02 && k.steps === '' && k.badge === 'Importing', 'PC import works, old key kept: ' + JSON.stringify(k));
    await pc.ctx.close();
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await phone.ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Delta from the PC only: balance on every device, no key boxes, old key copied then deleted');
  errs.forEach(e => { console.log('     ' + e); failures.push('delta share: ' + e); });
}

// A device whose alerts were never loaded by hand still gets them: the journal
// reads the scanner's files itself on opening, so a trade taken off a fresh
// alert matches it. A second look at Signals inside 15 minutes reads nothing.
async function alertRefreshRun(seed) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  // Noon IST two days ago, so the trade 20 min later never crosses midnight (a run near midnight IST failed).
  const at = Math.floor((Date.now() + 5.5 * 3600e3) / 864e5) * 864e5 - 5.5 * 3600e3 + 12 * 3600e3 - 2 * 864e5, ist = new Date(at + 5.5 * 3600e3).toISOString();
  const tradeTime = new Date(at + 5.5 * 3600e3 + 20 * 60e3).toISOString();
  const line = JSON.stringify({ delivered_at_utc: new Date(at).toISOString(), symbol: 'SOLUSDT', exchange: 'bitunix', timeframe: '4h', side: 'long', zone_type: 'demand',
    alert_price: 150.2, level: 149, zone_bottom: 149, zone_top: 150, body_entry: 150, planned_entry: 150, stop_price: 148.5, score: 8,
    message: '**SOL | BUY | 4H**\nPrice 150.20\nEntry 150 · SL 148.5', trade_id: 'smoke-sol-1' });
  let hits = 0;
  await ctx.route(url => !url.href.startsWith(base), async r => {
    const u = r.request().url();
    if (!u.includes('/scanner-runtime-state/')) return r.abort();
    hits++;
    const f = u.split('/').pop().split('?')[0];
    return r.fulfill({ status: 200, body: f === 'crypto_alert_records.jsonl' ? line + '\n' : f.endsWith('.json') ? '{}' : '' });
  });
  const trade = { id: 'trSol', accountId: 'acc_cry', date: tradeTime.slice(0, 10), exitDate: tradeTime.slice(0, 10), time: tradeTime.slice(11, 16), exitTime: tradeTime.slice(11, 16),
    symbol: 'SOLUSD', direction: 'long', entry: 150, exit: 151.5, stop: 148.5, qty: 1, fees: 0, leverage: 10, setup: '', rules: [], notes: '', updatedAt: new Date().toISOString() };
  const seeded = Object.assign({}, seed, { trades: seed.trades.concat([trade]) });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => (state.signals || []).length > 0, null, { timeout: 8000 });
    const got = await page.evaluate(() => { const pr = matchSignals('zone').find(x => x.signal.symbol && /SOL/.test(x.signal.symbol)); return { n: state.signals.length, date: pr && pr.signal.date, time: pr && pr.signal.time, trade: pr && pr.trade && pr.trade.id }; });
    check(got.n === 1, 'alerts loaded on opening: ' + got.n);
    check(got.date === ist.slice(0, 10) && got.time === ist.slice(11, 16), 'alert date/time not in IST: ' + JSON.stringify(got) + ' want ' + ist.slice(0, 16));
    check(got.trade === 'trSol', 'trade did not match the fresh alert: ' + JSON.stringify(got));
    const before = hits;
    await page.evaluate(() => switchTab('signals')); await page.waitForTimeout(400);
    check(hits === before, 'read the scanner again inside 10 minutes: ' + (hits - before) + ' more requests');
    const fresh = await page.evaluate(() => document.getElementById('sigFresh').innerText);
    check(/^Newest alert /.test(fresh), 'freshness line: ' + JSON.stringify(fresh));
    // A reload keeps them, and does not add the same alert twice.
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
    const after = await page.evaluate(() => { state.ui.sigAutoAt = 0; return autoRefreshAlerts().then(() => state.signals.length); });
    check(after === 1, 'alerts after reload and a second read: ' + after);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Scanner alerts load by themselves and match a fresh trade');
  errs.forEach(e => { console.log('     ' + e); failures.push('alert refresh: ' + e); });
}

// 30m S/R zones are gone (lakky, 2026-10-27) and the zone backtest rebuilt under
// today's rules replaces every zone alert before its cutoff: a 30m row, an old 4H
// row and a stored 30m signal all go; rebuilt 4H / 1D rows and a live 4H row after
// the cutoff stay; a rebuilt fill inside a US news window is left out; fib alerts
// and hand-pasted signals are untouched.
async function zoneRebuildRun(seed) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const H = 3600e3, now = Date.now(), cutoff = now - 2 * 24 * H;
  const isoAt = t => new Date(t).toISOString(), ist = t => new Date(t + 5.5 * H).toISOString().replace('Z', '+05:30');
  const fin = (sym, tf, t, extra) => JSON.stringify(Object.assign({ market: 'CRYPTO', timeframe: tf, date: ist(t).slice(0, 10), symbol: sym, side: 'long',
    trade_id: sym + tf + t, alert_time: ist(t), filled: true, outcome: 'SL', final_result: 'SL', net_realized_r: -1.1, alert_price: 100, stop_price: 99,
    planned_entry: 100, zone_bottom: 99.5, zone_top: 100 }, extra || {}));
  const files = {
    'daily_backtest_finalized_records.jsonl': [fin('OLD30USD', '30m', cutoff - 30 * H), fin('OLD4HUSD', '4h', cutoff - 30 * H), fin('LIVE4HUSD', '4h', cutoff + 5 * H)].join('\n'),
    'zone_rebuild_4h.jsonl': [fin('RB4HUSD', '4h', cutoff - 20 * H, { rebuild: true }), fin('NEWSUSD', '4h', cutoff - 19 * H, { rebuild: true, news_window: true })].join('\n'),
    'zone_rebuild_htf.jsonl': JSON.stringify({ market: 'crypto', symbol: 'RBDAYUSD', tf: '1d', price: 101, kind: 'zone', plan: { side: 'long', entry: 100, sl: 99 },
      zone_bottom: 99.5, zone_top: 100, id: 'zone|RBDAYUSD|1d@1|rb', key: 'zone|RBDAYUSD|1d', sent_ts: Math.floor((cutoff - 40 * H) / 1000), rebuild: true }),
    'zone_rebuild_htf_results.json': JSON.stringify({ 'zone|RBDAYUSD|1d@1|rb': { outcome: '2R', filled: true, resolved: true, r1: true, r2: true, sl: false, be: false } }),
    'zone_rebuild_meta.json': JSON.stringify({ since: isoAt(cutoff - 50 * 24 * H), cutoff: isoAt(cutoff), built_at: isoAt(cutoff) }),
    'fib_trendline_alert_records.jsonl': [
      JSON.stringify({ market: 'crypto', symbol: 'FIBUSD', tf: '4h', price: 101, kind: 'fib', plan: { side: 'long', entry: 100, sl: 99 },
        id: 'fib|FIBUSD@1', sent_ts: Math.floor((cutoff - 30 * H) / 1000) }),
      JSON.stringify({ market: 'crypto', symbol: 'LFIBUSD', tf: '4h', price: 101, kind: 'fib', plan: { side: 'long', entry: 100, sl: 99 },
        id: 'fib|LFIBUSD@1', sent_ts: Math.floor((cutoff + 3 * H) / 1000) })].join('\n'),
    'fibtl_rebuild_records.jsonl': JSON.stringify({ market: 'crypto', symbol: 'RBFIBUSD', tf: '1d', price: 101, kind: 'fib', plan: { side: 'long', entry: 100, sl: 99 },
      id: 'fib|RBFIBUSD@1|rb', key: 'fib|RBFIBUSD', sent_ts: Math.floor((cutoff - 30 * H) / 1000), rebuild: true }),
    'fibtl_rebuild_results.json': JSON.stringify({ 'fib|RBFIBUSD@1|rb': { outcome: 'SL', filled: true, resolved: true, r1: false, r2: false, sl: true, be: false } }),
    'fibtl_rebuild_meta.json': JSON.stringify({ cutoff: isoAt(cutoff), built_at: isoAt(cutoff) }),
  };
  await ctx.route(url => !url.href.startsWith(base), async r => {
    const u = r.request().url();
    if (!u.includes('/scanner-runtime-state/')) return r.abort();
    const f = u.split('/').pop().split('?')[0];
    return r.fulfill({ status: 200, body: files[f] != null ? files[f] + '\n' : f.endsWith('.json') ? '{}' : '' });
  });
  const d = ist(cutoff - 60 * H).slice(0, 10);
  const signals = [
    { id: 's30', key: 'SOL|x|30m|long', date: d, time: '10:00', symbol: 'SOL', side: 'long', market: 'CRYPTO', timeframe: '30m', channel: 'CRYPTO 30m', srcRank: 3 },
    { id: 'sOld', key: 'ETH|x|4h|long', date: d, time: '10:00', symbol: 'ETH', side: 'long', market: 'CRYPTO', timeframe: '4h', channel: 'CRYPTO 4h', srcRank: 3 },
    { id: 'sHand', date: d, time: '11:00', symbol: 'HAND', side: 'long', channel: 'CRYPTO 30M' },
  ];
  const seeded = Object.assign({}, seed, { signals });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => (state.signals || []).some(g => g.symbol === 'RB4HUSD'), null, { timeout: 8000 });
    const syms = await page.evaluate(() => state.signals.map(g => g.symbol).sort().join(','));
    check(syms === 'HAND,LFIBUSD,LIVE4HUSD,RB4HUSD,RBDAYUSD,RBFIBUSD', 'signals after the rebuild: ' + syms);
    const day = await page.evaluate(() => { const g = state.signals.find(x => x.symbol === 'RBDAYUSD'); return g && [g.channel, g.outcome, g.rb]; });
    check(day && day[0] === 'CRYPTO 1D' && day[1] === '+2R' && day[2] === true, 'rebuilt 1D zone: ' + JSON.stringify(day));
    // A second read changes nothing.
    const again = await page.evaluate(() => { state.ui.sigAutoAt = 0; return autoRefreshAlerts().then(() => state.signals.length); });
    check(again === 6, 'signals after a second read: ' + again);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + '30m zones dropped, rebuilt zone / fib / trendline backtest replaces old alerts');
  errs.forEach(e => { console.log('     ' + e); failures.push('zone rebuild: ' + e); });
}

// While the journal stays open it keeps reading the scanner by itself (every 10
// minutes, 2 after a failed read), and starts GitHub's CoinDCX import once the
// last run is an hour old, so the wallet balance stays fresh.
async function autoKeepRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  let scanner = 0, scanDown = false, lastRun = null, runReads = 0, dispatched = [], dispatchStatus = 204;
  await ctx.route(url => !url.href.startsWith(base), async r => {
    const u = r.request().url();
    if (u.includes('/scanner-runtime-state/')) {
      scanner++;
      if (scanDown) return r.fulfill({ status: 503, body: '' });
      return r.fulfill({ status: 200, body: u.split('?')[0].endsWith('.json') ? '{}' : '' });
    }
    if (u.startsWith('https://api.github.com/repos/victus/sync/actions/workflows/coindcx.yml/runs')) {
      runReads++;
      return r.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ workflow_runs: lastRun ? [{ created_at: lastRun }] : [] }) });
    }
    if (u === 'https://api.github.com/repos/victus/sync/actions/workflows/coindcx.yml/dispatches' && r.request().method() === 'POST') {
      dispatched.push({ body: r.request().postData(), auth: (await r.request().allHeaders()).authorization });
      return r.fulfill({ status: dispatchStatus, headers: { 'Access-Control-Allow-Origin': '*' }, body: dispatchStatus === 204 ? '' : '{"message":"Resource not accessible by personal access token"}' });
    }
    return r.abort();
  });
  const now = Date.parse('2026-10-22T10:00:00Z');
  const cdx = { files: [{ id: 'cdx-api', name: 'CoinDCX API', broker: 'CoinDCX', importedAt: new Date(now).toISOString(), cur: 'INR', wallet: { at: new Date(now).toISOString(), INR: 5000 } }], rows: [] };
  const seeded = Object.assign({}, seed, { backtest: cdx, sync: { token: 'gh-token', repo: 'victus/sync', branch: 'main', auto: false, lastAt: '', lastSha: '' } });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  await page.clock.install({ time: now });
  lastRun = new Date(now - 20 * 60e3).toISOString();   // GitHub ran it 20 min ago
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.clock.runFor(5000);
    await page.waitForTimeout(300);
    check(scanner > 0, 'scanner not read on opening');
    check(runReads === 1 && dispatched.length === 0, 'import started though GitHub ran it 20 min ago: ' + JSON.stringify({ runReads, dispatched }));
    // 9 minutes on: nothing due yet. 11 minutes on: the scanner is read again.
    let before = scanner;
    await page.clock.runFor(9 * 60e3); await page.waitForTimeout(200);
    check(scanner === before, 'scanner read again inside 10 minutes: ' + (scanner - before));
    await page.clock.runFor(2 * 60e3); await page.waitForTimeout(300);
    check(scanner > before, 'scanner not read again after 10 minutes while open');
    // The scanner is down: the line says so, and it tries again 2 minutes later.
    scanDown = true; before = scanner;
    await page.clock.runFor(11 * 60e3); await page.waitForTimeout(300);
    const down = await page.evaluate(() => document.getElementById('sigFresh').innerText);
    check(scanner > before && /couldn't reach the scanner/.test(down), 'failed read not shown: ' + JSON.stringify(down));
    scanDown = false; before = scanner;
    await page.clock.runFor(3 * 60e3); await page.waitForTimeout(300);
    const up = await page.evaluate(() => document.getElementById('sigFresh').innerText);
    check(scanner > before && !/couldn't reach/.test(up), 'no retry 2 minutes after a failed read: ' + JSON.stringify(up));
    // An hour after GitHub's last run, the journal starts it itself, with the sync token.
    check(dispatched.length === 0, 'import started before the hour: ' + dispatched.length);
    await page.clock.runFor(30 * 60e3); await page.waitForTimeout(300);
    check(dispatched.length === 1 && JSON.parse(dispatched[0].body).ref === 'main' && dispatched[0].auth === 'Bearer gh-token', 'import not started an hour after the last run: ' + JSON.stringify(dispatched));
    // And not again for the next hour, even though the run list still shows the old run.
    await page.clock.runFor(40 * 60e3); await page.waitForTimeout(300);
    check(dispatched.length === 1, 'import started twice inside an hour: ' + dispatched.length);
    // A token without Actions access: the CoinDCX card says what to give it.
    dispatchStatus = 403;
    await page.clock.runFor(15 * 60e3);
    // The start is a few fetches through the test's routes: on a busy runner 300 ms was not
    // always enough for the second one to land. Wait for it (up to 5 s), then for the card.
    for (let i = 0; i < 50 && dispatched.length < 2; i++) await page.waitForTimeout(100);
    let card = '';
    for (let i = 0; i < 50; i++) {
      card = await page.evaluate(() => { switchTab('data'); renderDataView(); return document.getElementById('cdxStatus').innerText; });
      if (/GitHub said 403/.test(card)) break;
      await page.waitForTimeout(100);
    }
    check(dispatched.length === 2 && /GitHub said 403/.test(card) && /Actions: Read and write/.test(card), 'card after a refused start: ' + JSON.stringify({ n: dispatched.length, card }));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Alerts and the CoinDCX import keep refreshing while the journal stays open');
  errs.forEach(e => { console.log('     ' + e); failures.push('auto keep: ' + e); });
}

// tools/delta-import.mjs, the Delta import that runs on lakky's PC (Delta only
// answers a key from its whitelisted IPs, and the phone's keeps changing). It
// runs here against a fake Delta, which checks every signature the way Delta
// documents it (HMAC-SHA256 hex of GET + timestamp + path + query), and a fake
// GitHub holding journal.json. The trades it builds must be the ones the
// journal's own in-page import builds from the same fills, each order once.
async function deltaImportRun(seed) {
  const KEY = 'dx-key-1', SECRET = 'dx-secret-2', REPO = 'victus/sync';
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const mock = { fills: [], calls: [], bad: [], refuse: null, ip: '203.0.113.9', ipReads: 0, equity: '512.25', products: true };
  const fill = (id, sym, side, size, price, at, order, fee = 0.05) => ({ id, product_symbol: sym, side, size, price: String(price), commission: String(fee), created_at: at, order_id: order });
  const CV = { BTCUSD: 0.001, ETHUSD: 0.01, SOLUSD: 1 };
  function delta(req) {
    const u = new URL(req.url, 'http://x'), path = u.pathname.replace(/^\/dx/, ''), h = req.headers;
    mock.calls.push(path + u.search);
    if (path === '/v2/products') return mock.products ? [200, { result: Object.keys(CV).map(k => ({ symbol: k, contract_value: String(CV[k]) })) }] : [503, { raw: 'down' }];
    const sig = crypto.createHmac('sha256', SECRET).update('GET' + h.timestamp + path + u.search).digest('hex');
    if (h['api-key'] !== KEY || h.signature !== sig || !/^\d{10}$/.test(h.timestamp || '')) { mock.bad.push(path + ' signature'); return [401, { success: false, error: { code: 'invalid_api_key' } }]; }
    if (mock.refuse === 'ip') return [401, { success: false, error: { code: 'ip_not_whitelisted_for_api_key', context: { client_ip: '198.51.100.4' } } }];
    if (mock.refuse === 'ipBare') return [401, { success: false, error: { code: 'ip_not_whitelisted_for_api_key' } }];
    if (path === '/v2/wallet/balances') return [200, { meta: { net_equity: mock.equity }, result: [] }];
    if (path === '/v2/fills') {
      const start = Number(u.searchParams.get('start_time') || 0), after = Number(u.searchParams.get('after') || 0), size = Number(u.searchParams.get('page_size'));
      const all = mock.fills.filter(f => Date.parse(f.created_at.replace(/(\.\d{3})\d+/, '$1')) * 1000 >= start).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
      const page = all.slice(after, after + 2); // two a page, so paging is used
      if (size !== 200) mock.bad.push('page_size ' + size);
      return [200, { result: page, meta: { after: after + 2 < all.length ? String(after + 2) : null } }];
    }
    return [404, { error: { code: 'not_found' } }];
  }
  const gh = { files: {}, puts: [] };
  function github(method, url, headers, body) {
    const u = new URL(url), m = u.pathname.match(/^(?:\/gh)?\/repos\/([^/]+\/[^/]+)\/contents\/journal\.json$/);
    if (!m || headers.authorization !== 'Bearer gh-token') return [404, { message: 'Not Found' }];
    const f = gh.files[m[1]];
    if (method === 'GET') return f ? [200, { sha: f.sha, size: f.text.length, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }] : [404, { message: 'Not Found' }];
    if (method === 'PUT') {
      const p = JSON.parse(body || '{}');
      if (f ? p.sha !== f.sha : !!p.sha) return [409, { message: 'conflict' }];
      const text = Buffer.from(String(p.content || ''), 'base64').toString('utf8'), sha = crypto.createHash('sha1').update(text).digest('hex');
      gh.files[m[1]] = { text, sha }; gh.puts.push(p.message);
      return [f ? 200 : 201, { content: { sha } }];
    }
    return [405, {}];
  }
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/ip') { mock.ipReads++; res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end(mock.ip); }
      const [status, data] = req.url.startsWith('/dx/') ? delta(req) : github(req.method, 'http://x' + req.url, req.headers, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise(r => fake.listen(0, '127.0.0.1', r));
  const fakeBase = 'http://127.0.0.1:' + fake.address().port;
  const runImport = (extra = {}) => new Promise(resolve => {
    const before = gh.puts.length;
    mock.calls = [];
    execFile(process.execPath, [path.join(ROOT, 'tools', 'delta-import.mjs')], {
      env: Object.assign({ PATH: process.env.PATH, TZ: 'UTC', DELTA_API_KEY: KEY, DELTA_API_SECRET: SECRET, GITHUB_TOKEN: 'gh-token', GITHUB_REPOSITORY: REPO,
        GITHUB_API_URL: fakeBase + '/gh', DELTA_BASE: fakeBase + '/dx', IP_URL: fakeBase + '/ip' }, extra),
      timeout: 60000
    }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, out: (stdout + stderr).trim(), puts: gh.puts.slice(before) }));
  });
  const stored = () => JSON.parse(gh.files[REPO].text);
  const dTrades = j => (j.trades || []).filter(t => t.src && t.src.startsWith('delta:'));

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.github.com/'), r => r.abort());
  await ctx.route('https://api.github.com/**', async route => {
    const req = route.request(), u = req.url();
    if (/\/actions\//.test(u)) return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
    const [status, data] = github(req.method(), u, await req.allHeaders(), req.postData() || '');
    return route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  });
  const seeded = Object.assign({}, seed, { sync: { token: 'gh-token', repo: REPO, branch: 'main', auto: false, lastAt: '', lastSha: '' } });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  page.on('dialog', d => d.accept());
  const sync = () => page.evaluate(() => syncNow({ quiet: true }));
  const card = () => page.evaluate(() => { openSettings('connect'); renderDataView(); return { status: document.getElementById('dxPcStatus').innerText, bad: document.getElementById('dxPcStatus').className.includes('rose'), steps: document.getElementById('dxPcSteps').innerText }; });
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    // A trade logged by hand that Delta will bring in too: matched, not doubled.
    await page.evaluate(() => { state.trades.push(stamp({ id: 'hand1', accountId: 'acc_cry', date: '2026-10-20', time: '15:30', exitTime: '16:00', exitDate: '2026-10-20', symbol: 'SOLUSD', direction: 'short', entry: 150, exit: 148, stop: 0, qty: 2, fees: 0.1, leverage: 10, setup: '', rules: [], notes: 'by hand' })); save(); });
    // The journal goes up first, with a field another feature keeps there.
    let s = await sync();
    const j0 = stored(); j0.keysLock = { v: 1, data: 'kept-as-is' }; const t0 = JSON.stringify(j0); gh.files[REPO] = { text: t0, sha: crypto.createHash('sha1').update(t0).digest('hex') };
    let c = await card();
    check(s.ok && /^Not set up yet/.test(c.status) && /DELTA_API_KEY/.test(c.steps) && /api\.ipify\.org/.test(c.steps), 'card before: ' + JSON.stringify(c));

    // No secrets: says what to add and touches nothing.
    let r = await runImport({ DELTA_API_KEY: '' });
    check(r.code === 1 && /Add the DELTA_API_KEY and DELTA_API_SECRET secrets/.test(r.out) && !r.puts.length && !mock.calls.length, 'no secrets: ' + JSON.stringify(r));

    // First run: the whole history. BTC long closed (two entry fills), ETH short
    // still open, SOL short matching the hand-logged trade, XRP with no contract size.
    mock.fills = [
      fill(1, 'BTCUSD', 'buy', 10, 60000, '2026-10-20T04:00:00.123456Z', 'o1'), fill(2, 'BTCUSD', 'buy', 10, 60200, '2026-10-20T04:05:00.000001Z', 'o2'),
      fill(3, 'BTCUSD', 'sell', 20, 61000, '2026-10-20T20:00:00.5Z', 'o3', 0.1),
      fill(4, 'ETHUSD', 'sell', 100, 2500, '2026-10-21T09:00:00Z', 'o4'),
      fill(5, 'SOLUSD', 'sell', 2, 150, '2026-10-20T10:00:10Z', 'o5'), fill(6, 'SOLUSD', 'buy', 2, 148, '2026-10-20T10:30:10Z', 'o6'),
      fill(7, 'XRPUSD', 'buy', 5, 2, '2026-10-21T10:00:00Z', 'o7'), fill(8, 'XRPUSD', 'sell', 5, 2.1, '2026-10-21T11:00:00Z', 'o8')
    ];
    r = await runImport();
    let j = stored(), dt = dTrades(j);
    const btc = dt.find(t => t.src === 'delta:o3');
    check(r.code === 0 && /^Imported 1 new trade from Delta · 8 fills read · skipped XRPUSD \(Delta gave no contract size\) · balance 512\.25 \(net equity\)$/.test(r.out) && JSON.stringify(r.puts) === '["Delta: 1 new trade"]', 'first run: ' + JSON.stringify(r));
    check(mock.bad.length === 0, 'requests Delta would refuse: ' + mock.bad.join(' | '));
    check(btc && btc.accountId === 'acc_cry' && btc.date === '2026-10-20' && btc.time === '09:30' && btc.exitDate === '2026-10-21' && btc.exitTime === '01:30' && btc.direction === 'long' && btc.entry === 60100 && btc.exit === 61000 && btc.qty === 0.02 && Math.abs(btc.fees - 0.2) < 1e-9 && btc.leverage === 10 && btc.rules.length === 5 && btc.updatedAt, 'BTC trade: ' + JSON.stringify(btc));
    check(j.trades.find(t => t.id === 'hand1').src === 'delta:o6' && dt.length === 2, 'hand-logged SOL not matched: ' + JSON.stringify(dt.map(t => t.src)));
    check(j.deltaImport && j.deltaImport.lastFillTime === Date.parse('2026-10-21T11:00:00Z') * 1000 && JSON.stringify(j.deltaImport.openPositions) === JSON.stringify({ ETHUSD: Date.parse('2026-10-21T09:00:00Z') * 1000 }) && !('note' in j.deltaImport), 'resume point: ' + JSON.stringify(j.deltaImport));
    check(j.deltaBalance && j.deltaBalance.value === 512.25 && j.deltaBalance.field === 'net equity' && JSON.stringify(j.keysLock) === '{"v":1,"data":"kept-as-is"}', 'balance / other fields: ' + JSON.stringify({ b: j.deltaBalance, k: j.keysLock }));
    check(mock.calls.some(x => x.startsWith('/v2/fills?page_size=200&after=')) && !mock.calls.some(x => /start_time/.test(x)), 'first run paging: ' + mock.calls.join(','));

    // The phone syncs: the trade and the balance arrive, the card says it works, nothing to push back.
    s = await sync();
    let p = await page.evaluate(() => ({ n: state.trades.filter(t => t.src === 'delta:o3').length, bal: state.delta && state.delta.liveBalance && state.delta.liveBalance.value, di: !!state.deltaImport }));
    c = await card();
    check(s.ok && p.n === 1 && p.bal === 512.25 && p.di && /^Your PC imports Delta every 30 minutes/.test(c.status) && /2 Delta trades in the journal/.test(c.status) && !c.bad && c.steps === '', 'phone after the run: ' + JSON.stringify({ s, p, c }));
    s = await sync();
    check(s.ok && s.changed === false, 'second sync rewrote the file: ' + JSON.stringify(s));

    // Second run: ETH closes; only fills from the open ETH position on are read.
    mock.fills.push(fill(9, 'ETHUSD', 'buy', 100, 2400, '2026-10-22T09:00:00Z', 'o9'));
    r = await runImport();
    j = stored();
    check(r.code === 0 && /^Imported 1 new trade from Delta/.test(r.out) && dTrades(j).length === 3 && JSON.stringify(j.deltaImport.openPositions) === '{}' && dTrades(j).find(t => t.src === 'delta:o9').direction === 'short', 'ETH closed: ' + JSON.stringify(r) + ' ' + JSON.stringify(j.deltaImport));
    check(mock.calls.some(x => x.includes('start_time=' + Date.parse('2026-10-21T09:00:00Z') * 1000)), 'resume start: ' + mock.calls.join(','));
    // Nothing new: no commit.
    r = await runImport();
    check(r.code === 0 && r.out.startsWith('Up to date, no new Delta trades') && !r.puts.length, 'nothing new: ' + JSON.stringify(r));

    // The PC's IP moved: Delta names it, the run says so, the phone shows it in red with the steps.
    mock.refuse = 'ip';
    r = await runImport();
    const why = "Delta refused this PC's IP 198.51.100.4: it isn't whitelisted on the key. On Delta, add 198.51.100.4 to the key's IPs (or make a Read Data key for it and update the two secrets).";
    check(r.code === 1 && r.out === '::error::' + why && JSON.stringify(r.puts) === '["Delta import failed"]' && stored().deltaImport.note === why && stored().deltaImport.lastFillTime === j.deltaImport.lastFillTime, 'IP refused: ' + JSON.stringify(r));
    await sync();
    c = await card();
    check(c.bad && c.status.startsWith("GitHub's last Delta run failed: " + why) && /DELTA_API_KEY/.test(c.steps), 'card after the refusal: ' + JSON.stringify(c));
    // Without Delta naming it, the PC asks api.ipify.org.
    mock.refuse = 'ipBare';
    const ips = mock.ipReads;
    r = await runImport();
    check(r.code === 1 && r.out.includes("Delta refused this PC's IP 203.0.113.9") && mock.ipReads === ips + 1, 'IP from ipify: ' + JSON.stringify(r));
    mock.refuse = null;
    r = await runImport();
    check(r.code === 0 && JSON.stringify(r.puts) === '["Delta import working again"]' && !('note' in stored().deltaImport), 'working again: ' + JSON.stringify(r));

    // A trade deleted on the phone stays deleted, even when the record is lost and the whole history is read again.
    await sync();
    await page.evaluate(() => { const t = state.trades.find(x => x.src === 'delta:o3'); noteDeleted('trades', t.id, t.src); state.trades = state.trades.filter(x => x !== t); save(); });
    await sync();
    const lost = stored(); delete lost.deltaImport; const lt = JSON.stringify(lost); gh.files[REPO] = { text: lt, sha: crypto.createHash('sha1').update(lt).digest('hex') };
    r = await runImport();
    j = stored();
    check(r.code === 0 && !r.out.startsWith('Imported') && !dTrades(j).some(t => t.src === 'delta:o3') && new Set(dTrades(j).map(t => t.src)).size === dTrades(j).length && j.deltaImport.lastFillTime > 0, 'full re-read after a delete: ' + JSON.stringify(r) + ' ' + JSON.stringify(dTrades(j).map(t => t.src)));
    // Contract sizes unreadable: nothing imported, the reason kept.
    mock.products = false;
    r = await runImport();
    check(r.code === 1 && /contract sizes could not be read/.test(stored().deltaImport.note || ''), 'no contract sizes: ' + JSON.stringify(r));
    mock.products = true;
    // No crypto book in the file: says so.
    const nb = stored(); nb.accounts = nb.accounts.filter(a => a.market !== 'crypto'); const nt = JSON.stringify(nb); gh.files['victus/nobook'] = { text: nt, sha: 'nb' };
    r = await runImport({ GITHUB_REPOSITORY: 'victus/nobook' });
    check(r.code === 1 && /no crypto book/.test(r.out), 'no crypto book: ' + JSON.stringify(r));
    check(!r.out.includes(KEY) && !r.out.includes(SECRET), 'the run printed the key');
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  fake.close();
  const label = 'Delta import on the PC: signed calls, trades, resume, IP named, deletes kept';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// "Import now" on the phone: the CoinDCX import runs on lakky's PC (CoinDCX locks
// each key to one IP), so a run waits in GitHub's queue while the PC is off. The
// button asks GitHub for a run, says whether it waits for the PC, runs or is done,
// then syncs the rows the PC's run added. A refused key shows the reason the run
// left, a run the PC never picks up says so after 15 minutes, and a token without
// Actions access is told what it needs.
async function importNowRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const REPO = 'victus/sync', TOKEN = 'gh-token', RUN_URL = 'https://github.com/victus/sync/actions/runs/';
  const gh = { files: {}, puts: 0, dispatched: [], dispatchStatus: 204, runs: [], runReads: 0, dx: null };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.github.com/'), r => r.abort());
  await ctx.route('https://api.github.com/**', async route => {
    const req = route.request(), u = new URL(req.url()), h = await req.allHeaders();
    const reply = (status, data) => route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: data === null ? '' : JSON.stringify(data) });
    if (h.authorization !== 'Bearer ' + TOKEN) return reply(401, { message: 'Bad credentials' });
    // Delta's job: missing (404) until the test adds it.
    const dx = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/actions\/workflows\/delta\.yml\/(dispatches|runs)$/);
    if (dx) {
      if (!gh.dx) return reply(404, { message: 'Not Found' });
      if (dx[1] === 'dispatches') { gh.dx.dispatched.push(JSON.parse(req.postData() || '{}')); return reply(204, null); }
      return reply(200, { workflow_runs: gh.dx.runs.slice(0, 1) });
    }
    if (u.pathname === '/repos/' + REPO + '/actions/workflows/coindcx.yml/dispatches' && req.method() === 'POST') {
      gh.dispatched.push(JSON.parse(req.postData() || '{}'));
      return gh.dispatchStatus === 204 ? reply(204, null) : reply(gh.dispatchStatus, { message: 'Resource not accessible by personal access token' });
    }
    if (u.pathname === '/repos/' + REPO + '/actions/workflows/coindcx.yml/runs' && req.method() === 'GET') {
      gh.runReads++;
      return reply(200, { total_count: gh.runs.length, workflow_runs: gh.runs.slice(0, Number(u.searchParams.get('per_page')) || 30) });
    }
    if (u.pathname !== '/repos/' + REPO + '/contents/journal.json') return reply(404, { message: 'Not Found' });
    const f = gh.files[REPO];
    if (req.method() === 'GET') return f ? reply(200, { sha: f.sha, size: f.text.length, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }) : reply(404, { message: 'Not Found' });
    if (req.method() === 'PUT') {
      const p = JSON.parse(req.postData() || '{}');
      if (f ? p.sha !== f.sha : !!p.sha) return reply(409, { message: 'conflict' });
      const text = Buffer.from(String(p.content || ''), 'base64').toString('utf8'), sha = crypto.createHash('sha1').update(text).digest('hex');
      gh.files[REPO] = { text, sha }; gh.puts++;
      return reply(f ? 200 : 201, { content: { sha } });
    }
    return reply(405, { message: 'no' });
  });
  const now = Date.parse('2026-11-02T14:00:00Z');
  const cdxFile = { id: 'cdx-api', name: 'CoinDCX API', broker: 'CoinDCX', importedAt: new Date(now - 864e5).toISOString(), updatedAt: new Date(now - 864e5).toISOString(), cur: 'INR', wallet: { at: new Date(now - 864e5).toISOString(), INR: 5000 } };
  const seeded = Object.assign({}, seed, { backtest: { files: [cdxFile], rows: [] }, sync: { token: TOKEN, repo: REPO, branch: 'main', auto: false, lastAt: '', lastSha: '' } });
  // GitHub's schedule ran it 20 minutes ago, so the hourly start leaves it alone.
  gh.runs = [{ id: 1, created_at: new Date(now - 20 * 60e3).toISOString(), status: 'completed', conclusion: 'success', html_url: RUN_URL + 1 }];
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  await page.clock.install({ time: now });
  const settle = async (ms) => { await page.clock.runFor(ms); await page.waitForTimeout(400); };
  // Press Import now and wait (real time) until GitHub has answered the dispatch: only then is
  // the first look at the runs set on the fake clock, so a slow runner can't leave settle() early.
  const press = async sel => {
    await page.click(sel);
    for (let i = 0; i < 50 && await page.evaluate(() => Object.values(pcRuns).some(r => r.step === 'asking')); i++) await page.waitForTimeout(100);
  };
  const view = () => page.evaluate(() => ({ text: document.getElementById('cdxRunStatus').innerText, cls: document.getElementById('cdxRunStatus').className,
    btn: document.getElementById('cdxRunBtn').innerText, off: document.getElementById('cdxRunBtn').disabled,
    link: document.getElementById('cdxRunLink').classList.contains('hidden') ? '' : document.getElementById('cdxRunLink').href,
    card: document.getElementById('cdxStatus').innerText, rows: state.backtest.rows.filter(r => r.file === 'cdx-api').length, toasts: window.__toasts.slice(),
    dx: document.getElementById('dxRunStatus').innerText, dxCard: document.getElementById('dxPcStatus').innerText, dxBtn: document.getElementById('dxRunBtn').disabled }));
  // What the PC's run leaves in the sync repo: this device's journal plus its rows.
  const pcRun = async (rows, note) => {
    const j = await page.evaluate(() => syncPayload(state));
    const at = new Date(now + 60 * 60e3).toISOString();
    const row = (id, gross, fee) => ({ id, file: 'cdx-api', sym: 'B-ETH_USDT', at: '2026-11-02 19:00:00', kind: 'order', type: 'By Order', gross, settle: 0, fee, net: gross - fee, cur: 'INR' });
    j.backtest = { files: [Object.assign({}, cdxFile, { updatedAt: at }, note ? { note } : {})], rows: rows.map((r, i) => row('px' + i + r, r, 1)) };
    const text = JSON.stringify(j, null, 2);
    gh.files[REPO] = { text, sha: crypto.createHash('sha1').update(text).digest('hex') };
  };
  const newRun = async (status) => {
    const t = await page.evaluate(() => Date.now());
    gh.runs.unshift({ id: gh.runs.length + 1, created_at: new Date(t).toISOString(), status, conclusion: null, html_url: RUN_URL + (gh.runs.length + 1) });
    return gh.runs[0];
  };
  try {
    await page.goto(base, { waitUntil: 'load' });
    await settle(5000);
    await page.evaluate(() => { window.__toasts = []; const real = toast; toast = m => { window.__toasts.push(String(m)); real(m); }; openSettings('connect'); renderDataView(); });
    check(gh.dispatched.length === 0 && gh.runReads === 1, 'started on opening though GitHub ran it 20 min ago: ' + JSON.stringify(gh));
    let v = await view();
    check(v.btn === 'Import now' && !v.off && v.text === '' && !v.link, 'button before: ' + JSON.stringify(v));

    // 1. Pressed on the phone while the PC is off: asked, then waiting for the PC.
    await press('#cdxRunBtn');
    await page.waitForTimeout(300);
    v = await view();
    check(gh.dispatched.length === 1 && gh.dispatched[0].ref === 'main', 'dispatch: ' + JSON.stringify(gh.dispatched));
    check(/^Asked GitHub at /.test(v.text) && v.off && v.btn === 'Importing…' && v.toasts.some(t => /asked for: it runs on your PC\. A note pops up here when it's done\./.test(t)), 'after the press: ' + JSON.stringify(v));
    const run1 = await newRun('queued');
    await settle(5000);
    v = await view();
    check(/^Waiting for your PC since \d\d:\d\d( [AP]M)?: the import runs there\. Turn the PC on/.test(v.text) && v.link === RUN_URL + run1.id && v.off, 'queued: ' + JSON.stringify(v));
    // A second press while it watches only says where it is.
    await page.evaluate(() => pcImportNow());
    await page.waitForTimeout(200);
    check(gh.dispatched.length === 1 && (await view()).toasts.pop().startsWith('Waiting for your PC'), 'second press started another run: ' + gh.dispatched.length);
    // The PC comes on: running, then done; the sync brings its two rows.
    run1.status = 'in_progress';
    await settle(10000);
    v = await view();
    check(v.text === 'Running on your PC…' && v.rows === 0, 'running: ' + JSON.stringify(v));
    await pcRun([40, -15]);
    Object.assign(run1, { status: 'completed', conclusion: 'success' });
    await settle(10000);
    await page.waitForTimeout(600);
    v = await view();
    check(v.text === 'CoinDCX import done · 2 new rows.' && v.rows === 2 && !v.off && v.btn === 'Import now' && /text-emerald-300/.test(v.cls), 'done: ' + JSON.stringify(v));
    check(v.toasts.includes('CoinDCX import done · 2 new rows.'), 'no toast when done: ' + JSON.stringify(v.toasts));
    const polls = gh.runReads;
    await settle(60000);
    check(gh.runReads === polls, 'still watching after it was done: ' + (gh.runReads - polls));

    // 2. From Signals → More, the key refused (the hotspot's IP moved): the reason the run left shows.
    await page.evaluate(() => switchTab('signals'));
    await page.click('#view-signals details.menu summary');
    await press('#view-signals details.menu >> text=Import CoinDCX + Delta');
    await page.waitForTimeout(300);
    check(gh.dispatched.length === 2, 'Signals → More did not start it: ' + gh.dispatched.length);
    const why = "CoinDCX refused the key (401) from this PC's IP 203.0.113.7. The key is locked to one IP: if it isn't 203.0.113.7, make a CoinDCX key for 203.0.113.7 and put it in the two secrets. Or a secret was copied short.";
    await pcRun([40, -15], why);
    const run2 = await newRun('completed');
    run2.conclusion = 'success';
    await settle(5000);
    await page.waitForTimeout(600);
    await page.evaluate(() => openSettings('connect'));
    v = await view();
    check(v.text.endsWith('but CoinDCX said no: ' + why) && /text-rose-300/.test(v.cls) && v.card.startsWith("GitHub's last run failed: " + why), 'refused key: ' + JSON.stringify(v));

    // 3. The PC never picks it up: after 15 minutes it stops watching and says so.
    await press('#cdxRunBtn');
    await page.waitForTimeout(300);
    await newRun('pending');
    await settle(5000);
    v = await view();
    check(/^Waiting for your PC/.test(v.text) && v.off, 'pending: ' + JSON.stringify(v));
    await settle(15 * 60e3);
    v = await view();
    check(/^Still waiting for your PC since \d\d:\d\d( [AP]M)?: .*New trades come in with the next sync\.$/.test(v.text) && !v.off && v.btn === 'Import now', 'gave up: ' + JSON.stringify(v));
    check(/The run from \d\d:\d\d( [AP]M)? is waiting for your PC: the import runs there/.test(v.card) && !/Import last run/.test(v.card), 'card does not say the run waits for the PC: ' + JSON.stringify(v.card));
    const reads = gh.runReads;
    await settle(60000);
    check(gh.runReads === reads, 'kept watching after 15 minutes: ' + (gh.runReads - reads));

    // 4. A token without Actions access: says what to give it.
    gh.dispatchStatus = 403;
    await press('#cdxRunBtn');
    await page.waitForTimeout(400);
    v = await view();
    check(v.text === 'GitHub refused (403): give the sync token Actions: Read and write, then press Import now again.' && !v.off && /GitHub said 403/.test(v.card), 'refused token: ' + JSON.stringify(v));
    // 6a. Delta's job is there but has no secrets: it stops before writing, and GitHub
    // still calls the run a success. The card says it isn't set up, not "nothing new".
    gh.dispatchStatus = 204;
    gh.dx = { dispatched: [], runs: [] };
    await page.evaluate(() => { openSettings('connect'); renderDataView(); });
    await press('#dxRunBtn');
    await page.waitForTimeout(300);
    const t6a = await page.evaluate(() => Date.now());
    gh.runs.unshift({ id: 40, created_at: new Date(t6a).toISOString(), status: 'completed', conclusion: 'success', html_url: RUN_URL + 40 });
    gh.dx.runs.unshift({ id: 41, created_at: new Date(t6a).toISOString(), status: 'completed', conclusion: 'success', html_url: RUN_URL + 41 });
    await settle(5000);
    await page.waitForTimeout(600);
    v = await view();
    check(/^Ran at \d\d:\d\d( [AP]M)?, but nothing reached the journal: Delta isn't set up on GitHub yet\. Add the DELTA_API_KEY and DELTA_API_SECRET secrets/.test(v.dx) && !/nothing new/.test(v.dx) && !v.dxBtn && /^Not set up yet/.test(v.dxCard), 'Delta without secrets: ' + JSON.stringify(v));
    check(await page.evaluate(() => /text-rose-300/.test(document.getElementById('dxRunStatus').className)), 'Delta without secrets not shown in red');
    check(v.toasts.some(t => /Delta: not set up yet, see its card/.test(t)), 'toast for Delta without secrets: ' + JSON.stringify(v.toasts));

    // 6. Delta through the PC too: one press (on the Delta card) runs both jobs, each
    // card says how its own went, and one note says both.
    gh.dispatchStatus = 204;
    gh.dx = { dispatched: [], runs: [] };
    const nd = gh.dispatched.length;
    await page.evaluate(() => { openSettings('connect'); renderDataView(); });
    v = await view();
    check(/^Not set up yet/.test(v.dxCard), 'Delta card before: ' + JSON.stringify(v.dxCard));
    await press('#dxRunBtn');
    await page.waitForTimeout(300);
    v = await view();
    check(gh.dispatched.length === nd + 1 && gh.dx.dispatched.length === 1 && gh.dx.dispatched[0].ref === 'main' && v.off && v.dxBtn, 'both not started: ' + JSON.stringify({ cdx: gh.dispatched.length - nd, dx: gh.dx.dispatched, v }));
    const t6 = await page.evaluate(() => Date.now());
    gh.runs.unshift({ id: 50, created_at: new Date(t6).toISOString(), status: 'completed', conclusion: 'success', html_url: RUN_URL + 50 });
    gh.dx.runs.unshift({ id: 51, created_at: new Date(t6).toISOString(), status: 'in_progress', conclusion: null, html_url: RUN_URL + 51 });
    // What the PC's two runs leave: the CoinDCX rows as they were, one new Delta trade and Delta's record.
    const j6 = await page.evaluate(() => syncPayload(state)), later = new Date(now + 2 * 3600e3).toISOString();
    j6.trades.push({ id: 'dxnew', accountId: 'acc_cry', date: '2026-11-02', time: '19:00', exitTime: '19:30', exitDate: '2026-11-02', symbol: 'BTCUSD', direction: 'long', entry: 60000, exit: 61000, stop: 0, qty: 0.01, fees: 0.1, leverage: 10, setup: '', rules: [false, false, false, false, false], notes: '', src: 'delta:o100', updatedAt: later });
    j6.deltaImport = { lastFillTime: 1, openPositions: {}, updatedAt: later };
    j6.backtest.files.forEach(f => { if (f.id === 'cdx-api') { delete f.note; f.updatedAt = later; } }); // the key works again
    const text6 = JSON.stringify(j6, null, 2);
    gh.files[REPO] = { text: text6, sha: crypto.createHash('sha1').update(text6).digest('hex') };
    await settle(5000);
    await page.waitForTimeout(600);
    v = await view();
    check(v.text === 'CoinDCX import done · nothing new.' && v.dx === 'Running on your PC…' && v.off, 'CoinDCX done, Delta running: ' + JSON.stringify(v));
    gh.dx.runs[0].status = 'completed'; gh.dx.runs[0].conclusion = 'success';
    await settle(10000);
    await page.waitForTimeout(600);
    v = await view();
    check(v.dx === 'Delta import done · 1 new trade.' && !v.dxBtn && /^Your PC imports Delta every 30 minutes/.test(v.dxCard) && v.toasts.includes('CoinDCX: nothing new · Delta: 1 new trade'), 'both done: ' + JSON.stringify(v));

    // 5. No GitHub Sync on this device: nothing is asked, it says what to connect.
    gh.dispatchStatus = 204;
    const n = gh.dispatched.length;
    await page.evaluate(() => { state.sync = { token: '', repo: '', branch: 'main', auto: false, lastAt: '', lastSha: '' }; renderDataView(); });
    await page.evaluate(() => pcImportNow());
    await page.waitForTimeout(200);
    v = await view();
    check(gh.dispatched.length === n && /^Connect GitHub Sync first/.test(v.toasts.pop()), 'no sync: ' + JSON.stringify(v));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'CoinDCX Import now from the phone: waits for the PC, runs, syncs, says why not';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Fib / trendline / 1D+ zone results priced with the scanner's costs (Delta fee,
// breakeven offset and stop slippage): a fib or trendline out in full at its TP (1R,
// as the alert prints), a 1D+ zone held for 2R; 1D+ zones shown as zones, and a 1W
// result that closes weeks after its alert still reaches the journal.
async function fibTlRun(seed) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const now = Math.floor(Date.now() / 1000), old = now - 20 * 86400;
  const rec = (id, kind, market, tf, plan, ts, extra) => JSON.stringify(Object.assign({ id, kind, market, tf, symbol: 'X' + id, plan, sent_ts: ts, price: plan.entry }, extra || {}));
  const recs = [
    rec('a', 'fib', 'crypto', '4h', { entry: 100, sl: 97, side: 'long' }, now - 3600),
    rec('b', 'fib', 'crypto', '1d', { entry: 50, sl: 51, side: 'short' }, now - 7200),
    rec('c', 'trendline', 'nse', '1d', { entry: 200, sl: 196, side: 'long', target_r: 1 }, now - 9000),
    rec('d', 'zone', 'nse', '1d', { entry: 200, sl: 196, side: 'long' }, now - 9600, { zone_bottom: 197, zone_top: 200 }),
    rec('w', 'fib', 'crypto', '1w', { entry: 10, sl: 9, side: 'long' }, old),
    // 1R traded, not 2R: the scanner held it for 2R, but the TP (1R) counts in full (lakky, 2026-11-09)
    rec('f', 'fib', 'crypto', '1d', { entry: 100, sl: 97, side: 'long' }, now - 10800),
    rec('g', 'fib', 'crypto', '1d', { entry: 100, sl: 97, side: 'long' }, now - 11000),
    rec('h', 'trendline', 'crypto', '4h', { entry: 100, sl: 97, side: 'long', target_r: 1 }, now - 11200),
    rec('i', 'fib', 'crypto', '1d', { entry: 100, sl: 97, side: 'long' }, now - 11400),
    rec('j', 'fib', 'crypto', '1d', { entry: 100, sl: 97, side: 'long' }, now - 11600),
    // a 1D+ zone is still held for 2R: 1R then breakeven is the breakeven
    rec('k', 'zone', 'crypto', '1d', { entry: 100, sl: 97, side: 'long' }, now - 11800, { zone_bottom: 98, zone_top: 100 }),
    rec('m', 'zone', 'crypto', '1d', { entry: 100, sl: 97, side: 'long' }, now - 12000, { zone_bottom: 98, zone_top: 100 }),
  ].join('\n') + '\n';
  const done = o => ({ filled: true, resolved: true, outcome: o });
  const res = { a: done('SL'), b: done('BE'), c: done('SL'), d: done('BE'), w: done('2R'),
    f: Object.assign(done('1R'), { r1: true, be: true }), g: Object.assign(done('1R'), { r1: true, sl: true }), h: Object.assign(done('1R'), { r1: true }),
    i: Object.assign(done('1R'), { r1: true }), j: { filled: true, resolved: false, outcome: '1R', r1: true },
    k: Object.assign(done('1R'), { r1: true, be: true }), m: Object.assign(done('2R'), { r1: true, r2: true }) };
  const wOpen = { w: { filled: true, resolved: false, outcome: 'open' } };
  let served = res;
  await ctx.route(url => !url.href.startsWith(base), async r => {
    const u = r.request().url();
    if (!u.includes('/scanner-runtime-state/')) return r.abort();
    const f = u.split('/').pop().split('?')[0];
    return r.fulfill({ status: 200, body: f === 'fib_trendline_alert_records.jsonl' ? recs : f === 'fib_trendline_results.json' ? JSON.stringify(served) : f.endsWith('.json') ? '{}' : '' });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  try {
    await page.goto(base, { waitUntil: 'load' });
    const got = await page.evaluate(([r, x]) => {
      const out = {}; parseFibTl(r, JSON.stringify(x)).records.forEach(g => { out[g.key] = { r: g.resultR, o: g.outcome, kind: g.kind, daily: g.scoredDaily, lo: g.zoneLow }; });
      return out;
    }, [recs, res]);
    // Fibs and trendlines are out at 1R (the alert's TP), 1D+ zones held for 2R, with the
    // scanner's costs. Risk 3%: cost 0.0826 / 3 = 0.02753R, so +1R = 0.97247R and +2R =
    // 1.97247R; breakeven (0.0933 - 1.000933 x 0.05) / 3 - 0.02753 = -0.01312R.
    const want = { a: -1.0437, b: -0.019627, c: -1.07765, d: -0.01818, f: 0.972467, g: 0.972467, h: 0.972467, i: 0.972467, j: 0.972467, k: -0.013116, m: 1.972467 };
    Object.keys(want).forEach(k => check(got[k] && Math.abs(got[k].r - want[k]) < 1e-4, `R of ${k}: ${got[k] && got[k].r} want ${want[k]}`));
    // A fib that reached its TP is +1R in full, whatever came after (breakeven, stop,
    // timeout, still open); a fib the breakeven closed before the TP (b) stays BE; a 1D+
    // zone that reached 1R and came back is the breakeven, and its 2R is +2R.
    check(['f', 'g', 'h', 'i', 'j'].every(k => got[k] && got[k].o === '+1R'), 'TP counts in full: ' + JSON.stringify(['f', 'g', 'h', 'i', 'j'].map(k => got[k])));
    check(got.b && got.b.o === 'BE' && got.k && got.k.o === 'BE' && got.m && got.m.o === '+2R', 'BE before the TP / zone held for 2R: ' + JSON.stringify([got.b, got.k, got.m]));
    check(got.d && got.d.kind === undefined && got.d.daily === true && got.d.lo === 197, '1D zone not a zone: ' + JSON.stringify(got.d));
    check(got.a && got.a.kind === 'fib' && got.c.kind === 'trendline', 'fib / trendline kinds: ' + JSON.stringify(got));
    // A device that took the 1W alert while it was open, and has newer alerts since,
    // still gets its result: the refresh reaches back to the oldest open alert.
    served = wOpen;
    await page.evaluate(() => { state.signals = []; state.ui.sigAutoAt = 0; return autoRefreshAlerts(true); });
    served = res;
    const wBefore = await page.evaluate(() => { const g = state.signals.find(s => s.key === 'w'); return g && g.resultR; });
    check(wBefore === null || wBefore === undefined, '1W should start open: ' + wBefore);
    await page.evaluate(() => { state.ui.sigAutoAt = 0; return autoRefreshAlerts(true); });
    const w = await page.evaluate(() => { const g = state.signals.find(s => s.key === 'w'); return g && g.resultR; });
    // 2R on a 1W fib: +1R less 0.0826 / 10 = 0.99174R
    check(typeof w === 'number' && Math.abs(w - 0.99174) < 1e-4, '1W result never arrived: ' + w);
    // Copies kept by v.179 (breakeven, timeout, open) or before it (+2R) are re-priced: recent
    // ones on the next refresh, older ones (w, 20 days back, past the refresh window) on the
    // first refresh after an app update.
    const rp = await page.evaluate(async () => {
      const old = { f: { outcome: 'BE', resultR: -0.0131 }, i: { outcome: 'timeout', resultR: null }, j: { outcome: 'open', resultR: null }, w: { outcome: '+2R', resultR: 1.9917 } };
      Object.keys(old).forEach(k => { const g = state.signals.find(s => s.key === k); if (g) Object.assign(g, old[k]); });
      const now = () => Object.keys(old).map(k => { const g = state.signals.find(s => s.key === k); return g ? [g.outcome, g.resultR] : null; });
      state.ui.sigAutoAt = 0; await autoRefreshAlerts(true);
      const same = now();
      state.ui.sigPriceVer = '2026-11-09.179'; state.ui.sigAutoAt = 0; await autoRefreshAlerts(true);
      return { same, upd: now(), ver: state.ui.sigPriceVer === appVersion() };
    });
    check(rp.same.slice(0, 3).every(x => x && x[0] === '+1R' && Math.abs(x[1] - 0.9725) < 1e-4) && rp.same[3] && rp.same[3][0] === '+2R', 'recent copies re-priced, old one waits for an update: ' + JSON.stringify(rp.same));
    check(rp.upd[3] && rp.upd[3][0] === '+1R' && Math.abs(rp.upd[3][1] - 0.9917) < 1e-4 && rp.ver, 'old copy re-priced after an app update: ' + JSON.stringify(rp));
    // Fib levels: L1-L4 come back from the alert's key and entry (the scanner's own
    // levels for this XAUT alert).
    const lv = await page.evaluate(() => {
      const a = { id: '1', kind: 'fib', key: 'fib|XAUTUSD|4h|1|1791374400|4215.9|2@1', side: 'long', entry: 4142.134, stop: 4123.6925, price: 4170.83, filled: true, outcome: '+2R', resultR: 1.9, date: '2026-10-12', time: '10:00', symbol: 'XAUTUSD' };
      const g = fibGeom(a);
      return { lv: g && g.levels, entry: g && g.entryLevel, noKey: fibGeom({ kind: 'fib', key: 'a', entry: 1, stop: 0.9 }) };
    });
    const wantLv = { L1: 4170.2992, L2: 4155.546, L3: 4142.134, L4: 4127.3808 };
    Object.keys(wantLv).forEach(k => check(lv.lv && Math.abs(lv.lv[k] - wantLv[k]) < 1e-6, `fib ${k}: ${lv.lv && lv.lv[k]} want ${wantLv[k]}`));
    check(lv.entry === 'L3', 'zone 2 should enter at L3: ' + lv.entry);
    check(lv.noKey === null, 'an alert without a fib key has no levels');
    // What-ifs at L1 / L2 / L4 from the scanner, priced like the real result. The
    // Level filter scores each alert at the picked level: its own result where it
    // entered, the what-if elsewhere, and leaves out alerts with neither.
    const wi = await page.evaluate(() => {
      const rec = JSON.stringify({ id: 'fib|XAUTUSD|4h|1|1791374400|4215.9|2@1', kind: 'fib', market: 'crypto', tf: '4h', symbol: 'XAUTUSD', price: 4150, sent_ts: 1791806036, plan: { entry: 4142.134, sl: 4123.6925, side: 'long' } });
      const lvr = { 'fib|XAUTUSD|4h|1|1791374400|4215.9|2@1': { L1: { entry: 4170.2992, filled: true, resolved: true, outcome: 'SL', sl: true }, L2: { entry: 4155.546, outcome: 'not reached', filled: false, resolved: true }, L4: { entry: 4127.3808, filled: true, resolved: true, outcome: '2R', r1: true, r2: true } } };
      const g = parseFibTl(rec + '\n', '{}', JSON.stringify(lvr)).records[0];
      g.filled = true; g.outcome = '+1R'; g.resultR = 0.9;
      const l1 = { id: 'z1', kind: 'fib', key: 'fib|BTCUSD|4h|1|1791374400|100|1@z1', side: 'long', entry: 99, stop: 96, filled: true, outcome: 'SL', resultR: -1.05, date: '2026-10-12', time: '10:00', symbol: 'BTCUSD' };
      const pairs = [{ signal: g, trade: null }, { signal: l1, trade: null }];
      const at = k => { state.ui.sigKind = 'fib'; state.ui.sigLvl = k; return sigLvlPairs(pairs).map(p => ({ e: p.signal.entry, r: p.signal.resultR, f: p.signal.filled, wi: p.signal.lvlWhatIf || '', same: p.signal === g || p.signal === l1 })); };
      const out = { w: g.fibWhatIf, all: at(''), L1: at('L1'), L2: at('L2'), L3: at('L3'), L4: at('L4'), again: sigLvlPairs(pairs)[0].signal === sigLvlPairs(pairs)[0].signal };
      state.ui.sigKind = 'zone'; out.zone = sigLvlPairs(pairs).length; state.ui.sigLvl = '';
      return out;
    });
    // L4: risk 3.6883 on 4127.38 = 0.08936%; its 2R is out at the TP, 1R less 0.0826% / 0.08936% = 1 - 0.9243
    const l4r = 1 - 0.0826 / (Math.abs(4127.3808 - 4123.6925) / 4127.3808 * 100);
    check(wi.w && wi.w.L4 && Math.abs(wi.w.L4.resultR - l4r) < 1e-3, 'L4 what-if R: ' + JSON.stringify(wi.w && wi.w.L4));
    check(wi.w && wi.w.L2 && wi.w.L2.outcome === 'not reached' && wi.w.L2.resultR === null, 'L2 not reached: ' + JSON.stringify(wi.w && wi.w.L2));
    check(wi.all.length === 2 && wi.all.every(x => x.same), 'All levels keeps every alert as is: ' + JSON.stringify(wi.all));
    check(wi.L3.length === 1 && wi.L3[0].same && wi.L3[0].r === 0.9, 'L3 = the alert that entered at L3: ' + JSON.stringify(wi.L3));
    check(wi.L1.length === 2 && wi.L1[0].wi === 'L1' && wi.L1[0].r < 0 && Math.abs(wi.L1[0].e - 4170.2992) < 1e-6 && wi.L1[1].same, 'L1 = what-if + the L1 alert: ' + JSON.stringify(wi.L1));
    check(wi.L2.length === 1 && wi.L2[0].f === false && wi.L2[0].wi === 'L2', 'L2 never reached = no fill: ' + JSON.stringify(wi.L2));
    check(wi.L4.length === 1 && Math.abs(wi.L4[0].r - l4r) < 1e-3 && wi.L4[0].f === true, 'L4 = what-if result: ' + JSON.stringify(wi.L4));
    check(wi.again, 'same copy on every redraw');
    check(wi.zone === 2, 'Level ignored outside Fib alerts: ' + wi.zone);
    // Trendline Type: support = lower line (0), resistance = upper line (1); the line
    // comes from the key, or the side when an old key has none.
    const tt = await page.evaluate(() => {
      const mk = (id, line, side) => ({ signal: { id, kind: 'trendline', key: line == null ? 'tl|X' : 'tl|BTCUSD|4h|' + line + '|1|2@' + id, side, entry: 100, stop: 99 }, trade: null });
      const pairs = [mk('s1', 0, 'long'), mk('r1', 1, 'short'), mk('s2', 0, 'long'), mk('old', null, 'short'), mk('sb', 0, 'short'), mk('rb', 1, 'long')];
      const ids = k => { state.ui.sigKind = 'trendline'; state.ui.sigTlType = k; return sigLvlPairs(pairs).map(p => p.signal.id).join(); };
      const out = { all: ids(''), sup: ids('support'), res: ids('resistance'), spbr: ids('spbr'), rsbr: ids('rsbr') };
      state.ui.sigKind = 'fib'; out.fib = sigLvlPairs(pairs).length; state.ui.sigTlType = '';
      return out;
    });
    check(tt.all === 's1,r1,s2,old,sb,rb' && tt.sup === 's1,s2' && tt.res === 'r1,old' && tt.spbr === 'sb' && tt.rsbr === 'rb' && tt.fib === 6, 'trendline type filter: ' + JSON.stringify(tt));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Fib, trendline and 1D+ zone results match the scanner');
  errs.forEach(e => { console.log('     ' + e); failures.push('fib/tl results: ' + e); });
}

// The Signals backtest report: drawn only once its section is open, and its
// numbers checked against a hand-worked run of seven results.
async function sigBacktestRun(seed) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  try {
    await page.goto(base, { waitUntil: 'load' });
    const v = await page.evaluate(() => {
      // In time order: +2 -1 -1 +1 | -1 +2 -1, then one never filled and one still open.
      // Equity 2 1 0 1 0 2 1: total +1R, peak 2, deepest fall 2R, 4 alerts under the peak.
      const rs = [2, -1, -1, 1, -1, 2, -1];
      const sg = (i, r, extra) => Object.assign({ id: 'bt' + i, key: 'k' + i, kind: 'trendline', date: '2026-10-0' + (i + 1), time: '10:00', symbol: 'S' + i + 'USD', side: i % 2 ? 'short' : 'long', score: '',
        market: 'CRYPTO', timeframe: i < 4 ? '4H' : '1D', channel: i < 4 ? 'CRYPTO 4H' : 'CRYPTO 1D', filled: true, outcome: r > 0 ? (r === 2 ? '+2R' : '+1R') : 'SL', resultR: r, hasReportR: true, price: 100, stop: 99, entry: 100 }, extra || {});
      state.signals = rs.map((r, i) => sg(i, r)).concat([sg(7, null, { filled: false, outcome: '', resultR: null, date: '2026-10-08' }), sg(8, null, { outcome: 'open', resultR: null, date: '2026-10-09' })]);
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'alerts', mktFilter: '', sigBtDim: 'channel', sigBtSort: null });
      switchTab('signals'); renderAll();
      const text = id => document.getElementById(id).innerText.replace(/\s+/g, ' ');
      const out = { lazy: [text('sigBacktest'), text('sigSetups')] };
      setSigSec('report');
      out.rep = text('sigBacktest');
      out.edgeStill = text('sigSetups');
      setSigSec('edge');
      out.edge = text('sigSetups');
      out.st = sigRunStats(rs);
      setSigSec('report');
      setSigBtSort('tot');
      const tbls = document.querySelectorAll('#sigBacktest table'); out.firstRow = (tbls[tbls.length - 1].querySelector('tbody tr') || {}).innerText || '';
      const said = [], realToast = toast, realUrl = URL.createObjectURL;
      toast = m => said.push(m); URL.createObjectURL = () => 'blob:x';
      exportSigBacktestCsv();
      toast = realToast; URL.createObjectURL = realUrl;
      out.said = said;
      return out;
    });
    check(v.lazy[0] === '' && v.lazy[1] === '', 'hidden sections should wait until opened: ' + JSON.stringify(v.lazy));
    check(v.edgeStill === '' && v.edge.length > 0, 'edge drawn only when opened: ' + JSON.stringify([v.edgeStill, v.edge.slice(0, 80)]));
    const st = v.st;
    check(st.n === 7 && st.tot === 1 && st.maxDD === 2 && st.longestDD === 4 && st.maxLs === 2 && st.maxWs === 1 && Math.abs(st.pf - 1.25) < 1e-9 && Math.abs(st.payoff - 5 / 3) < 1e-9 && st.wins === 3 && st.losses === 4, 'run stats: ' + JSON.stringify(st));
    const has = t => v.rep.toUpperCase().includes(t.toUpperCase());
    ['GRADED ALERTS 7', 'WIN RATE 43%', 'EXPECTANCY +0.14R', 'TOTAL R +1.00R', 'PROFIT FACTOR 1.25', 'AVERAGE WIN +1.67R', 'AVERAGE LOSS -1.00R', 'PAYOFF RATIO 1.67', 'MAX DRAWDOWN -2.00R longest 4 alerts', 'STREAKS 1W / 2L', 'FILL RATE 89%']
      .forEach(t => check(has(t), 'report should show "' + t + '": ' + v.rep.slice(0, 900)));
    check(/CRYPTO 4h 4 100% 4 50% \+0\.25R \+1\.00R 1\.50 -2\.00R/.test(v.rep) && /CRYPTO 1D 5 80% 3 33% \+0\.00R \+0\.00R 1\.00 -1\.00R/.test(v.rep), 'channel rows: ' + v.rep.slice(-700));
    check(/^CRYPTO 4h/.test(v.firstRow.trim()), 'sorted by total R: ' + v.firstRow);
    check(JSON.stringify(v.said) === '["Exported 9 alerts"]', 'CSV export: ' + JSON.stringify(v.said));
    // The % beside Total R / Average R is the price move (R × the 1% stops), and says so (v.177).
    const strip = await page.evaluate(() => { const el = document.getElementById('sigEdgeStrip'); return { t: el.innerText.replace(/\s+/g, ' '), tip: (el.querySelector('span[title*="price move"]') || {}).title || '' }; });
    check(/Total R \+1\.00R \(\+1\.00% price move\)/i.test(strip.t) && /Average R \+0\.14R \(\+0\.14% price move\)/i.test(strip.t) && /not an account return/.test(strip.tip), 'price move label: ' + JSON.stringify(strip));
    // The R curve (lakky, 2026-11-08): equity 0 2 1 0 1 0 2 1, so a 0-2R axis in 0.5R steps, the
    // deepest fall 2R, dates under alerts 1, 2, 4, 5 and 7, and a tip for the alert under the pointer.
    const c = await page.evaluate(() => ({ y: [...document.querySelectorAll('#sigBtChart .dc-y:not(.dc-y2) span')].map(s => s.textContent), y2: [...document.querySelectorAll('#sigBtChart .dc-y2 span')].map(s => s.textContent),
      x: [...document.querySelectorAll('#sigBtChart .dc-x span')].map(s => s.textContent), dd: document.querySelector('#sigBtChart .dc-ddlab').textContent, start: document.querySelector('#sigBtChart .dc-startlab').textContent,
      head: document.querySelector('#sigBtChart .dc-head').innerText.replace(/\s+/g, ' '), days: ['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-07'].map(fmtDay) }));
    check(JSON.stringify(c.y) === '["0R","+0.5R","+1.0R","+1.5R","+2.0R"]' && c.start === 'start 0R' && JSON.stringify(c.y2) === '["0R","-2.0R"]' && c.dd === 'Drawdown from the last high · max -2.00R', 'R curve axis 0-2R, drawdown 2R: ' + JSON.stringify(c));
    check(JSON.stringify(c.x) === JSON.stringify(c.days) && /^Equity curve, every alert at 1R total \+1\.00R · /.test(c.head), 'dates of alerts 1, 2, 4, 5, 7 and the total: ' + JSON.stringify(c));
    await page.$eval('#sigBtPlot', el => el.scrollIntoView({ block: 'center' }));
    const pb = await page.$eval('#sigBtPlot', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.mouse.move(pb.x + pb.w - 1, pb.y + pb.h / 2);
    const tip7 = await page.$eval('#sigBtPlot .dc-tip', t => t.innerText.replace(/\s+/g, ' ').trim());
    check(/^#7 · .* 10:00 S6USD Long 1D -1\.00R SL Total \+1\.00R -1\.00R from the high$/.test(tip7), 'tip at the last alert: ' + tip7);
    // On a phone or iPad a finger lifting also "leaves": the tip stays until a tap elsewhere.
    const touch = await page.evaluate(() => {
      const plot = document.getElementById('sigBtPlot'), r = plot.getBoundingClientRect(), tip = plot.querySelector('.dc-tip'), x = r.left + r.width / 7 * 2;
      const ev = (type, cx, el) => (el || plot).dispatchEvent(new PointerEvent(type, { clientX: cx, clientY: r.top + r.height / 2, pointerType: 'touch', bubbles: true }));
      ev('pointerdown', x); ev('pointerup', x); ev('pointerleave', x);
      const after = tip.classList.contains('hidden') ? 'hidden' : tip.innerText.replace(/\s+/g, ' ').trim();
      ev('pointerdown', 5, document.body);
      return { after, away: tip.classList.contains('hidden') };
    });
    check(/^#2 · .* S1USD Short 4H -1\.00R SL Total \+1\.00R -1\.00R from the high$/.test(touch.after) && touch.away, 'a tap keeps its tip until a tap elsewhere: ' + JSON.stringify(touch));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals backtest report: drawn when opened, numbers by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('signals backtest: ' + e); });
}

// Signals redesign (v.167): two filter panels that fold to one line, Reset, the Coins
// filter (Top 3 / Top 5 / Picks, by market cap or most alerts), the Backtest report's
// "How sure is this?" and "Top coins vs all crypto", worked out by hand. Then the
// rebuilt history (several MB from 1 Jun) is downloaded once, and fib / trendline
// records keep the scanner's fill and close times.
async function sigRedesignRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const H = 3600e3, cutoff = Date.now() - 2 * 24 * H, isoAt = t => new Date(t).toISOString();
  const sent = Math.floor((cutoff - 30 * H) / 1000), sentOld = Math.floor((cutoff - 60 * 24 * H) / 1000);
  const files = {
    // One rebuilt alert from 2 days back, one from 2 months back (older than any refresh window).
    'fibtl_rebuild_records.jsonl': JSON.stringify({ market: 'crypto', symbol: 'RBFIBUSD', tf: '1d', price: 101, kind: 'fib', plan: { side: 'long', entry: 100, sl: 99 },
      id: 'fib|RBFIBUSD@1|rb', key: 'fib|RBFIBUSD', sent_ts: sent, rebuild: true }) + '\n'
      + JSON.stringify({ market: 'crypto', symbol: 'RBOLDUSD', tf: '1d', price: 101, kind: 'fib', plan: { side: 'long', entry: 100, sl: 99 },
      id: 'fib|RBOLDUSD@1|rb', key: 'fib|RBOLDUSD', sent_ts: sentOld, rebuild: true }),
    'fibtl_rebuild_results.json': JSON.stringify({ 'fib|RBFIBUSD@1|rb': { outcome: '2R', filled: true, resolved: true, r1: true, r2: true, sl: false, be: false, fill_ts: sent + 3600, end_ts: sent + 6 * 3600 } }),
    'fibtl_rebuild_meta.json': JSON.stringify({ cutoff: isoAt(cutoff), built_at: isoAt(cutoff) }),
  };
  const hits = {};
  await ctx.route(url => !url.href.startsWith(base), async r => {
    const u = r.request().url();
    if (!u.includes('/scanner-runtime-state/')) return r.abort();
    const f = u.split('/').pop().split('?')[0];
    hits[f] = (hits[f] || 0) + 1;
    return r.fulfill({ status: 200, body: files[f] != null ? files[f] + '\n' : f.endsWith('.json') ? '{}' : '' });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => (state.signals || []).some(g => g.symbol === 'RBFIBUSD'), null, { timeout: 8000 });
    // Fill and close times: 1h and 6h after the alert, so 5 hours in the trade.
    const rb = await page.evaluate(() => { const g = state.signals.find(x => x.symbol === 'RBFIBUSD'); return [g.endTs - g.fillTs, g.outcome]; });
    check(rb[0] === 5 * 3600 && rb[1] === '+1R', 'rebuilt record keeps fill / close times: ' + JSON.stringify(rb));
    const once = Object.assign({}, hits);
    await page.evaluate(() => autoRefreshAlerts(true));
    await page.evaluate(() => autoRefreshAlerts(true));
    check(once['fibtl_rebuild_records.jsonl'] === 1 && hits['fibtl_rebuild_records.jsonl'] === 1 && hits['fibtl_rebuild_results.json'] === 1 && hits['zone_rebuild_4h.jsonl'] === 1,
      'rebuilt history read once while unchanged: ' + JSON.stringify(hits));
    check(hits['fibtl_rebuild_meta.json'] === 3 && hits['fib_trendline_alert_records.jsonl'] === 3, 'meta and live files read every time: ' + JSON.stringify(hits));
    // A new rebuild (new built_at) is read again, once.
    files['fibtl_rebuild_meta.json'] = JSON.stringify({ cutoff: isoAt(cutoff), built_at: isoAt(cutoff + 60e3) });
    await page.evaluate(() => autoRefreshAlerts(true));
    await page.evaluate(() => autoRefreshAlerts(true));
    check(hits['fibtl_rebuild_records.jsonl'] === 2, 'a new rebuild is read once more: ' + JSON.stringify(hits));
    // lakky, 2026-11-09 (Fib 608 -> 531 on one PC): after "Delete all signals" the device took
    // back only the last days, and "Load scanner alerts" (Last 1 month) only a month, while it
    // still counted the rebuild as taken. The whole rebuilt history must come back either way.
    const syms = () => page.evaluate(() => (state.signals || []).filter(g => g.rb).map(g => g.symbol).sort().join(','));
    check(await syms() === 'RBFIBUSD,RBOLDUSD', 'both rebuilt alerts held: ' + await syms());
    await page.evaluate(() => { state.signals = []; save(); return autoRefreshAlerts(true); });
    check(await syms() === 'RBFIBUSD,RBOLDUSD', 'after Delete all signals the rebuilt history comes back: ' + await syms());
    check(hits['fibtl_rebuild_records.jsonl'] === 3, 'read again because the device lost it: ' + JSON.stringify(hits));
    await page.evaluate(() => autoRefreshAlerts(true));
    check(hits['fibtl_rebuild_records.jsonl'] === 3, 'then skipped again while held: ' + JSON.stringify(hits));
    await page.evaluate(() => { state.signals = []; save(); openScannerImport(); });
    await page.waitForFunction(() => /alerts/.test((document.getElementById('scanStatus') || {}).innerText || '') && !/Fetching/.test(document.getElementById('scanStatus').innerText), null, { timeout: 8000 });
    const st = await page.evaluate(() => document.getElementById('scanStatus').innerText);
    check(/with the scanner's rebuilt history/.test(st), 'Load scanner alerts says it brings the rebuilt history: ' + st);
    await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(300);
    check(await syms() === 'RBFIBUSD,RBOLDUSD', 'Load scanner alerts (Last 1 month) brings the whole rebuilt history: ' + await syms());

    const v = await page.evaluate(() => {
      const text = id => (document.getElementById(id) || {}).innerText.replace(/\s+/g, ' ');
      const out = {};
      out.coins = ['BTCUSD', 'ETHUSD', '1000PEPEUSD', 'TSLAXUSD', 'SOXLBUSD', 'NVDAXUSD', 'MRVL', 'XAUTUSD', 'SLVONUSD', 'TRXUSD', 'S0USD'].map(s => coinOf({ symbol: s, market: 'CRYPTO' }) || '-').join(' ')
        + ' ' + (coinOf({ symbol: 'RELIANCE', market: 'NSE' }) || '-');
      // In time order. BTC +2 +2 -1 +2 | ETH +2 -1 +2 | XRP -1 | BNB +2 | SOL -1 -1 | DOGE -1 -1 -1 | ADA -1 +2,
      // then an xStock, gold and an NSE stock (not coins).
      const plan = [['BTC', 2], ['BTC', 2], ['BTC', -1], ['BTC', 2], ['ETH', 2], ['ETH', -1], ['ETH', 2], ['XRP', -1], ['BNB', 2], ['SOL', -1], ['SOL', -1],
        ['DOGE', -1], ['DOGE', -1], ['DOGE', -1], ['ADA', -1], ['ADA', 2], ['TSLAX', 2], ['XAUT', -1], ['RELIANCE', -1]];
      const hrs = [2, 4, 10, 30];
      state.signals = plan.map(([c, r], i) => {
        const nse = c === 'RELIANCE', t0 = Date.parse('2026-10-' + String(i + 1).padStart(2, '0') + 'T10:00:00+05:30') / 1000;
        const g = { id: 'rd' + i, key: 'rd' + i, kind: 'fib', date: '2026-10-' + String(i + 1).padStart(2, '0'), time: '10:00', symbol: nse ? c : c + 'USD', side: 'long', score: '',
          market: nse ? 'NSE' : 'CRYPTO', timeframe: '4H', channel: (nse ? 'NSE' : 'CRYPTO') + ' 4H', filled: true, outcome: r > 0 ? '+2R' : 'SL', resultR: r, hasReportR: true, price: 100, stop: 99, entry: 100 };
        if (c === 'BTC') { g.fillTs = t0 + 600; g.endTs = g.fillTs + hrs[i] * 3600; }
        return g;
      });
      Object.assign(state.ui, { sigKind: 'fib', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'alerts', mktFilter: '', sigTgt: '', sigNoFee: false,
        sigStop: { mode: 'off' }, sigTrail: { on: false }, sigHold: 'tp', sigCoins: '', sigCoinRank: 'cap', sigCoinPicks: undefined, sigFold: {}, sigLvl: '' });
      switchTab('signals'); renderAll();
      const alerts = () => text('sigEdgeStrip').match(/Alerts (\d+)/)[1];
      out.all = alerts();
      out.panels = [!!document.querySelector('#sigWhichPanel #sigPeriodBar'), !!document.querySelector('#sigRulesPanel #sigTgtBar'), !!document.querySelector('#sigWhichPanel #sigCoinBar')];
      document.querySelector('#sigCoinBar button[data-coins="top3"]').click();
      out.top3 = [alerts(), text('sigCoinList'), /Total R \+7\.00R/.test(text('sigEdgeStrip')), text('sigWhichSum'), text('sigPeriodHint')];
      document.getElementById('sigCoinRank').value = 'alerts'; document.getElementById('sigCoinRank').dispatchEvent(new Event('change'));
      out.byAlerts = [alerts(), text('sigCoinList')];
      setSigCoinRank('cap');
      document.querySelector('#sigCoinBar button[data-coins="picks"]').click();
      out.picks = [alerts(), [...document.querySelectorAll('#sigCoinPicks .sig-coin.on')].map(b => b.dataset.coin).join(',')];
      document.querySelector('#sigCoinPicks button[data-coin="SOL"]').click();
      out.unpick = [alerts(), JSON.stringify(state.ui.sigCoinPicks)];
      toggleSigCoinPick('SOL');
      // The report, with Top 3 picked: its numbers are Top 3's, the compare has every group.
      setSigCoins('top3'); setSigSec('report');
      out.rep = text('sigBacktest');
      out.sure = text('sigSure');
      out.rows = [...document.querySelectorAll('#sigCoinCmp tbody tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').trim());
      out.cur = (document.querySelector('#sigCoinCmp tr.cur') || {}).innerText;
      out.verdict = text('sigCoinCmp').match(/Top 3 [^\n]*?(likely real, not luck|maybe: needs more alerts|could be luck|too few alerts to tell)/);
      out.verdict = out.verdict && out.verdict[1];
      out.lastTable = (() => { const t = document.querySelectorAll('#sigBacktest table'); return t[t.length - 1].querySelector('thead').innerText.replace(/\s+/g, ' '); })();
      // Pure figures.
      const a = [2, 2, 2, -1, 2, 2, 2, -1, 2, 2, 2, -1], b = [-1, -1, 2, -1, -1, -1, 2, -1, -1, -1, -1, -1];
      out.gap = [sigGapWord(sigGap(a, b)).w, sigGapWord(sigGap(a, a.slice().reverse())).w, sigGapWord(sigGap(a.slice(0, 5), b)).w];
      out.mean = sigMeanRange(sigRunStats([2, -1, -1, 1, -1, 2, -1]));
      out.win = sigWinRange(3, 7);
      // Panels: fold one, it says its settings in one line; Reset inside the title doesn't unfold it.
      setSigSec('alerts'); setSigCoins('');
      return out;
    });
    check(v.coins === 'BTC ETH 1000PEPE - - - - - - TRX S0 -', 'coins: ' + v.coins);
    check(v.all === '19' && v.panels.every(Boolean), 'all alerts, panels: ' + JSON.stringify([v.all, v.panels]));
    check(v.top3[0] === '8' && v.top3[1] === 'BTC, ETH, XRP' && v.top3[2] && /Top 3 \(BTC, ETH, XRP\)/.test(v.top3[3]) && /BTC, ETH, XRP/.test(v.top3[4]), 'Top 3: ' + JSON.stringify(v.top3));
    check(v.byAlerts[0] === '10' && v.byAlerts[1] === 'BTC, DOGE, ETH', 'Top 3 by most alerts: ' + JSON.stringify(v.byAlerts));
    check(v.picks[0] === '9' && v.picks[1] === 'BTC,ETH,SOL' && v.unpick[0] === '7' && v.unpick[1] === '["BTC","ETH"]', 'picks: ' + JSON.stringify([v.picks, v.unpick]));
    // Top 3: 8 results, total +7, 5 wins; BTC's times 2h 4h 10h 30h: median 7h.
    check(/GRADED ALERTS 8/i.test(v.rep) && /TOTAL R \+7\.00R/i.test(v.rep) && /Too few to trust · 8/.test(v.sure) && /median 7\.0h/.test(v.sure) && /4 trades, fill to close/.test(v.sure), 'report on Top 3: ' + v.sure);
    const row = k => v.rows.find(r => r.startsWith(k)) || '';
    check(/^All crypto 7 coins 16 16 44% \+0\.31R .* \+5\.00R/.test(row('All crypto')), 'all crypto row: ' + row('All crypto'));
    check(/^Top 3 BTC, ETH, XRP 8 8 63% \+0\.88R .* \+7\.00R/.test(row('Top 3')), 'top 3 row: ' + row('Top 3'));
    check(/^Top 5 BTC, ETH, XRP, BNB, SOL 11 11 55% \+0\.64R .* \+7\.00R/.test(row('Top 5')), 'top 5 row: ' + row('Top 5'));
    check(/^Other coins not in the top 5 5 5 20% -0\.40R .* -2\.00R/.test(row('Other coins')), 'other coins row: ' + row('Other coins'));
    check(/^Your picks BTC, ETH, SOL 9 9 56% \+0\.67R .* \+6\.00R/.test(row('Your picks')), 'picks row: ' + row('Your picks'));
    check(/^BTC 4 4 75% \+1\.25R/.test(row('BTC')) && /^DOGE/.test(row('DOGE')) === false, 'each coin: ' + v.rows.join(' | '));
    check(/^Top 3/.test(v.cur || '') && v.verdict === 'too few alerts to tell', 'current group and verdict: ' + JSON.stringify([v.cur, v.verdict]));
    check(/^Channel/i.test(v.lastTable.trim()), 'breakdown table stays last: ' + v.lastTable);
    check(JSON.stringify(v.gap) === '["likely real, not luck","could be luck","too few alerts to tell"]', 'gap words: ' + JSON.stringify(v.gap));
    // t(6) = 2.447 from the table: 1/7 ± 2.447 × 1.4639 / √7.
    check(v.mean && Math.abs(v.mean.lo - (1 / 7 - 2.447 * 1.46385 / Math.sqrt(7))) < 0.02 && Math.abs(v.mean.hi - (1 / 7 + 2.447 * 1.46385 / Math.sqrt(7))) < 0.02, 'mean range: ' + JSON.stringify(v.mean));
    check(v.win && Math.abs(v.win.lo - 15.82) < 0.05 && Math.abs(v.win.hi - 74.95) < 0.05, 'Wilson 3 of 7: ' + JSON.stringify(v.win));
    // Fold the rules panel by its title; it says its settings; Reset doesn't unfold it.
    await page.click('#sigRulesPanel > summary h3');
    // The details "toggle" event fires on a later task, so wait for it to be saved.
    await page.waitForFunction(() => state.ui.sigFold && state.ui.sigFold.rules === true, null, { timeout: 5000 }).catch(() => {});
    await page.evaluate(() => setSigTgt('2R'));
    const f1 = await page.evaluate(() => ({ open: document.getElementById('sigRulesPanel').open, fold: state.ui.sigFold, sum: document.getElementById('sigRulesSum').innerText, reset: !!document.getElementById('sigRulesResetBtn') }));
    check(f1.open === false && f1.fold.rules === true && /exit at 2R · stop stays · held till TP or SL · with fees/.test(f1.sum) && f1.reset, 'folded rules: ' + JSON.stringify(f1));
    await page.click('#sigRulesResetBtn');
    const f2 = await page.evaluate(() => ({ open: document.getElementById('sigRulesPanel').open, tgt: state.ui.sigTgt, sum: document.getElementById('sigRulesSum').innerText, reset: !!document.getElementById('sigRulesResetBtn') }));
    check(f2.open === false && f2.tgt === '' && f2.sum === "scanner's own exits · with fees" && !f2.reset, 'after Reset: ' + JSON.stringify(f2));
    await page.reload({ waitUntil: 'load' });
    await page.evaluate(() => { switchTab('signals'); renderAll(); });
    const f3 = await page.evaluate(() => [document.getElementById('sigRulesPanel').open, document.getElementById('sigWhichPanel').open]);
    check(f3[0] === false && f3[1] === true, 'fold kept after reload: ' + JSON.stringify(f3));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals redesign: panels, Coins filter, top coins compare, how sure, history read once, by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('signals redesign: ' + e); });
}

// Charts (lakky, 2026-11-08: "anywhere where graph is using or showing make it usable and
// more informative"). The Dashboard's and the broker report's tips worked out by hand, then the
// Dashboard chart on the real Chart.js: the same file the page loads from the CDN (same
// integrity hash), served here from node_modules.
async function chartsRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const cdn = u => u.href.startsWith('https://cdn.jsdelivr.net/npm/chart.js@');
  const lib = fs.readFileSync(path.join(ROOT, 'node_modules/chart.js/dist/chart.umd.js'));
  await ctx.route(cdn, r => r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: lib }));
  await ctx.route(url => !url.href.startsWith(base) && !cdn(url), r => r.abort());
  // Three crypto trades today: +$3, -$1, +$2.
  const d = new Date(Date.now() - 5.5 * 3600e3), today = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const tr = (i, exit, qty) => ({ id: 'ch' + i, accountId: 'acc_cry', date: today, exitDate: today, time: '10:1' + i, exitTime: '11:00', symbol: 'BTCUSD', direction: 'long', entry: 100, exit, stop: 99, qty, fees: 0, leverage: 10, setup: 'Breakout', notes: '', updatedAt: seed.savedAt, pnl: (exit - 100) * qty, risk: qty, r: exit - 100 });
  const data = Object.assign({}, seed, { trades: [tr(0, 101, 3), tr(1, 99.5, 2), tr(2, 102, 1)] });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(data));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  try {
    await page.goto(base, { waitUntil: 'load' });
    // By hand: a day that closed at +$10 (+$11 before fees), made +$4 on 3 trades, $2 under a +$12 high.
    const p = await page.evaluate(() => {
      const dd = { date: '2026-11-05', n: 3, w: 2, l: 1, pnl: 4, net: 10, gross: 11, dd: -2, peak: 12 };
      const closed = [{ net: 5, fees: 0.5, held: 90 }, { net: -8, fees: 0, held: null }], data = [0, 5, -3];
      return { net: eqTipLines(dd, 'net', 'USD'), gross: eqTipLines(dd, 'gross', 'USD'), dd: eqTipLines(dd, 'dd', 'USD'), one: eqTipLines(Object.assign({}, dd, { n: 1, w: 1, l: 0, dd: 0 }), 'net', 'USD'),
        bt: [0, 1, 2].map(i => btTipLines(closed, data, i, 'USD')), day: longDay('2026-11-05'), held: btHeld(90) };
    });
    check(JSON.stringify(p.net) === '["Total +$10.00","That day +$4.00 · 3 trades (2W / 1L)","Under the high by $2.00"]', 'equity tip, net: ' + JSON.stringify(p.net));
    check(p.gross[0] === 'Total before fees +$11.00' && JSON.stringify(p.dd) === '["Drawdown -$2.00 from a high of +$12.00","That day +$4.00 · 3 trades (2W / 1L)"]', 'equity tip, gross and drawdown: ' + JSON.stringify([p.gross, p.dd]));
    check(JSON.stringify(p.one) === '["Total +$10.00","That day +$4.00 · 1 trade (1W / 0L)"]', 'one trade, at the high: ' + JSON.stringify(p.one));
    check(/^Thu,? 5 Nov 2026$/.test(p.day), 'a day in full: ' + p.day);
    check(JSON.stringify(p.bt) === JSON.stringify(['Start +$0.00', ['Trade +$5.00 (fees $0.50)', 'Held ' + p.held, 'Total +$5.00'], ['Trade -$8.00', 'Total -$3.00', 'Under the high by $8.00']]), 'broker report tip: ' + JSON.stringify(p.bt));
    // The real chart: hovering anywhere over it picks today and shows what it did.
    await page.evaluate(() => { state.ui.allCur = 'USD'; switchTab('dashboard'); renderAll(); });
    await page.waitForFunction(() => typeof Chart !== 'undefined' && mainEquityChartInstance, null, { timeout: 10000 });
    await page.evaluate(() => { state.ui.allCur = 'USD'; renderAll(); });
    await page.$eval('#mainEquityChart', el => el.scrollIntoView({ block: 'center' }));
    const tipOf = async () => {
      const b = await page.$eval('#mainEquityChart', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
      await page.mouse.move(b.x + b.w * 0.3, b.y + b.h * 0.2); await page.mouse.move(b.x + b.w * 0.5, b.y + b.h * 0.9);
      return page.evaluate(() => { const t = mainEquityChartInstance.tooltip; return { on: !!(t && t.getActiveElements().length), title: t && t.title, body: ((t && t.body) || []).map(x => x.lines).flat(), opts: mainEquityChartInstance.options.interaction }; });
    };
    let t = await tipOf();
    const want = await page.evaluate(day => longDay(day), today);
    check(t.on && JSON.stringify(t.title) === JSON.stringify([want]) && JSON.stringify(t.body) === '["Total +$4.00","That day +$4.00 · 3 trades (2W / 1L)"]' && t.opts.mode === 'index' && t.opts.intersect === false,
      'Dashboard chart: hover far from the point still shows today: ' + JSON.stringify(t));
    await page.evaluate(() => changeChartMetric('dd'));
    t = await tipOf();
    check(JSON.stringify(t.body) === '["Drawdown +$0.00 from a high of +$4.00","That day +$4.00 · 3 trades (2W / 1L)"]', 'Drawdown view tip: ' + JSON.stringify(t.body));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Charts: Dashboard and broker report tips by hand, on the real Chart.js');
  errs.forEach(e => { console.log('     ' + e); failures.push('charts: ' + e); });
}

// Demo account: $100 that takes every graded alert in order and compounds. The
// numbers are worked out by hand from seven alerts at a 1% stop: +2 -1 -1 +1 -1 +2 -1.
async function demoAccountRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const load = () => page.evaluate(() => {
    const rs = [2, -1, -1, 1, -1, 2, -1];
    const sg = (i, r, extra) => Object.assign({ id: 'dm' + i, key: 'd' + i, kind: 'trendline', date: '2026-10-0' + (i + 1), time: '10:00', symbol: 'S' + i + 'USD', side: i % 2 ? 'short' : 'long', score: '',
      market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H', filled: true, outcome: r > 0 ? (r === 2 ? '+2R' : '+1R') : 'SL', resultR: r, hasReportR: true, price: 100, stop: 99, entry: 100 }, extra || {});
    state.signals = rs.map((r, i) => sg(i, r)).concat([sg(7, null, { filled: false, outcome: '', resultR: null, date: '2026-10-08' })]);
    Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', mktFilter: '', sigTgt: '', sigNoFee: false });
    // These made-up coins aren't on Delta, so the money is checked with real orders off
    // (any size); real orders have their own test (demoRealRun).
    state.ui.sigDemo = Object.assign({}, state.ui.sigDemo || {}, { real: false });
    // The trade list is folded by default; these checks read it, so it starts open here.
    demoTrOpen = true;
    switchTab('signals'); renderAll();
  });
  const text = () => page.evaluate(() => document.getElementById('sigDemo').innerText.replace(/\s+/g, ' '));
  const realOff = () => page.click('#sigDemo button[data-real="0"]');
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => { state.ui.sigSec = 'alerts'; });
    await load();
    check(await text() === '', 'Demo account waits until opened');
    await page.evaluate(() => setSigSec('demo'));
    // 1% of the balance: 100 → 102 → 100.98 → 99.9702 → 100.9699 → 99.9602 → 101.9594 → 100.9398.
    let t = await text();
    ['Final balance $100.94', 'from $100.00 · peak $102.00', 'Return +0.94%', 'Trades 7', '3W / 4L', 'Max drawdown -2.00%', '-$2.04 at most', 'Lowest balance $99.96', 'Leverage needed 1.0x']
      .forEach(x => check(t.includes(x), 'default demo should show "' + x + '": ' + t.slice(0, 700)));
    check(/Same alerts, other risk sizes .*2% \$101\.76 \+1\.76%/.test(t), '2% row (100 → 101.7586): ' + t.slice(0, 1400));
    const first = await page.$eval('#sigDemoTrades tbody tr', tr => tr.innerText.replace(/\s+/g, ' ').trim());
    check(/^7 2026-10-07 10:00 S6USD Long 4H 1\.00% -1\.00R SL \$1\.02 \$101\.96 · 1\.0x — -\$0\.08 -\$1\.02 \$100\.94$/.test(first), 'newest trade first, with its fee: ' + first);
    check((await text()).includes('Real orders off: every trade at its exact risk ÷ stop size') && (await text()).includes('0 of 7 placed'), 'real orders off says so, and that none of these made-up coins is on Delta');
    // Fees (lakky, 2026-11-07): on by default at Delta's rates and said in money. Worked out
    // here apart from the app: each result already carries 0.0826R of fee on a 1% stop, so the
    // fee paid is risk × 0.0826 and the result before fees is R + 0.0826.
    const RS = [2, -1, -1, 1, -1, 2, -1];
    const play = feePct => { let b = 100, f = 0; RS.forEach(r => { const risk = b / 100, fee = risk * feePct; f += fee; b += risk * (r + 0.0826) - fee; }); return { b, f }; };
    const usd = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const lm = play(0.0826), none = play(0), mm = play(0.118), ll = play(0.0472);
    t = await text();
    check(t.includes('Fees on · Delta · limit in, market out: 0.02% maker in + 0.05% taker out + 18% GST = 0.0826% of each position.'), 'fee line says on, broker and rate: ' + t.slice(0, 900));
    check(t.includes('Paid ' + usd(lm.f) + ' on 7 trades') && t.includes('Without fees: ' + usd(none.b)) && t.includes('Final balance ' + usd(lm.b)) && t.includes('after fees'), 'fees paid ' + usd(lm.f) + ', without ' + usd(none.b) + ': ' + t.slice(0, 900));
    const feeCol = await page.$$eval('#sigDemoTrades tbody tr', trs => trs.map(tr => tr.children[8].innerText.trim()));
    check(feeCol.length === 7 && feeCol.every(x => /^-\$0\.0[89]$/.test(x)), 'a fee on every trade: ' + JSON.stringify(feeCol));
    // Market in and out: 0.05% + 0.05% + GST = 0.118%; limit both: 0.0472%.
    await page.selectOption('#sigDemoOrders', 'mm');
    t = await text();
    check(t.includes('0.05% taker in + 0.05% taker out + 18% GST = 0.1180%') && t.includes('Final balance ' + usd(mm.b)) && t.includes('Paid ' + usd(mm.f)), 'market in and out → ' + usd(mm.b) + ': ' + t.slice(0, 700));
    await page.selectOption('#sigDemoOrders', 'll');
    t = await text();
    check(t.includes('= 0.0472%') && t.includes('Final balance ' + usd(ll.b)), 'limit in and out → ' + usd(ll.b) + ': ' + t.slice(0, 700));
    await page.selectOption('#sigDemoOrders', 'lm');
    // CoinDCX: same rates as Delta on lakky's fills, so the same balance; its rates are its own.
    await page.click('#sigDemo button[data-broker="coindcx"]');
    t = await text();
    check(t.includes('Fees on · CoinDCX · limit in') && t.includes('Final balance ' + usd(lm.b)), 'CoinDCX: ' + t.slice(0, 700));
    await page.fill('#sigDemoTk', '0.1');
    const dcx = play((0.02 + 0.1) * 1.18);
    t = await text();
    check(t.includes('0.02% maker in + 0.1% taker out + 18% GST = 0.1416%') && t.includes('Final balance ' + usd(dcx.b)), 'CoinDCX taker 0.1% → ' + usd(dcx.b) + ': ' + t.slice(0, 700));
    check(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'sigDemoTk', 'typing a fee keeps focus');
    await page.click('#sigDemo button[data-broker="delta"]');
    check(await page.inputValue('#sigDemoTk') === '0.05' && (await text()).includes('Final balance ' + usd(lm.b)), 'Delta keeps its own 0.05% taker');
    for (const v of ['', '-0.01', '2']) { await page.fill('#sigDemoMk', v); check((await text()).includes('Enter the maker and taker fees'), 'maker "' + v + '" says what is wrong: ' + (await text()).slice(0, 300)); }
    await page.fill('#sigDemoMk', '0.02');
    // No fees is the tab's Fees switch: the line says off and what fees would have cost.
    await page.click('#sigDemo button[data-broker="off"]');
    t = await text();
    check(await page.evaluate(() => state.ui.sigNoFee === true) && t.includes('Fees off') && t.includes('Final balance ' + usd(none.b)) && t.includes("With Delta's fees (limit in, market out, 0.0826%): " + usd(lm.b)) && !(await page.$('#sigDemoOrders')), 'no fees: ' + t.slice(0, 700));
    check(await page.$eval('#sigFeeBar button[data-nofee="1"]', b => b.className.includes('text-amber-400')), 'the tab Fees switch shows Without');
    await page.click('#sigDemo button:has-text("Charge fees")');
    t = await text();
    check(await page.evaluate(() => state.ui.sigNoFee === false) && t.includes('Fees on · Delta') && t.includes('Final balance ' + usd(lm.b)), 'charge fees turns them back on: ' + t.slice(0, 400));
    // Reset puts the broker, orders and rates back.
    await page.selectOption('#sigDemoOrders', 'mm'); await page.click('#sigDemo button[data-broker="coindcx"]');
    await page.click('#sigDemo button:has-text("Reset")');
    check(await page.inputValue('#sigDemoOrders') === 'lm' && (await text()).includes('Fees on · Delta') && (await page.inputValue('#sigDemoTk')) === '0.05', 'reset: Delta, limit in, market out');
    check((await text()).includes('Real orders on · Delta'), 'reset turns real orders back on');
    await realOff();
    // A new balance redraws the results and keeps the box focused.
    await page.fill('#sigDemoStart', '1000');
    t = await text();
    check(t.includes('Final balance $1,009.40') && t.includes('Return +0.94%'), '$1,000 start: ' + t.slice(0, 500));
    check(await page.evaluate(() => document.activeElement && document.activeElement.id) === 'sigDemoStart', 'typing keeps focus in the balance box');
    // Fixed $10: 1000 → 1020 → 1010 → 1000 → 1010 → 1000 → 1020 → 1010; deepest fall 20 from 1020.
    await page.click('#sigDemo button[data-mode="fixed"]');
    await page.fill('#sigDemoRisk', '10');
    t = await text();
    check(t.includes('Final balance $1,010.00') && t.includes('Return +1.00%') && t.includes('Max drawdown -1.96%') && t.includes('-$20.00 at most'), 'fixed $10: ' + t.slice(0, 600));
    // Kept on the device: a reload opens on the same settings.
    await page.reload({ waitUntil: 'load' });
    await load();
    await page.evaluate(() => setSigSec('demo'));
    const kept = await page.evaluate(() => ({ start: document.getElementById('sigDemoStart').value, risk: document.getElementById('sigDemoRisk').value, t: document.getElementById('sigDemo').innerText.replace(/\s+/g, ' ') }));
    check(kept.start === '1000' && kept.risk === '10' && kept.t.includes('Final balance $1,010.00'), 'settings kept after reload: ' + JSON.stringify(kept).slice(0, 300));
    // Fees off: each result gets 0.0826% / 1% = 0.0826R back (worked out here, apart from the app).
    await page.evaluate(() => setSigNoFee(true));
    let b = 1000; [2, -1, -1, 1, -1, 2, -1].forEach(r => { b += 10 * (r + 0.0826); });
    t = await text();
    check(t.includes('Final balance $' + b.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })), 'no fees → $' + b.toFixed(2) + ': ' + t.slice(0, 500));
    await page.evaluate(() => setSigNoFee(false));
    // Rupees, then reset to $100 at 1%.
    await page.click('#sigDemo button[data-cur="INR"]');
    check((await text()).includes('Final balance ₹1,010.00'), 'rupee label: ' + (await text()).slice(0, 400));
    await page.click('#sigDemo button:has-text("Reset")');
    await realOff();
    check((await text()).includes('Final balance $100.94'), 'reset to $100 at 1%: ' + (await text()).slice(0, 400));
    // Wrong inputs say what is wrong instead of drawing nonsense.
    const bad = [['#sigDemoStart', '', 'Enter a starting balance above 0.'], ['#sigDemoStart', '-5', 'Enter a starting balance above 0.'], ['#sigDemoStart', '1e13', 'too large'], ['#sigDemoStart', '100', 'Final balance $100.94'],
      ['#sigDemoRisk', '0', 'as a % above 0'], ['#sigDemoRisk', '150', "can't be more than 100%"], ['#sigDemoRisk', '1', 'Final balance $100.94']];
    for (const [sel, val, want] of bad) { await page.fill(sel, val); const x = await text(); check(x.includes(want), sel + ' = "' + val + '" should say "' + want + '": ' + x.slice(0, 300)); }
    await page.click('#sigDemo button[data-mode="fixed"]');
    await page.fill('#sigDemoRisk', '500');
    check((await text()).includes('more than the starting balance'), 'risk over the balance warns');
    // Pure checks: a leverage cap, a blown account, and a stop the account can't pay.
    const p = await page.evaluate(() => {
      const rows = [2, -1, -1, 1, -1, 2, -1].map(r => ({ r, slp: 1 }));
      const capped = demoRun(rows, { start: 100, mode: 'pct', pct: 5, lev: 2 }), two = demoRun(rows, { start: 100, mode: 'pct', pct: 2, lev: 0 });
      const blown = demoRun([{ r: -1.2, slp: 1 }, { r: -1, slp: 1 }, { r: -1, slp: 1 }], { start: 100, mode: 'fixed', fixed: 50, lev: 0 });
      const all = demoRun([{ r: -1.5, slp: 0.5 }], { start: 100, mode: 'pct', pct: 100, lev: 0 });
      // A fee: risk 1 on a 0.5% stop = a 200 position; 0.1% of it is 0.2 = 0.2R.
      const fee = demoRun([{ r: 2, slp: 0.5, fee: 0.2 }, { r: -1, slp: 0.5, fee: 0.2 }], { start: 100, mode: 'fixed', fixed: 1, lev: 0 });
      // NSE pays 0.1063% whatever the broker; no stop, no fee.
      const keep = demoRows;
      demoRows = [{ g: 1, slp: 0.5, nse: true }, { g: 1, slp: 0.5, nse: false }, { g: 1, slp: null, nse: false }];
      const pl = demoPlay({ feePct: 0.118 }, true).map(x => x.fee), off = demoPlay({ feePct: 0.118 }, false).map(x => x.fee);
      demoRows = keep;
      return { feeEnd: fee.end, fees: fee.fees, fee0: fee.trades[0].fee, pl, off, capEnd: capped.end, twoEnd: two.end, capN: capped.capped, capLev: capped.maxLev, blownAt: blown.blownAt, blownEnd: blown.end, blownN: blown.trades.length, allEnd: all.end, allLev: all.maxLev };
    });
    check(Math.abs(p.capEnd - p.twoEnd) < 1e-9 && Math.abs(p.twoEnd - 101.7586070) < 1e-6 && p.capN === 7 && p.capLev === 2, '5% risk capped at 2x on a 1% stop = 2% risk: ' + JSON.stringify(p));
    check(p.blownAt === 1 && p.blownEnd === 0 && p.blownN === 2, 'fixed $50: 100 → 40 → 0, blown on trade 2: ' + JSON.stringify(p));
    check(p.allEnd === 0 && p.allLev === 200, 'a loss past the balance stops at 0; 100% on a 0.5% stop needs 200x: ' + JSON.stringify(p));
    check(Math.abs(p.feeEnd - 100.6) < 1e-9 && Math.abs(p.fees - 0.4) < 1e-9 && Math.abs(p.fee0 - 0.2) < 1e-9, 'fixed 1 at 0.2R fee: 100 + 1.8 - 1.2 = 100.60, 0.40 paid: ' + JSON.stringify(p));
    check(Math.abs(p.pl[0] - 0.2126) < 1e-9 && Math.abs(p.pl[1] - 0.236) < 1e-9 && p.pl[2] === 0 && p.off.every(x => x === 0), 'NSE 0.1063% / crypto 0.118% on a 0.5% stop, none without a stop or with fees off: ' + JSON.stringify(p));
    await page.fill('#sigDemoStart', '100'); await page.fill('#sigDemoRisk', '60');
    await page.evaluate(() => { state.signals.forEach(g => { if (g.resultR != null) g.resultR = -1; }); renderAll(); });
    t = await text();
    check(/Account blown on trade 2 of 7/.test(t) && t.includes('Final balance $0.00') && t.includes('Trades 2'), 'blown account says so: ' + t.slice(0, 500));
    // Phone: no sideways scroll on the page.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { demoReset(); });
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    check(sw <= 390, 'phone width scrolls sideways: ' + sw);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals demo account: $100 compounded by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('demo account: ' + e); });
}

// Demo account deep data (lakky, 2026-11-08: "graph does not show proper view ... every day
// trades and every weeks trades and avg hold time avg top 3-5 cryptos"). Nine alerts on
// 5-15 Oct, $1 fixed risk on 1% stops at Delta's fees (the fee the scanner's R already
// carries), so each trade's money is its R:
//  1 05 Oct BTC +2 held 120m · 2 05 Oct ETH -1 60m · 3 06 Oct XRP +1 300m · 4 07 Oct DOGE -1 30m
//  5 08 Oct BNB +2 600m · 6 12 Oct SOL -1 90m · 7 13 Oct ADA +1 45m · 8 14 Oct BTC -1 (no times)
//  9 15 Oct ETH +2 1440m. Balance 100 → 102 → 101 → 102 → 101 → 103 → 102 → 103 → 102 → 104.
// Hold: 8 timed, avg 2685 / 8 = 335.6m, median 90m. Weeks: 5-11 Oct 5 trades +3 (3 / 2),
// avg hold 222m; 12-18 Oct 4 trades +1 (2 / 2), 525m. Top 3 (BTC ETH XRP): 5 trades +3,
// 60% won, avg 480m; Top 5 (+BNB SOL): 7 trades +4; All: 9 trades +4.
// Exit at times: A long 100 / 99 on 15m candles reaches 1R on the candle 15m after the fill;
// B short 200 / 202 never does and leaves on time 320 candles (4800m) after its fill.
async function demoDeepRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 820 }, timezoneId: 'Asia/Kolkata' });
  const t0 = Date.parse('2026-10-01T10:00:00+05:30') / 1000, Q = 900;
  const bars = { AUSD: [[t0, 100.2, 99.9, 100.1], [t0 + Q, 101.6, 100, 101.5], [t0 + 2 * Q, 102.1, 101, 101.2], [t0 + 3 * Q, 101, 98.9, 99]], BUSD: [] };
  for (let i = 0; i < 320; i++) bars.BUSD.push(i === 0 ? [t0, 200.1, 199.8, 199.9] : i === 1 ? [t0 + Q, 200.5, 198.5, 199] : [t0 + i * Q, 200, 199, 199.4]);
  let calls = 0, gone = false;
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const u = new URL(route.request().url()), b = bars[u.searchParams.get('symbol')];
    if (!b) return route.abort();
    calls++;
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: gone ? [] : b.map(([time, high, low, close]) => ({ time, open: close, high, low, close })) }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const text = sel => page.evaluate(s => { const el = document.querySelector(s); return el ? el.innerText.replace(/\s+/g, ' ').trim() : null; }, sel);
  try {
    await page.goto(base, { waitUntil: 'load' });
    // ---- Pure: walk times, the exit time of each rule, hold, labels, axis steps ----
    const p = await page.evaluate(t0 => {
      const sig = { side: 'long', entry: 100, stop: 99, timeframe: '4H', date: '2026-10-01', time: '10:00' }, Q = 900;
      const w = tgtWalk(sig, [{ time: t0, high: 100.1, low: 99.95, close: 100 }, { time: t0 + Q, high: 100.5, low: 99.9, close: 100.4 }, { time: t0 + 2 * Q, high: 101.2, low: 100.3, close: 101 },
        { time: t0 + 3 * Q, high: 102.1, low: 101.5, close: 102 }, { time: t0 + 4 * Q, high: 102, low: 98.9, close: 99 }], 15);
      const at = (tg, mv, tr) => { const o = tgtScore(sig, w, tg, true, mv, tr); return o && [o.label, o.at]; };
      return { ft: w.ft, te: w.te, pt: w.pt, r1: at({ r: 1 }), r2: at({ r: 2 }), r3: at({ r: 3 }), be: at({ r: 3 }, stopMove('be', 0.5)), trail: at({ r: 1 }, null, trailMove('R', 0.5, 0.5)),
        fill: tgtWalk(sig, [{ time: t0, high: 100.1, low: 98.5, close: 99 }], 15),
        h: [demoHoldOf({ source: 'target', at: 45 }, {}), demoHoldOf({ source: 'target' }, { fillTs: 1, endTs: 61 }), demoHoldOf({ source: 'recorded' }, { fillTs: 1000, endTs: 4600 }), demoHoldOf({ source: 'recorded' }, { fillTs: 1000 }), demoHoldOf({ source: 'recorded' }, { fillTs: 5000, endTs: 1000 })],
        lab: ['+2R', '-1R', '+1.5R', 'SL', 'BE', 'Trail +1.5R'].map(demoLab), ax: niceAxis(80.37, 102.93, 4).ticks, flat: niceAxis(100, 100, 4).ticks.length };
    }, Date.parse('2026-10-01T04:30:00Z') / 1000);
    check(p.ft === Date.parse('2026-10-01T04:30:00Z') && p.te === 60 && JSON.stringify(p.pt) === '[[15,15],[30,30],[45,45]]', 'walk keeps the fill time, exit 60m later and each point\'s time: ' + JSON.stringify(p));
    check(JSON.stringify([p.r1, p.r2, p.r3, p.be]) === '[["Target",30],["Target",45],["SL",60],["BE",60]]', '1R at 30m, 2R at 45m, the stop at 60m, breakeven on the stop candle: ' + JSON.stringify([p.r1, p.r2, p.r3, p.be]));
    check(p.trail && p.trail[1] === 60, 'Trail TP ends on the stop candle: ' + JSON.stringify(p.trail));
    check(p.fill.sl === 1 && p.fill.te === 0, 'stopped on the fill candle: held 0m: ' + JSON.stringify(p.fill));
    check(JSON.stringify(p.h) === '[45,null,60,null,null]', 'hold: Exit at\'s time, else the scanner\'s fill → close, never negative: ' + JSON.stringify(p.h));
    check(JSON.stringify(p.lab) === '["","","","SL","BE","Trail +1.5R"]', 'an R label is not said twice: ' + JSON.stringify(p.lab));
    check(JSON.stringify(p.ax) === '[80,90,100,110]' && p.flat >= 2, 'axis in round steps: ' + JSON.stringify(p));

    // ---- The Demo account in scanner mode: 9 alerts by hand ----
    await page.evaluate(() => {
      const L = [['2026-10-05', '10:00', 'BTCUSD', 2, 120], ['2026-10-05', '14:00', 'ETHUSD', -1, 60], ['2026-10-06', '09:00', 'XRPUSD', 1, 300], ['2026-10-07', '11:00', 'DOGEUSD', -1, 30], ['2026-10-08', '12:00', 'BNBUSD', 2, 600],
        ['2026-10-12', '10:00', 'SOLUSD', -1, 90], ['2026-10-13', '15:00', 'ADAUSD', 1, 45], ['2026-10-14', '08:00', 'BTCUSD', -1, null], ['2026-10-15', '20:00', 'ETHUSD', 2, 1440]];
      state.signals = L.map(([date, time, symbol, r, h], i) => { const f = Date.parse(date + 'T' + time + ':00+05:30') / 1000 + 600;
        return Object.assign({ id: 'dd' + i, key: 'dd' + i, kind: 'trendline', date, time, symbol, side: i % 3 ? 'long' : 'short', score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H', filled: true,
          outcome: r > 0 ? '+' + r + 'R' : 'SL', resultR: r, hasReportR: true, price: 100, entry: 100, stop: i % 3 ? 99 : 101 }, h == null ? {} : { fillTs: f, endTs: f + h * 60 }); });
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', mktFilter: '', sigTgt: '', sigNoFee: false, sigCoins: '', sigSec: 'alerts' });
      state.ui.sigDemo = { start: 100, mode: 'fixed', fixed: 1, real: false };
      switchTab('signals'); renderAll(); setSigSec('demo');
    });
    await page.waitForFunction(() => document.getElementById('sigDemoOut') && /Final balance/.test(document.getElementById('sigDemoOut').innerText));
    const f = await page.evaluate(() => ({ avg: btHeld(336), med: btHeld(90), w1: btHeld(222), w2: btHeld(525), t3: btHeld(480), t5: btHeld(Math.round((120 + 60 + 300 + 1440 + 600 + 90) / 6)), d5: fmtDay('2026-10-05'), d15: fmtDay('2026-10-15') }));
    const hold = await text('#sigDemoStats [data-demo="hold"]');
    check(hold === 'Avg hold ' + f.avg + ' median ' + f.med + ' · 8 of 9 timed', 'Avg hold card (2685 / 8 = 336m, median 90m): ' + hold);
    check((await text('#sigDemoStats [data-demo="end"]')) === 'Final balance $104.00 from $100.00 · peak $104.00', 'final balance card: ' + (await text('#sigDemoStats [data-demo="end"]')));
    // The chart: round price steps, five dates from the first trade to the last, the drawdown.
    const c = await page.evaluate(() => ({ y: [...document.querySelectorAll('#sigDemoChart .dc-y:not(.dc-y2) span')].map(s => s.textContent), x: [...document.querySelectorAll('#sigDemoChart .dc-x span')].map(s => s.textContent),
      dd: document.querySelector('#sigDemoChart .dc-ddlab').textContent, y2: [...document.querySelectorAll('#sigDemoChart .dc-y2 span')].map(s => s.textContent), start: document.querySelector('#sigDemoChart .dc-startlab').textContent,
      pts: document.querySelector('#sigDemoPlot polyline').getAttribute('points').split(' ').length }));
    check(JSON.stringify(c.y) === '["$100","$101","$102","$103","$104"]' && c.start === 'start $100', 'price axis $100-$104 and the start line: ' + JSON.stringify(c));
    check(c.x.length === 4 && c.x[0] === f.d5 && c.x[3] === f.d15 && c.pts === 10, 'dates from the first trade to the last (a day once), a point per trade and the start: ' + JSON.stringify(c));
    check(c.dd === 'Drawdown from the last high · max -0.98%' && c.y2[1] === '-1.0%', 'drawdown 1 from 102 = -0.98%: ' + JSON.stringify(c));
    await page.$eval('#sigDemoPlot', el => el.scrollIntoView({ block: 'center' }));
    const b = await page.$eval('#sigDemoPlot', el => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.mouse.move(b.x + b.w - 1, b.y + b.h / 2);
    const tipEnd = await text('#sigDemoPlot .dc-tip');
    check(/^#9 · .* ETHUSD Long 4H \+\$2\.00 \+2\.00R Balance \$104\.00 Held 1d 0h$/.test(tipEnd), 'tooltip at the last point is trade 9: ' + tipEnd);
    await page.mouse.move(b.x + b.w / 9 * 2, b.y + b.h / 2);
    check(/^#2 · .* ETHUSD Long 4H -\$1\.00 -1\.00R SL Balance \$101\.00 -0\.98% Held 1h 0m$/.test(await text('#sigDemoPlot .dc-tip')), 'trade 2 with its drawdown: ' + (await text('#sigDemoPlot .dc-tip')));
    await page.mouse.move(b.x + 1, b.y + b.h / 2);
    check((await text('#sigDemoPlot .dc-tip')) === 'Start $100.00', 'left edge is the start: ' + (await text('#sigDemoPlot .dc-tip')));
    await page.mouse.move(b.x + b.w / 2, b.y + b.h + 200);
    check(await page.$eval('#sigDemoPlot .dc-tip', t => t.classList.contains('hidden')), 'tooltip hides when the pointer leaves');
    // Results by day (11 days of alerts), newest first; a day opens its trades.
    const rows = () => page.$$eval('#sigDemoBy tbody tr[data-demorow]', trs => trs.map(tr => tr.innerText.replace('▸', '').replace(/\s+/g, ' ').trim()));
    check(/^Results by day/.test(await text('#sigDemoBy')), 'by day for under two weeks of alerts: ' + (await text('#sigDemoBy')).slice(0, 80));
    let r = await rows();
    check(r.length === 8 && /^Thu,? 15 Oct 1 1 \/ 0 \+\$2\.00 \+1\.96% 1d 0h \$104\.00$/.test(r[0]) && /^Mon,? 5 Oct 2 1 \/ 1 \+\$1\.00 \+1\.00% 1h 30m \$101\.00$/.test(r[7]), '8 days, newest first: ' + r.join(' | '));
    await page.click('#sigDemoBy tr[data-demorow="2026-10-05"]');
    let sub = await page.$$eval('#sigDemoBy .demo-sub .demo-tl', ls => ls.map(l => l.innerText.replace(/\s+/g, ' ').trim()));
    check(sub.length === 2 && /^#2 .*ETHUSD Long 4H -1\.00R SL -\$1\.00 held 1h 0m$/.test(sub[0]) && /^#1 .*BTCUSD Short 4H \+2\.00R \+\$2\.00 held 2h 0m$/.test(sub[1]), '5 Oct opens its 2 trades: ' + sub.join(' | '));
    await page.click('#sigDemoBy tr[data-demorow="2026-10-05"]');
    check(!(await page.$('#sigDemoBy .demo-sub')), 'tapping again closes it');
    // By week and month.
    await page.click('#sigDemoBy button[data-demoby="week"]');
    r = await rows();
    check(r.length === 2 && r[0] === '12–18 Oct 4 2 / 2 +$1.00 +0.97% ' + f.w2 + ' $104.00' && r[1] === '5–11 Oct best 5 3 / 2 +$3.00 +3.00% ' + f.w1 + ' $103.00', 'two weeks: ' + r.join(' | '));
    check(await page.evaluate(() => state.ui.sigDemo.by) === 'week', 'the pick is kept');
    await page.click('#sigDemoBy button[data-demoby="month"]');
    r = await rows();
    check(r.length === 1 && r[0] === 'October 2026 9 5 / 4 +$4.00 +4.00% ' + f.avg + ' $104.00', 'one month: ' + r.join(' | '));
    // By coin: Top 3 / Top 5 by market cap against all, and every coin.
    await page.click('#sigDemoBy button[data-demoby="coin"]');
    const top = await page.$$eval('#sigDemoTop tbody tr', trs => trs.map(tr => tr.innerText.replace('▸', '').replace(/\s+/g, ' ').trim()));
    check(top.length === 3 && top[0] === 'Top 3 BTC, ETH, XRP 5 60% +$3.00 +$0.60 +0.60R ' + f.t3 && top[1] === 'Top 5 BTC, ETH, XRP, BNB, SOL 7 57% +$4.00 +$0.57 +0.57R ' + f.t5 && top[2] === 'All 9 56% +$4.00 +$0.44 +0.44R ' + f.avg, 'Top 3 / Top 5 / All by hand: ' + top.join(' | '));
    await page.click('#sigDemoTop tr[data-demorow="#top3"]');
    sub = await page.$$eval('#sigDemoTop .demo-sub .demo-tl', ls => ls.map(l => l.innerText.replace(/\s+/g, ' ').trim().split(' ')[0]));
    check(sub.join(',') === '#9,#8,#3,#2,#1', 'Top 3 opens its 5 trades: ' + sub.join(','));
    const coins = await page.$$eval('#sigDemoCoins tbody tr[data-demorow]', trs => trs.map(tr => tr.dataset.demorow + ' ' + tr.children[3].innerText.trim()));
    check(coins.join(',') === 'BNB +$2.00,BTC +$1.00,ETH +$1.00,ADA +$1.00,XRP +$1.00,DOGE -$1.00,SOL -$1.00', 'every coin, most money first: ' + coins.join(','));
    // Wins, losses and streaks, by hand (every trade risks $1, fees as the scanner's, so P&L = R):
    // wins 2+1+2+1+2 = $8 over 5, losses 4 × $1; payoff 1.6 needs 100 / 2.6 = 38% won; fees 9 × 0.0826.
    const keys = await page.$$eval('#sigDemoKeys [data-demo]', cs => cs.map(c => c.dataset.demo + ' ' + c.innerText.replace(/\s+/g, ' ').trim().toLowerCase()));
    const wantK = ['avgw avg win +$1.60 +1.60r · 5 wins', 'avgl avg loss -$1.00 -1.00r · 4 losses', 'payoff payoff 1.60 break-even at 38% won · you 56%', 'exp expectancy +$0.44 +0.44r a trade',
      'pf profit factor 2.00 won $8.00 ÷ lost $4.00', 'wstreak win streak 1 won +$2.00 · ' + f.d5.toLowerCase(), 'lstreak losing streak 1 lost -$1.00 (-0.98%) · ' + f.d5.toLowerCase(), 'fees fees $0.74 9% of what winners made'];
    check(JSON.stringify(keys) === JSON.stringify(wantK), 'wins, losses and streaks by hand: ' + JSON.stringify(keys));
    // What to improve: groups of 3+; Short = Resistance TL here, so it shows once, by its level / type name.
    const tips = await page.evaluate(() => ({ bad: document.getElementById('sigDemoBad').innerText.replace(/\s+/g, ' ').trim(), good: [...document.querySelectorAll('#sigDemoGood .demo-tip')].map(b => b.innerText.replace(/\s+/g, ' ').trim()) }));
    check(tips.bad === 'Costing you No group of 3+ trades lost money.' && JSON.stringify(tips.good) === JSON.stringify(['Level / type Support TL +$2.00 6 trades · 50% won · avg +0.33R', 'Level / type Resistance TL +$2.00 3 trades · 67% won · avg +0.67R']),
      'what to improve, no group twice: ' + JSON.stringify(tips));
    await page.click('#sigDemoGood .demo-tip[data-tipk="Support TL"]');
    const jump = await page.evaluate(() => ({ by: state.ui.sigDemo.by, open: [...document.querySelectorAll('#sigDemoGroups .demo-sub .demo-tl')].length, head: document.querySelector('#sigDemoBy').innerText.slice(0, 30) }));
    check(jump.by === 'setup' && jump.open === 6 && /^Results by level \/ type/i.test(jump.head), 'a tip opens its group under Results by: ' + JSON.stringify(jump));
    // The other splits: exit, weekday (Mon first), stop size and time held in their own order.
    const split = async k => { await page.click('#sigDemoBy button[data-demoby="' + k + '"]'); return page.$$eval('#sigDemoGroups tbody tr[data-demorow]', trs => trs.map(tr => tr.dataset.demorow + ' ' + tr.children[1].innerText.trim() + ' ' + tr.children[3].innerText.trim()).join(', ')); };
    check(await split('exit') === '+2R 3 +$6.00, +1R 2 +$2.00, SL 4 -$4.00', 'by exit: ' + await split('exit'));
    check(await split('dow') === 'Mon 3 +$0.00, Tue 2 +$2.00, Wed 2 -$2.00, Thu 2 +$4.00', 'by weekday: ' + await split('dow'));
    check(await split('stop') === '1 - 2% 9 +$4.00', 'by stop size: ' + await split('stop'));
    check(await split('hold') === 'under 1h 2 +$0.00, 1 - 4h 3 +$0.00, 4 - 12h 2 +$3.00, 1 - 3 days 1 +$2.00, Not timed 1 -$1.00', 'by time held: ' + await split('hold'));
    // Trades: folded until opened, with Won / Lost filters.
    await page.click('#sigDemoBy button[data-demoby="coin"]');
    const fold = await page.evaluate(() => ({ table: !!document.getElementById('sigDemoTrades'), btn: document.getElementById('sigDemoTradesBtn').innerText.replace(/\s+/g, ' ').trim() }));
    check(!fold.table && /^▸ Trades 9 placed · 5 won · 4 lost tap to see every trade$/i.test(fold.btn), 'trades folded by default: ' + JSON.stringify(fold));
    await page.click('#sigDemoTradesBtn');
    const trRows = () => page.$$eval('#sigDemoTrades tbody tr', trs => trs.map(tr => tr.children[0].innerText.trim() + ' ' + tr.children[9].innerText.trim()).join(','));
    check(await trRows() === '9 +$2.00,8 -$1.00,7 +$1.00,6 -$1.00,5 +$2.00,4 -$1.00,3 +$1.00,2 -$1.00,1 +$2.00' && !(await page.$('#sigDemoTrF button[data-demotf="skip"]')), 'opened: all 9, newest first, no Skipped chip: ' + await trRows());
    await page.click('#sigDemoTrF button[data-demotf="lost"]');
    check(await trRows() === '8 -$1.00,6 -$1.00,4 -$1.00,2 -$1.00', 'Lost: the 4 losses: ' + await trRows());
    await page.click('#sigDemoTrF button[data-demotf="won"]');
    check(await trRows() === '9 +$2.00,7 +$1.00,5 +$2.00,3 +$1.00,1 +$2.00', 'Won: the 5 wins: ' + await trRows());
    await page.click('#sigDemoTrF button[data-demotf="all"]');
    await page.click('#sigDemoTradesBtn');
    check(!(await page.$('#sigDemoTrades')), 'tapping Trades again folds it');
    // Phone: no sideways scroll, and an open row's trades stay on screen.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.click('#sigDemoBy button[data-demoby="day"]');
    await page.click('#sigDemoBy tr[data-demorow="2026-10-05"]');
    const ph = await page.evaluate(() => { const box = document.querySelector('#sigDemoPeriods').parentElement.getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, over: [...document.querySelectorAll('#sigDemoBy .demo-tl > span')].filter(s => s.getBoundingClientRect().right > box.right + 1).length, tbl: document.querySelector('#sigDemoPeriods').scrollWidth - box.width }; });
    check(ph.sw <= 390 && ph.over === 0 && ph.tbl <= 1, 'phone: no sideways scroll, trades and table fit: ' + JSON.stringify(ph));
    await page.setViewportSize({ width: 1180, height: 820 });

    // ---- Exit at: hold times from the candles; old walks read again only while this is open ----
    await page.evaluate(() => {
      const sg = (id, sym, side, entry, stop) => ({ id, key: 'k' + id, kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: sym, side, score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H', filled: true, outcome: 'SL', resultR: -1, hasReportR: true, price: entry, stop, entry });
      state.signals = [sg('a', 'A', 'long', 100, 99), sg('b', 'B', 'short', 200, 202)];
      Object.assign(state.ui, { sigTgt: '1R', sigHold: '20', sigSec: 'edge' }); delete state.ui.sigDemo.by; save(); renderAll();
    });
    await page.waitForFunction(() => /2 of 2 graded alerts have price data/.test(document.getElementById('sigTgtCmp').innerText) && !tgtBusy, null, { timeout: 10000 });
    await page.evaluate(() => setSigSec('demo'));
    await page.waitForFunction(() => /Avg hold/.test((document.querySelector('#sigDemoStats [data-demo="hold"]') || {}).innerText || ''));
    const ex = await page.evaluate(() => ({ holds: demoRows.map(x => x.hold), card: document.querySelector('#sigDemoStats [data-demo="hold"]').innerText.replace(/\s+/g, ' '), want: 'Avg hold ' + btHeld(Math.round((15 + 4800) / 2)) }));
    check(JSON.stringify(ex.holds) === '[15,4800]' && ex.card.startsWith(ex.want), 'Exit at 1R: A 15m, B on time after 4800m: ' + JSON.stringify(ex));
    // A walk kept before times (no ft): not read again on another section, read once here.
    const n0 = calls;
    await page.evaluate(() => { Object.values(tgtCache()).forEach(w => { delete w.ft; delete w.te; delete w.pt; delete w.tta; }); Object.keys(tgtTried).forEach(k => delete tgtTried[k]); setSigSec('edge'); renderAll(); });
    await page.waitForTimeout(400);
    check(calls === n0, 'no re-read outside the Demo account: ' + (calls - n0));
    await page.evaluate(() => { setSigSec('demo'); });
    await page.waitForFunction(n => !tgtBusy && Object.values(tgtCache()).every(w => w.ft != null), n0, { timeout: 10000 }).catch(() => {});
    check(calls === n0 + 2 && await page.evaluate(() => JSON.stringify(demoRows.map(x => x.hold))) === '[15,4800]', 'each old walk read once for its times: ' + (calls - n0));
    // Read again with the candles gone: the old walk is kept, not lost.
    gone = true;
    await page.evaluate(() => { Object.values(tgtCache()).forEach(w => { delete w.ft; }); Object.keys(tgtTried).forEach(k => delete tgtTried[k]); renderAll(); });
    await page.waitForFunction(n => !tgtBusy, null, { timeout: 10000 });
    await page.waitForTimeout(300);
    const kept = await page.evaluate(() => Object.values(tgtCache()).map(w => Array.isArray(w.p)));
    check(calls >= n0 + 4 && JSON.stringify(kept) === '[true,true]', 'candles gone on a re-read: the old walks stay: ' + JSON.stringify(kept) + ' calls ' + (calls - n0));
    // A "no fill" from the scanner that the walk fills later: Edge & breakdowns still draws, and
    // the Scanner row leaves it out (lakky, 2026-11-08: the whole section came up empty).
    gone = false;
    const edge = await page.evaluate(() => {
      state.signals.push(Object.assign({}, state.signals[0], { id: 'c', key: 'kc', filled: false, outcome: 'no fill', resultR: null }));
      try { setSigSec('edge'); renderAll(); return 'ok'; } catch (e) { return 'threw ' + e.message; }
    });
    await page.waitForFunction(() => !tgtBusy && /3 of 3 graded alerts have price data/.test(document.getElementById('sigTgtCmp').innerText), null, { timeout: 10000 }).catch(() => {});
    const cmp = await page.evaluate(() => ({ rows: [...document.querySelectorAll('#sigTgtCmp > div > table tbody tr')].map(tr => tr.innerText.replace(/\s+/g, ' ').trim()), note: document.getElementById('sigTgtCmp').innerText.replace(/\s+/g, ' '), out: document.getElementById('sigByOutcome').innerText.replace(/\s+/g, ' ') }));
    check(edge === 'ok' && /^Scanner 2 /.test(cmp.rows[0]) && /^1R 3 /.test(cmp.rows[1]) && cmp.note.includes('except 1 the scanner had as no fill that filled later within 20 candles') && /Target/.test(cmp.out),
      'scanner no fill, walk filled: Edge draws, Scanner row 2, targets 3: ' + edge + ' ' + JSON.stringify(cmp).slice(0, 600));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals demo account: graph, results by day / week / coin, hold times');
  errs.forEach(e => { console.log('     ' + e); failures.push('demo deep data: ' + e); });
}

// Real orders in the Demo account (lakky, 2026-11-07: "is it possible to have my desire sl
// ... make it practical ... different and random sl ... check is it showing correct").
// Part 1, by hand on Delta's own contract sizes (7 Nov 2026): $100 risking 2% a trade.
//  1 BTC  long  75000 / 72000 (4%):  wants a $50 position, 1 contract is $75 -> skipped
//  2 ETH  long  2240 / 2228.8 (0.5%): $400 wanted, 17 x $22.40 = $380.80, risk $1.904, +2R
//  3 DOGE short stop 0.07% -> under the 0.1% min, skipped
//  4 VELVET long 0.05 / 0.0498 (0.4%): its tick 0.0001 is 0.2%, so 3 ticks = 0.6% -> skipped
//  5 RLC  long 0.12% stop: $1,730 wanted, RLC max 10x = $1,038.08, 241 x $4.30 = $1,036.30, -1.5R
//  6 MAGIC is not on Delta -> skipped
//  7 MRVL (Delta's MRVLBUSD) 140 / 137.2: 7 x $14 = $98, risk $1.96, +1R
//  8 SOL  short 90 / 91.8: 1 x $90, risk $1.80, -1R
// Part 2: 400 random alerts on random Delta coins, prices and stops from 0.01% to 40%, at
// random balances, risks, caps and settings, each checked against a sizing worked out here.
async function demoRealRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  // Delta's product list, served from here: 25 coins, BTC's contract made 0.01 to see the live list win.
  const live = { success: true, result: Array.from({ length: 25 }, (_, i) => ({ symbol: i ? 'FAKE' + i + 'USD' : 'BTCUSD', contract_type: 'perpetual_futures', state: 'live', contract_value: i ? '1' : '0.01', tick_size: '0.5', initial_margin: '0.5', short_description: 'x' })) };
  let liveOn = false, liveCalls = 0;
  await ctx.route(url => !url.href.startsWith(base), r => {
    if (liveOn && /\/v2\/products\?/.test(r.request().url())) { liveCalls++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(live) }); }
    return r.abort();
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const text = () => page.evaluate(() => document.getElementById('sigDemo').innerText.replace(/\s+/g, ' '));
  const usd = v => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // symbol, side, entry, stop, scanner R (after its 0.0826% fee, which Delta's default fee equals)
  const A = [['BTCUSD', 'long', 75000, 72000, -1], ['ETHUSD', 'long', 2240, 2228.8, 2], ['DOGEUSD', 'short', 0.0718, 0.07185, 2], ['VELVETUSD', 'long', 0.05, 0.0498, -1],
    ['RLCUSD', 'long', 0.43, 0.43 * (1 - 0.0012), -1.5], ['MAGICUSD', 'long', 0.1, 0.098, 1], ['MRVL', 'long', 140, 137.2, 1], ['SOLUSD', 'short', 90, 91.8, -1]];
  try {
    await page.goto(base, { waitUntil: 'load' });
    // The alerts and price data load from IndexedDB after the page: let them land first.
    await page.waitForFunction(() => typeof tgtReady !== 'undefined' && tgtReady && signalsLoaded, null, { timeout: 5000 });
    await page.evaluate(A => {
      state.signals = A.map((a, i) => ({ id: 'rl' + i, key: 'r' + i, kind: 'trendline', date: '2026-10-0' + (i + 1), time: '10:00', symbol: a[0], side: a[1], score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: a[4] > 0 ? '+' + a[4] + 'R' : 'SL', resultR: a[4], hasReportR: true, price: a[2], entry: a[2], stop: a[3] }));
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', mktFilter: '', sigTgt: '', sigNoFee: false, sigSec: 'demo' });
      state.ui.sigDemo = { start: 100, mode: 'pct', pct: 2 };
      demoTrOpen = true;
      switchTab('signals'); renderAll();
    }, A);
    let t = await text();
    // 100 -> +3.808 -> -1.86534 -> +1.96 -> -1.80 = 102.10266
    check(t.includes('Real orders on · Delta: whole contracts, rounded down') && t.includes('Placed 4 of 8, skipped 4: 1 smaller than 1 contract, 1 stop under 0.1%, 1 stop within 3 ticks, 1 not on Delta.') && t.includes('1 sized down to the coin\'s max leverage.'), 'real orders line: ' + t.slice(0, 1600));
    check(t.includes('Final balance $102.10') && t.includes('Trades 4 +4 skipped'), 'real orders by hand → $102.10: ' + t.slice(0, 1800));
    // innerText needs the table laid out (hidden, its cells run together): wait for it to show.
    await page.waitForFunction(() => { const t = document.getElementById('sigDemoTrades'); return t && t.offsetParent !== null; }, null, { timeout: 5000 }).catch(() => {});
    const rows = await page.$$eval('#sigDemoTrades tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    const want = [
      /^8 2026-10-08 10:00 SOLUSD Short 4H 2\.00% -1\.00R SL \$1\.80 \$90\.00 · 0\.9x 1 SOL /,
      /^7 2026-10-07 10:00 MRVL Long 4H 2\.00% \+1\.00R \+1R \$1\.96 \$98\.00 · 1\.0x 0\.7 MRVLB /,
      /^6 2026-10-06 10:00 MAGICUSD Long 4H 2\.00% \+1\.00R Skipped: MAGICUSD is not on Delta$/,
      /^5 2026-10-05 10:00 RLCUSD Long 4H 0\.12% -1\.50R SL \$1\.24 \$1,036\.30 · 10\.0x max 2410 RLC /,
      /^4 2026-10-04 10:00 VELVETUSD Long 4H 0\.40% -1\.00R Skipped: stop 0\.400% is within 3 ticks \(1 tick = 0\.2000%\)$/,
      /^3 2026-10-03 10:00 DOGEUSD Short 4H 0\.07% \+2\.00R Skipped: stop 0\.070% is under the 0\.1% min$/,
      /^2 2026-10-02 10:00 ETHUSD Long 4H 0\.50% \+2\.00R \+2R \$1\.90 \$380\.80 · 3\.8x 0\.17 ETH /,
      /^1 2026-10-01 10:00 BTCUSD Long 4H 4\.00% -1\.00R Skipped: 1 contract \(0\.001 BTC\) = \$75\.00 risks \$3\.00 at this stop, more than the \$2\.00 planned$/];
    want.forEach((re, i) => check(re.test(rows[i] || ''), 'trade row ' + (8 - i) + ' ' + re + ': ' + rows[i]));
    // What to improve: the 4 skipped would have made -1 +2 -1 +1 = +1R, 2 of them won, by reason.
    const skips = await page.$eval('#sigDemoSkips', el => [el.innerText.replace(/\s+/g, ' ').trim(), [...el.querySelectorAll('.demo-chip')].map(c => c.textContent)]).catch(() => null);
    check(skips && skips[0].startsWith('Skipped 4 would have made +1.00R (2 of 4 won)')
      && JSON.stringify(skips[1]) === JSON.stringify(['1 smaller than 1 contract · -1.00R', '1 stop under 0.1% · +2.00R', '1 stop within 3 ticks · -1.00R', '1 not on Delta · +1.00R']), 'skipped alerts summed by reason: ' + JSON.stringify(skips));
    // The list's Skipped filter shows only those four.
    await page.click('#sigDemoTrF button[data-demotf="skip"]');
    check(JSON.stringify(await page.$$eval('#sigDemoTrades tbody tr', trs => trs.map(tr => tr.dataset.skip))) === '["venue","ticks","tight","lot"]', 'Skipped filter: the 4 skipped');
    await page.click('#sigDemoTrF button[data-demotf="all"]');
    // Take 1 contract instead: BTC goes in at $75 (risk $3, -1R), the rest re-size from there.
    // 100 -3 = 97; ETH 17 x 22.4, +3.808 = 100.808; RLC 234 x 4.3 = 1006.2, -1.81116 = 98.99684;
    // MRVL 7 x 14, +1.96 = 100.95684; SOL 1 x 90, -1.80 = 99.15684.
    await page.click('#sigDemo button[data-lot1="one"]');
    t = await text();
    check(t.includes('Final balance $99.16') && t.includes('Placed 5 of 8') && t.includes('1 taken at 1 contract, risking more than planned (up to 3.0% of the balance on one trade, never over 2× the plan).'), 'take 1 contract → $99.16: ' + t.slice(0, 1800));
    check(/^1 2026-10-01 10:00 BTCUSD Long 4H 4\.00% -1\.00R SL \$3\.00 \$75\.00 · 0\.8x 0\.001 BTC min /.test(await page.$eval('#sigDemoTrades tbody tr:last-child', tr => tr.innerText.replace(/\s+/g, ' ').trim())), 'BTC at 1 contract');
    // Limit 1.5× still takes BTC ($3 = 1.5 × $2); 1.5× is the edge, so a smaller plan skips it.
    await page.selectOption('#sigDemoLot1Cap', '1.5');
    check((await text()).includes('Final balance $99.16'), '1.5× limit still takes BTC at exactly 1.5×');
    // 1% of $100 = $1 planned: 1 BTC contract risks $3 = 3× and 1 SOL contract $1.80 = 1.8× → both over 1.5×, skipped.
    await page.evaluate(() => demoSet('pct', '1'));
    t = await text();
    const btc1 = await page.$eval('#sigDemoTrades tbody tr:last-child', tr => tr.innerText.replace(/\s+/g, ' ').trim());
    check(t.includes('2 where 1 contract risks over 1.5× the plan') && /Skipped: 1 contract \(0\.001 BTC\) = \$75\.00 risks \$3\.00 at this stop, more than 1\.5× the \$1\.00 planned$/.test(btc1)
      && await page.$eval('#sigDemoTrades tbody tr:last-child', tr => tr.dataset.skip) === 'big', 'over the 1.5× limit → skipped: ' + btc1 + ' | ' + t.slice(0, 900));
    await page.selectOption('#sigDemoLot1Cap', '0');
    check((await text()).includes('2 taken at 1 contract') && !(await text()).includes('never over'), '"whatever it risks" takes BTC at 3× and SOL at 1.8×');
    await page.evaluate(() => demoSet('pct', '2'));
    // Always 1 contract (test): every placed trade is exactly 1 contract, whatever the risk.
    // BTC 1 x 75 = $75, -1R at 4% = -3 → 97; ETH 1 x 22.4 at 0.5% = $0.112 x 2 = +0.224;
    // RLC 1 x 4.3 at 0.12% x -1.5; MRVL 1 x 14 at 2% x +1; SOL 1 x 90 at 2% x -1 = 95.70.
    await page.click('#sigDemo button[data-lot1="always"]');
    t = await text();
    // (the scanner R is after Delta's default fee, so each trade nets risk × R)
    let b1 = 100;
    [[75, 4, -1], [22.4, 0.5, 2], [4.3, 0.12, -1.5], [14, 2, 1], [90, 2, -1]].forEach(([p, sl, r]) => { b1 += p * sl / 100 * r; });
    check(t.includes('Test: every trade is 1 contract, whatever it risks') && t.includes('Placed 5 of 8') && t.includes('Final balance ' + usd(b1)) && (await page.getAttribute('#sigDemoStats [data-demo="end"]', 'title')) === 'Risk 1 contract a trade (test)' && !t.includes('Same alerts, other risk sizes'), 'always 1 contract → ' + usd(b1) + ': ' + t.slice(0, 1600));
    const units = await page.$$eval('#sigDemoTrades tbody tr:not([data-skip])', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    check(units.length === 5 && /0\.001 BTC min/.test(units[4]) && /0\.01 ETH min/.test(units[3]) && /1 SOL min/.test(units[0]), 'always: 1 contract each: ' + units.join(' | '));
    await page.click('#sigDemo button[data-lot1="skip"]');
    check((await text()).includes('as many contracts as the risk allows, never more risk than planned') && !(await page.$('#sigDemoLot1Cap')), 'Max within risk says so, no limit box');
    // Min stop 0: DOGE is placed (0.07% stop, $2 / 0.0007 = $2,872 needs 28x of 100x, 400 x $7.18).
    await page.fill('#sigDemoMinStop', '0');
    t = await text();
    check(t.includes('Placed 5 of 8') && !t.includes('stop under'), 'min stop 0 places DOGE: ' + t.slice(0, 1400));
    for (const v of ['-1', '11', '']) { await page.fill('#sigDemoMinStop', v); check((await text()).includes('Enter the min stop'), 'min stop "' + v + '" says what is wrong'); }
    await page.fill('#sigDemoMinStop', '0.1');
    // Real orders off: every alert at its exact size, 2% each, compounding.
    let b = 100; A.forEach(a => { b += b * 0.02 * a[4]; });
    check(t.includes('Any size, every alert: ' + usd(b)) || (await text()).includes('Any size, every alert: ' + usd(b)), 'real orders line gives the any-size result ' + usd(b));
    await page.click('#sigDemo button[data-real="0"]');
    t = await text();
    check(t.includes('Final balance ' + usd(b)) && t.includes('Real orders off') && t.includes('As real Delta orders: $102.10') && t.includes('4 of 8 placed'), 'off → ' + usd(b) + ': ' + t.slice(0, 1400));
    await page.click('#sigDemo button:has-text("Use real orders")');
    check((await text()).includes('Final balance $102.10'), 'Use real orders turns them back on');
    // CoinDCX: its own minimum orders (BTC 0.001 and $60, ETH $24, SOL 0.01), no MRVL or VELVET.
    await page.click('#sigDemo button[data-broker="coindcx"]');
    t = await text();
    check(t.includes('Real orders on · CoinDCX: whole min orders') && t.includes('not on CoinDCX'), 'CoinDCX specs: ' + t.slice(0, 1400));
    await page.click('#sigDemo button[data-broker="delta"]');
    // Rupees: Delta India's ₹85 a dollar, so 1 BTC contract = ₹6,375; ₹10,000 at 2% wants ₹5,000.
    await page.evaluate(() => { demoSet('cur', 'INR'); demoSet('start', '10000'); });
    const rb = await page.$eval('#sigDemoTrades tbody tr:last-child', tr => tr.innerText.replace(/\s+/g, ' ').trim());
    check(/1 contract \(0\.001 BTC\) = ₹6,375\.00 risks ₹255\.00 at this stop, more than the ₹200\.00 planned/.test(rb), 'rupees use ₹85 a dollar: ' + rb);
    await page.evaluate(() => { demoSet('cur', 'USD'); demoSet('start', '100'); });
    // Delta's live list wins over the saved one: BTC at 0.01 a contract ($750) and FAKE coins.
    liveOn = true;
    await page.evaluate(() => { demoLiveAt = 0; renderSigDemoNow(); });
    await page.waitForFunction(() => !!demoLive, null, { timeout: 5000 });
    t = await text();
    check(liveCalls === 1 && t.includes('read live from Delta') && t.includes('Placed 0 of 8') && t.includes('None of these 8 alerts'), 'live specs: only BTC + 24 fake coins listed, so nothing places: calls ' + liveCalls + ' ' + t.slice(0, 900));
    await page.evaluate(() => { demoLive = null; demoLiveAt = Date.now(); renderSigDemoNow(); });
    // Part 2: random alerts, checked trade by trade against sizing worked out here.
    const res = await page.evaluate(() => {
      let seed = 20261107; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
      const syms = Object.keys(DEMO_DELTA), runs = [];
      for (let k = 0; k < 40; k++) {
        const cfg = Object.assign(demoCfg(), { start: [100, 1000, 25000][k % 3], mode: k % 5 ? 'pct' : 'fixed', pct: [0.5, 1, 2, 5][k % 4], fixed: [1, 10, 50][k % 3], lev: [0, 5, 20][k % 3], lot1: ['skip', 'one', 'always', 'one'][k % 4], lot1Cap: [0, 1.5, 2, 3, 5][k % 5], minStop: [0, 0.1, 0.3][k % 3], real: true, broker: 'delta' });
        const rows = Array.from({ length: 10 }, () => {
          const sym = syms[Math.floor(rnd() * syms.length)], entry = Math.pow(10, rnd() * 8 - 3), slp = Math.pow(10, rnd() * 3.6 - 2), side = rnd() < 0.5 ? 'long' : 'short';
          const sig = { symbol: sym, side, entry, stop: side === 'long' ? entry * (1 - slp / 100) : entry * (1 + slp / 100), market: 'CRYPTO' };
          return { sig, r: [-1.3, -1, 1, 2, 0.4][Math.floor(rnd() * 5)], slp: slPct(sig), fee: 0.0826 / slPct(sig), spec: demoSpec(sig, cfg) };
        });
        runs.push({ cfg, rows: rows.map(x => ({ sym: x.sig.symbol, entry: x.sig.entry, r: x.r, slp: x.slp, fee: x.fee, spec: x.spec })), out: demoRun(rows, cfg) });
      }
      return { runs, specs: DEMO_DELTA };
    });
    let n = 0, placed = 0, skipped = 0;
    res.runs.forEach((run, k) => {
      const cfg = run.cfg, o = run.out;
      let bal = cfg.start, ti = 0, si = 0;
      for (let i = 0; i < run.rows.length; i++) {
        const x = run.rows[i], d = res.specs[x.sym], step = d[0] * x.entry, tickPct = d[1] / x.entry * 100;
        n++;
        // the spec itself
        check(Math.abs(x.spec.step - step) <= 1e-9 * step && x.spec.maxLev === d[2] && Math.abs(x.spec.tickPct - tickPct) <= 1e-9 * tickPct, 'spec ' + x.sym + ' ' + JSON.stringify(x.spec));
        const plan = cfg.mode === 'fixed' ? Math.min(cfg.fixed, bal) : bal * cfg.pct / 100;
        const why = x.slp < cfg.minStop ? 'tight' : x.slp < 3 * tickPct ? 'ticks' : '';
        const lim = bal * Math.min(d[2], cfg.lev || Infinity);
        let lots = Math.floor(Math.min(plan / (x.slp / 100), lim) / step + 1e-9), one = false;
        let big = false;
        if (!why && cfg.lot1 === 'always') { lots = step <= lim * (1 + 1e-9) ? 1 : 0; one = lots === 1; }
        else if (!why && lots < 1 && cfg.lot1 === 'one' && step <= lim * (1 + 1e-9)) {
          // 1 contract only while it risks at most lot1Cap x the plan (0 = any)
          if (!cfg.lot1Cap || step * x.slp / 100 <= plan * cfg.lot1Cap * (1 + 1e-9)) { lots = 1; one = true; } else big = true;
        }
        if (why || lots < 1) {
          const sk = o.skips[si++], w = why || (big ? 'big' : 'lot');
          check(sk && sk.i === i && sk.why === w, 'run ' + k + ' alert ' + i + ' should skip (' + w + '): ' + JSON.stringify(sk));
          skipped++; continue;
        }
        const tr = o.trades[ti++];
        if (!tr) { errs.push('run ' + k + ' alert ' + i + ' missing'); break; }
        const pos = lots * step, risk = pos * x.slp / 100, fee = pos * 0.0826 / 100;
        let pnl = risk * x.r - fee; if (bal + pnl < 0) pnl = -bal;
        bal += pnl; placed++;
        check(tr.i === i && Math.abs(tr.units - lots * d[0]) <= 1e-9 * lots * d[0] && Math.abs(tr.risk - risk) <= 1e-9 * risk && Math.abs(tr.fee - fee) <= 1e-9 * fee && Math.abs(tr.bal - bal) <= 1e-9 * Math.max(1, bal) && tr.one === one,
          'run ' + k + ' alert ' + i + ' ' + x.sym + ': ' + lots + ' contracts, risk ' + risk + ', balance ' + bal + ' vs ' + JSON.stringify({ units: tr.units, risk: tr.risk, bal: tr.bal, one: tr.one }));
        // never more risk than planned unless one contract was asked for; never past the leverage
        check(one || tr.risk <= plan * (1 + 1e-9), 'run ' + k + ' alert ' + i + ' risks more than planned');
        check(cfg.lot1 !== 'one' || !cfg.lot1Cap || tr.risk <= plan * cfg.lot1Cap * (1 + 1e-9), 'run ' + k + ' alert ' + i + ' risks over the ' + cfg.lot1Cap + 'x limit');
        check(tr.pos <= lim * (1 + 1e-9), 'run ' + k + ' alert ' + i + ' over its max leverage');
        if (bal <= cfg.start * 1e-6) break;
      }
      check(Math.abs(o.end - bal) <= 1e-9 * Math.max(1, bal), 'run ' + k + ' ends at ' + bal + ', the app says ' + o.end);
    });
    check(n === 400 && placed > 80 && skipped > 80, 'random audit covered placed and skipped trades: ' + n + ' alerts, ' + placed + ' placed, ' + skipped + ' skipped');
    console.log('     random audit: ' + n + ' alerts, ' + placed + ' placed, ' + skipped + ' skipped, all sized as worked out here');
    // Phone: no sideways scroll on the page.
    await page.setViewportSize({ width: 390, height: 844 });
    check(await page.evaluate(() => document.documentElement.scrollWidth) <= 390, 'phone width scrolls sideways');
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals demo account: real orders (contracts, max leverage, min stop) by hand and 400 random alerts');
  errs.forEach(e => { console.log('     ' + e); failures.push('demo real orders: ' + e); });
}

// Trades take their alert's stop, setup and fib level; the review queue; empty
// books off the bar; old deletion markers dropped; setup picked in the inspector.
async function cleanupRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const v = await page.evaluate(() => {
      const d = iso(new Date()), out = {};
      state.playbook = [{ id: 'pbf', name: 'FIB', rules: ['L1', 'L2', 'L3', 'L4'] }];
      // Fib from 110 (top) entering at L3 = 100: L1 103.8, L2 101.8, L3 100, L4 98.
      const fib = { id: 'sgf', kind: 'fib', key: 'fib|XFIB|4h|1|2|110|2', date: d, time: '09:50', symbol: 'XFIB', side: 'long', entry: 100, stop: 97, filled: true, scoredDaily: true };
      const zone = { id: 'sgz', date: d, time: '09:55', symbol: 'YZON', side: 'short', zoneLow: 50, zoneHigh: 51, stop: 52, filled: true };
      const tr = (id, sym, dir, entry, exit, extra) => Object.assign({ id, accountId: 'acc_cry', date: d, time: '10:00', symbol: sym, direction: dir, entry, exit, qty: 1, fees: 0, stop: 0, setup: '', rules: [], notes: '' }, extra || {});
      state.signals = [fib, zone];
      state.trades = state.trades.concat([tr('tf1', 'XFIBUSD', 'long', 98.1, 99), tr('tz1', 'YZONUSD', 'short', 50.5, 50, { setup: 'Breakout', stop: 51.5 }), tr('tq2', 'QQQUSD', 'long', 10, 9)]);
      save(); renderAll();
      const f = state.trades.find(t => t.id === 'tf1'), z = state.trades.find(t => t.id === 'tz1');
      out.fib = { stop: f.stop, src: f.stopSrc, setup: f.setup, auto: f.setupAuto, pr: f.playRules, r: +derive(f).r.toFixed(4) };
      out.zone = { stop: z.stop, src: z.stopSrc || null, setup: z.setup };
      // Review queue: today's three are waiting; Clean and a mistake each take one off.
      const ids = () => reviewQueue().map(t => t.id);
      out.q0 = ['tf1', 'tz1', 'tq2'].filter(id => ids().includes(id));
      out.label = anSecList().find(x => x.k === 'review').label;
      quickReview('tf1', 'clean'); quickReview('tq2', 'FOMO Entry');
      out.q1 = ['tf1', 'tz1', 'tq2'].filter(id => ids().includes(id));
      out.tags = state.trades.find(t => t.id === 'tq2').tagsMistakes;
      state.ui.anSec = 'review'; switchTab('analysis'); renderAll();
      out.panel = document.getElementById('reviewQueuePanel').innerText.replace(/\s+/g, ' ');
      out.week = document.getElementById('weeklyReview').textContent.replace(/\s+/g, ' ');
      out.shown = [...document.querySelectorAll('[data-ansec]')].filter(el => !el.classList.contains('hidden')).map(el => el.getAttribute('data-ansec'));
      // Inspector: setup chips and the FIB checklist with L4 ticked.
      openInspector(allTrades().find(t => t.id === 'tf1'));
      out.chips = [...document.querySelectorAll('#inspChecklist [data-setup]')].map(b => b.textContent);
      out.rows = [...document.querySelectorAll('#inspChecklist button:not([data-setup])')].map(b => b.innerText.replace(/\s+/g, ' '));
      out.rTxt = document.getElementById('inspR').innerText;
      document.querySelector('#inspChecklist [data-setup="None"]').click();
      out.afterNone = { setup: state.trades.find(t => t.id === 'tf1').setup, pr: state.trades.find(t => t.id === 'tf1').playRules || null };
      // An empty book stays off the bar until it is picked.
      state.accounts.push({ id: 'acc_empty', name: 'EmptyBook', currency: 'INR', market: 'nse', startBalance: 0 });
      state.ui.account = 'all'; renderAccountsBar();
      out.bar = document.getElementById('accountsBar').innerText;
      state.ui.account = 'acc_empty'; renderAccountsBar();
      out.barPicked = document.getElementById('accountsBar').innerText;
      state.ui.account = 'all';
      // Deletion markers: 30 days, a deleted Delta order 183.
      const ago = n => new Date(Date.now() - n * 864e5).toISOString();
      out.tomb = Object.keys(cleanTombstones({ 'trades:old': ago(40), 'trades:new': ago(5), 'trades:src:delta:1': ago(40), 'goals:old': ago(31) })).sort();
      return out;
    });
    check(v.fib.stop === 97 && v.fib.src === 'alert' && v.fib.setup === 'FIB' && v.fib.auto === true && JSON.stringify(v.fib.pr) === '{"L1":false,"L2":false,"L3":false,"L4":true}', 'fib trade from its alert: ' + JSON.stringify(v.fib));
    check(Math.abs(v.fib.r - (99 - 98.1) / (98.1 - 97)) < 1e-4, 'R from the alert stop: ' + v.fib.r);
    check(v.zone.stop === 51.5 && v.zone.src === null && v.zone.setup === 'Breakout', 'typed stop and setup left alone: ' + JSON.stringify(v.zone));
    check(v.q0.length === 3 && /^Review \(\d+\)$/.test(v.label), 'queue before: ' + JSON.stringify([v.q0, v.label]));
    check(JSON.stringify(v.q1) === '["tz1"]' && JSON.stringify(v.tags) === '["FOMO Entry"]', 'queue after Clean and a tag: ' + JSON.stringify([v.q1, v.tags]));
    check(/TO REVIEW/i.test(v.panel) && v.panel.includes('YZONUSD') && !v.panel.includes('XFIBUSD') && !/WEEK SUMMARY/i.test(v.panel) && /week summary/i.test(v.week) && JSON.stringify(v.shown) === '["review"]', 'review panel: ' + JSON.stringify([v.panel.slice(0, 300), v.shown]));
    check(JSON.stringify(v.chips) === '["FIB","None"]', 'setup chips: ' + JSON.stringify(v.chips));
    check(v.rows.includes('✓ L4') && v.rows.includes('○ L1') && v.rTxt.includes('stop from alert'), 'inspector checklist: ' + JSON.stringify([v.rows, v.rTxt]));
    check(v.afterNone.setup === '' && v.afterNone.pr === null, 'setup cleared from the inspector: ' + JSON.stringify(v.afterNone));
    check(!v.bar.includes('EmptyBook') && v.barPicked.includes('EmptyBook'), 'empty book on the bar: ' + JSON.stringify([v.bar, v.barPicked]));
    check(JSON.stringify(v.tomb) === '["trades:new","trades:src:delta:1"]', 'deletion markers kept: ' + JSON.stringify(v.tomb));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'alert fills stop and setup, review queue, empty books hidden, old markers dropped');
  errs.forEach(e => { console.log('     ' + e); failures.push('cleanup: ' + e); });
}

// Revenge sizing, behaviour score and the weekly process grade. Two losses in a
// row, then a trade three times their size: flagged, with the extra size's share
// of its loss (-6 x (1 - 100/300) = -4). A smaller one after that is not.
async function behaviourRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const v = await page.evaluate(() => {
      const d = todayDay();
      const tr = (id, time, exitTime, exit, qty, stop) => ({ id, accountId: 'acc_cry', date: d, exitDate: d, time, exitTime, symbol: 'XREVUSD', direction: 'long', entry: 100, exit, qty, fees: 0, stop: stop || 0, setup: '', rules: [], notes: '' });
      state.trades = state.trades.concat([tr('rv1', '10:00', '10:10', 99, 1, 99.5), tr('rv2', '10:20', '10:30', 99, 1), tr('rv3', '10:40', '10:50', 98, 3), tr('rv4', '11:30', '11:40', 99, 1.1)]);
      state.ui.account = 'all'; state.ui.weekOffset = 0; state.ui.dashSec = 'week';
      save(); switchTab('dashboard'); renderAll();
      const rows = analyzeTrades(statScoped()), mine = rows.filter(x => /^rv/.test(x.t.id));
      const out = { flagged: mine.filter(x => x.revenge).map(x => x.t.id) };
      const r3 = mine.find(x => x.t.id === 'rv3');
      out.r3 = r3 && r3.revenge ? { run: r3.revenge.lossRun, x: +r3.revenge.x.toFixed(4), extra: +r3.revenge.extraLoss.toFixed(4), flag: r3.flags.includes('revengeSize') } : null;
      const b = behaviourScore(mine);
      out.score = { n: b.n, calm: b.parts.disc.calm, clean: b.parts.disc.clean, rules: b.parts.disc.rules, disc: b.disc, stops: b.parts.risk.stops, rev: b.revenge.length };
      out.empty = behaviourScore([]);
      out.calm = AN_RULES.find(r => r.k === 'calm').broke(r3);
      const host = document.getElementById('processGrade');
      out.panel = host ? host.innerText.replace(/\s+/g, ' ') : '';
      out.grade = host && host.querySelector('[data-grade]') ? host.querySelector('[data-grade]').getAttribute('data-grade') : null;
      out.bars = host ? host.querySelectorAll('[data-bscore]').length : 0;
      return out;
    });
    check(JSON.stringify(v.flagged) === '["rv3"]', 'revenge-sized trades: ' + JSON.stringify(v.flagged));
    check(v.r3 && v.r3.run === 2 && v.r3.x === 3 && v.r3.extra === -4 && v.r3.flag, 'revenge sizing on rv3: ' + JSON.stringify(v.r3));
    check(v.calm === true, 'calm rule should count revenge sizing');
    // rv2 and rv3 re-entered within 15 min of a loss, rv4 traded past the 2.5 daily loss limit: 1 of 4 calm.
    // Nothing reviewed or ticked, so those checks stay out; one stop in four.
    check(v.score.n === 4 && v.score.calm === 0.25 && v.score.clean === null && v.score.rules === null && v.score.disc === 25 && v.score.stops === 0.25 && v.score.rev === 1, 'behaviour score: ' + JSON.stringify(v.score));
    check(v.empty.overall === null && v.empty.grade === null, 'empty week should have no grade: ' + JSON.stringify(v.empty));
    check(/^[A-F]$/.test(v.grade || '') && v.bars === 3 && /PROCESS GRADE/i.test(v.panel) && v.panel.includes('XREVUSD') && v.panel.includes('3.0× size after 2 losses') && v.panel.includes('revenge-sized trade'), 'process grade panel: ' + JSON.stringify([v.grade, v.bars, v.panel.slice(0, 600)]));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'revenge sizing, behaviour score, weekly process grade');
  errs.forEach(e => { console.log('     ' + e); failures.push('behaviour: ' + e); });
}

// Every trade gets a setup and its level from the scanner's alerts. Line 0 (support)
// runs 100 -> 102 over the day before its alert, so an hour after the alert it is at
// 102.083; the alert's risk is 1. A long at 102.3 is SUPPORT, a short at 100.5 is
// 1.58R under it: SP BROKEN. Line 1 (resistance) sits at 120: a short at 120.2 is
// RESISTANCE, a long at 121.5 RT BROKEN. Anything picked by hand stays.
async function setupLevelRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const v = await page.evaluate(() => {
      const out = {};
      const d = iso(new Date(Date.now() - 2 * 864e5)), later = iso(new Date(Date.now() + 5 * 864e5 - 2 * 864e5));
      const at = istMs(d, '09:00') / 1000;
      // The scanner's file: a trendline record keeps its two anchor prices.
      const line = JSON.stringify({ id: 'tl|XLINE/USDT:USDT|4h|0|' + (at - 86400) + '|' + at + '@' + at, kind: 'trendline', line: 0, market: 'crypto', symbol: 'XLINE/USDT:USDT', tf: '4h', price: 102.5, sent_ts: at, plan: { side: 'long', entry: 102, sl: 101 }, from: [100, 'a'], to: [102, 'b'] });
      out.parsed = parseFibTl(line, '{}', '{}').records[0].tl;
      state.playbook = [{ id: 'pbf', name: 'FIB', rules: ['L1', 'L2', 'L3', 'L4'] }, { id: 'pbt', name: 'TRENDLINE', rules: ['SUPPORT', 'RESISTANCE', 'SP BROKEN', 'RT BROKEN'] }, { id: 'pbc', name: 'Checklist', rules: ['A', 'B'] }];
      const sig = (id, sym, ln, side, entry, stop, tl) => ({ id, kind: 'trendline', key: `tl|${sym}|4h|${ln}|${at - 86400}|${at}@${at}`, date: d, time: '09:00', symbol: sym, side, entry, stop, tl, timeframe: '4H', filled: true, scoredDaily: true });
      state.signals = [sig('sga', 'TLA', 0, 'long', 102, 101, [100, 102]), sig('sgb', 'TLB', 1, 'short', 120, 121, [120, 120])];
      const tr = (id, sym, dir, entry, exit, extra) => Object.assign({ id, accountId: 'acc_cry', date: d, time: '10:00', symbol: sym + 'USD', direction: dir, entry, exit, qty: 1, fees: 0, stop: 0, setup: '', rules: [], notes: '' }, extra || {});
      state.trades = state.trades.concat([
        tr('a1', 'TLA', 'long', 102.3, 103), tr('a2', 'TLA', 'short', 100.5, 100), tr('b1', 'TLB', 'short', 120.2, 119), tr('b2', 'TLB', 'long', 121.5, 121),
        tr('old', 'TLA', 'long', 102.3, 103, { date: later }),
        tr('h1', 'TLA', 'long', 102.3, 102, { setup: 'FIB', playRules: { L1: false, L2: true, L3: false, L4: false } }),
        tr('z1', 'TLA', 'long', 102.2, 103, { setup: 'ZONE', setupAuto: true }),
        tr('n1', 'TLA', 'long', 102.3, 103, { noSetup: true }),
        tr('c1', 'TLB', 'short', 120.1, 119, { setup: 'Checklist', playRules: { A: true, B: false } })
      ]);
      save(); renderAll();
      const one = id => { const t = state.trades.find(x => x.id === id); return [t.setup, Object.keys(t.playRules || {}).filter(k => t.playRules[k]).join(','), !!t.playAuto]; };
      out.got = {}; ['a1', 'a2', 'b1', 'b2', 'old', 'h1', 'z1', 'n1', 'c1'].forEach(id => { out.got[id] = one(id); });
      renderPlaybook();
      const card = n => [...document.querySelectorAll('#playbookList > div')].find(x => x.querySelector('.text-amber-300') && x.querySelector('.text-amber-300').textContent === n);
      out.tl = card('TRENDLINE').innerText.replace(/\s+/g, ' ');
      out.chk = card('Checklist').innerText.replace(/\s+/g, ' ');
      out.cov = document.getElementById('playCoverage').innerText;
      // The inspector: one level at a time, and a level tapped by hand is yours.
      openInspector(allTrades().find(t => t.id === 'a1'));
      out.rows0 = [...document.querySelectorAll('#inspChecklist button:not([data-setup])')].map(b => b.innerText.replace(/\s+/g, ' ')).slice(-4);
      [...document.querySelectorAll('#inspChecklist button:not([data-setup])')].find(b => /RESISTANCE/.test(b.innerText) && !/BROKEN/.test(b.innerText)).click();
      out.after = one('a1');
      alertFillKey = ''; fillFromAlerts();
      out.kept = one('a1');
      return out;
    });
    check(JSON.stringify(v.parsed) === '[100,102]', 'trendline anchors kept from the scanner file: ' + JSON.stringify(v.parsed));
    const want = { a1: ['TRENDLINE', 'SUPPORT', true], a2: ['TRENDLINE', 'SP BROKEN', true], b1: ['TRENDLINE', 'RESISTANCE', true], b2: ['TRENDLINE', 'RT BROKEN', true], old: ['', '', false],
      h1: ['FIB', 'L2', false], z1: ['TRENDLINE', 'SUPPORT', true], n1: ['', '', false], c1: ['Checklist', 'A', false] };
    Object.keys(want).forEach(id => check(JSON.stringify(v.got[id]) === JSON.stringify(want[id]), id + ': ' + JSON.stringify(v.got[id]) + ' wanted ' + JSON.stringify(want[id])));
    check(/SUPPORT ?100% win · 2 trades/.test(v.tl) && /SP BROKEN ?100% win · 1 trade/.test(v.tl) && /RESISTANCE ?100% win · 1 trade/.test(v.tl) && /RT BROKEN ?0% win · 1 trade/.test(v.tl) && !/Broke a rule/.test(v.tl) && /5 trades \(5 from alerts\)/.test(v.tl), 'trendline levels card: ' + v.tl);
    check(/Kept every rule/.test(v.chk) && /Broke a rule ?100% win · 1 trade/.test(v.chk), 'checklist setup still kept/broke: ' + v.chk);
    check(/have a setup · \d+ have a level · \d+ filled in from alerts/.test(v.cov), 'coverage line: ' + v.cov);
    check(JSON.stringify(v.rows0) === '["✓ SUPPORT","○ RESISTANCE","○ SP BROKEN","○ RT BROKEN"]', 'inspector levels: ' + JSON.stringify(v.rows0));
    check(JSON.stringify(v.after) === '["TRENDLINE","RESISTANCE",false]' && JSON.stringify(v.kept) === '["TRENDLINE","RESISTANCE",false]', 'level picked by hand stays: ' + JSON.stringify([v.after, v.kept]));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'setup and level from fib and trendline alerts, playbook levels');
  errs.forEach(e => { console.log('     ' + e); failures.push('setup level: ' + e); });
}

// Analysis filters (lakky, 2026-10-31): the Signals tab's filter set on your own
// trades. Expected counts are worked out by hand from the trades seeded here.
async function analysisFiltersRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const d = await page.evaluate(() => {
      const d = iso(new Date(Date.now() - 2 * 864e5)), later = iso(new Date(Date.now() + 3 * 864e5));
      const at = istMs(d, '09:00') / 1000;
      state.playbook = [{ id: 'pbf', name: 'FIB', rules: ['L1', 'L2', 'L3', 'L4'] }, { id: 'pbt', name: 'TRENDLINE', rules: ['SUPPORT', 'RESISTANCE', 'SP BROKEN', 'RT BROKEN'] }, { id: 'pbc', name: 'Checklist', rules: ['A', 'B'] }];
      const sig = (id, sym, ln, side, entry, stop, tl) => ({ id, kind: 'trendline', channel: 'CRYPTO 4H', key: `tl|${sym}|4h|${ln}|${at - 86400}|${at}@${at}`, date: d, time: '09:00', symbol: sym, side, entry, stop, tl, timeframe: '4H', filled: true, scoredDaily: true });
      state.signals = [sig('sga', 'TLA', 0, 'long', 102, 101, [100, 102]), sig('sgb', 'TLB', 1, 'short', 120, 121, [120, 120]),
        { id: 'zz', date: d, time: '09:00', symbol: 'ZZ', side: 'long', entry: 50, stop: 49, channel: 'CRYPTO 1D', filled: true }];
      const tr = (id, sym, dir, entry, exit, extra) => Object.assign({ id, accountId: 'acc_cry', date: d, time: '10:00', symbol: sym + 'USD', direction: dir, entry, exit, qty: 1, fees: 0, stop: 0, setup: '', rules: [], notes: '' }, extra || {});
      state.trades = state.trades.concat([
        tr('a1', 'TLA', 'long', 102.3, 103, { fees: 0.1 }), tr('a2', 'TLA', 'short', 100.5, 100), tr('b1', 'TLB', 'short', 120.2, 119), tr('b2', 'TLB', 'long', 121.5, 121),
        tr('old', 'TLA', 'long', 102.3, 103, { date: later }),
        tr('h1', 'TLA', 'long', 102.3, 102, { setup: 'FIB', playRules: { L1: false, L2: true, L3: false, L4: false } }),
        tr('z1', 'TLA', 'long', 102.2, 103, { setup: 'ZONE', setupAuto: true }),
        tr('n1', 'TLA', 'long', 102.3, 103, { noSetup: true }),
        tr('c1', 'TLB', 'short', 120.1, 119, { setup: 'Checklist', playRules: { A: true, B: false } }),
        tr('zz1', 'ZZ', 'long', 50.2, 51)
      ]);
      state.ui.account = 'acc_cry'; state.ui.allCur = 'USD'; state.ui.anSec = 'overview';
      save(); renderAll(); switchTab('analysis');
      return d;
    });
    const read = (ui) => page.evaluate(u => {
      Object.assign(state.ui, { anKind: '', anLvl: '', anTlType: '', anChan: '', anNoFee: false, anPeriod: 'all' }, u);
      renderAnalysis();
      const card = k => { const c = document.querySelector('#anStrip [data-ancard="' + k + '"]'); return c ? c.innerText.replace(/\s+/g, ' ') : ''; };
      const checked = [...document.querySelectorAll('#anStrip > div')].find(x => /Trades checked/i.test(x.innerText));
      const cnt = {}; document.querySelectorAll('#anKindBar button').forEach(b => { cnt[b.dataset.ankind || 'all'] = +b.querySelector('.cnt').innerText; });
      const brk = document.querySelector('#anBrokers tr[data-anbroker="acct:acc_cry"]');
      return { n: checked ? +checked.querySelector('.mono-num').innerText : 0, net: card('net'), cnt, brk: brk ? brk.children[2].innerText.trim() : '',
        lvl: !document.getElementById('anLvlWrap').classList.contains('hidden'), tl: !document.getElementById('anTlWrap').classList.contains('hidden'),
        chans: [...document.querySelectorAll('#anChanSel option')].map(o => o.innerText), hint: document.getElementById('anFilterHint').innerText, rules: document.getElementById('anRulesSum').innerText };
    }, ui);
    const all = await read({});
    check(JSON.stringify(all.cnt) === JSON.stringify({ all: 18, zone: 1, fib: 1, trendline: 5, none: 11 }), 'alert type counts: ' + JSON.stringify(all.cnt));
    check(all.n === 18 && !all.lvl && !all.tl, 'all trades: ' + JSON.stringify(all));
    check(all.chans.length === 3 && /\(18\)$/.test(all.chans[0]) && /4h \(5\)$/i.test(all.chans[1]) && /1D \(1\)$/i.test(all.chans[2]), 'channel list: ' + all.chans.join());
    const tl = await read({ anKind: 'trendline' });
    check(tl.n === 5 && tl.tl && !tl.lvl && tl.brk === '5', 'trendline trades (and the broker table): ' + JSON.stringify(tl));
    const types = {};
    for (const k of ['support', 'resistance', 'spbr', 'rsbr']) types[k] = (await read({ anKind: 'trendline', anTlType: k })).n;
    check(JSON.stringify(types) === '{"support":2,"resistance":1,"spbr":1,"rsbr":1}', 'trendline types: ' + JSON.stringify(types));
    const fib = await read({ anKind: 'fib' }), l2 = await read({ anKind: 'fib', anLvl: 'L2' }), l1 = await read({ anKind: 'fib', anLvl: 'L1' });
    check(fib.n === 1 && fib.lvl && !fib.tl && l2.n === 1 && l1.n === 0, 'fib levels: ' + JSON.stringify([fib.n, fib.lvl, l2.n, l1.n]));
    const none = await read({ anKind: 'none' });
    check(none.n === 11, 'no-alert trades: ' + none.n);
    const c4 = await read({ anChan: 'CRYPTO 4H' }), c1 = await read({ anChan: 'CRYPTO 1D' });
    check(c4.n === 5 && c1.n === 1, 'channels: ' + JSON.stringify([c4.n, c1.n]));
    // a1 made 0.70 before a 0.10 fee, z1 made 0.80: 1.40 with fees, 1.50 without.
    const w = await read({ anKind: 'trendline', anTlType: 'support' }), wo = await read({ anKind: 'trendline', anTlType: 'support', anNoFee: true });
    check(/\+\$1\.40/.test(w.net) && /\+\$1\.50/.test(wo.net) && /no fees/.test(wo.rules) && /with fees/.test(w.rules), 'fees with / without: ' + JSON.stringify([w.net, wo.net, wo.rules]));
    const day1 = await read({ anPeriod: '1d' });
    const cust = await read({ anPeriod: 'custom', anCustom: { from: d, to: d } });
    const swap = await read({ anPeriod: 'custom', anCustom: { from: d, to: '2000-01-01' } });
    check(day1.cnt.all === 0, '1 day: ' + JSON.stringify(day1.cnt));
    // The sample journal's own crypto trades can land on that day too (it depends on the clock).
    const own = await page.evaluate(day => state.trades.filter(t => t.accountId === 'acc_cry' && /^tr\d/.test(t.id) && dayOf(t) === day).length, d);
    check(cust.cnt.all === 9 + own && cust.n === 9 + own && cust.hint.indexOf(d + ' → ' + d) === 0, 'custom range: ' + JSON.stringify([cust.cnt, cust.n, cust.hint]));
    check(swap.cnt.all > 9 + own, 'custom range given backwards still reads from 2000 to the day: ' + JSON.stringify(swap.cnt));
    // Clicking through the bar works too.
    await page.evaluate(() => { Object.assign(state.ui, { anKind: '', anPeriod: 'all' }); renderAnalysis(); });
    await page.click('#anKindBar button[data-ankind="fib"]');
    await page.click('#anLvlBar button[data-lvl="L2"]');
    const clicked = await page.evaluate(() => [state.ui.anKind, state.ui.anLvl, document.getElementById('anFilterHint').innerText, !document.getElementById('anReset').classList.contains('hidden')]);
    check(clicked[0] === 'fib' && clicked[1] === 'L2' && /fib L2/.test(clicked[2]) && clicked[3], 'clicking the bars: ' + JSON.stringify(clicked));
    // Overview insights: setups by result, and a click on one filters the tab to it.
    await page.click('#anReset');
    const bd = await page.evaluate(() => { state.ui.anBdDim = 'setup'; renderAnalysis();
      const rows = [...document.querySelectorAll('#anBreakdown [data-bdk]')].map(r => r.getAttribute('data-bdk') + ':' + r.children[1].innerText);
      return { rows, ins: [...document.querySelectorAll('#anInsights .ins-row')].map(r => r.innerText.replace(/\s+/g, ' ')), kind: state.ui.anKind }; });
    check(bd.kind === '' && bd.rows.indexOf('Support TL:2') !== -1 && bd.rows.indexOf('Fib L2:1') !== -1 && bd.rows.indexOf('Zone:1') !== -1 && bd.rows.indexOf('No alert:11') !== -1, 'results by setup: ' + JSON.stringify(bd.rows));
    check(bd.ins.length >= 2 && bd.ins.some(t => /^. Keep: /.test(t)), 'insights: ' + JSON.stringify(bd.ins));
    await page.click('#anBreakdown [data-bdk="Support TL"]');
    const after = await page.evaluate(() => [state.ui.anKind, state.ui.anTlType, document.querySelector('#anStrip [data-ancard="win"] .mono-num').innerText]);
    check(after[0] === 'trendline' && after[1] === 'support', 'clicking a setup filters to it: ' + JSON.stringify(after));
    // Delta / All books get the broker report's view: 8 numbers, equity, pairs, days.
    // Support TL is a1 (+0.60 after a 0.10 fee) and z1 (+0.80), both on TLAUSD.
    const rep = await page.evaluate(() => { state.ui.anSec = 'report'; renderAnalysis();
      const card = l => (document.querySelector('#anStrip [data-ancard="' + l + '"] .mono-num') || {}).innerText;
      return { head: !document.getElementById('anRepHead').classList.contains('hidden'), net: card('net'), win: card('win'), fees: document.getElementById('anRepSub').innerText, bw: card('bw'), n: document.querySelectorAll('#anStrip > div').length,
        pairs: [...document.querySelectorAll('#btPairs [data-anpair]')].map(b => b.getAttribute('data-anpair')), days: document.querySelectorAll('#btDays > div').length, sel: [...document.querySelectorAll('#anPairSel option')].map(o => o.value) }; });
    check(rep.head && rep.n === 8 && /\+\$1\.40/.test(rep.net) && rep.win === '100%' && /fees \$0\.10/.test(rep.fees) && /^\+\$0\.80 TLAUSD \+\$0\.60 TLAUSD$/.test(rep.bw.replace(/\s+/g, ' ')) && rep.pairs.join() === 'TLAUSD' && rep.days === 1 && rep.sel.indexOf('TLAUSD') !== -1, 'journal report: ' + JSON.stringify(rep));
    const onePair = await page.evaluate(() => { state.ui.anKind = ''; state.ui.anTlType = ''; state.ui.anPair = 'ZZUSD'; renderAnalysis(); const n = +[...document.querySelectorAll('#anStrip > div')].find(x => /Trades checked/i.test(x.innerText)).querySelector('.mono-num').innerText; state.ui.anPair = ''; return n; });
    check(onePair === 1, 'pair filter on a journal book: ' + onePair);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Analysis filters: alert type, period, channel, level, trendline type, fees');
  errs.forEach(e => { console.log('     ' + e); failures.push('analysis filters: ' + e); });
}

// Analysis in Signals' design, and its demo mode (lakky, 2026-11-08: "check what mistakes
// i did if i go with the tp and sl not with amount i saw and exit"): each trade with a
// stop is replayed from its own entry on (fake) Delta candles with the panel's target,
// then set beside the exit taken. Every plan figure below is worked out by hand.
async function anDemoRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  // Three days ago, 10:00 IST: every trade opens then.
  const d0 = new Date(Date.now() - 3 * 864e5 + 5.5 * 3600e3).toISOString().slice(0, 10);
  const T0 = Date.parse(d0 + 'T10:00:00+05:30'), H = 3600e3;
  // Each coin: a flat price, and a few moves at given times after the entry.
  const PATHS = {
    BTCUSD: { base: 100, ev: [[0.5 * H, 'h', 101.6]] },               // long 100 / 99: reaches 1.5R at 10:30
    ETHUSD: { base: 200, ev: [[0.3 * H, 'h', 202.5]] },               // short 200 / 202: stopped at 10:18
    SOLUSD: { base: 50, ev: [[0.6 * H, 'l', 48.9]] },                 // long 50 / 49: stopped at 10:36
    XRPUSD: { base: 1, ev: [[40 * H, 'h', 1.016]] },                  // long 1 / 0.99: 1.5R only after 40 h (15m candles)
    ADAUSD: { base: 10, ev: [] }                                      // long 10 / 9.9: never moves, still open
  };
  const reads = [];
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const u = new URL(route.request().url()), sym = u.searchParams.get('symbol'), p = PATHS[sym];
    const res = u.searchParams.get('resolution'), ms = { '1m': 60e3, '15m': 900e3, '4h': 4 * H }[res];
    // BTC days (1d / 1h) are not the demo's: refused, like the other tests do.
    if (!ms) return route.abort();
    reads.push(sym + ' ' + res);
    if (!p) return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: [] }) });
    const from = +u.searchParams.get('start') * 1000, to = Math.min(+u.searchParams.get('end') * 1000, Date.now()), out = [];
    for (let t = Math.ceil(from / ms) * ms; t < to; t += ms) {
      let h = p.base * 1.0005, l = p.base * 0.9995;
      p.ev.forEach(([at, k, v]) => { const e = T0 + at; if (e >= t && e < t + ms) { if (k === 'h') h = Math.max(h, v); else l = Math.min(l, v); } });
      out.push({ time: t / 1000, open: p.base, high: h, low: l, close: p.base });
    }
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: out.reverse() }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof tgtReady !== 'undefined' && tgtReady, null, { timeout: 5000 });
    await page.evaluate(d => {
      const tr = (id, sym, dir, entry, exit, stop, qty, extra) => Object.assign({ id, accountId: 'acc_cry', date: d, time: '10:00', exitDate: d, exitTime: '11:00', symbol: sym, direction: dir, entry, exit, stop, qty, fees: 0.1, setup: '', rules: [], notes: '' }, extra || {});
      state.trades = state.trades.filter(t => t.accountId !== 'acc_cry').concat([
        tr('dBTC', 'BTCUSD', 'long', 100, 100.5, 99, 2),     // you +0.9, plan +1.5R = 3 - 0.1 = +2.9
        tr('dETH', 'ETHUSD', 'short', 200, 203, 202, 1),     // you -3.1, plan SL -1.0505R = -2.101 - 0.1 = -2.201
        tr('dSOL', 'SOLUSD', 'long', 50, 49.6, 49, 2),       // you -0.9, plan SL -1.0245R = -2.049 - 0.1 = -2.149
        tr('dXRP', 'XRPUSD', 'long', 1, 1.004, 0.99, 100),   // you +0.3, plan +1.5R = 1.5 - 0.1 = +1.4
        tr('dADA', 'ADAUSD', 'long', 10, 10.05, 9.9, 1),     // still open on the plan
        tr('dNo', 'DOGEUSD', 'long', 0.2, 0.21, 0, 100)      // no stop: not replayed
      ]);
      state.signals = [];
      Object.assign(state.ui, { account: 'acc_cry', allCur: 'USD', anSec: 'overview', anKind: '', anChan: '', anLvl: '', anTlType: '', anCoins: '', anNoFee: false, anPeriod: 'all', mktFilter: '', anPair: '' });
      delete state.ui.anPlay;
      save(); renderAll(); switchTab('analysis');
    }, d0);
    // The Signals design: two folding panels, 8 cards, and no candle read without the demo.
    const look = await page.evaluate(() => ({ which: !!document.querySelector('#anWhichPanel[open] #anPeriodBar'), rules: !!document.querySelector('#anRulesPanel[open] #anTgtBar'),
      exits: [...document.querySelectorAll('#anTgtBar button')].map(b => b.innerText).join(), cards: document.querySelectorAll('#anStrip > div').length,
      coins: [...document.querySelectorAll('#anCoinBar button[data-coins]')].map(b => b.innerText).join(), line: document.getElementById('anDemoLine').classList.contains('hidden') }));
    check(look.which && look.rules && look.exits === 'My exit,1R,1.5R,2R,3R,1%,2%,3%' && look.cards === 8 && look.coins === 'All,Top 3,Top 5,Picks' && look.line, 'Signals-style panels: ' + JSON.stringify(look));
    await page.waitForTimeout(300);
    check(reads.length === 0, 'no candles read with My exit: ' + reads.join());
    // Fold a panel: it says in one line what it is set to, and stays folded after a reload.
    await page.click('#anWhichPanel > summary h3');
    await page.waitForTimeout(100);
    const sum = await page.evaluate(() => ({ open: document.getElementById('anWhichPanel').open, sum: document.getElementById('anWhichSum').innerText, fold: state.ui.sigFold }));
    check(!sum.open && /All trades · All · all channels/.test(sum.sum) && sum.fold && sum.fold.anWhich === true, 'folded Which trades: ' + JSON.stringify(sum));
    await page.click('#anWhichPanel > summary h3');
    // Demo at 1.5R: the Demo section opens and every trade with a stop is read.
    await page.click('#anTgtBar button[data-tgt="1.5R"]');
    await page.waitForFunction(() => !anDemoBusy && /4 of 6 trades replayed/.test(document.getElementById('anDemoLine').innerText), null, { timeout: 15000 });
    const v = await page.evaluate(() => {
      const card = k => (document.querySelector('#anStrip [data-ancard="' + k + '"]') || {}).innerText || '';
      const rows = {}; document.querySelectorAll('#anDemoTable tbody tr').forEach(tr => { rows[tr.getAttribute('data-demorow')] = [...tr.children].map(td => td.innerText.replace(/\s+/g, ' ').trim()); });
      return { sec: state.ui.anSec, shown: !document.querySelector('[data-ansec="demo"]').classList.contains('hidden'), line: document.getElementById('anDemoLine').innerText,
        n: card('demo-n'), net: card('net'), diff: card('diff'), win: card('win'), avgr: card('avgr'), rows, head: document.getElementById('anDemoHead').innerText.replace(/\s+/g, ' ').trim(), chips: [...document.querySelectorAll('#anDemoLine .demo-chip')].map(c => c.innerText).join('|'), habit: (document.getElementById('anDemoHabit') || {}).innerText || '',
        groups: [...document.querySelectorAll('#anDemoGroups [data-verdict]')].map(b => b.getAttribute('data-verdict') + ':' + b.innerText.replace(/\s+/g, ' ')),
        rules: document.getElementById('anRulesSum').innerText };
    });
    check(v.sec === 'demo' && v.shown, 'picking a target opens Demo vs you: ' + v.sec);
    check(/2 with no stop|1 with no stop/.test(v.line) && /1 still open/.test(v.line), 'demo line counts the trades it could not play: ' + v.line);
    // Plan: +2.90 -2.201 -2.149 +1.40 = -0.05; you: +0.90 -3.10 -0.90 +0.30 = -2.80; plan vs you +2.75.
    check(/-\$0\.05/.test(v.net) && /you -\$2\.80/.test(v.net), 'demo net vs yours: ' + v.net);
    check(/\+\$2\.75/.test(v.diff) && /what your exits cost/.test(v.diff), 'plan vs you: ' + v.diff);
    check(/50%/.test(v.win) && /you 50%/.test(v.win), 'win rate: ' + v.win);
    const row = (id, you, plan, how, diff, what) => {
      const r = v.rows[id];
      check(r && r[1].indexOf(you) === 0 && r[2].indexOf(plan) === 0 && r[2].indexOf(how) !== -1 && r[3] === diff && r[4] === what, id + ': ' + JSON.stringify(r));
    };
    row('dBTC', '+$0.90', '+$2.90', 'Target', '+$2.00', 'Closed before the TP');
    row('dETH', '-$3.10', '-$2.20', 'SL', '+$0.90', 'Lost past the stop');
    row('dSOL', '-$0.90', '-$2.15', 'SL', '-$1.25', 'Cut before the stop');
    row('dXRP', '+$0.30', '+$1.40', 'Target', '+$1.10', 'Closed before the TP');
    check(!v.rows.dADA && !v.rows.dNo, 'open and stop-less trades are not in the table: ' + Object.keys(v.rows).join());
    check(/Costliest habit: Closed before the TP · 2 trades · \$3\.10 less than the plan/.test(v.habit), 'costliest habit: ' + v.habit);
    // +0.48R: plan - you in R a trade, BTC +2.00 / 2, ETH +0.90 / 2, SOL -1.25 / 2, XRP +1.10 / 1 = 1.925 / 4.
    check(v.head === 'Plan made -$0.05 4 trades held to the rules You made -$2.80 same trades, your exits Your exits cost $2.75 +0.48R a trade vs the plan', 'demo head, three figures: ' + v.head);
    check(v.chips === 'Exit 1.5R|Held till TP or SL' && /Back to my exits/.test(v.line), 'demo rules as chips: ' + v.chips + ' / ' + v.line);
    check(v.groups.length === 3 && /^early:/.test(v.groups[0]) && v.groups.some(g => /^saved:/.test(g)), 'groups: ' + JSON.stringify(v.groups));
    check(/demo: exit at 1\.5R/.test(v.rules), 'rules summary: ' + v.rules);
    // Candles: 1m first, and no more once 1.5R closes the trade. ETH and SOL are stopped and
    // BTC reaches 1.5R within the day: 1m only. XRP's 1.5R comes after 40 h, so it reads 15m
    // candles too; ADA (open) reads on up to now. DOGE (no stop) is never read.
    const rd = reads.join();
    check(/BTCUSD 1m/.test(rd) && !/BTCUSD 15m/.test(rd) && !/ETHUSD 15m/.test(rd) && !/SOLUSD 15m/.test(rd) && /XRPUSD 15m/.test(rd) && /ADAUSD 15m/.test(rd) && !/DOGE/.test(rd) && !/4h/.test(rd) && reads.length === 7, 'candle reads: ' + rd);
    // A group click lists only its trades.
    await page.click('#anDemoGroups [data-verdict="saved"]');
    const only = await page.evaluate(() => [...document.querySelectorAll('#anDemoTable tbody tr')].map(tr => tr.getAttribute('data-demorow')));
    check(only.join() === 'dSOL', 'group filter: ' + only.join());
    // Redraws read nothing again, and neither does a reload: the trades 1.5R closes are kept,
    // and ADA, still open, was read under 15 minutes ago.
    const before = reads.length;
    await page.evaluate(() => renderAnalysis());
    await page.waitForTimeout(400);
    check(reads.length === before, 'no new reads on a redraw: ' + reads.slice(before).join());
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => typeof tgtReady !== 'undefined' && tgtReady, null, { timeout: 5000 });
    await page.evaluate(() => switchTab('analysis'));
    await page.waitForFunction(() => document.getElementById('anDemoLine') && /4 of 6 trades replayed/.test(document.getElementById('anDemoLine').innerText) && !anDemoBusy, null, { timeout: 15000 });
    await page.waitForTimeout(300);
    check(reads.length === before, 'nothing read again after a reload: ' + reads.slice(before).join());
    // 3R: BTC's walk stopped at 1.5R, so it is read on (to now, still open); XRP's already
    // runs to now and ADA's is fresh. ETH and SOL stay stopped.
    await page.click('#anTgtBar button[data-tgt="3R"]');
    // "3 still open" only once BTC's later candles are in (until then it is waiting for prices).
    await page.waitForFunction(() => !anDemoBusy && /2 of 6 trades replayed.*3 still open/.test(document.getElementById('anDemoLine').innerText), null, { timeout: 15000 });
    const r3 = await page.evaluate(() => ({ line: document.getElementById('anDemoLine').innerText, ids: [...document.querySelectorAll('#anDemoTable tbody tr')].map(tr => tr.getAttribute('data-demorow')).sort().join() }));
    check(reads.slice(before).join() === 'BTCUSD 1m,BTCUSD 15m' && /3 still open/.test(r3.line) && r3.ids === 'dETH,dSOL', '3R reads only BTC on: ' + reads.slice(before).join() + ' ' + JSON.stringify(r3));
    // Back to 1.5R: nothing read, the same figures.
    const b15 = reads.length;
    await page.click('#anTgtBar button[data-tgt="1.5R"]');
    await page.waitForFunction(() => !anDemoBusy && /4 of 6 trades replayed/.test(document.getElementById('anDemoLine').innerText), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    const bt = await page.evaluate(() => [...document.querySelector('#anDemoTable tr[data-demorow="dBTC"]').children].map(td => td.innerText.replace(/\s+/g, ' ').trim()));
    check(reads.length === b15 && bt[2].indexOf('+$2.90') === 0, 'back to 1.5R, nothing read: ' + reads.slice(b15).join() + ' ' + JSON.stringify(bt));
    // Hold 1 day: XRP's 1.5R comes too late, so it closes at the day's price (Time exit).
    await page.click('#anHoldBar button[data-hold="1d"]');
    await page.waitForFunction(() => !anDemoBusy && document.querySelector('#anDemoTable tr[data-demorow="dXRP"]'), null, { timeout: 15000 });
    await page.waitForTimeout(300);
    const x1 = await page.evaluate(() => [...document.querySelector('#anDemoTable tr[data-demorow="dXRP"]').children].map(td => td.innerText.replace(/\s+/g, ' ').trim()));
    check(/Time exit/.test(x1[2]) && x1[2].indexOf('-$0.10') === 0, 'XRP held 1 day: ' + JSON.stringify(x1));
    // Coins: Top 3 by market cap keeps BTC, ETH and XRP.
    await page.click('#anHoldBar button[data-hold="tp"]');
    await page.click('#anCoinBar button[data-coins="top3"]');
    await page.waitForFunction(() => !anDemoBusy, null, { timeout: 15000 });
    const top = await page.evaluate(() => ({ ids: [...document.querySelectorAll('#anDemoTable tbody tr')].map(tr => tr.getAttribute('data-demorow')).sort().join(), list: (document.getElementById('anCoinList') || {}).innerText }));
    check(top.ids === 'dBTC,dETH,dXRP' && top.list === 'BTC, ETH, XRP', 'Top 3 coins: ' + JSON.stringify(top));
    // Reset puts back My exit: no demo line, the usual cards.
    await page.click('#anRulesResetBtn');
    const off = await page.evaluate(() => ({ line: document.getElementById('anDemoLine').classList.contains('hidden'), checked: [...document.querySelectorAll('#anStrip > div')].some(d => /Trades checked/.test(d.innerText)), tgt: anTgt(), quick: document.querySelectorAll('#anDemoQuick button').length }));
    check(off.line && off.checked && !off.tgt && off.quick === 7, 'reset to my exits: ' + JSON.stringify(off));
    // Pure: the walk across candle sizes. 1m then 15m candles; the fill is the candle the entry is in.
    const pure = await page.evaluate(() => {
      const px = { side: 'long', entry: 100, stop: 99, inMs: 600000 };
      const m = (t, h, l, c, r) => ({ t, h, l, c, r });
      const a = anWalk(px, [m(540000, 100.2, 98.5, 100, 60000), m(600000, 100.3, 99.5, 100.2, 60000), m(660000, 100.4, 99.8, 100.1, 60000), m(900000, 101.6, 100, 101.5, 900000)], Infinity);
      const b = anWalk(px, [m(600000, 100.3, 98.9, 100.2, 60000)], Infinity);
      const c = anWalk(px, [m(0, 1, 1, 1, 60000)], Infinity);
      const sc = w => { const o = tgtScore({ entry: 100, stop: 99, side: 'long', market: '' }, w, { k: '1.5R', r: 1.5 }, true, null, null); return o && [+o.r.toFixed(4), o.label]; };
      return { a: sc(a), b: sc(b), c: c.none || '' };
    });
    // a: the 98.5 dip came before the entry minute, so it doesn't count; 1.5R is reached on the 15m candle.
    check(JSON.stringify(pure.a) === '[1.5,"Target"]' && JSON.stringify(pure.b) === '[-1.0495,"SL"]' && /no candles/.test(pure.c), 'pure walk: ' + JSON.stringify(pure));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'Analysis: Signals-style panels and demo mode (plan TP / SL vs your exit)';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Number rows stay readable (lakky, 2026-11-08, iPad: "hard to see ... worst trade"):
// 2 across on a phone, 4 on an iPad or laptop, 8 only from 1440px; no value or line
// under it cut off or ending in "…", even for lakh-sized rupee figures; Best / worst
// shows both figures, one under the other, and the sign stays with its amount.
async function statRowsRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  for (const [name, vp, cols] of [['phone', { width: 390, height: 844 }, 2], ['iPad', { width: 1180, height: 820 }, 4], ['iPad portrait', { width: 820, height: 1180 }, 4], ['desktop', { width: 1600, height: 900 }, 8]]) {
    const ctx = await browser.newContext({ viewport: vp, timezoneId: 'Asia/Kolkata' });
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(name + ' page error: ' + (e.stack || e.message)));
    try {
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(200);
      // Two big trades on the rupee book: a lakh-sized loss and a big win.
      await page.evaluate(() => {
        // On days the rupee book has no other trade (the made-up journal's crypto days), so each is its own best / worst day.
        const used = new Set(state.trades.filter(t => t.accountId === 'acc_nse').map(dayOf)), t0 = state.trades.find(t => t.accountId === 'acc_nse');
        // The first two past days with no rupee trade. Fixed odd days found none between 00:00 and
        // 05:30 IST, when the made-up journal (machine clock - 5.5h) and the page's date differ by a day.
        const free = []; for (let n = 1; free.length < 2 && n < 60; n++) { const d = iso(new Date(Date.now() - n * 864e5)); if (!used.has(d)) free.push(d); }
        state.trades.push(Object.assign({}, t0, { id: 'bigL', date: free[0], exitDate: free[0], entry: 2000, exit: 1785.0898, stop: 1990, qty: 500, direction: 'long', pnl: -107455.2, risk: 5000, r: -21.49 }));
        state.trades.push(Object.assign({}, t0, { id: 'bigW', date: free[1], exitDate: free[1], entry: 2000, exit: 2197.5309, stop: 1990, qty: 500, direction: 'long', pnl: 98765.35, risk: 5000, r: 19.75 }));
        Object.assign(state.ui, { account: 'acc_nse', allCur: 'INR', month: 'all', anPeriod: 'all', anKind: '', anChan: '', anCoins: '', anPair: '' });
        delete state.ui.anPlay;
        save(); renderAll(); switchTab('dashboard');
      });
      // Measured after the rows are fitted (they fit on the next frame).
      const read = id => page.evaluate(id => new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => {
        const row = document.getElementById(id), cut = [];
        row.querySelectorAll('*').forEach(el => { const cs = getComputedStyle(el); if (cs.textOverflow === 'ellipsis' || el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible') cut.push(el.textContent.trim()); });
        const card = l => [...row.children].find(c => c.firstElementChild && c.firstElementChild.textContent.trim().toLowerCase() === l);
        const pair = c => c ? [...c.querySelectorAll('.stat-pair')].map(p => p.innerText.replace(/\s+/g, ' ').trim()) : [];
        // A sign on its own line: a line box ending in "-" or "+" inside any card.
        const lone = [...row.querySelectorAll('.mono-num, .truncate')].filter(el => el.getClientRects().length && /(^|\n)[+-]\s*(\n|$)/.test(el.innerText)).map(el => el.innerText);
        res({ cols: getComputedStyle(row).gridTemplateColumns.split(' ').length, cut, lone, net: (card('net p&l') || {}).innerText, bw: pair(card('best / worst')), bwd: pair(card('best / worst day')) });
      }))), id);
      const dash = await read('kpiRibbon');
      check(dash.cols === cols, name + ': dashboard row has ' + dash.cols + ' columns, wanted ' + cols);
      check(!dash.cut.length && !dash.lone.length, name + ': dashboard cut off: ' + JSON.stringify(dash.cut.concat(dash.lone)));
      check(dash.bwd.length === 2 && /^\+₹98,765\.35 \d+ \w+$/.test(dash.bwd[0]) && /^-₹1,07,455\.20 \d+ \w+$/.test(dash.bwd[1]), name + ': best / worst day: ' + JSON.stringify(dash.bwd));
      await page.evaluate(() => switchTab('analysis'));
      const an = await read('anStrip');
      check(an.cols === cols, name + ': analysis row has ' + an.cols + ' columns, wanted ' + cols);
      check(!an.cut.length && !an.lone.length, name + ': analysis cut off: ' + JSON.stringify(an.cut.concat(an.lone)));
      check(an.bw.length === 2 && /^\+₹98,765\.35 RELIANCE$/.test(an.bw[0]) && /^-₹1,07,455\.20 RELIANCE$/.test(an.bw[1]), name + ': best / worst: ' + JSON.stringify(an.bw));
      // Turning the iPad (or resizing the window) refits the rows.
      if (name === 'iPad') {
        await page.setViewportSize({ width: 1500, height: 900 });
        // A resize is fitted on the frame after it (a redraw before its first paint).
        await page.waitForTimeout(300);
        const wide = await read('anStrip');
        check(wide.cols === 8 && !wide.cut.length, 'iPad turned to 1500px: ' + JSON.stringify(wide));
      }
    } catch (e) {
      errs.push(name + ' threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
    }
    await ctx.close();
  }
  const label = 'Number rows readable on phone, iPad and desktop (no cut-off values, Best / worst stacked)';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// A trade goes to the alert whose entry is closest to its own (lakky, 2026-11-03).
// The real case: a BTC long at 76,449 on 31 Oct went to the 1W fib (L1 77,313) because
// the rebuilt history had replaced the live 1M fib alert he took (L2 76,355). The live
// alerts the rebuild hides are kept aside for matching, survive a reload, and stay off
// the Signals tab. Fib alerts at L1 / L2 / L4 get their own level's geometry.
async function alertPriceMatchRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  // Noon IST two days ago; the trade at 18:00 IST the same day.
  const at = Math.floor((Date.now() + 5.5 * 3600e3) / 864e5) * 864e5 - 5.5 * 3600e3 + 12 * 3600e3 - 2 * 864e5;
  const ist = ms => new Date(ms + 5.5 * 3600e3).toISOString();
  const s = ms => Math.floor(ms / 1000), tradeAt = at + 6 * 3600e3;
  const rec = (key, tf, sentMs, entry, sl, extra) => Object.assign({ market: 'crypto', symbol: 'BTCUSD', tf, price: entry + 500, kind: 'fib', plan: { side: 'long', entry, sl },
    id: key + '@' + s(sentMs), key, sent_ts: s(sentMs) }, extra || {});
  const w1L1 = 'fib|BTCUSD|1w|1|1782691200|87378.8|1|L1', m1L2 = 'fib|BTCUSD|1M|1|1667260800|126192.6|1|L2', w1L2 = 'fib|BTCUSD|1w|1|1782691200|87378.8|1|L2';
  const live = [rec(w1L1, '1w', at - 6 * 864e5, 77312.828, 67024.8125), rec(m1L2, '1M', at, 76355.37, 71362.9), rec(w1L2, '1w', tradeAt - 10 * 60e3, 74056.19, 70281.4505)];
  // The rebuild keeps the 1W L1 (at its candle's close) and has no 1M alert at all.
  const rebuilt = [Object.assign(rec(w1L1, '1w', at - 6 * 864e5 - 15 * 3600e3, 77312.828, 73242.0305), { id: w1L1 + '@' + s(at - 6 * 864e5 - 15 * 3600e3) + '|rb', rebuild: true })];
  const files = {
    'fib_trendline_alert_records.jsonl': live.map(r => JSON.stringify(r)).join('\n') + '\n',
    'fibtl_rebuild_records.jsonl': rebuilt.map(r => JSON.stringify(r)).join('\n') + '\n',
    'fibtl_rebuild_meta.json': JSON.stringify({ since: new Date(at - 30 * 864e5).toISOString(), cutoff: new Date(at + 864e5).toISOString(), built_at: new Date(at + 864e5).toISOString() })
  };
  let serve = true, hits = 0;
  await ctx.route(url => !url.href.startsWith(base), r => {
    const u = r.request().url();
    if (!serve || !u.includes('/scanner-runtime-state/')) return r.abort();
    hits++;
    const f = u.split('/').pop().split('?')[0];
    return r.fulfill({ status: 200, body: files[f] != null ? files[f] : f.endsWith('.json') ? '{}' : '' });
  });
  const T = ist(tradeAt);
  const trade = { id: 'trBtc', accountId: 'acc_cry', date: T.slice(0, 10), exitDate: T.slice(0, 10), time: T.slice(11, 16), exitTime: '23:30',
    symbol: 'BTCUSD', direction: 'long', entry: 76449, exit: 77986.2, stop: 0, qty: 0.005, fees: 0, leverage: 10, setup: '', rules: [], notes: '', updatedAt: new Date().toISOString() };
  const seeded = Object.assign({}, seed, { trades: seed.trades.concat([trade]),
    playbook: [{ id: 'pbf', name: 'FIB', rules: ['L1', 'L2', 'L3', 'L4'] }, { id: 'pbt', name: 'TRENDLINE', rules: ['SUPPORT', 'RESISTANCE', 'SP BROKEN', 'RT BROKEN'] }] });
  await ctx.addInitScript(x => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', x); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seeded));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  const look = () => page.evaluate(() => {
    const t = state.trades.find(x => x.id === 'trBtc'), c = tradeAlertMap().trBtc, a = anTradeSetup(t, anAlertMap());
    const row = analyzeTrades(statScoped()).find(x => x.t.id === 'trBtc');
    return { fibSignals: state.signals.filter(g => g.kind === 'fib').map(g => g.key), sent: sentSigs.map(g => g.key.split('@')[0]).sort(),
      tf: c && c.sig.timeframe, rule: c && c.rule, chan: a.chan, level: a.level, setup: t.setup, ticked: Object.keys(t.playRules || {}).filter(k => t.playRules[k]).join(),
      stop: t.stop, stopSrc: t.stopSrc || '', flags: row ? row.flags : null };
  });
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => sentSigs.length > 0 && state.trades.some(t => t.id === 'trBtc' && t.setup), null, { timeout: 8000 });
    const v = await look();
    check(JSON.stringify(v.fibSignals) === JSON.stringify([rebuilt[0].id]), 'Signals keep the rebuilt history only: ' + JSON.stringify(v.fibSignals));
    check(JSON.stringify(v.sent) === JSON.stringify([m1L2, w1L1, w1L2].sort()), 'live alerts the rebuild replaced are kept aside: ' + JSON.stringify(v.sent));
    check(v.tf === '1MO' && v.rule === 'L2' && v.chan === 'CRYPTO 1MO' && v.level === 'L2', 'BTC trade goes to the 1M L2 alert (closest entry): ' + JSON.stringify(v));
    check(v.setup === 'FIB' && v.ticked === 'L2', 'setup and level filled in: ' + JSON.stringify(v));
    check(v.stop === 71362.9 && v.stopSrc === 'alert' && v.flags && v.flags.indexOf('noAlert') === -1, "the matched alert's stop, and it counts as traded from an alert: " + JSON.stringify(v));
    // A reload with the scanner out of reach: the kept alerts come back from the device.
    serve = false; const before = hits;
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => sentSigs.length === 3, null, { timeout: 8000 });
    await page.waitForTimeout(2800);
    const r = await look();
    check(r.tf === '1MO' && r.chan === 'CRYPTO 1MO' && r.ticked === 'L2' && hits === before, 'after a reload, offline: ' + JSON.stringify(r) + ' reads ' + (hits - before));

    const u = await page.evaluate(() => {
      const out = {};
      // L1 / L2 / L4 alerts: geometry from their own level (the scanner's 1M levels).
      const g = fibGeom({ kind: 'fib', key: 'fib|BTCUSD|1M|1|1667260800|126192.6|1|L2@1793327605', entry: 76355.37, stop: 71362.9 });
      out.lv = g && FIB_LEVEL_KEYS.map(k => Math.round(g.levels[k]));
      out.old = fibGeom({ kind: 'fib', key: 'fib|ZECUSD|4h|1|1792339200|1367.83|2@1792810800', entry: 1192.039, stop: 1100 }).entryLevel;
      const l4 = fibGeom({ kind: 'fib', key: 'fib|ZECUSD|4h|1|1792339200|1367.83|2|L4@1792812168|rb', entry: 1156.8808, stop: 1112.93 });
      out.l4 = [l4.entryLevel, Math.round(l4.levels.L3 * 1000) / 1000, fibNearest(l4, 1158)];
      // Trendlines: a long near a short break alert is not that alert's; a touch of a line
      // that broke before the trade does not count; a live alert beats its rebuilt twin.
      const d = iso(new Date(Date.now() - 864e5)), ms = istMs(d, '09:00') / 1000;
      const tl = (id, line, side, entry, stop, time, extra) => Object.assign({ id, kind: 'trendline', key: `tl|TLX|4h|${line}|${ms - 86400}|${ms}${extra || ''}@${ms}`, date: d, time,
        symbol: 'TLX', side, entry, stop, tl: [entry, entry], timeframe: '4H', channel: 'CRYPTO 4H' });
      const idxOf = list => { const keep = state.signals; state.signals = list; try { return setupAlertIndex(); } finally { state.signals = keep; } };
      const tr = (entry, time, dir) => ({ id: 'x', symbol: 'TLXUSD', direction: dir || 'long', entry, date: d, time });
      const brk = Object.assign(tl('b', 0, 'short', 100.05, 101, '10:00', '|br'), { key: `tl|TLX|4h|0|${ms - 86400}|${ms + 1}|br@${ms}` });
      const far = tl('far', 0, 'long', 100.6, 99.6, '10:30'); far.key = far.key.replace(`|${ms - 86400}|`, `|${ms - 80000}|`);
      const c1 = classifyTrade(tr(100, '11:00'), idxOf([brk, far]));
      out.brk = c1 && c1.sig.id;
      const touch = tl('t', 0, 'long', 100.02, 99, '08:00'), broke = Object.assign(tl('b2', 0, 'short', 99.5, 100.5, '09:30', '|br')), other = tl('o', 0, 'long', 100.6, 99.6, '08:30');
      other.key = other.key.replace(`|${ms - 86400}|`, `|${ms - 90000}|`);
      out.broken = (classifyTrade(tr(100, '10:00'), idxOf([touch, broke, other])) || {}).sig;
      out.broken = out.broken && out.broken.id;
      out.beforeBreak = (classifyTrade(tr(100, '09:00'), idxOf([touch, broke, other])) || {}).sig;
      out.beforeBreak = out.beforeBreak && out.beforeBreak.id;
      const twin = Object.assign({}, touch, { id: 'rb', rb: true, time: '08:50' });
      out.twin = classifyTrade(tr(100, '10:00'), idxOf([touch, twin])).sig.id;
      // The broker's name can be longer than the scanner's: Delta MRVLBUSD, scanner MRVL.
      const mr = Object.assign(tl('m', 0, 'long', 250, 245, '08:00'), { symbol: 'MRVL', key: `tl|MRVL/USDT:USDT|4h|0|${ms - 86400}|${ms}@${ms}` });
      const cm = classifyTrade({ symbol: 'MRVLBUSD', direction: 'long', entry: 250.5, date: d, time: '09:00' }, idxOf([mr]));
      out.mrvl = cm && cm.sig.id;
      return out;
    });
    check(JSON.stringify(u.lv) === JSON.stringify([88538, 76355, 65280, 53098]), "an L2 alert's levels: " + JSON.stringify(u.lv));
    check(u.old === 'L3' && JSON.stringify(u.l4) === JSON.stringify(['L4', 1192.039, 'L4']), 'older keys and L4 keys: ' + JSON.stringify([u.old, u.l4]));
    check(u.brk === 'far', 'a long is not matched to a short break alert: ' + u.brk);
    check(u.broken === 'o' && u.beforeBreak === 't', 'a broken line no longer counts after its break: ' + JSON.stringify([u.broken, u.beforeBreak]));
    check(u.twin === 't', 'a live alert beats its rebuilt twin at the same price: ' + u.twin);
    check(u.mrvl === 'm', 'MRVLBUSD matches the scanner MRVL: ' + u.mrvl);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'trades match the alert with the closest entry, live alerts the rebuild replaced included');
  errs.forEach(e => { console.log('     ' + e); failures.push('alert price match: ' + e); });
}

// AI review: the key stays out of the synced file and backups, the period's trades
// go to (a fake) Gemini with the key, and its pros / cons / improve show in Analysis.
async function aiReviewRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const GEM = 'https://generativelanguage.googleapis.com/';
  const DELTA = 'https://api.india.delta.exchange/';
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith(GEM) && !url.href.startsWith(DELTA), r => r.abort());
  // A made-up XAIUSD long: in at 100 (stop 99) 3 days ago at 10:00 IST, out at 101 at 10:30.
  // While open: low 99.8 at 10:05, high 101.5 at 10:10. After: 104 at 11:00, low 100.5 at 12:30.
  const d3 = new Date(Date.now() + 5.5 * 3600e3 - 3 * 864e5).toISOString().slice(0, 10);
  const inMs = Date.parse(d3 + 'T10:00:00+05:30'), outMs = inMs + 30 * 60e3;
  const deltaCalls = [];
  await ctx.route(DELTA + '**', route => {
    const u = new URL(route.request().url());
    deltaCalls.push(u.searchParams.get('symbol') + ' ' + u.searchParams.get('resolution'));
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (u.searchParams.get('symbol') !== 'XAIUSD') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ success: true, result: [] }) });
    const out = [];
    for (let t = +u.searchParams.get('start'); t < +u.searchParams.get('end'); t += 60) {
      const ms = t * 1000, m = (ms - inMs) / 60e3;
      let h = 100.1, l = 100;
      if (m > 0 && m < 30) { h = 100.5; l = 100.2; }
      if (m === 5) l = 99.8;
      if (m === 10) h = 101.5;
      if (m >= 30) { h = 101.2; l = 100.9; }
      if (m === 60) h = 104;
      if (m === 150) l = 100.5;
      out.push({ time: t, open: l, high: h, low: l, close: h, volume: 1 });
    }
    route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ success: true, result: out.reverse() }) });
  });
  const calls = [];
  let mode = 'ok';
  await ctx.route(GEM + '**', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST' } });
    calls.push({ url: req.url(), key: req.headers()['x-goog-api-key'], body: req.postData() });
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (mode === 'quota') return route.fulfill({ status: 429, headers: cors, body: JSON.stringify({ error: { code: 429, message: 'Resource exhausted' } }) });
    if (mode === 'busy' && req.url().includes('gemini-2.5-flash:')) return route.fulfill({ status: 503, headers: cors, body: JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }) });
    if (mode === 'busy404') return route.fulfill({ status: req.url().includes('lite') ? 404 : 503, headers: cors, body: JSON.stringify({ error: { message: 'x' } }) });
    if (mode === 'allbusy') return route.fulfill({ status: 503, headers: cors, body: JSON.stringify({ error: { code: 503, message: 'high demand' } }) });
    if (mode === 'nomodel' && req.url().includes('gemini-2.5-flash')) return route.fulfill({ status: 404, headers: cors, body: JSON.stringify({ error: { code: 404, message: 'not found' } }) });
    // The connection drops ("Failed to fetch"): once, on every review call, or
    // everywhere (the reachability check too). 'slow' hangs past the time limit.
    const post = req.method() === 'POST';
    if ((mode === 'drop1' && post && calls.filter(c => c.post).length === 0) || (mode === 'dropall' && post) || mode === 'down') { calls[calls.length - 1].post = post; return route.abort('failed'); }
    if (post) calls[calls.length - 1].post = true;
    if (mode === 'slow' && post && req.url().includes('gemini-2.5-flash:')) { await new Promise(r => setTimeout(r, 1500)); return route.abort('failed').catch(() => {}); }
    if (!post && mode !== 'ok') return route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ name: 'models/x' }) });
    const answer = { verdict: 'You cut winners early.', wrong: [{ point: 'Pullback shorts lose', proof: '-3R total' }, { point: '<b>x</b>', proof: '' }], right: [{ point: 'Breakout longs win', proof: '6 of 8 won' }], trailing: [{ point: 'Trail starts too tight', proof: 'XAIUSD went 3% on' }], vas: [{ point: 'Fib 1h shorts lose', proof: 'avg -1R' }], setup: [{ point: 'Enter at L3 only', proof: 'L3 won 4 of 5' }], rules: [{ point: 'Skip pullback shorts', proof: 'They lost most' }] };
    route.fulfill({ status: 200, headers: cors, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'thinking', thought: true }, { text: JSON.stringify(answer) }] } }] }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    // No key yet: a clear message and no call.
    await page.evaluate(() => { state.ui.aiPeriod = '30d'; state.ui.anSec = 'ai'; switchTab('analysis'); renderAll(); });
    await page.click('#aiRunBtn');
    check(/Gemini API key/.test(await page.innerText('#aiStatus')) && !calls.length, 'no key should ask for one');
    // Save the key in Settings.
    await page.evaluate(() => openSettings('connect'));
    await page.fill('#aiKeyInput', 'AIzaTESTKEY');
    await page.evaluate(() => saveAiKey());
    await page.waitForTimeout(300);
    const v = await page.evaluate(() => {
      const t = todayDay(), tm = aiRange('tm'), lm = aiRange('lm'), d30 = aiRange('30d');
      const back = new Date(parseDay(tm.from)); back.setDate(back.getDate() - 1);
      return {
        badge: document.getElementById('aiKeyBadge').innerText,
        inSync: JSON.stringify(syncPayload(state)).includes('AIzaTESTKEY') || JSON.stringify(state).includes('AIzaTESTKEY'),
        tmOk: tm.from.slice(8) === '01' && tm.to === t && tm.from.slice(0, 7) === t.slice(0, 7),
        lmOk: lm.from.slice(8) === '01' && lm.to === iso(back),
        d30: d30, n30: allTrades().filter(x => dayOf(x) >= d30.from && dayOf(x) <= d30.to).length
      };
    });
    check(v.badge === 'Key saved', 'badge after saving: ' + v.badge);
    check(!v.inSync, 'the Gemini key must never be in the synced file or journal state');
    check(v.tmOk && v.lmOk, 'this / last month ranges: ' + JSON.stringify(v));
    check(calls.length === 1 && calls[0].key === 'AIzaTESTKEY' && /models\/gemini-2\.5-flash$/.test(calls[0].url), 'Save & Test should check the key once: ' + JSON.stringify(calls.map(c => c.url)));
    // The price measures, by hand from the candles above.
    const m = await page.evaluate(([d]) => {
      state.trades.push({ id: 'aiE1', accountId: 'acc_cry', date: d, exitDate: d, time: '10:00', exitTime: '10:30', symbol: 'XAIUSD', direction: 'long', entry: 100, exit: 101, stop: 99, qty: 2, fees: 0, leverage: 10, setup: 'Breakout', rules: [], notes: 'scared after a loss', tagsMistakes: [], tagsPositives: ['Trailed Stop Loss'], updatedAt: new Date().toISOString() });
      // Two VAS fib alerts: the long was taken (alert made 3R), the short skipped (-1R).
      state.signals = (state.signals || []).concat([
        { id: 'aiS1', kind: 'fib', date: d, time: '09:58', side: 'long', symbol: 'XAIUSDT', timeframe: '1h', score: '8', entry: 100, stop: 99, exit: 103, resultR: 3, outcome: 'win' },
        { id: 'aiS2', kind: 'fib', date: d, time: '14:00', side: 'short', symbol: 'XAIUSDT', timeframe: '1h', score: '6', entry: 102, stop: 103, exit: 103, resultR: -1, outcome: 'loss' }]);
      save();
      return aiPriceCheck(aiPeriodRows('30d')).then(r => r.aiE1);
    }, [d3]);
    check(m && m.mfePct === 1.5 && m.maePct === 0.2 && m.mfeU === 1.5 && m.kept === 67 && m.peakToExit === 20 && m.a1Best === 3 && m.a1Worst === 0.1 && m.a4Best === 3 && m.a4Worst === 0.5 && m.a4BestU === 3 && m.unit === 'R'
      && JSON.stringify(m.labels) === '["early_exit"]' && m.missed === 6 && m.res === 1, 'price measures: ' + JSON.stringify(m));
    check(deltaCalls.some(c => c === 'XAIUSD 1m') && deltaCalls.includes('BTCUSD 1m'), 'candles asked: ' + JSON.stringify(deltaCalls.slice(0, 5)));
    // Review.
    calls.length = 0; deltaCalls.length = 0;
    await page.evaluate(() => { state.ui.anSec = 'ai'; switchTab('analysis'); });
    await page.click('#aiRunBtn');
    await page.waitForFunction(() => document.querySelector('#aiResult [data-ai-sec]'), null, { timeout: 5000 });
    const body = calls[0] ? JSON.parse(calls[0].body) : {};
    const prompt = ((((body.contents || [])[0] || {}).parts || [])[0] || {}).text || '';
    const lines = prompt.split('\n').filter(l => /^\d{4}-\d\d-\d\d\|/.test(l));
    check(calls.length === 1 && calls[0].key === 'AIzaTESTKEY' && /gemini-2\.5-flash:generateContent$/.test(calls[0].url), 'review call: ' + JSON.stringify(calls.map(c => c.url)));
    check(lines.length === 17 && v.n30 === 16, 'trades sent: ' + lines.length + ' of 16 + 1');
    check(!deltaCalls.some(c => c.startsWith('XAIUSD')), 'a second read of finished trades should use the saved candles: ' + JSON.stringify(deltaCalls));
    const xai = lines.find(l => l.includes('|XAIUSD|')) || '';
    check(prompt.includes('price data for 1 of 17 trades') && prompt.includes('early_exit (a winner closed') && /: 1, about 510 INR/.test(prompt) && xai.includes('|3|1|1.5|0.2|1.5R|67|20|3|0.1|3|0.5|early_exit|scared after a loss') && prompt.includes('no BTCUSD candles on Delta'), 'price check in prompt: ' + xai + ' / ' + (prompt.match(/PRICE CHECK[^\n]*\n[^\n]*/) || [''])[0]);
    check(prompt.includes('- fib: 2 alerts, result known 2, win 50%, avg 1R | taken 1: alert avg 3R, your avg 1R | skipped 1: alert avg -1R') && prompt.includes('- fib short: 1 alerts, result known 1, win 0%, avg -1R | taken 0 | skipped 1') && prompt.includes('TradingView'), 'VAS block: ' + (prompt.match(/VAS ALERTS[\s\S]{0,700}/) || [''])[0]);
    check(prompt.includes('- trailed: 1 trades, 1 wins, net 170 INR, winners kept 67% of best move, early_exit 1, gave_back 0, your avg 1R, the alert\'s own avg 3R on the same trades'), 'trailing block: ' + (prompt.match(/TRAILING SL[\s\S]{0,500}/) || [''])[0]);
    check(xai.includes('|first of day|trailed|fib 1h score 8 win|3|1|'), 'trade line alert columns: ' + xai);
    check(prompt.includes('Test Crypto (USD') && prompt.includes('BY SETUP') && prompt.includes('Breakout') && prompt.includes('Volume spike') && prompt.includes('FLAG MEANINGS') && !prompt.includes('AIzaTESTKEY'), 'prompt content: ' + prompt.slice(0, 400));
    check(body.generationConfig && body.generationConfig.responseMimeType === 'application/json' && body.generationConfig.responseSchema, 'asks for JSON');
    const shown = await page.innerText('#aiResult');
    check(shown.includes('You cut winners early.') && /TRAILING SL/i.test(shown) && shown.includes('XAIUSD went 3% on') && /price data for 1/.test(shown) && /2 VAS alerts/.test(shown), 'verdict and trailing shown: ' + shown.slice(0, 300));
    check(shown.includes('Breakout longs win') && shown.includes('6 of 8 won') && shown.includes('Skip pullback shorts') && shown.includes('Fib 1h shorts lose') && shown.includes('Enter at L3 only') && /WHAT YOU DO WRONG/i.test(shown) && /WHAT WORKS/i.test(shown) && /VAS ALERTS/i.test(shown) && /DO THIS NEXT/i.test(shown), 'review shown: ' + shown.slice(0, 400));
    check(await page.$$eval('#aiResult [data-ai-sec]', els => els.length) === 6, 'six sections');
    check(shown.includes('<b>x</b>') && !(await page.$('#aiResult b')), 'AI text must be escaped');
    check(!thinkingShown(shown), 'thought parts must be dropped');
    // Survives a reload.
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
    await page.evaluate(() => { state.ui.anSec = 'ai'; switchTab('analysis'); });
    check((await page.innerText('#aiResult')).includes('Breakout longs win'), 'last review should stay after reload');
    // Quota error, and the fallback model when the default is gone.
    mode = 'quota'; calls.length = 0;
    await page.click('#aiRunBtn'); await page.waitForTimeout(400);
    check(/free limit/.test(await page.innerText('#aiStatus')), 'quota message: ' + await page.innerText('#aiStatus'));
    mode = 'nomodel'; calls.length = 0;
    await page.click('#aiRunBtn');
    await page.waitForFunction(() => !aiBusy, null, { timeout: 5000 });
    check(calls.length === 2 && /gemini-flash-latest:generateContent$/.test(calls[1].url) && (await page.innerText('#aiResult')).includes('gemini-flash-latest'), 'fallback model: ' + JSON.stringify(calls.map(c => c.url)));
    // Overloaded (503): the same model is tried again, then the next one answers.
    await page.evaluate(() => { aiRetryMs = [10, 10]; });
    mode = 'busy'; calls.length = 0;
    await page.click('#aiRunBtn');
    await page.waitForFunction(() => !aiBusy, null, { timeout: 8000 });
    check(JSON.stringify(calls.map(c => c.url.replace(/^.*models\//, ''))) === JSON.stringify(['gemini-2.5-flash:generateContent', 'gemini-2.5-flash:generateContent', 'gemini-2.5-flash:generateContent', 'gemini-flash-latest:generateContent'])
      && (await page.innerText('#aiResult')).includes('gemini-flash-latest'), 'busy retry then fallback: ' + JSON.stringify(calls.map(c => c.url.replace(/^.*models\//, ''))));
    mode = 'allbusy'; calls.length = 0;
    await page.click('#aiRunBtn');
    await page.waitForFunction(() => !aiBusy, null, { timeout: 8000 });
    check(calls.length === 12 && /overloaded/.test(await page.innerText('#aiStatus')), 'all busy: ' + calls.length + ' ' + await page.innerText('#aiStatus'));
    // Busy everywhere and the lite models missing: still "overloaded", not "model not found".
    mode = 'busy404'; calls.length = 0;
    await page.click('#aiRunBtn');
    await page.waitForFunction(() => !aiBusy, null, { timeout: 8000 });
    check(calls.length === 8 && /overloaded/.test(await page.innerText('#aiStatus')), 'busy + missing lite: ' + calls.length + ' ' + await page.innerText('#aiStatus'));
    // "Failed to fetch" (lakky, 3 Nov, desktop Chrome): one dropped connection used to
    // end the review. Now a quick check that Gemini is reachable, the same model again, and it answers.
    const seq = () => JSON.stringify(calls.map(c => (c.post ? 'POST ' : 'GET ') + c.url.replace(/^.*models\//, '')));
    const runAi = async () => { calls.length = 0; await page.evaluate(() => { localStorage.removeItem('tapeAndTarget.aiReview'); renderAiResult(null); }); await page.click('#aiRunBtn'); await page.waitForFunction(() => !aiBusy, null, { timeout: 8000 }); };
    mode = 'drop1'; await runAi();
    check(seq() === JSON.stringify(['POST gemini-2.5-flash:generateContent', 'GET gemini-2.5-flash', 'POST gemini-2.5-flash:generateContent'])
      && (await page.innerText('#aiResult')).includes('Breakout longs win') && !(await page.innerText('#aiStatus')), 'one dropped connection should be retried: ' + seq() + ' ' + await page.innerText('#aiStatus'));
    // Every review call drops but Gemini answers the check: three tries in all, then "kept dropping".
    mode = 'dropall'; await runAi();
    let st = await page.innerText('#aiStatus');
    check(seq() === JSON.stringify(['POST gemini-2.5-flash:generateContent', 'GET gemini-2.5-flash', 'POST gemini-2.5-flash:generateContent', 'POST gemini-flash-latest:generateContent'])
      && /kept dropping \(Failed to fetch\)/.test(st) && !(await page.$('#aiResult [data-ai-sec]')), 'every call dropped: ' + seq() + ' ' + st);
    // Gemini can't be reached at all (blocked network): stop at once and say what to do.
    mode = 'down'; await runAi();
    st = await page.innerText('#aiStatus');
    check(seq() === JSON.stringify(['POST gemini-2.5-flash:generateContent', 'GET gemini-2.5-flash']) && /can't reach Gemini \(Failed to fetch\)/.test(st) && /VPN, ad-blocker/.test(st) && /Copy for Gemini app/.test(st), 'Gemini unreachable: ' + seq() + ' ' + st);
    // Offline: no calls wasted, and the message says so.
    // (Routed requests skip Playwright's offline switch, so the route drops them too.)
    await ctx.setOffline(true); mode = 'down'; await runAi(); await ctx.setOffline(false);
    st = await page.innerText('#aiStatus');
    check(seq() === JSON.stringify(['POST gemini-2.5-flash:generateContent']) && /You're offline/.test(st), 'offline: ' + seq() + ' ' + st);
    // A call that hangs past the limit moves to the next model instead of waiting forever.
    await page.evaluate(() => { aiTimeoutMs = 300; });
    mode = 'slow'; await runAi();
    await page.evaluate(() => { aiTimeoutMs = 150000; });
    check(seq() === JSON.stringify(['POST gemini-2.5-flash:generateContent', 'GET gemini-2.5-flash', 'POST gemini-flash-latest:generateContent'])
      && (await page.innerText('#aiResult')).includes('gemini-flash-latest'), 'hung call should time out to the next model: ' + seq() + ' ' + await page.innerText('#aiStatus'));
    // Remove.
    await page.evaluate(() => { switchTab('data'); removeAiKey(); });
    check(await page.evaluate(() => !aiCfg().key && !localStorage.getItem('tapeAndTarget.gemini')), 'key should be removed');
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'AI trade review (Gemini key, prompt, pros / cons / improve)');
  errs.forEach(e => { console.log('     ' + e); failures.push('ai review: ' + e); });
}

// The reorganized layout: what sits where on each tab, and the numbers that
// moved with it (Results by broker total, the rule count in the strip, the
// calculator's book, chart labels over more than a year).
async function layoutRun(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  const s2 = JSON.parse(JSON.stringify(seed));
  s2.accounts.push({ id: 'acc_unused', name: 'Unused', market: 'nse', currency: 'INR', startBalance: 0, updatedAt: new Date().toISOString() });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(s2));
  const page = await ctx.newPage();
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.dismiss());
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const v = await page.evaluate(() => {
      const out = {};
      const shown = el => !!el && !el.closest('.hidden') && el.offsetHeight > 0;
      // Dashboard: the goal and today side by side at the top, then the month and its numbers, then the sections.
      state.ui.account = 'all'; state.ui.allCur = 'USD'; save(); switchTab('dashboard');
      const kids = [...document.getElementById('view-dashboard').children];
      const at = el => kids.indexOf(el.closest('#view-dashboard > *'));
      out.order = [document.getElementById('riskTodayPnl'), document.getElementById('goalTitle'), document.getElementById('activeMonthTitle'), document.getElementById('kpiRibbon'), document.getElementById('dashSecBar')].map(at);
      out.today = [...kids[0].children].map(c => c.querySelector('#goalTitle') ? 'goal' : c.querySelector('#riskTodayPnl') ? 'today' : '?').join('|');
      out.dash = DASH_SECS.map(x => x.label).join('|');
      // Analysis, all books: one row of sections, empty book left out, a total line.
      state.ui.anSec = 'overview'; state.ui.anPeriod = 'all'; switchTab('analysis'); renderAll();
      out.anSecs = [...document.querySelectorAll('#anSecBar button')].map(b => b.innerText).join('|');
      out.bar = [...document.querySelectorAll('#anBrokerBar [data-anbroker]')].map(b => b.innerText).join('|');
      out.lines = [...document.querySelectorAll('#anBrokers tbody tr')].map(r => r.cells[0].innerText.split(/\s/)[0] + ' ' + r.cells[2].innerText);
      out.total = [...document.querySelectorAll('#anBrokers tfoot td')].map(td => td.innerText.trim());
      const st = computeStats(allTrades().map(t => toView(t, 'USD')));
      out.want = { net: signedMoney(st.net, 'USD'), n: String(st.n) };
      out.aiShown = shown(document.getElementById('aiReviewCard'));
      out.brokersShown = shown(document.getElementById('anBrokers'));
      // The strip's "broke a rule" is the scorecard's count.
      out.strip = [...document.querySelectorAll('#anStrip > div')].find(d => /Trades checked/i.test(d.textContent)).textContent.replace(/\s+/g, ' ');
      out.score = (document.getElementById('anRules').textContent.match(/Broke at least one\S*\s*[^·]*·\s*(\d+) trades/) || [])[1];
      setAnSec('ai'); out.aiOnly = shown(document.getElementById('aiReviewCard')) && !shown(document.getElementById('anBrokers'));
      setAnSec('trades'); out.allTrades = { here: shown(document.getElementById('anAllTrades')), closed: !document.getElementById('anAllTrades').open };
      // A trade a year back: the size chart keeps the year in its labels.
      const old = Object.assign({}, state.trades[0], { id: 'old1', date: '2025-01-15', exitDate: '2025-01-15' });
      state.trades.push(old); save(); setAnSec('size'); renderAll();
      out.labels = typeof Chart === 'undefined' ? null : anChartInstance.data.labels.slice(0, 2);
      state.trades = state.trades.filter(t => t.id !== 'old1'); save();
      // Settings in three groups, Books & rules first; a link can open another.
      switchTab('data');
      out.set = [...document.querySelectorAll('#setSecBar button')].map(b => b.innerText).join('|');
      out.setBooks = shown(document.getElementById('booksList')) && !shown(document.getElementById('syncRepoInput'));
      openSettings('connect');
      out.setConnect = shown(document.getElementById('syncRepoInput')) && shown(document.getElementById('btFiles')) && !shown(document.getElementById('booksList'));
      openSettings('backup');
      out.setBackup = shown(document.getElementById('storageUsage')) && !shown(document.getElementById('syncRepoInput'));
      out.nav = document.getElementById('navTab-data').innerText;
      // Calculator: no book picked yet, so it sizes from the header's book, then the one traded last.
      delete state.calculatorSettings; state.ui.account = 'acc_cry'; save(); switchTab('calculator');
      out.calcCry = { id: calcSettings().accountId, cap: calcSettings().capital, bal: +(bookBalance(acct('acc_cry')) * fxk(acct('acc_cry'), viewCur())).toFixed(2) };
      delete state.calculatorSettings; state.ui.account = 'all'; save(); switchTab('calculator');
      const last = allTrades().slice().sort((a, b) => -byWhen(a, b))[0];
      out.calcAll = { id: calcSettings().accountId, want: last.accountId };
      calcPickAccount(''); switchTab('calculator'); renderCalculator();
      out.calcCustom = { id: calcSettings().accountId, picked: calcSettings().accountPicked };
      // A report trade's prices come from the broker's fills, when there are any.
      out.px = [tradePx({ rep: true, px: { entry: 0.2176, exit: 0.2144 } }, 'entry'), tradePx({ rep: true, px: { entry: 0.2176, exit: 0.2144 } }, 'exit'), tradePx({ rep: true }, 'entry'), tradePx({ entry: 5 }, 'entry')];
      return out;
    });
    check(JSON.stringify(v.order) === '[0,0,1,2,3]' && v.today === 'goal|today', 'dashboard order (goal + today, month, numbers, sections): ' + JSON.stringify([v.order, v.today]));
    check(v.dash === "Equity & calendar|Day's trades|Week & grade|Time & habits", 'dashboard sections: ' + v.dash);
    check(/^Report\|Overview\|Demo vs you\|Review(\s*\d+)?\|Position size\|Trades\|Market days\|AI review$/.test(v.anSecs), 'analysis sections: ' + v.anSecs);
    check(v.bar === 'All books|Test NSE|Test Crypto' && v.lines.join(',') === 'Test 8,Test 8', 'empty book left out of Analysis: ' + JSON.stringify([v.bar, v.lines]));
    check(v.total[0] === 'Total' && v.total[1] === v.want.net && v.total[2] === v.want.n, 'results by broker total: ' + JSON.stringify([v.total, v.want]));
    check(v.brokersShown && !v.aiShown && v.aiOnly, 'AI review has its own section: ' + JSON.stringify([v.brokersShown, v.aiShown, v.aiOnly]));
    check(v.score && v.strip.includes(v.score + ' (') && v.strip.includes('broke a rule'), 'strip and scorecard agree: ' + JSON.stringify([v.strip, v.score]));
    check(v.allTrades.here && v.allTrades.closed, 'All trades folded under Trades: ' + JSON.stringify(v.allTrades));
    check(v.labels === null || (/^25-01-15/.test(v.labels[0]) && /^\d\d-\d\d-\d\d/.test(v.labels[1])), 'size chart labels over two years: ' + JSON.stringify(v.labels));
    check(v.set === 'Books & rules|Connections|Backup' && v.setBooks && v.setConnect && v.setBackup && v.nav === 'Settings', 'settings groups: ' + JSON.stringify([v.set, v.setBooks, v.setConnect, v.setBackup, v.nav]));
    check(v.calcCry.id === 'acc_cry' && Math.abs(v.calcCry.cap - v.calcCry.bal) < 0.005, 'calculator sizes from the header book: ' + JSON.stringify(v.calcCry));
    check(v.calcAll.id === v.calcAll.want, 'calculator on All accounts uses the book traded last: ' + JSON.stringify(v.calcAll));
    check(v.calcCustom.id === '' && v.calcCustom.picked === true, 'Custom picked by hand stays: ' + JSON.stringify(v.calcCustom));
    check(JSON.stringify(v.px) === '["0.2176","0.2144","—",5]', 'report trade prices from fills: ' + JSON.stringify(v.px));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'layout: sections per tab, broker total, strip vs scorecard, calculator book, chart years');
  errs.forEach(e => { console.log('     ' + e); failures.push('layout: ' + e); });
}
// The clean redesign (v.132): today's loss-limit bar, channel dropdown, mistake picker, tabs.
async function cleanRun(seed) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.dismiss());
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof state !== 'undefined' && state);
    const v = await page.evaluate(() => {
      const out = {};
      const now = new Date().toISOString(), d = todayDay();
      // Test Crypto (USD) has a $2.50 daily loss limit; a $1.00 loss today uses 40% of it.
      state.trades = state.trades.filter(t => !(t.accountId === 'acc_cry' && dayOf(t) === d));
      state.trades.push({ id: 'cl1', accountId: 'acc_cry', date: d, exitDate: d, time: '10:00', exitTime: '10:30', symbol: 'ETHUSD', direction: 'long', entry: 100, exit: 99.5, stop: 99, qty: 2, fees: 0, leverage: 10, pnl: -1, risk: 2, r: -0.5, updatedAt: now });
      state.ui.account = 'acc_cry'; save(); switchTab('dashboard'); renderAll();
      out.bar = document.getElementById('riskLossBar').style.width;
      out.barCls = document.getElementById('riskLossBar').className;
      out.barTxt = document.getElementById('riskLossUsedText').innerText;
      out.pnl = document.getElementById('riskTodayPnl').innerText;
      // A $2.00 loss is 80%: the bar turns amber.
      Object.assign(state.trades.find(t => t.id === 'cl1'), { exit: 99, pnl: -2, r: -1 }); renderAll();
      out.bar2 = [document.getElementById('riskLossBar').style.width, document.getElementById('riskLossBar').className];
      // Section bars are plain tabs; the open one is marked, a count sits in its own span.
      out.tabs = [...document.querySelectorAll('#dashSecBar .tab')].map(b => (b.classList.contains('on') ? '*' : '') + b.firstChild.textContent + (b.querySelector('.cnt') ? '(' + b.querySelector('.cnt').innerText + ')' : '')).join('|');
      // Signals: channels are one dropdown, empty channels left out, and picking one filters.
      const g = (id, ch) => ({ id, key: 'z|' + id, kind: 'zone', date: d, time: '09:00', symbol: 'X' + id, side: 'long', market: 'CRYPTO', timeframe: ch.split(' ')[1], channel: ch, entry: 100, stop: 99, price: 100, updatedAt: now });
      state.signals = [g('a', 'CRYPTO 1D'), g('b', 'CRYPTO 1D'), g('c', 'CRYPTO 4H')];
      state.ui.sigKind = 'zone'; state.ui.sigChan = ''; state.ui.sigPeriod = 'all'; save(); switchTab('signals'); renderAll();
      const sel = document.getElementById('sigChanSel');
      out.opts = sel ? [...sel.options].map(o => o.innerText).join('|') : null;
      out.chipsLeft = document.querySelectorAll('#sigChanBar button').length;
      sel.value = 'CRYPTO 4H'; sel.dispatchEvent(new Event('change'));
      out.chan = state.ui.sigChan;
      out.picked = document.getElementById('sigChanSel').value;
      out.kind = [...document.querySelectorAll('#sigKindBar button')].map(b => (b.classList.contains('on') ? '*' : '') + b.innerText).join('|');
      // Review queue: a mistake is picked from one dropdown, which tags the trade.
      state.ui.account = 'all'; state.ui.anSec = 'review'; save(); switchTab('analysis'); renderAll();
      out.anTabs = [...document.querySelectorAll('#anSecBar .tab')].map(b => b.firstChild.textContent + (b.querySelector('.cnt') ? '(' + b.querySelector('.cnt').innerText + ')' : '')).join('|');
      const row = [...document.querySelectorAll('#reviewQueuePanel select')].find(x => x.closest('div.py-2').innerText.includes('ETHUSD'));
      out.mistakeOpts = row ? [...row.options].map(o => o.value).filter(Boolean) : null;
      out.btns = row ? row.closest('div.py-2').querySelectorAll('button').length : null;
      if (row) { row.value = 'FOMO Entry'; row.dispatchEvent(new Event('change')); }
      out.tags = state.trades.find(t => t.id === 'cl1').tagsMistakes;
      let a;
      // Time & habits: one short row per half-hour slot, in time order, with a bar; tags the same way.
      state.ui.account = 'acc_cry'; state.ui.dashSec = 'habits'; save(); switchTab('dashboard'); renderAll();
      const slots = [...document.querySelectorAll('#timeOfDayContainer > .hrow')];
      out.slotTimes = slots.map(r => r.innerText.slice(0, 13));
      out.slotBars = slots.every(r => r.querySelector('.hbar > i'));
      out.habitsTall = document.querySelector('[data-dashsec="habits"]').offsetHeight;
      out.reviewOnDash = !!document.querySelector('#view-dashboard #reviewQueuePanel');
      a = slots.find(r => r.innerText.startsWith('10:00 - 10:30'));
      if (a) a.click();
      out.afterClick = state.ui.dashSec;

      out.fonts = [...new Set([...document.querySelectorAll('#view-dashboard *')].map(el => getComputedStyle(el).fontFamily.split(',')[0].replace(/"/g, '').trim()))];
      return out;
    });
    check(v.bar === '40%' && /bg-emerald-500/.test(v.barCls) && v.barTxt === '40% of $2.50' && v.pnl === '-$1.00', 'loss bar at 40%: ' + JSON.stringify([v.bar, v.barCls, v.barTxt, v.pnl]));
    check(v.bar2[0] === '80%' && /bg-amber-500/.test(v.bar2[1]), 'loss bar at 80% turns amber: ' + JSON.stringify(v.bar2));
    check(/^\*Equity & calendar\|Day's trades\|Week & grade\|Time & habits$/.test(v.tabs) && /^Report\|Overview\|Demo vs you\|Review\(\d+\)\|Position size/.test(v.anTabs), 'dashboard and analysis tabs: ' + v.tabs + ' / ' + v.anTabs);
    check(v.opts === 'All channels (3)|CRYPTO 4h (1)|CRYPTO 1D (2)' && v.chipsLeft === 0, 'channel dropdown: ' + JSON.stringify([v.opts, v.chipsLeft]));
    check(v.chan === 'CRYPTO 4H' && v.picked === 'CRYPTO 4H', 'channel picked from the dropdown: ' + JSON.stringify([v.chan, v.picked]));
    check(/^\*Zone alerts 3\|Fib alerts 0\|Trendline alerts 0$/.test(v.kind), 'scanner switch: ' + v.kind);
    check(Array.isArray(v.mistakeOpts) && v.mistakeOpts.includes('FOMO Entry') && v.btns === 3, 'mistake dropdown in the review row: ' + JSON.stringify([v.mistakeOpts, v.btns]));
    check(Array.isArray(v.tags) && v.tags.includes('FOMO Entry'), 'mistake picked tags the trade: ' + JSON.stringify(v.tags));
    check(v.slotTimes.length > 0 && v.slotTimes.every((t, i, l) => !i || l[i - 1] <= t) && v.slotBars && v.habitsTall < 900 && !v.reviewOnDash, 'time & habits compact rows: ' + JSON.stringify([v.slotTimes, v.slotBars, v.habitsTall, v.reviewOnDash]));
    check(v.afterClick === 'ledger', 'clicking a slot opens its trades: ' + v.afterClick);
    check(!v.fonts.some(f => /mono/i.test(f)), 'no monospace font left on the dashboard: ' + JSON.stringify(v.fonts));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'clean redesign: loss bar, tabs, channel dropdown, mistake picker, one font');
  errs.forEach(e => { console.log('     ' + e); failures.push('clean: ' + e); });
}
// What's new: tapping the version pill opens the update log. The newest entry
// is this build's version and marked Current; versions only go down the list.
async function whatsNewRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  for (const vp of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const w = vp.width;
    try {
      const pill = page.locator('#appVerPill');
      check(await pill.isVisible(), w + 'px: version pill visible');
      await pill.click();
      const v = await page.evaluate(() => {
        const ver = document.querySelector('meta[name="app-version"]').content;
        const items = [...document.querySelectorAll('#wnBack .wn-item')];
        const box = document.getElementById('wnBox');
        const r = box ? box.getBoundingClientRect() : null;
        return {
          ver, pill: document.getElementById('appVerPill').textContent.trim(),
          first: items[0] ? items[0].querySelector('.wn-title b').innerText : null,
          firstCur: items[0] ? !!items[0].querySelector('.wn-cur') : false,
          curCount: document.querySelectorAll('#wnBack .wn-cur').length,
          sub: (document.querySelector('#wnBack .wn-sub') || {}).innerText,
          vers: CHANGELOG.map(e => e.v),
          empty: CHANGELOG.filter(e => !e.title || !e.pts || !e.pts.length).map(e => e.v),
          shown: items.length, n: CHANGELOG.length,
          fits: r ? r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight : false,
          date: items[0] ? items[0].querySelector('.wn-date').innerText : null,
        };
      });
      const num = x => { const [d, n] = x.split('.'); return [d, +n]; };
      const down = v.vers.every((x, i, l) => { if (!i) return true; const [a, an] = num(l[i - 1]), [b, bn] = num(x); return a > b || (a === b && an > bn); });
      check(v.vers[0] === v.ver, w + 'px: newest entry is this build (' + v.vers[0] + ' vs ' + v.ver + ')');
      check(v.first === v.pill && v.firstCur && v.curCount === 1, w + 'px: current marked once on the pill version: ' + JSON.stringify([v.first, v.pill, v.firstCur, v.curCount]));
      check(down && new Set(v.vers).size === v.vers.length, w + 'px: versions go down the list: ' + v.vers.join(','));
      check(v.empty.length === 0 && v.shown === v.n && v.n >= 30, w + 'px: every entry has a title and bullets: ' + JSON.stringify([v.empty, v.shown, v.n]));
      check(v.sub === 'This copy: ' + v.ver && v.fits && /^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(v.date), w + 'px: header, date and fit: ' + JSON.stringify([v.sub, v.fits, v.date]));
      await page.locator('#wnBack .wn-head button').click();
      check(await page.locator('#wnBack').count() === 0, w + 'px: Close shuts it');
      await pill.click();
      await page.keyboard.press('Escape');
      check(await page.locator('#wnBack').count() === 0, w + 'px: Escape shuts it');
      await pill.click();
      await page.mouse.click(5, vp.height - 5);
      check(await page.locator('#wnBack').count() === 0, w + 'px: tapping outside shuts it');
    } catch (e) {
      errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
    }
    await ctx.close();
  }
  const label = "what's new: version pill opens the update log";
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}
// GitHub sync card: no Branch field (always main), repo and token masked with
// neutral hints, and a connection saved by an older build keeps syncing.
async function syncSettingsRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const REPO = 'someone/private-sync', TOKEN = 'secret-token-123';
  const gh = { gets: [], puts: [], files: {} };
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.github.com/'), r => r.abort());
  await ctx.route('https://api.github.com/**', async route => {
    const req = route.request(), u = new URL(req.url()), h = await req.allHeaders();
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/journal\.json$/);
    const reply = (status, data) => route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (!m || h.authorization !== 'Bearer ' + TOKEN) return reply(404, { message: 'Not Found' });
    if (req.method() === 'GET') {
      gh.gets.push(m[1] + '@' + u.searchParams.get('ref'));
      const f = gh.files[m[1] + '@' + u.searchParams.get('ref')];
      return f ? reply(200, { sha: f.sha, size: f.text.length, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }) : reply(404, { message: 'Not Found' });
    }
    if (req.method() === 'PUT') {
      const p = JSON.parse(req.postData() || '{}'), key = m[1] + '@' + p.branch, cur = gh.files[key];
      if (cur ? p.sha !== cur.sha : !!p.sha) return reply(409, { message: 'conflict' });
      const text = Buffer.from(String(p.content || ''), 'base64').toString('utf8'), sha = crypto.createHash('sha1').update(text).digest('hex');
      gh.files[key] = { text, sha };
      gh.puts.push(key);
      return reply(cur ? 200 : 201, { content: { sha } });
    }
    return reply(405, { message: 'no' });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
  page.on('dialog', d => d.accept());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  const card = () => page.evaluate(() => {
    openSettings('connect'); renderDataView();
    const repo = document.getElementById('syncRepoInput'), tok = document.getElementById('syncTokenInput');
    const box = repo.closest('.bg-terminal-card');
    return { branch: !!document.getElementById('syncBranchInput'), text: box.innerText, html: box.innerHTML,
      repo: [repo.type, repo.value, repo.placeholder], tok: [tok.type, tok.value, tok.placeholder] };
  });
  const settle = async () => { for (let i = 0; i < 50 && await page.evaluate(() => syncBusy); i++) await page.waitForTimeout(100); };
  try {
    // A new device: empty, masked fields with plain hints; nothing names GitHub's repo or token format.
    let c = await card();
    check(!c.branch && !/\bBranch\b/.test(c.text), 'Branch field gone: ' + JSON.stringify(c.text));
    check(c.repo[0] === 'password' && c.tok[0] === 'password', 'repo and token masked: ' + JSON.stringify([c.repo, c.tok]));
    check(!/victus2034|trading-journal|github_pat/i.test(c.html), 'card shows no repo name or token hint');
    check(c.repo[2] === 'owner/repo' && c.tok[2] === 'Paste token', 'neutral hints: ' + JSON.stringify([c.repo[2], c.tok[2]]));
    // Typed in and saved: branch is main, the sync goes to main.
    await page.fill('#syncRepoInput', REPO);
    await page.fill('#syncTokenInput', TOKEN);
    await page.click('button:has-text("Save & Connect")');
    await page.waitForTimeout(300); await settle();
    let st = await page.evaluate(() => Object.assign({}, state.sync));
    check(st.repo === REPO && st.token === TOKEN && st.branch === 'main', 'saved: ' + JSON.stringify([st.repo, st.branch]));
    check(gh.puts.length === 1 && gh.puts[0] === REPO + '@main' && gh.gets.every(g => g === REPO + '@main'), 'first sync to main: ' + JSON.stringify(gh));
    // Saved values come back into the masked fields (still there, still hidden).
    c = await card();
    check(c.repo[1] === REPO && c.tok[1] === TOKEN && c.repo[0] === 'password' && !c.text.includes(REPO) && !c.text.includes(TOKEN), 'saved values kept, hidden: ' + JSON.stringify([c.repo, c.tok[0]]));
    // A connection an older build saved with no branch at all keeps syncing to main.
    await page.evaluate(([r, t]) => { const s = state.sync; state.sync = { token: t, repo: r, auto: false, lastAt: s.lastAt, lastSha: s.lastSha }; save(); }, [REPO, TOKEN]);
    await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300); await settle();
    const getsBefore = gh.gets.length;
    await page.evaluate(() => { state.trades.push(Object.assign({}, state.trades[0], { id: 'tr-after-reload', notes: 'logged after reload', updatedAt: new Date().toISOString() })); save(); });
    let r = await page.evaluate(() => syncNow({ quiet: true }));
    const sent = JSON.parse(gh.files[REPO + '@main'].text).trades.some(t => t.id === 'tr-after-reload');
    check(r.ok && r.changed !== false && sent && gh.puts[gh.puts.length - 1] === REPO + '@main' && gh.gets.slice(getsBefore).every(g => g === REPO + '@main'), 'old config (no branch) syncs to main: ' + JSON.stringify([r, sent, gh.puts]));
    // Save & Connect on it fills in main; one saved on another branch keeps it, since there is no field to change it.
    await page.evaluate(() => { openSettings('connect'); renderDataView(); saveSyncSettings(); });
    await page.waitForTimeout(300); await settle();
    st = await page.evaluate(() => state.sync.branch);
    check(st === 'main', 'save fills in main: ' + st);
    await page.evaluate(() => { state.sync.branch = 'dev'; state.sync.lastSha = ''; save(); openSettings('connect'); renderDataView(); saveSyncSettings(); });
    await page.waitForTimeout(300); await settle();
    st = await page.evaluate(() => state.sync.branch);
    check(st === 'dev' && gh.gets[gh.gets.length - 1] === REPO + '@dev', 'older non-main branch kept: ' + JSON.stringify([st, gh.gets.slice(-2)]));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'GitHub sync card: no branch field, repo and token hidden, old setups keep syncing';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}
// Keys on your other devices: the Gemini key locked into journal.json with a
// passphrase, unlocked once on a new device, then kept in step; setup codes and links.
// The Delta key never goes in (its import runs on the PC), and a lock an older
// build made with the Delta key inside is resealed without it.
// Several browsers (devices) share one fake GitHub. The lock is also opened by hand
// here in Node (PBKDF2 + AES-GCM), so it is the standard cipher, not something only
// the page itself can read.
async function keysLockRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const REPO = 'someone/private-sync', TOKEN = 'github_pat_sync-token-456', PASS = 'blue tiger seven', PASS2 = 'green lamp river';
  const DKEY = 'delta-key-AAA111', DSEC = 'delta-secret-BBB222', GKEY = 'AIza-gemini-CCC333';
  const gh = { files: {}, puts: 0 };
  const ghFile = () => { const f = gh.files[REPO + '@main']; return f ? JSON.parse(f.text) : null; };
  const ghText = () => (gh.files[REPO + '@main'] || {}).text || '';
  const devices = [];
  async function device(name, opts = {}) {
    const ctx = await browser.newContext({ viewport: opts.phone ? { width: 390, height: 844 } : { width: 1366, height: 900 } });
    await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.github.com/'), r => r.abort());
    await ctx.route('https://api.github.com/**', async route => {
      const req = route.request(), u = new URL(req.url()), h = await req.allHeaders();
      const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/journal\.json$/);
      const reply = (status, data) => route.fulfill({ status, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!m || h.authorization !== 'Bearer ' + TOKEN) return reply(404, { message: 'Not Found' });
      const key = m[1] + '@' + (req.method() === 'GET' ? u.searchParams.get('ref') : JSON.parse(req.postData() || '{}').branch);
      if (req.method() === 'GET') {
        const f = gh.files[key];
        return f ? reply(200, { sha: f.sha, size: f.text.length, encoding: 'base64', content: Buffer.from(f.text).toString('base64') }) : reply(404, { message: 'Not Found' });
      }
      if (req.method() === 'PUT') {
        const p = JSON.parse(req.postData() || '{}'), cur = gh.files[key];
        if (cur ? p.sha !== cur.sha : !!p.sha) return reply(409, { message: 'conflict' });
        const text = Buffer.from(String(p.content || ''), 'base64').toString('utf8'), sha = crypto.createHash('sha1').update(text).digest('hex');
        gh.files[key] = { text, sha }; gh.puts++;
        return reply(cur ? 200 : 201, { content: { sha } });
      }
      return reply(405, { message: 'no' });
    });
    if (opts.seed) await ctx.addInitScript(([s, g]) => {
      if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); if (g) localStorage.setItem('tapeAndTarget.gemini', g); sessionStorage.setItem('seeded', '1'); }
    }, [JSON.stringify(opts.seed), opts.gemini ? JSON.stringify({ key: opts.gemini, model: '' }) : '']);
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(name + ' page error: ' + (e.stack || e.message)));
    page.on('dialog', d => d.accept());
    await page.goto(base + (opts.hash || ''), { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const dev = { ctx, page, name };
    devices.push(dev);
    return dev;
  }
  const until = async (page, fn, arg, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await page.evaluate(fn, arg)) return true; await page.waitForTimeout(100); } return false; };
  const settle = page => until(page, () => !syncBusy && !keysBusy);
  const card = page => page.evaluate(() => { openSettings('connect'); renderDataView(); const b = document.getElementById('keysBox'); return { text: b.innerText, badge: (document.getElementById('keysBadge') || {}).innerText || '' }; });
  const modal = page => page.evaluate(() => ({ open: !document.getElementById('modalSheet').classList.contains('hidden'), title: document.getElementById('modalSheetTitle').innerText, body: document.getElementById('modalSheetBody').innerText }));
  const keysOf = page => page.evaluate(() => ({ dk: (state.delta || {}).key || '', ds: (state.delta || {}).secret || '', gk: aiCfg().key }));
  const connect = async page => {
    await page.evaluate(() => { openSettings('connect'); renderDataView(); });
    await page.fill('#syncRepoInput', REPO); await page.fill('#syncTokenInput', TOKEN);
    await page.click('button:has-text("Save & Connect")');
    await page.waitForTimeout(300); await settle(page);
  };
  try {
    // ---- Device A (the PC): has the keys, turns it on ----
    const A = await device('A', { seed: Object.assign({}, seed, { delta: { key: DKEY, secret: DSEC, lastAt: '', lastFillTime: 0 } }), gemini: GKEY });
    await connect(A.page);
    let c = await card(A.page);
    check(c.badge === 'Off' && /Save keys to GitHub/.test(c.text) && /Delta and CoinDCX need nothing here/.test(c.text), 'A starts Off: ' + JSON.stringify(c));
    check(!/keysLock/.test(ghText()) && !ghText().includes(DKEY), 'nothing about keys on GitHub before it is on');
    await A.page.click('#keysBox button:has-text("Save keys to GitHub")');
    let mo = await modal(A.page);
    check(mo.open && /This device's Gemini key is locked/.test(mo.body) && !/Delta/.test(mo.body), 'create dialog names the key: ' + JSON.stringify(mo));
    await A.page.fill('#mKeysNew', 'short'); await A.page.fill('#mKeysNew2', 'short'); await A.page.click('#modalSheetSaveBtn');
    let err = await A.page.evaluate(() => document.getElementById('mKeysErr').innerText);
    check(/at least 8/.test(err) && !(await A.page.evaluate(() => state.keysLock)), 'short passphrase refused: ' + err);
    await A.page.fill('#mKeysNew', PASS); await A.page.fill('#mKeysNew2', PASS + 'x'); await A.page.click('#modalSheetSaveBtn');
    err = await A.page.evaluate(() => document.getElementById('mKeysErr').innerText);
    check(/don't match/.test(err), 'mismatch refused: ' + err);
    await A.page.fill('#mKeysNew2', PASS); await A.page.click('#modalSheetSaveBtn');
    check(await until(A.page, () => !!state.keysLock && document.getElementById('modalSheet').classList.contains('hidden')), 'lock made, dialog closed');
    await A.page.waitForTimeout(200); await settle(A.page);
    let f = ghFile();
    const text = ghText();
    check(f && f.keysLock && f.keysLock.s && f.keysLock.c && f.keysLock.n === 600000 && JSON.stringify(f.keysLock.has) === '["ai"]', 'keysLock on GitHub: ' + JSON.stringify(f && f.keysLock));
    check(![DKEY, DSEC, GKEY, PASS, TOKEN].some(x => text.includes(x)), 'no key, secret, passphrase or token in journal.json in plain text');
    // Opened by hand: PBKDF2-SHA256 600k over the passphrase, AES-256-GCM with its AAD.
    const open = (lock, pass) => {
      const u = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
      const k = crypto.pbkdf2Sync(pass, u(lock.s), lock.n, 32, 'sha256'), ct = u(lock.c);
      const d = crypto.createDecipheriv('aes-256-gcm', k, u(lock.i)); d.setAAD(Buffer.from('victus-keys-1')); d.setAuthTag(ct.subarray(ct.length - 16));
      return JSON.parse(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]).toString('utf8'));
    };
    let plain = null; try { plain = open(f.keysLock, PASS); } catch (e) { errs.push('Node could not open the lock: ' + e.message); }
    check(plain && !plain.delta && plain.ai.key === GKEY && Object.keys(plain).join() === 'ai', 'lock holds the Gemini key only: ' + JSON.stringify(plain));
    let wrongOpens = true; try { open(f.keysLock, PASS2); } catch (e) { wrongOpens = false; }
    check(!wrongOpens, 'a wrong passphrase does not open it in Node either');
    const bk = await A.page.evaluate(() => [!!syncPayload(state).keysLock, 'keysLock' in backupPayload(state), JSON.stringify(state.sync).includes('"vault"')]);
    check(bk[0] && !bk[1] && bk[2], 'synced, left out of backup files, vault kept on the device: ' + JSON.stringify(bk));
    c = await card(A.page);
    check(c.badge === 'On' && /Gemini key follows you/.test(c.text), 'A shows On: ' + JSON.stringify(c));

    // ---- Device B (the iPhone home-screen app): empty, connects with repo + token ----
    const B = await device('B', { phone: true });
    c = await card(B.page);
    check(c.badge === 'New device?' && /Use setup code/.test(c.text), 'B starts as a new device: ' + JSON.stringify(c));
    await connect(B.page);
    mo = await modal(B.page);
    check(mo.open && mo.title === 'Unlock your keys' && /\(Gemini key\)/.test(mo.body), 'B is asked for the passphrase after connecting: ' + JSON.stringify(mo));
    check((await B.page.evaluate(() => state.trades.length)) === seed.trades.length, 'B pulled the journal');
    await B.page.fill('#mKeysPass', PASS2); await B.page.click('#modalSheetSaveBtn');
    await until(B.page, () => /Wrong/.test(document.getElementById('mKeysErr').innerText));
    let k = await keysOf(B.page);
    check(!k.dk && !k.gk && (await modal(B.page)).open, 'wrong passphrase fills nothing: ' + JSON.stringify(k));
    await B.page.fill('#mKeysPass', PASS); await B.page.click('#modalSheetSaveBtn');
    await until(B.page, () => document.getElementById('modalSheet').classList.contains('hidden'));
    await settle(B.page);
    k = await keysOf(B.page);
    check(!k.dk && !k.ds && k.gk === GKEY, 'B got the Gemini key and no Delta key: ' + JSON.stringify(k));
    const gc = await B.page.evaluate(() => ({ boxes: !!document.getElementById('deltaKeyInput'), form: !document.getElementById('aiKeyForm').classList.contains('hidden'),
      saved: document.getElementById('aiKeySaved').innerText, box: document.getElementById('aiKeyInput').value }));
    check(!gc.boxes && !gc.form && /Key saved/.test(gc.saved) && /Change key/.test(gc.saved) && gc.box === '', 'no Delta key boxes, Gemini key out of sight: ' + JSON.stringify(gc));
    c = await card(B.page);
    check(c.badge === 'On', 'B shows On: ' + c.badge);
    // Reload: B keeps the keys and needs no passphrase again.
    await B.page.reload({ waitUntil: 'load' }); await B.page.waitForTimeout(300);
    await B.page.evaluate(() => syncNow()); await settle(B.page);
    check(!(await modal(B.page)).open && (await keysOf(B.page)).gk === GKEY, 'after a reload: no passphrase asked, key kept');

    // ---- A changes its Gemini key (Change key opens the boxes): B picks it up, no passphrase ----
    const lockAt = f.keysLock.at;
    await A.page.evaluate(() => { openSettings('connect'); renderDataView(); });
    check(!(await A.page.isVisible('#aiKeyInput')), 'A\'s saved Gemini key box is on show');
    await A.page.click('#aiKeySaved button:has-text("Change key")');
    await A.page.fill('#aiKeyInput', 'AIza-NEW1'); await A.page.click('button:has-text("Save & Test")');
    check(await until(A.page, at => state.keysLock.at !== at && !syncBusy, lockAt), 'A wrote a new lock');
    await settle(A.page);
    check(ghFile().keysLock.at !== lockAt && !(await A.page.isVisible('#aiKeyInput')), 'new lock pushed to GitHub, box hidden again');
    await B.page.evaluate(() => syncNow({ quiet: true })); await settle(B.page);
    k = await keysOf(B.page);
    check(k.gk === 'AIza-NEW1' && !k.dk, 'B followed the new Gemini key: ' + JSON.stringify(k));
    // A key removed on B stays removed there while the lock doesn't change, and isn't removed from GitHub.
    await B.page.evaluate(() => removeAiKey());
    await B.page.evaluate(() => syncNow({ quiet: true })); await settle(B.page);
    await A.page.evaluate(() => syncNow({ quiet: true })); await settle(A.page);
    k = await keysOf(B.page);
    check(!k.gk, 'B: removed Gemini key came back: ' + JSON.stringify(k));
    plain = open(ghFile().keysLock, PASS);
    check(plain.ai && plain.ai.key === 'AIza-NEW1' && (await keysOf(A.page)).gk === 'AIza-NEW1', 'removing on B did not remove it from GitHub or A');
    // B saves its own Gemini key: A gets it.
    await B.page.evaluate(() => { openSettings('connect'); renderDataView(); });
    await B.page.fill('#aiKeyInput', 'AIza-from-phone'); await B.page.click('button:has-text("Save & Test")');
    await until(B.page, () => !!state.keysLock && !syncBusy && !keysBusy); await B.page.waitForTimeout(500); await settle(B.page);
    await A.page.evaluate(() => syncNow({ quiet: true })); await settle(A.page);
    k = await keysOf(A.page);
    check(k.gk === 'AIza-from-phone' && k.dk === DKEY, 'A followed B\'s Gemini key; its old Delta key stayed on A only: ' + JSON.stringify(k));
    check(![DKEY, DSEC].some(x => ghText().includes(x)) && !open(ghFile().keysLock, PASS).delta, 'the Delta key reached GitHub');

    // ---- Setup link: device C opens it, types the passphrase once ----
    await A.page.evaluate(() => { openSettings('connect'); renderDataView(); });
    await A.page.click('#keysBox button:has-text("Set up another device")');
    await until(A.page, () => !!document.getElementById('mShareCode'));
    const share = await A.page.evaluate(() => ({ code: document.getElementById('mShareCode').value, link: document.getElementById('mShareLink').value,
      qr: !!document.getElementById('setupQr'), body: document.getElementById('modalSheetBody').innerText,
      dark: (document.querySelector('#setupQr path').getAttribute('d').match(/M/g) || []).length }));
    check(/^VJ1\./.test(share.code) && share.link === base + '#vjsetup=' + share.code && share.qr && /home-screen app/.test(share.body), 'setup code, link and QR shown: ' + JSON.stringify(share).slice(0, 200));
    check(![TOKEN, REPO, PASS].some(x => share.code.includes(x)), 'setup code holds no plain token or repo');
    // The QR decodes back to the link (jsQR, a separate decoder).
    const qr = await A.page.evaluate(l => qrMatrix(l), share.link);
    const n = qr.length + 8, S = 4, W = n * S, px = new Uint8ClampedArray(W * W * 4);
    for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const my = Math.floor(y / S) - 4, mx = Math.floor(x / S) - 4, on = my >= 0 && mx >= 0 && my < qr.length && mx < qr.length && qr[my][mx], i = (y * W + x) * 4; px[i] = px[i + 1] = px[i + 2] = on ? 0 : 255; px[i + 3] = 255; }
    const dec = jsQR(px, W, W);
    check(dec && dec.data === share.link, 'QR decodes to the link: ' + (dec ? dec.data.slice(0, 60) : 'no read'));
    check(share.dark === qr.flat().filter(Boolean).length, 'SVG draws every dark module');
    await A.page.click('#modalSheetSaveBtn');
    const C = await device('C', { phone: true, hash: '#vjsetup=' + share.code });
    mo = await modal(C.page);
    check(mo.open && mo.title === 'Set up this device' && !C.page.url().includes('vjsetup'), 'link opens the setup dialog and leaves the address bar: ' + C.page.url());
    check((await C.page.evaluate(() => document.getElementById('mSetupCode').value)) === share.code, 'code prefilled');
    await C.page.fill('#mSetupPass', PASS2); await C.page.click('#modalSheetSaveBtn');
    await until(C.page, () => /Wrong passphrase/.test(document.getElementById('mSetupErr').innerText));
    check(!(await C.page.evaluate(() => syncReady())), 'wrong passphrase: nothing connected');
    await C.page.fill('#mSetupPass', PASS); await C.page.click('#modalSheetSaveBtn');
    await until(C.page, () => document.getElementById('modalSheet').classList.contains('hidden')); await settle(C.page);
    const cs = await C.page.evaluate(() => ({ repo: state.sync.repo, token: state.sync.token, auto: state.sync.auto, trades: state.trades.length }));
    k = await keysOf(C.page);
    check(cs.repo === REPO && cs.token === TOKEN && cs.auto && cs.trades === seed.trades.length, 'C connected from the link: ' + JSON.stringify(Object.assign({}, cs, { token: cs.token === TOKEN })));
    check(!k.dk && k.gk === 'AIza-from-phone' && (await card(C.page)).badge === 'On', 'C got the key with the same passphrase: ' + JSON.stringify(k));
    // ---- Device D: the code pasted into Repository Name works too ----
    const D = await device('D', { phone: true });
    // D already has a Gemini key of its own: it keeps it, and GitHub's stays as it was.
    await D.page.evaluate(() => { aiSetCfg({ key: 'AIza-D-own', model: '' }); openSettings('connect'); renderDataView(); });
    await D.page.fill('#syncRepoInput', share.code); await D.page.click('button:has-text("Save & Connect")');
    mo = await modal(D.page);
    check(mo.open && mo.title === 'Set up this device' && !(await D.page.evaluate(() => state.sync && state.sync.repo)), 'code in the repo box opens setup, not saved as a repo name');
    await D.page.fill('#mSetupPass', PASS); await D.page.click('#modalSheetSaveBtn');
    await until(D.page, () => document.getElementById('modalSheet').classList.contains('hidden')); await settle(D.page);
    k = await keysOf(D.page);
    check((await D.page.evaluate(() => state.sync.repo)) === REPO, 'D set up from a pasted code');
    check(k.gk === 'AIza-D-own' && open(ghFile().keysLock, PASS).ai.key === 'AIza-from-phone', 'D kept its own Gemini key, GitHub kept its: ' + k.gk);
    // A damaged or cut code is turned away with a reason.
    const E = await device('E', { phone: true });
    const flip = share.code.slice(0, -5) + (share.code.slice(-5, -4) === 'A' ? 'B' : 'A') + share.code.slice(-4);
    for (const [bad, why] of [[flip, /Wrong passphrase, or the code was cut/], [share.code.slice(0, 40), /isn't a whole setup code/]]) {
      await E.page.evaluate(code => openSetupCode(code), bad);
      await E.page.fill('#mSetupPass', PASS); await E.page.click('#modalSheetSaveBtn');
      await until(E.page, () => !document.getElementById('mSetupErr').classList.contains('hidden'));
      const m2 = await E.page.evaluate(() => document.getElementById('mSetupErr').innerText);
      check(why.test(m2) && !(await E.page.evaluate(() => syncReady())), 'bad code refused: ' + m2);
      await E.page.evaluate(() => closeModalSheet());
    }

    // ---- Start over with a new passphrase on A: C asks for the new one ----
    await A.page.evaluate(() => { delete state.sync.vault; save(); renderKeysCard(); });
    c = await card(A.page);
    check(c.badge === 'Locked' && /Forgot it/.test(c.text), 'A without its saved key shows Locked: ' + JSON.stringify(c));
    // Inline unlock with a wrong passphrase, then start over.
    await A.page.fill('#keysPassInput', PASS2); await A.page.click('#keysBox button:has-text("Unlock")');
    await until(A.page, () => /Wrong/.test(document.getElementById('keysErr').innerText));
    await A.page.click('#keysBox button:has-text("Forgot it?")');
    await A.page.fill('#mKeysNew', PASS2); await A.page.fill('#mKeysNew2', PASS2); await A.page.click('#modalSheetSaveBtn');
    await until(A.page, () => document.getElementById('modalSheet').classList.contains('hidden')); await A.page.waitForTimeout(200); await settle(A.page);
    plain = open(ghFile().keysLock, PASS2);
    check(!plain.delta && plain.ai.key === 'AIza-from-phone', 'new lock under the new passphrase');
    await C.page.evaluate(() => syncNow({ quiet: true })); await settle(C.page);
    c = await card(C.page);
    check(c.badge === 'Locked' && (await keysOf(C.page)).gk === 'AIza-from-phone', 'C keeps its key and asks for the new passphrase: ' + JSON.stringify(c));
    await C.page.fill('#keysPassInput', PASS2); await C.page.click('#keysBox button:has-text("Unlock")');
    await until(C.page, () => (document.getElementById('keysBadge') || {}).innerText === 'On');
    check((await card(C.page)).badge === 'On', 'C unlocked inline with the new passphrase');

    // ---- Taken off GitHub: every device keeps its keys, nothing new arrives ----
    await A.page.evaluate(() => { openSettings('connect'); renderDataView(); });
    await A.page.click('#keysBox button:has-text("Take keys off GitHub")');
    await A.page.waitForTimeout(200); await settle(A.page);
    f = ghFile();
    check(f.keysLock && f.keysLock.off && !f.keysLock.c, 'GitHub holds only the "off" marker: ' + JSON.stringify(f.keysLock));
    await C.page.evaluate(() => syncNow({ quiet: true })); await settle(C.page);
    const cv = await C.page.evaluate(() => !!state.sync.vault);
    c = await card(C.page);
    check(!cv && c.badge === 'Off' && (await keysOf(C.page)).gk === 'AIza-from-phone', 'C forgot the passphrase key, kept its key: ' + JSON.stringify(c));
    // Off still offers Set up another device: it picks the passphrase first, then shows the code.
    check(/Set up another device/.test(c.text), 'Off shows Set up another device too: ' + JSON.stringify(c.text));
    await C.page.click('#keysBox button:has-text("Set up another device")');
    mo = await modal(C.page);
    check(mo.open && mo.title === 'Save keys to GitHub', 'it asks for a passphrase first: ' + mo.title);
    await C.page.fill('#mKeysNew', PASS); await C.page.fill('#mKeysNew2', PASS); await C.page.click('#modalSheetSaveBtn');
    check(await until(C.page, () => !!document.getElementById('mShareCode') && /^VJ1\./.test(document.getElementById('mShareCode').value)), 'then the setup code shows');
    // The push to GitHub can finish after the code shows: wait for the new lock there.
    for (let i = 0; i < 80 && !(ghFile().keysLock || {}).c; i++) await C.page.waitForTimeout(100);
    await settle(C.page);
    check((await modal(C.page)).title === 'Set up another device' && !!(ghFile().keysLock || {}).c && open(ghFile().keysLock, PASS).ai.key === 'AIza-from-phone', 'and the key is on GitHub again');
    await C.page.click('#modalSheetSaveBtn'); await settle(C.page);

    // ---- A lock from an older build, with the Delta key sealed inside ----
    const b64u = b => Buffer.from(b).toString('base64url');
    const sealOld = (salt, pass, obj, at) => {
      const u = x => Buffer.from(x, 'base64url'), k = crypto.pbkdf2Sync(pass, u(salt), 600000, 32, 'sha256'), iv = crypto.randomBytes(12);
      const ci = crypto.createCipheriv('aes-256-gcm', k, iv); ci.setAAD(Buffer.from('victus-keys-1'));
      return { v: 1, s: salt, i: b64u(iv), c: b64u(Buffer.concat([ci.update(JSON.stringify(obj)), ci.final(), ci.getAuthTag()])), n: 600000, at, has: ['delta', 'ai'] };
    };
    const putLock = lock => { const j = ghFile(); j.keysLock = lock; const t = JSON.stringify(j, null, 2); gh.files[REPO + '@main'] = { text: t, sha: crypto.createHash('sha1').update(t).digest('hex') }; };
    const OLD = { delta: { key: 'dk-OLDLOCK', secret: 'ds-OLDLOCK' }, ai: { key: 'AIza-from-phone', model: '' } };
    // C made the lock it holds (its passphrase key is open, nothing newer to read): it reseals it without Delta.
    const salt = ghFile().keysLock.s, old1 = sealOld(salt, PASS, OLD, new Date().toISOString());
    putLock(old1);
    await C.page.evaluate(l => { state.keysLock = l; state.sync.vault.at = l.at; save(); }, old1);
    await C.page.evaluate(() => syncNow({ quiet: true })); await settle(C.page);
    for (let i = 0; i < 40 && (ghFile().keysLock.has || []).includes('delta'); i++) await C.page.waitForTimeout(100);
    plain = open(ghFile().keysLock, PASS);
    check(JSON.stringify(ghFile().keysLock.has) === '["ai"]' && !plain.delta && plain.ai.key === 'AIza-from-phone' && !(await keysOf(C.page)).dk, 'C resealed the old lock without the Delta key: ' + JSON.stringify([ghFile().keysLock.has, plain]));
    // A new device unlocking an old lock: gets the Gemini key only, and the lock loses the Delta key.
    putLock(sealOld(salt, PASS, OLD, new Date(Date.now() + 1000).toISOString()));
    const F = await device('F', { phone: true });
    await connect(F.page);
    mo = await modal(F.page);
    check(mo.open && /\(Gemini key\)/.test(mo.body) && !/Delta/.test(mo.body), 'F is asked for the Gemini key only: ' + JSON.stringify(mo));
    await F.page.fill('#mKeysPass', PASS); await F.page.click('#modalSheetSaveBtn');
    await until(F.page, () => document.getElementById('modalSheet').classList.contains('hidden')); await settle(F.page);
    for (let i = 0; i < 40 && (ghFile().keysLock.has || []).includes('delta'); i++) await F.page.waitForTimeout(100);
    k = await keysOf(F.page);
    plain = open(ghFile().keysLock, PASS);
    check(!k.dk && !k.ds && k.gk === 'AIza-from-phone' && !plain.delta && JSON.stringify(ghFile().keysLock.has) === '["ai"]' && !ghText().includes('dk-OLDLOCK'), 'F: ' + JSON.stringify({ k, has: ghFile().keysLock.has }));
    // The newer of two locks wins a merge, whichever side it is on.
    const mg = await A.page.evaluate(() => {
      const L = at => ({ v: 1, s: 'c2FsdHNhbHRzYWx0c2FsdA', i: 'aXZpdml2aXZpdml2', c: 'Y2lwaGVydGV4dGNpcGhlcnRleHQ', n: 600000, at, has: ['delta'] });
      const a = mergeState(Object.assign({}, state, { keysLock: L('2026-11-02T10:00:00.000Z') }), { accounts: state.accounts, trades: [], keysLock: L('2026-11-02T09:00:00.000Z') });
      const b = mergeState(Object.assign({}, state, { keysLock: L('2026-11-02T08:00:00.000Z') }), { accounts: state.accounts, trades: [], keysLock: L('2026-11-02T09:00:00.000Z') });
      const bad = mergeState(Object.assign({}, state, { keysLock: undefined }), { accounts: state.accounts, trades: [], keysLock: { v: 1, at: 'x', s: '<script>', i: 'a', c: 'b' } });
      return [a.keysLock.at, b.keysLock.at, 'keysLock' in bad];
    });
    check(mg[0] === '2026-11-02T10:00:00.000Z' && mg[1] === '2026-11-02T09:00:00.000Z' && !mg[2], 'merge keeps the newer lock, drops a bad one: ' + JSON.stringify(mg));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  for (const d of devices) await d.ctx.close();
  const label = 'keys on other devices: locked in journal.json, unlocked once, kept in step; setup link, code and QR';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}
// Signals "Exit at": alerts re-scored at fixed targets from (fake) Delta candles,
// every number worked out by hand.
async function exitTargetRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const t0 = Date.parse('2026-10-01T10:00:00+05:30') / 1000, Q = 900;
  // A: long 100, stop 99. Fills, runs to +2.1%, then stopped. B: short 200, stop 202:
  // fills, best -0.75%, then sits; 20 4H candles later closes at 199.4 (+0.3% its way).
  const bars = { AUSD: [[t0, 100.2, 99.9, 100.1], [t0 + Q, 101.6, 100, 101.5], [t0 + 2 * Q, 102.1, 101, 101.2], [t0 + 3 * Q, 101, 98.9, 99]], BUSD: [] };
  for (let i = 0; i < 320; i++) bars.BUSD.push(i === 0 ? [t0, 200.1, 199.8, 199.9] : i === 1 ? [t0 + Q, 200.5, 198.5, 199] : [t0 + i * Q, 200, 199, 199.4]);
  let calls = 0;
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const u = new URL(route.request().url()), b = bars[u.searchParams.get('symbol')];
    if (!b) return route.abort();
    calls++;
    check(u.searchParams.get('resolution') === '15m', 'a 4H alert reads 15m candles: ' + u.href);
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: b.map(([time, high, low, close]) => ({ time, open: close, high, low, close })) }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
      const sg = (id, sym, side, entry, stop, r, mkt) => ({ id, key: 'k' + id, kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: sym, side, score: '', market: mkt || 'CRYPTO', timeframe: '4H', channel: (mkt || 'CRYPTO') + ' 4H',
        filled: true, outcome: r > 0 ? '+1R' : 'SL', resultR: r, hasReportR: true, price: entry, stop, entry });
      state.signals = [sg('a', 'A', 'long', 100, 99, 0.9), sg('b', 'B', 'short', 200, 202, -1), sg('c', 'RELIANCE', 'long', 100, 99, 0.9, 'NSE')];
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '', sigHold: '20' });
      switchTab('signals'); renderAll();
    });
    await page.waitForFunction(() => /2 of 3 graded alerts have price data/.test(document.getElementById('sigTgtCmp').innerText) && !/reading/.test(document.getElementById('sigTgtCmp').innerText), null, { timeout: 10000 });
    const rows = await page.$$eval('#sigTgtCmp > div > table tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    // costs 0.0826R; SL = -1 - 0.99*0.05 - 0.0826 = -1.1321; B time exit = 0.3 - 0.0826 = 0.2174
    const want = ['Scanner 2 50% -0.10R -0.05R 0.90 -0.10%', '1R 2 100% +1.13R +0.57R ∞ +1.13%', '1.5R 2 100% +1.63R +0.82R ∞ +1.63%', '2R best 2 100% +2.13R +1.07R ∞ +2.13%', '3R 2 50% -0.91R -0.46R 0.19 -0.91%', '1% 2 100% +1.13R +0.57R ∞ +1.13%', '2% 2 100% +2.13R +1.07R ∞ +2.13%', '3% 2 50% -0.91R -0.46R 0.19 -0.91%'];
    check(JSON.stringify(rows) === JSON.stringify(want), 'compare rows:\n       ' + rows.join('\n       '));
    check(calls === 2, 'one candle read per crypto alert, none for NSE: ' + calls);
    // Pick 2R: the whole tab re-scores, and By outcome speaks in targets.
    await page.click('#sigTgtBar button[data-tgt="2R"]');
    const v = await page.evaluate(() => ({ strip: document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '), out: document.getElementById('sigByOutcome').innerText.replace(/\s+/g, ' '),
      on: document.querySelector('#sigTgtCmp tr[data-tgt="2R"]').className, kept: Object.keys(tgtCache()).length, keptLocal: localStorage.getItem('tapeAndTarget.sigTgt'),
      // Pure: a candle that touches both the target and the stop counts as the stop.
      both: tgtScore({ side: 'long', entry: 100, stop: 99, timeframe: '4H', date: '2026-10-01', time: '10:00' }, tgtWalk({ side: 'long', entry: 100, stop: 99, timeframe: '4H', date: '2026-10-01', time: '10:00' }, [{ time: 1790829000, high: 100.1, low: 99.95, close: 100 }, { time: 1790829900, high: 102.5, low: 98.5, close: 100 }], 15), { r: 2 }),
      analysisSame: (() => { tgtScope = false; const o = outcomeOf({ signal: state.signals[0] }); return o.r; })() }));
    check(/What if every alert exited at 2R/.test(v.strip) && /\+2\.13R/.test(v.strip) && /100%/.test(v.strip), '2R strip: ' + v.strip);
    check(/Target 1/.test(v.out) && /Time exit 1/.test(v.out) && !/\+1R 1/.test(v.out), 'By outcome at 2R: ' + v.out);
    check(/text-amber-300/.test(v.on), 'picked row marked');
    check(v.kept === 2, 'finished candles kept on the device: ' + v.kept);
    check(v.both && v.both.label === 'SL', 'both in one candle = stop: ' + JSON.stringify(v.both));
    check(v.analysisSame === 0.9, 'outside Signals the scanner result stands: ' + v.analysisSame);
    // Without fees: each result gets its 0.0826% round trip back (NSE 0.1063%), in R = fee % / stop %.
    await page.click('#sigFeeBar button[data-nofee="1"]');
    await page.waitForFunction(() => /no fees/.test(document.getElementById('sigEdgeStrip').innerText));
    const rowsNf = await page.$$eval('#sigTgtCmp > div > table tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    const wantNf = ['Scanner 2 50% +0.07R +0.03R 1.07 +0.07%', '1R 2 100% +1.30R +0.65R ∞ +1.30%', '1.5R 2 100% +1.80R +0.90R ∞ +1.80%', '2R best 2 100% +2.30R +1.15R ∞ +2.30%', '3R 2 50% -0.75R -0.37R 0.29 -0.75%', '1% 2 100% +1.30R +0.65R ∞ +1.30%', '2% 2 100% +2.30R +1.15R ∞ +2.30%', '3% 2 50% -0.75R -0.37R 0.29 -0.75%'];
    check(JSON.stringify(rowsNf) === JSON.stringify(wantNf), 'compare rows without fees:\n       ' + rowsNf.join('\n       '));
    const nf = await page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
    check(/Total R \+2\.30R/.test(nf), '2R strip without fees: ' + nf);
    await page.click('#sigTgtNote button:last-child');
    const nfScan = await page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
    // 0.9826 - 0.9174 + 1.0063 (the NSE alert, 0.1063% fee) = 1.0715
    check(/Total R \+1\.07R/.test(nfScan) && /No fees/.test(nfScan), 'scanner results without fees: ' + nfScan);
    await page.click('#sigFeeBar button[data-nofee="0"]');
    const back = await page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
    check(!/What if/.test(back) && /Total R \+0\.80R/.test(back), 'back to scanner: ' + back);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals exit at a fixed target: re-scored by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('exit target: ' + e); });
}
// "Move SL": breakeven or a stop shift on top of a fixed Exit at, re-scored by hand.
// A: long 100, stop 99 (1%): fill close 100.1, +1.6R (low 100 = entry), +2.1R (low 101
// = +1R), then stopped at 98.9. B: short 200, stop 202: best +0.75R (high 200.5), then
// sits with highs at 200 (= entry) and closes 20 4H candles later at 199.4 (+0.3R).
async function stopMoveRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const t0 = Date.parse('2026-10-01T10:00:00+05:30') / 1000, Q = 900;
  const bars = { AUSD: [[t0, 100.2, 99.9, 100.1], [t0 + Q, 101.6, 100, 101.5], [t0 + 2 * Q, 102.1, 101, 101.2], [t0 + 3 * Q, 101, 98.9, 99]], BUSD: [] };
  for (let i = 0; i < 320; i++) bars.BUSD.push(i === 0 ? [t0, 200.1, 199.8, 199.9] : i === 1 ? [t0 + Q, 200.5, 198.5, 199] : [t0 + i * Q, 200, 199, 199.4]);
  let calls = 0;
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const b = bars[new URL(route.request().url()).searchParams.get('symbol')];
    if (!b) return route.abort();
    calls++;
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: b.map(([time, high, low, close]) => ({ time, open: close, high, low, close })) }) });
  });
  // A was read before Move SL (no path kept): it must be read again, once.
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); localStorage.setItem('tapeAndTarget.sigTgt', JSON.stringify({ 'ka|long|100|99': { m: 0.021, sl: 1, e: 0, done: 1 } })); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const strip = () => page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
      const sg = (id, sym, side, entry, stop, r) => ({ id, key: 'k' + id, kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: sym, side, score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: r > 0 ? '+1R' : 'SL', resultR: r, hasReportR: true, price: entry, stop, entry });
      state.signals = [sg('a', 'A', 'long', 100, 99, 0.9), sg('b', 'B', 'short', 200, 202, -1)];
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '3R', sigNoFee: false, sigStop: { mode: 'be', beAt: 1 }, sigHold: '20' });
      // A and B are made-up coins (BUSD's real contract is $20,000), so the demo sizes them at any size
      state.ui.sigDemo = Object.assign({}, state.ui.sigDemo || {}, { real: false });
      switchTab('signals'); renderAll();
    });
    await page.waitForFunction(() => /2 of 2 graded alerts have price data/.test(document.getElementById('sigTgtCmp').innerText) && !/reading/.test(document.getElementById('sigTgtCmp').innerText) && document.getElementById('sigStopGrid'), null, { timeout: 10000 });
    check(calls === 2, 'the old summary without a path is read again, and B once: ' + calls);
    // 3R, BE at 1R. A: armed at +1.6R, stopped at entry: 0 - 0.05 - 0.0826 = -0.1326.
    // B: never reached +1R, so as before: time exit 0.3 - 0.0826 = +0.2174. Total +0.0848.
    let st = await strip();
    check(/exited at 3R \(BE at 1R, closed after 20 candles\)/.test(st) && /Total R \+0\.08R/.test(st), '3R + BE at 1R strip: ' + st);
    const rows = await page.$$eval('#sigTgtCmp > div > table tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    // 1R: both as before (A hits 1R before the move matters; B never reaches 1R). 2R: A at +2.1R (low +1R, above entry) = +1.9174.
    const want = ['Scanner 2 50% -0.10R -0.05R 0.90 -0.10%', '1R 2 100% +1.13R +0.57R ∞ +1.13%', '1.5R 2 100% +1.63R +0.82R ∞ +1.63%', '2R best 2 100% +2.13R +1.07R ∞ +2.13%', '3R 2 50% +0.08R +0.04R 1.64 +0.08%', '1% 2 100% +1.13R +0.57R ∞ +1.13%', '2% 2 100% +2.13R +1.07R ∞ +2.13%', '3% 2 50% +0.08R +0.04R 1.64 +0.08%'];
    check(JSON.stringify(rows) === JSON.stringify(want), 'compare rows with BE at 1R:\n       ' + rows.join('\n       '));
    const out = await page.evaluate(() => document.getElementById('sigByOutcome').innerText.replace(/\s+/g, ' '));
    check(/BE 1/.test(out) && /Time exit 1/.test(out), 'By outcome shows the BE exit: ' + out);
    // The grid: No move vs BE vs shifts, total R on the same alerts.
    const grid = await page.$$eval('#sigStopGrid tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    const cell = (rule, tgt) => page.$eval(`#sigStopGrid td[data-cell="${tgt}~${rule}"]`, td => td.innerText.trim()).catch(() => null);
    check(grid[0] === 'No move +1.13R +1.63R +2.13R -0.91R', 'no-move row = fixed stop (R targets with an R target): ' + grid[0]);
    // shift 1R -> +0.75R at 3R: A 0.75 - 1.0075*0.05 - 0.0826 = +0.6170; B never armed +0.2174 => +0.83R
    check(await cell('shift|1|0.75', '3R') === '+0.83R', 'shift 1R -> +0.75R at 3R: ' + await cell('shift|1|0.75', '3R'));
    // shift 1.5R -> +1R at 2R: the +2.1R candle's low is exactly +1R, so the moved stop
    // and the target share a candle: the stop. A 1 - 1.01*0.05 - 0.0826 = +0.8669; B +0.2174 => +1.08R
    check(await cell('shift|1.5|1', '2R') === '+1.08R', 'stop and target in one candle = stop: ' + await cell('shift|1.5|1', '2R'));
    // BE at 0.5R at 1R: A hits 1R first (+0.9174); B armed at +0.75R, back to entry: -0.1326 => +0.78R
    check(await cell('be|0.5', '1R') === '+0.78R', 'BE at 0.5R, 1R: ' + await cell('be|0.5', '1R'));
    // Pick SL shift 1R -> +0.75R from the bar; the whole tab follows, demo account too.
    await page.click('#sigStopBar button[data-stop="shift"]');
    const sel = await page.evaluate(() => ({ at: document.getElementById('sigStopAt').value, to: document.getElementById('sigStopTo').value, off: [...document.querySelectorAll('#sigStopTo option')].filter(o => o.disabled).map(o => o.value).join(',') }));
    check(sel.at === '1' && sel.to === '0.75' && sel.off === '1,1.25,1.5,2,2.5', 'shift defaults to 1R -> +0.75R, levels at or past the trigger off: ' + JSON.stringify(sel));
    st = await strip();
    check(/SL to \+0\.75R at 1R/.test(st) && /Total R \+0\.83R/.test(st), 'shift strip: ' + st);
    await page.evaluate(() => setSigSec('demo'));
    await page.waitForFunction(() => document.getElementById('sigDemoOut') && /Final balance/i.test(document.getElementById('sigDemoOut').innerText));
    // $100 at 1%: A +0.6170R -> 100.617; B 1.00617 x 0.2174 = +0.2187 -> 100.84
    const demo = await page.evaluate(() => document.getElementById('sigDemoOut').innerText.replace(/\s+/g, ' '));
    check(/\$100\.84/.test(demo), 'demo account follows Move SL: ' + demo.slice(0, 300));
    // Raising the trigger to 0.75R keeps the level under it (0.5R).
    await page.evaluate(() => { setSigSec('edge'); setSigStop('shAt', '0.75'); });
    const raw = await page.evaluate(() => JSON.stringify(stopRaw()));
    check(raw === '{"mode":"shift","beAt":1,"shAt":0.75,"shTo":0.5,"beAtP":1,"shAtP":1,"shToP":0.5}', 'level kept under the trigger: ' + raw);
    // Scanner keeps its own rules and says so.
    await page.evaluate(() => setSigTgt(''));
    st = await strip();
    check(/Total R -0\.10R/.test(st) && /Move SL \(SL to \+0\.5R at 0\.75R\) works with a fixed Exit at/.test(st), 'scanner + Move SL note: ' + st);
    // Click a grid cell: target and stop move together.
    await page.click('#sigStopGrid td[data-cell="2R~be|1"]');
    const picked = await page.evaluate(() => ({ t: state.ui.sigTgt, s: JSON.stringify(stopRaw()) }));
    check(picked.t === '2R' && /"mode":"be","beAt":1/.test(picked.s), 'grid click sets both: ' + JSON.stringify(picked));
    // A trigger at or past an R target never fires: greyed out, warned, "same" in the grid.
    await page.evaluate(() => setSigTgt('1.5R'));
    const offAt = await page.evaluate(() => [...document.querySelectorAll('#sigStopAt option')].filter(o => o.disabled).map(o => o.value).join(','));
    check(offAt === '1.5,2,2.5,3', 'at 1.5R, triggers from +1.5R are off: ' + offAt);
    check(!(await page.$('#sigStopWarn')), 'no warning while the trigger is under the target');
    await page.evaluate(() => setSigStop('beAt', '2'));
    const warn = await page.evaluate(() => (document.getElementById('sigStopWarn') || {}).innerText || '');
    check(/below your 1\.5R target/.test(warn), 'trigger past the target is warned: ' + warn);
    check(await cell('be|1', '1R') === 'same' && await cell('be|1', '2R') !== 'same', 'grid: BE at 1R with a 1R target is "same": ' + await cell('be|1', '1R'));
    // A % target: the trigger and level are in % too, greyed out from the target up.
    await page.evaluate(() => setSigTgt('2%'));
    const pctBar = await page.evaluate(() => ({ unit: document.getElementById('sigStopAt').dataset.unit, off: [...document.querySelectorAll('#sigStopAt option')].filter(o => o.disabled).map(o => o.value).join(','), txt: document.getElementById('sigStopAt').selectedOptions[0].innerText }));
    check(pctBar.unit === '%' && pctBar.off === '2,2.5,3' && pctBar.txt === '+1%' && !(await page.$('#sigStopWarn')), '% target: trigger in %, from +2% off: ' + JSON.stringify(pctBar));
    // Pure: the path kept for a long, and outside Signals the scanner result stands.
    const pure = await page.evaluate(() => {
      const sig = { side: 'long', entry: 100, stop: 99, timeframe: '4H', date: '2026-10-01', time: '10:00' };
      const w = tgtWalk(sig, [{ time: 1790829000, high: 100.1, low: 99.95, close: 100.05 }, { time: 1790829900, high: 100.505, low: 99.8, close: 100.4 }, { time: 1790830800, high: 100.508, low: 99.9, close: 100.4 }, { time: 1790831700, high: 101.2, low: 100.3, close: 101 }, { time: 1790832600, high: 101, low: 98.5, close: 99 }], 15);
      tgtScope = false; const o = outcomeOf({ signal: state.signals[0] }).r; tgtScope = true;
      // The stop moves from the candle after the trigger: the trigger candle's own dip (-0.3R) doesn't stop it.
      const sc = tgtScore(sig, { m: 0.025, sl: 0, e: 0.02, done: 1, p: [[1.2, -0.3], [2.5, 0.4]], ta: 0.5 }, { r: 2 }, true, { at: 1, to: 0 });
      return { p: w.p, ta: w.ta, o, sc };
    });
    check(pure.sc && pure.sc.label === 'Target' && pure.sc.r === 2, 'stop moves from the next candle: ' + JSON.stringify(pure.sc));
    // fill close +0.05R; +0.505R kept; +0.508R is within 0.01R (dropped, its dip -0.1R joins the next); +1.2R; then stopped (-1.5R)
    check(JSON.stringify(pure.p) === '[[0.05,0.05],[0.505,-0.2],[1.2,-0.1]]' && pure.ta === -1.5, 'path kept: ' + JSON.stringify(pure));
    check(pure.o === 0.9, 'outside Signals the scanner result stands: ' + pure.o);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals Move SL (BE / SL shift): re-scored by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('move sl: ' + e); });
}
// "SL" (lakky, 2026-11-10: "so many ways to see sl ... below or above candle, wick"):
// each alert played with another stop, re-scored by hand. Two 4H trendline alerts at
// 10:00 IST (04:30 UTC) on 1 Oct. 4H candles before it (newest first; the 04:00 UTC one
// is still forming and must be ignored):
//   A long 100 (alert SL 99, 1%): 00:00 low 99.6 body 100.4 · 20:00 low 98.8 body 99.8 ·
//     16:00 low 98.6 body 99.2. At 0.75%+ (99.25): wick 98.8 (1.2%), body 99.2 (0.8%).
//   B short 200 (alert SL 202, 1%): 00:00 high 201 body 199.8 · 20:00 high 201.8 body 201 ·
//     16:00 high 202.4 body 201.6. At 0.75%+ (201.5): wick 201.8 (0.9%), body 201.6 (0.8%).
// 15m walk: A fills, +1.6% (high 101.6), +2.1% (high 102.1), then low 98.5 (every stop).
// B fills, -1.25% (low 197.5), then high 202.5 (every stop).
async function slTypeRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const t0 = Date.parse('2026-10-01T10:00:00+05:30') / 1000, Q = 900, H4 = 14400, c0 = Date.parse('2026-10-01T00:00:00Z') / 1000;
  const pre = {
    // [time, open, high, low, close]
    AUSD: [[c0 + H4, 100, 100.2, 95, 100], [c0, 100.5, 101, 99.6, 100.4], [c0 - H4, 99.8, 100.6, 98.8, 100.5], [c0 - 2 * H4, 99.4, 99.9, 98.6, 99.2]],
    BUSD: [[c0 + H4, 200, 210, 199, 200], [c0, 199.5, 201, 199, 199.8], [c0 - H4, 200.2, 201.8, 199.5, 201], [c0 - 2 * H4, 201.6, 202.4, 200.5, 200.9]]
  };
  for (let i = 3; i < 10; i++) { pre.AUSD.push([c0 - i * H4, 101, 101.5, 101, 101.2]); pre.BUSD.push([c0 - i * H4, 199, 199.2, 198.5, 199]); }
  const walk = { AUSD: [[t0, 100.2, 99.9, 100.1], [t0 + Q, 101.6, 100, 101.5], [t0 + 2 * Q, 102.1, 101, 101.2], [t0 + 3 * Q, 101, 98.5, 98.6]],
    BUSD: [[t0, 200.1, 199.8, 199.9], [t0 + Q, 200.2, 197.5, 198], [t0 + 2 * Q, 202.5, 199, 202.4]] };
  const reads = { '4h': 0, '15m': 0 };
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const u = new URL(route.request().url()), sym = u.searchParams.get('symbol'), res = u.searchParams.get('resolution');
    if (!pre[sym]) return route.abort();
    reads[res] = (reads[res] || 0) + 1;
    const body = res === '4h' ? pre[sym].map(([time, open, high, low, close]) => ({ time, open, high, low, close }))
      : walk[sym].map(([time, high, low, close]) => ({ time, open: close, high, low, close }));
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: body }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const strip = () => page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
  const cell = (tgt, sl) => page.$eval(`#sigSlGrid td[data-cell="${tgt}~${sl}"]`, td => td.innerText.trim()).catch(() => null);
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
      const sg = (id, sym, side, entry, stop, r, mkt) => ({ id, key: 'k' + id, kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: sym, side, score: '', market: mkt || 'CRYPTO', timeframe: '4H', channel: (mkt || 'CRYPTO') + ' 4H',
        filled: true, outcome: r > 0 ? '+1R' : 'SL', resultR: r, hasReportR: true, price: entry, stop, entry });
      state.signals = [sg('a', 'A', 'long', 100, 99, 0.9), sg('b', 'B', 'short', 200, 202, -1), sg('c', 'RELIANCE', 'long', 100, 99, 0.9, 'NSE')];
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '', sigHold: '20', sigNoFee: false, sigStop: { mode: 'off' }, sigTrail: { on: false } });
      state.ui.sigDemo = Object.assign({}, state.ui.sigDemo || {}, { real: false });
      switchTab('signals'); renderAll();
    });
    // Picking an SL with the Scanner exit moves to 1R (a new stop needs a fixed target).
    await page.click('#sigSlBar button[data-sl="wick"]');
    check(await page.evaluate(() => state.ui.sigTgt) === '1R', 'an SL with no target picks 1R: ' + await page.evaluate(() => state.ui.sigTgt));
    await page.waitForFunction(n => { const t = (document.getElementById('sigTgtNote') || {}).innerText || ''; return /2 of 2 graded alerts have price data/.test(t) && !/reading|waiting for candles/.test(t); }, null, { timeout: 15000 });
    // 1R on the wick: A 1 - 0.0826/1.2 = +0.9312; B 1 - 0.0826/0.9 = +0.9082 => +1.84R
    let st = await strip();
    check(/exited at 1R \(SL at the last candle wick 0\.75%\+ past entry, no breakeven, closed after 20 candles\)/.test(st) && /Total R \+1\.84R/.test(st), 'wick 0.75% at 1R: ' + st);
    check(/1 with no candle 0\.75% past entry/.test(st), 'the NSE alert has no candle stop: ' + st);
    check(reads['4h'] === 2, 'one 4H read per crypto alert, none for NSE: ' + reads['4h']);
    const kept = await page.evaluate(() => ({ a: tgtCache()['slc|ka|long|4H'], b: tgtCache()['slc|kb|short|4H'], stops: sigView.pairs.map(pr => pr.signal.stop) }));
    // The forming 04:00 candle (low 95 / high 210) is left out; older flat candles add no new step.
    check(JSON.stringify(kept.a && kept.a.w) === '[99.6,98.8,98.6]' && JSON.stringify(kept.a && kept.a.b) === '[100.4,99.8,99.2]', 'A steps: ' + JSON.stringify(kept.a));
    check(JSON.stringify(kept.b && kept.b.w) === '[201,201.8,202.4]' && JSON.stringify(kept.b && kept.b.b) === '[199.8,201,201.6]', 'B steps: ' + JSON.stringify(kept.b));
    check(JSON.stringify(kept.stops) === '[98.8,201.8,null]', 'stops in play: ' + JSON.stringify(kept.stops));
    // The table says which SL the numbers use.
    const tag = await page.evaluate(() => [...document.querySelectorAll('#signalsTableBody tr')].map(tr => tr.innerText).join(' | '));
    check(/SL Wick 0\.75%/.test(tag), 'alert rows tagged with the SL: ' + tag.slice(0, 200));
    // Body: no new candle read. A 1 - 0.0826/0.8 = +0.8968; B the same => +1.79R
    await page.click('#sigSlBar button[data-sl="body"]');
    await page.waitForFunction(() => /Total R\s+\+1\.79R/.test(document.getElementById('sigEdgeStrip').innerText) && !/reading/.test((document.getElementById('sigTgtNote') || {}).innerText || ''), null, { timeout: 10000 });
    check(reads['4h'] === 2, 'the kept candles serve every SL type: ' + reads['4h']);
    // Wick at 0.25%+: A 99.6 (0.4%) 1 - 0.2065 = +0.7935; B 201 (0.5%) 1 - 0.1652 = +0.8348 => +1.63R
    await page.click('#sigSlBar button[data-sl="wick"]');
    await page.selectOption('#sigSlGap', '0.25');
    await page.waitForFunction(() => /Total R\s+\+1\.63R/.test(document.getElementById('sigEdgeStrip').innerText) && !/reading/.test((document.getElementById('sigTgtNote') || {}).innerText || ''), null, { timeout: 10000 });
    check(reads['4h'] === 2, 'a new gap needs no new read either: ' + reads['4h']);
    await page.selectOption('#sigSlGap', '0.75');
    // The grid: every SL type at every target on the same alerts, once asked.
    check(/Read prices for every SL/.test(await page.evaluate(() => document.getElementById('sigTgtCmp').innerText)), 'the grid waits to be asked');
    // A device that never read the alerts on their own SL (no Scanner visit) reads them for the Alert row too.
    // Fixed 0.5% (A 99.5, B 201), so no other row shares the alerts' own stops.
    await page.evaluate(() => { setSigSl('pct', 0.5); ['ka|long|100|99', 'kb|short|200|202'].forEach(k => { delete tgtCache()[k]; delete tgtTried[k]; }); });
    await page.click('#sigSlCmpRead');
    await page.waitForFunction(() => document.getElementById('sigSlGrid') && !/reading|still need/.test(document.getElementById('sigTgtCmp').innerText.split('SL compared')[1] || 'reading'), null, { timeout: 15000 });
    // Avg SL and 1R: Alert 1.00% +1.83R; Wick (1.2 + 0.9) / 2; Body / Wick or body 0.8%; 1% = the alert's stop.
    const rows = await page.$$eval('#sigSlGrid tbody tr', trs => trs.map(tr => tr.dataset.sl + ':' + tr.children[1].innerText.trim()));
    check(JSON.stringify(rows) === '[":1.00%","wick:1.05%","body:0.80%","near:0.80%","pct:0.50%"]', 'grid rows and avg SL: ' + JSON.stringify(rows));
    // 3R (nothing reaches it): every stop hit. Alert -1.1321 - 1.1331; Wick A -1 - 0.988*0.05/1.2 - 0.0826/1.2 = -1.11,
    // B -1 - 1.009*0.05/0.9 - 0.0826/0.9 = -1.14783 => -2.26R; Body A -1.16525, B -1 - 1.008*0.05/0.8 - 0.10325 = -1.16625 => -2.33R
    // 2R: Alert A +1.9174 (102.1), B SL -1.1331 => +0.78R; Body A 101.6 = 2R +1.89675, B 2R = 196.8 not reached, SL -1.16625 => +0.73R
    // Fixed 0.5%: 1R both reached, 1 - 0.0826/0.5 = +0.8348 each => +1.67R; 3R: A 101.5 reached +2.8348, B stopped at 201:
    // -1 - 1.005*0.05/0.5 - 0.1652 = -1.2657 => +1.57R
    const want = { '1R~': '+1.83R', '1R~wick': '+1.84R', '1R~body': '+1.79R', '1R~near': '+1.79R', '1R~pct': '+1.67R', '3R~pct': '+1.57R', '3R~': '-2.27R', '3R~wick': '-2.26R', '3R~body': '-2.33R', '2R~': '+0.78R', '2R~body': '+0.73R' };
    for (const [k, v] of Object.entries(want)) { const [t, s] = k.split('~'); const got = await cell(t, s); check(got === v, 'grid ' + k + ': ' + got + ' (want ' + v + ')'); }
    check(!(await page.$('#sigSlGrid tr[data-sl="next"]')), 'fib-only types are not offered on trendline alerts');
    // Click a cell: SL type and target together; the demo account follows.
    await page.click('#sigSlGrid td[data-cell="2R~body"]');
    const picked = await page.evaluate(() => ({ t: state.ui.sigTgt, s: state.ui.sigSl.mode }));
    check(picked.t === '2R' && picked.s === 'body', 'grid click sets both: ' + JSON.stringify(picked));
    st = await strip();
    check(/Total R \+0\.73R/.test(st), 'body at 2R strip: ' + st);
    await page.evaluate(() => setSigSec('demo'));
    await page.waitForFunction(() => document.getElementById('sigDemoOut') && /Final balance/i.test(document.getElementById('sigDemoOut').innerText));
    // $100 at 1% risk: A +1.89675R -> 101.89675; B 1.0189675 x -1.16625 => 100.71
    const demo = await page.evaluate(() => document.getElementById('sigDemoOut').innerText.replace(/\s+/g, ' '));
    check(/\$100\.71/.test(demo), 'demo account follows the SL: ' + demo.slice(0, 200));
    await page.evaluate(() => setSigSec('edge'));
    // Back to Scanner: the alert's own SL and result, and a note on the SL picked.
    await page.evaluate(() => setSigTgt(''));
    st = await strip();
    check(/Total R \+0\.80R/.test(st) && /SL \(SL at the last candle body 0\.75%\+ past entry\) works with a fixed Exit at/.test(st), 'scanner keeps the alert SL: ' + st);
    check(/candle body/.test(await page.evaluate(() => document.getElementById('sigRulesSum').innerText)) === false, 'folded rules line names no SL without a target');
    await page.evaluate(() => setSigTgt('1R'));
    check(/SL at the last candle body/.test(await page.evaluate(() => document.getElementById('sigRulesSum').innerText)), 'folded rules line names the SL');
    // Reset puts the alert's own SL back.
    await page.click('#sigRulesResetBtn');
    check(await page.evaluate(() => slRaw().mode) === '' && await page.evaluate(() => state.ui.sigTgt) === '', 'Reset clears the SL');
    // Pure checks.
    const pure = await page.evaluate(() => {
      const fib = (key, entry, side, lvl) => Object.assign({ key, kind: 'fib', side: side || 'long', entry, stop: 1 }, lvl ? { lvlWhatIf: lvl } : {});
      const at = (sig, m) => { const v = slStopFor(sig, slRuleOf(m, {})); return v == null ? v : +v.toFixed(6); };
      // Buy fib top 110, base 10 (range 100): L1 76, L2 65, L3 55, L4 44; pad = 25% of a box (11) = 2.75.
      const L3 = fib('fib|X|1d|1|1000|110|2', 55), L1 = fib('fib|X|1d|1|1000|110|1|L1', 76), L4 = fib('fib|X|1d|1|1000|110|2|L4', 44), L2c = fib('fib|X|1d|1|1000|110|2', 65, 'long', 'L2');
      // Sell fib top 10 (low), base 110: L3 at 65, next = 10 + 0.6875 x 100 = 78.75.
      const S3 = fib('fib|X|4h|-1|1000|10|2', 65, 'short');
      const out = { L3: [at(L3, 'next'), at(L3, 'box')], L1: [at(L1, 'next'), at(L1, 'box')], L4: [at(L4, 'next'), at(L4, 'box')], L2c: at(L2c, 'next'), S3: at(S3, 'next'),
        pct: [at({ entry: 100, side: 'long' }, 'pct'), at({ entry: 200, side: 'short' }, 'pct')], tl: at({ key: 'tl|1', kind: 'trendline', entry: 100, side: 'long' }, 'next') };
      // Built candles: 1M from days (calendar months, UTC), the forming month and a partial oldest one left out;
      // 1W from Monday. Days from 15 Jul to 10 Oct 2026, alert on 10 Oct.
      const D = 86400, rows = [];
      for (let t = Date.UTC(2026, 6, 15) / 1000; t <= Date.UTC(2026, 9, 10) / 1000; t += D) rows.push({ time: t, open: 10, high: 11 + (t === Date.UTC(2026, 7, 20) / 1000 ? 5 : 0), low: 9, close: 10.5 });
      const mo = slcBars(rows, 43200, 1440, Date.UTC(2026, 9, 10, 6));
      const wk = slcBars(rows, 10080, 1440, Date.UTC(2026, 9, 10, 6));
      out.months = mo.map(k => new Date(k.t).toISOString().slice(0, 10) + ':' + k.h);
      out.weeks = [wk.length, new Date(wk[0].t).toISOString().slice(0, 10), new Date(wk[wk.length - 1].t).getUTCDay(), new Date(wk[wk.length - 1].t).toISOString().slice(0, 10)];
      // Random candles: the kept steps pick the same stop as walking back candle by candle (the scanner's candle_stop).
      let bad = 0, seed = 7;
      const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let n = 0; n < 400; n++) {
        const s = rnd() < 0.5 ? 1 : -1, bars = [];
        let p = 100;
        for (let i = 0; i < 60; i++) { const o = p, c = p * (1 + (rnd() - 0.5) * 0.04); bars.push({ o, c, h: Math.max(o, c) * (1 + rnd() * 0.01), l: Math.min(o, c) * (1 - rnd() * 0.01) }); p = c; }
        const e = p * (1 + (rnd() - 0.5) * 0.02), gap = [0.25, 0.5, 0.75, 1, 1.5][n % 5], st = slcStairs(bars, s), T = e * (1 - s * gap / 100);
        let w = null, b = null;
        for (let j = bars.length - 1; j >= 0; j--) {
          const k = bars[j], wv = s > 0 ? k.l : k.h, bv = s > 0 ? Math.min(k.o, k.c) : Math.max(k.o, k.c);
          if (w == null && (s > 0 ? wv <= T : wv >= T)) w = wv;
          if (b == null && (s > 0 ? bv <= T : bv >= T)) b = bv;
        }
        const near = w == null ? b : b == null ? w : s > 0 ? Math.max(w, b) : Math.min(w, b), sig = { entry: e, side: s > 0 ? 'long' : 'short' };
        const got = ['wick', 'body', 'near'].map(m => slStopFor(sig, { mode: m, v: gap }, st));
        if (got[0] !== w || got[1] !== b || got[2] !== near) bad++;
      }
      out.bad = bad;
      return out;
    });
    check(JSON.stringify(pure.L3) === '[41.25,41.25]', 'fib L3: next = L4 box = L4 - pad: ' + JSON.stringify(pure.L3));
    check(JSON.stringify(pure.L1) === '[62.25,41.25]' && JSON.stringify(pure.L4) === '[30.25,41.25]' && pure.L2c === 52.25, 'fib L1 / L4 / L2 what-if: ' + JSON.stringify(pure));
    check(pure.S3 === 78.75, 'sell fib next level: ' + pure.S3);
    check(JSON.stringify(pure.pct) === '[99,202]' && pure.tl === null, 'fixed 1% both ways; a trendline has no fib level: ' + JSON.stringify([pure.pct, pure.tl]));
    check(JSON.stringify(pure.months) === '["2026-08-01:16","2026-09-01:11"]', '1M candles from days: ' + JSON.stringify(pure.months));
    check(pure.weeks[2] === 1 && pure.weeks[3] === '2026-09-28' && pure.weeks[1] === '2026-07-20', '1W candles start on Monday, forming week out: ' + JSON.stringify(pure.weeks));
    check(pure.bad === 0, 'steps pick the same stop as walking back: ' + pure.bad + ' of 400 differ');
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals SL types (wick / body / fixed % / fib levels) + SL compared: re-scored by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('sl types: ' + e); });
}
// Hold and % Move SL. C: long 100, stop 99 (1%): flat for 330 15m candles (past its
// 20 4H candles = 320), then +2.2R. D: short 200, stop 202: flat, never stopped, never 2R.
async function holdPctRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const t0 = Date.parse('2026-10-01T10:00:00+05:30') / 1000, Q = 900;
  const bars = { CUSD: [[t0, 100.2, 99.9, 100.1]], DUSD: [] };
  for (let i = 1; i <= 330; i++) bars.CUSD.push([t0 + i * Q, 100.5, 99.8, 100.2]);
  bars.CUSD.push([t0 + 331 * Q, 102.2, 100.1, 102]);
  for (let i = 0; i < 400; i++) bars.DUSD.push(i === 0 ? [t0, 200.1, 199.8, 200] : [t0 + i * Q, 200.5, 199.5, 200]);
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const b = bars[new URL(route.request().url()).searchParams.get('symbol')];
    if (!b) return route.abort();
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: b.map(([time, high, low, close]) => ({ time, open: close, high, low, close })) }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const strip = () => page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
      const sg = (id, sym, side, entry, stop) => ({ id, key: 'k' + id, kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: sym, side, score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: '+1R', resultR: 0.9, hasReportR: true, price: entry, stop, entry });
      state.signals = [sg('c', 'C', 'long', 100, 99), sg('d', 'D', 'short', 200, 202)];
      delete state.ui.sigHold;
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '2R', sigNoFee: false, sigStop: { mode: 'off' } });
      switchTab('signals'); renderAll();
    });
    // Default hold: till TP / SL. C hits 2R after its 20 candles: +2 - 0.0826; D is still open.
    await page.waitForFunction(() => /2 of 2 graded alerts have price data/.test(document.getElementById('sigEdgeStrip').innerText) && !/reading/.test(document.getElementById('sigEdgeStrip').innerText), null, { timeout: 10000 });
    let st = await strip();
    check(/held till TP or SL/.test(st) && /1 still open \(no TP or SL yet\)/.test(st) && /Total R \+1\.92R/.test(st), 'till TP / SL strip: ' + st);
    const holdOn = await page.evaluate(() => document.querySelector('#sigHoldBar button[data-hold="tp"]').className);
    check(/text-amber-400/.test(holdOn), 'Till TP / SL is the default');
    // 20 candles: C closes at its 20th 4H candle (+0.2R - 0.0826), D too (0 - 0.0826) = +0.03R.
    await page.click('#sigHoldBar button[data-hold="20"]');
    await page.waitForFunction(() => /closed after 20 candles/.test(document.getElementById('sigEdgeStrip').innerText) && /2 of 2 graded/.test(document.getElementById('sigEdgeStrip').innerText) && !/reading/.test(document.getElementById('sigEdgeStrip').innerText), null, { timeout: 10000 });
    st = await strip();
    check(/Total R \+0\.03R/.test(st) && !/still open/.test(st), '20 candles strip: ' + st);
    const out = await page.evaluate(() => document.getElementById('sigByOutcome').innerText.replace(/\s+/g, ' '));
    check(/Time exit\s*2\s*50%/.test(out), 'By outcome shows the time exits: ' + out);
    // % target with % Move SL: the bar and the grid switch to % (20 candles, so every alert has a result).
    await page.evaluate(() => { setSigTgt('2%'); setSigStop('mode', 'shift'); });
    st = await strip();
    const g = await page.evaluate(() => ({ head: [...document.querySelectorAll('#sigStopGrid thead th')].map(t => t.innerText).join(','), rows: [...document.querySelectorAll('#sigStopGrid tbody tr td:first-child')].map(t => t.innerText).slice(0, 3).join(','), title: document.getElementById('sigTgtCmp').innerText.includes('(in %)') }));
    check(/SL to \+0\.5% at 1%/.test(st), '% shift in the strip: ' + st);
    check(g.head === 'Move SL,1%,2%,3%' && g.rows === 'No move,BE at 0.5%,BE at 1%' && g.title, '% grid: ' + JSON.stringify(g));
    // Pure: % moves are % of entry. Long 100, stop 98 (2%): +1% = 0.5R, +0.5% = 0.25R.
    // Path: +0.6R, then +1.2R with a dip to +0.1R (under +0.25R) => out at +0.25R - 1.005 x 0.05 / 2.
    const pure = await page.evaluate(() => {
      const sig = { side: 'long', entry: 100, stop: 98 }, w = { m: 0.024, sl: 1, e: 0, done: 1, p: [[0.6, 0.6], [1.2, 0.1]], ta: -2 };
      return { p: tgtScore(sig, w, { p: 3 }, true, stopMove('pshift', 1, 0.5)), r: tgtScore(sig, w, { p: 3 }, true, stopMove('shift', 1, 0.5)) };
    });
    check(pure.p && pure.p.label === 'SL shift' && Math.abs(pure.p.r - 0.224875) < 1e-9, '% shift: ' + JSON.stringify(pure.p));
    // The same numbers in R: armed only at +1.2R, then the fall to -2R stops it at +0.5R - 1.01 x 0.05 / 2.
    check(pure.r && Math.abs(pure.r.r - 0.47475) < 1e-9, 'R shift on the same path: ' + JSON.stringify(pure.r));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals hold (till TP / SL or 20 candles) and Move SL in %: by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('hold / % move: ' + e); });
}
// Trail TP (lakky, 2026-11-07): each target reached moves the target up a step and the
// stop to the gap behind it. One long alert E, 100 / stop 99 (1% = 1R), 15m candles:
// fill (close +0.1R), 1R (low +0.5R), 1.3R (low +0.9R), a low of +0.95R, then 1.6R,
// 2.4R, 3.3R and a fall to +0.9R.
async function trailRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const t0 = Date.parse('2026-10-01T10:00:00+05:30') / 1000, Q = 900;
  const bars = { EUSD: [[t0, 100.2, 99.9, 100.1], [t0 + Q, 101, 100.5, 100.8], [t0 + 2 * Q, 101.3, 100.9, 101.2], [t0 + 3 * Q, 101.2, 100.95, 101], [t0 + 4 * Q, 101.6, 101.1, 101.5], [t0 + 5 * Q, 102.4, 101.5, 102.3], [t0 + 6 * Q, 103.3, 102.2, 103.2], [t0 + 7 * Q, 103.2, 100.9, 101]] };
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const b = bars[new URL(route.request().url()).searchParams.get('symbol')];
    if (!b) return route.abort();
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: b.map(([time, high, low, close]) => ({ time, open: close, high, low, close })) }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const strip = () => page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
  const ready = () => page.waitForFunction(() => /1 of 1 graded alerts have price data/.test(document.getElementById('sigEdgeStrip').innerText) && !/reading/.test(document.getElementById('sigEdgeStrip').innerText), null, { timeout: 10000 });
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
      state.signals = [{ id: 'e', key: 'ke', kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: 'E', side: 'long', score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: '+1R', resultR: 0.9, hasReportR: true, price: 100, stop: 99, entry: 100 }];
      delete state.ui.sigTrail; delete state.ui.sigHold;
      state.ui.sigDemo = Object.assign({}, state.ui.sigDemo || {}, { real: false });
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '1R', sigNoFee: false, sigStop: { mode: 'off' } });
      switchTab('signals'); renderAll();
    });
    await ready();
    let st = await strip();
    // Off (the default): the 1R target, +1 - 0.0826.
    const off = await page.evaluate(() => ({ cls: document.querySelector('#sigTrailBar button[data-trail="false"]').className, sel: !!document.getElementById('sigTrailStep') }));
    check(/text-amber-400/.test(off.cls) && !off.sel && /Total R \+0\.92R/.test(st) && !/Trail TP/.test(st), 'Trail TP off by default: ' + st);
    // On, +0.25R, SL 0.25R behind: 1R -> target 1.25R, stop +0.75R; 1.25R -> 1.5R, +1R;
    // the +0.95R low stops it at +1R: 1 - 1.01 x 0.05 - 0.0826 = +0.8669R.
    await page.click('#sigTrailBar button[data-trail="true"]');
    st = await strip();
    const on = await page.evaluate(() => ({ step: document.getElementById('sigTrailStep').value, gap: document.getElementById('sigTrailGap').value, unit: document.getElementById('sigTrailStep').dataset.unit, r: inSigScope(() => outcomeNow(sigView.pairs[0])) }));
    check(on.step === '0.25' && on.gap === '0.25' && on.unit === 'R', 'Trail TP selects: ' + JSON.stringify(on));
    check(/Trail TP \+0\.25R, SL 0\.25R behind/.test(st) && /Total R \+0\.87R/.test(st), 'Trail TP strip: ' + st);
    check(on.r && on.r.label === 'Trail TP' && Math.abs(on.r.r - 0.8669) < 1e-9, 'Trail TP result: ' + JSON.stringify(on.r));
    const out = await page.evaluate(() => document.getElementById('sigByOutcome').innerText.replace(/\s+/g, ' '));
    check(/Trail TP\s*1\s*100%/.test(out), 'By outcome shows Trail TP: ' + out);
    // Move SL works up to the target: triggers at or past 1R stay greyed out with Trail TP on (lakky), and read "same".
    await page.evaluate(() => setSigStop('mode', 'shift'));
    const mv = await page.evaluate(() => ({ dis: [...document.querySelectorAll('#sigStopAt option[disabled]')].map(o => o.value).join(','), warn: (document.getElementById('sigStopWarn') || {}).innerText || '', same: [...document.querySelectorAll('#sigStopGrid td')].filter(t => t.innerText === 'same').length, head: document.getElementById('sigTgtCmp').innerText.includes('Trail TP +0.25R'), r: inSigScope(() => outcomeNow(sigView.pairs[0])) }));
    check(mv.dis === '1,1.25,1.5,2,2.5,3' && /Trail TP moves it/.test(mv.warn) && mv.same > 0 && mv.head && mv.r && Math.abs(mv.r.r - 0.8669) < 1e-9, 'Move SL with Trail TP: ' + JSON.stringify(mv));
    await page.evaluate(() => setSigStop('mode', 'off'));
    // SL 0.5R behind: the TP is locked once hit (lakky), so at 1R the stop goes to +1R (not +0.5R) and the
    // +0.9R low ends it there: +0.87R again. (Without the lock it would ride to +2.75R: +2.62R.)
    await page.selectOption('#sigTrailGap', '0.5');
    st = await strip();
    check(!/still open/.test(st) && /SL 0\.5R behind, TP locked/.test(st) && /Total R \+0\.87R/.test(st), 'TP locked under a wider gap: ' + st);
    await page.selectOption('#sigTrailGap', '0.25');
    // Demo account follows: $100, 1% risk, one trade at +0.8669R after Delta's fee = $100.87.
    await page.evaluate(() => setSigSec('demo'));
    await page.waitForFunction(() => document.getElementById('sigDemoOut') && /Final balance/i.test(document.getElementById('sigDemoOut').innerText));
    const demo = await page.evaluate(() => document.getElementById('sigDemoOut').innerText.replace(/\s+/g, ' '));
    check(/\$100\.87/.test(demo), 'demo account follows Trail TP: ' + demo.slice(0, 300));
    // % target: the steps turn into %.
    await page.evaluate(() => setSigTgt('1%'));
    const pc = await page.evaluate(() => ({ unit: document.getElementById('sigTrailStep').dataset.unit, txt: document.getElementById('sigTrailStep').selectedOptions[0].innerText, strip: document.getElementById('sigEdgeStrip').innerText }));
    check(pc.unit === '%' && pc.txt === '+0.25%' && /Trail TP \+0\.25%, SL 0\.25% behind/.test(pc.strip), '% trail: ' + JSON.stringify(pc));
    // Pure checks.
    const pure = await page.evaluate(() => {
      const L = { side: 'long', entry: 100, stop: 98 }, L1 = { side: 'long', entry: 100, stop: 99 };
      // % trail on a 2% stop: 1% target = 0.5R, +0.5% = 0.25R, 0.25% = 0.125R. 0.6R -> stop 0.375R, 0.8R -> 0.625R;
      // the fall to 0.6R hits it: 0.625 - 1.0125 x 0.05 / 2 (no fees).
      const a = tgtScore(L, { m: 0.016, sl: 0, e: 0.012, done: 0, p: [[0.6, 0.6], [0.8, 0.55]], ta: 0.6 }, { p: 1 }, true, null, trailMove('%', 0.5, 0.25));
      // lakky's example: 1.5R target, +0.25R, SL 0.5R behind. 1.5R -> SL 1.5R (locked), 1.75R and 2R -> still 1.5R,
      // 2.25R -> 1.75R; the dips to 1.6R / 1.8R / 1.76R miss it, the fall to 1.7R ends it at 1.75 - 1.0175 x 0.05.
      const e = tgtScore(L1, { m: 0.023, sl: 0, e: 0.017, done: 0, p: [[1.5, 1.5], [1.75, 1.6], [2, 1.6], [2.25, 1.8], [2.3, 1.76]], ta: 1.7 }, { r: 1.5 }, true, null, trailMove('R', 0.25, 0.5));
      // Same path one step earlier: at 2R the stop is still 1.5R, so a dip to 1.55R doesn't end it.
      const e2 = tgtScore(L1, { m: 0.02, sl: 0, e: 0.017, done: 0, p: [[1.5, 1.5], [1.75, 1.6], [2, 1.6]], ta: 1.55 }, { r: 1.5 }, true, null, trailMove('R', 0.25, 0.5));
      // One candle through several steps: 3R target, best 4R -> stop 3.75R; the next low (1.9R) hits it.
      const b = tgtScore(L1, { m: 0.04, sl: 0, e: 0.02, done: 1, tr: 1, p: [[0.1, 0.1], [4, 1]], ta: 1.9 }, { r: 3 }, true, null, trailMove('R', 0.25, 0.25));
      // BE at 0.5R with Trail TP: BE is the higher stop until the target, then the stop to -1R hits BE.
      const c = tgtScore(L, { m: 0.018, sl: 1, e: 0, done: 1, p: [[0.6, 0.6], [0.9, 0.2]], ta: -1 }, { r: 1 }, true, stopMove('be', 0.5), trailMove('R', 0.25, 0.5));
      // SL shift at 1.5R (past the 1R target) never fires: 1.6R -> trail stop +1R, then the 0.9R dip ends it there.
      const d = tgtScore(L1, { m: 0.016, sl: 0, e: 0.012, done: 0, p: [[1, 1], [1.6, 0.8]], ta: 0.9 }, { r: 1 }, true, stopMove('shift', 1.5, 1.25), trailMove('R', 0.25, 0.5));
      // The walk: past 3R it goes on until a 2R fall back on a later candle.
      const sig = { side: 'long', entry: 100, stop: 99, date: '2026-10-01', time: '10:00', timeframe: '4H' }, t = Date.parse('2026-10-01T10:00:00+05:30') / 1000;
      const cs = [[0, 100.2, 99.9, 100.1], [1, 104, 101, 103.5], [2, 103.8, 102.5, 103], [3, 103, 101.9, 102]].map(([i, high, low, close]) => ({ time: t + i * 900, high, low, close }));
      const w3 = tgtWalk(sig, cs.slice(0, 3), 15, 'tp'), w4 = tgtWalk(sig, cs, 15, 'tp'), w20 = tgtWalk(sig, cs, 15, '20');
      // The path: a best held back (under 0.01R past the last) is kept once price dips after it,
      // bests round down and dips up, so 2.2496R reads 2.249 and can't reach a 2.25R level early.
      const r1 = tgtRec(0.01, 0); r1.bar(0.01, 0.005); r1.bar(0.01005, 0.009); r1.bar(0.0095, 0.0075); r1.bar(0.0102, 0.0099);
      const r2 = tgtRec(0.01, 0); r2.bar(0.022496, 0.019996);
      return { a, b, c, d, e, e2, w3: [w3.done, w3.tr], w4: [w4.done, w4.tr, w4.ta], w20: [w20.done, w20.tr], rec: JSON.stringify(r1.end()), rnd: JSON.stringify(r2.end()) };
    });
    check(pure.a && pure.a.label === 'Trail TP' && Math.abs(pure.a.r - 0.5996875) < 1e-9, '% trail: ' + JSON.stringify(pure.a));
    check(pure.e && pure.e.label === 'Trail TP' && Math.abs(pure.e.r - (1.75 - 1.0175 * 0.05)) < 1e-9 && pure.e2 === null, 'TP locked, then 0.5R behind: ' + JSON.stringify([pure.e, pure.e2]));
    check(pure.b && pure.b.label === 'Trail TP' && Math.abs(pure.b.r - 3.698125) < 1e-9, 'several steps in one candle: ' + JSON.stringify(pure.b));
    check(pure.c && pure.c.label === 'BE' && Math.abs(pure.c.r + 0.025) < 1e-9, 'BE under Trail TP: ' + JSON.stringify(pure.c));
    check(pure.d && pure.d.label === 'Trail TP' && Math.abs(pure.d.r - (1 - 1.01 * 0.05)) < 1e-9, 'SL shift past the target never fires with Trail TP: ' + JSON.stringify(pure.d));
    // Exit at: the walk's own 20-candle fill window decides, not the scanner's "no fill"
    // (lakky, 2026-11-08: BTC L4 1D of 15 Oct filled 30 Oct, the scanner said no fill).
    const fw = await page.evaluate(() => {
      const sig = { side: 'long', entry: 100, stop: 98, timeframe: '1D', date: '2026-10-15', time: '17:30', market: 'crypto', symbol: 'BTCUSD', filled: false };
      const t = Date.parse('2026-10-15T17:30:00+05:30') / 1000, d = 86400;
      const early = tgtWalk(sig, [{ time: t, high: 101, low: 100.5, close: 100.8 }], 1440, 'tp');
      const over = tgtWalk(sig, Array.from({ length: 21 }, (_, i) => ({ time: t + i * d, high: 102, low: 100.5, close: 101 })), 1440, 'tp');
      const late = tgtWalk(sig, [{ time: t, high: 101, low: 100.5, close: 100.8 }, { time: t + 15 * d, high: 100.5, low: 97, close: 97.5 }], 1440, 'tp');
      const was = state.ui.sigTgt; state.ui.sigTgt = '1.5R';
      const base = !!tgtBase({ signal: sig }), nse = !!tgtBase({ signal: Object.assign({}, sig, { market: 'NSE' }) });
      state.ui.sigTgt = ''; const off = !!tgtBase({ signal: sig }); state.ui.sigTgt = was;
      return { early, over, late: [late.sl, late.none], base, nse, off };
    });
    check(fw.early.none && fw.early.wait === 1 && fw.over.none && !fw.over.wait && fw.late[0] === 1 && !fw.late[1], 'fill window: wait while open, filled on day 15: ' + JSON.stringify(fw));
    check(fw.base && !fw.nse && !fw.off, 'Exit at walks a scanner "no fill" crypto alert, not NSE, not with Scanner: ' + JSON.stringify(fw));
    check(pure.rec === '{"p":[[1,0.5],[1.005,0.9],[1.02,0.75]],"ta":null}' && pure.rnd === '{"p":[[2.249,2]],"ta":null}', 'path kept for Trail TP: ' + pure.rec + ' ' + pure.rnd);
    check(JSON.stringify(pure.w3) === '[0,1]' && JSON.stringify(pure.w4) === '[1,1,1.9]' && pure.w20[1] === undefined, 'till TP / SL walk past 3R: ' + JSON.stringify(pure));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals Trail TP (target steps up, stop follows) in R and %: by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('trail TP: ' + e); });
}
// NSE "Exit at": the sync repo's job reads Yahoo candles (a fake one here) and writes
// nse-paths.json; the journal reads it with its sync token and re-scores NSE alerts.
// Old alerts read 15m candles for their first ~18 days (backtest 2026-11-09: on 1h-1d
// candles the pullbacks inside a candle are invisible and Trail TP read far better than
// it was). A long 100 / 99, 40 days old: 1.1R, a dip to +0.4R and 2.6R all inside one
// hour, then the stop. 15m: Trail TP (+0.25R, 0R behind) locks 1R and the dip ends it at
// +1R - 1.01 x 0.05 = +0.9495R. The same hour as one 1h candle hides the dip: +2.44875R.
async function tgtHeadRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  const day = new Date(Date.now() - 40 * 86400e3).toISOString().slice(0, 10);
  const t0 = Date.parse(day + 'T10:00:00+05:30') / 1000, Q = 900, H = 3600, h0 = t0 - 1800;
  const q = [[t0, 100.3, 99.9, 100.1], [t0 + Q, 100.3, 99.95, 100.1], [t0 + 2 * Q, 101.1, 100.6, 101], [t0 + 3 * Q, 101.05, 100.4, 100.5], [t0 + 4 * Q, 102.6, 100.5, 102.5], [t0 + 5 * Q, 102.6, 102.3, 102.5], [t0 + 6 * Q, 102.5, 98.9, 99]];
  const hr = [[h0, 100.3, 99.9, 100.1], [h0 + H, 102.6, 100.4, 102.5], [h0 + 2 * H, 102.5, 98.9, 99]];
  const reads = [];
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    const u = new URL(route.request().url()), res = u.searchParams.get('resolution'), a = +u.searchParams.get('start'), b = +u.searchParams.get('end');
    if (u.searchParams.get('symbol') === 'HEADUSD') reads.push([res, a, b]);
    const rows = (res === '15m' ? q : res === '1h' ? hr : []).filter(x => x[0] >= a && x[0] <= b);
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: rows.map(([time, high, low, close]) => ({ time, open: close, high, low, close })) }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof tgtReady !== 'undefined' && tgtReady);
    const r = await page.evaluate(async ([day, hr]) => {
      const sig = { id: 'h', key: 'kh', kind: 'trendline', date: day, time: '10:00', symbol: 'HEAD', side: 'long', score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: '+1R', resultR: 0.9, hasReportR: true, price: 100, stop: 99, entry: 100 };
      const tr = trailMove('R', 0.25, 0), sc = w => { const o = tgtScore(sig, w, { r: 1 }, true, null, tr); return o && [o.label, +o.r.toFixed(5)]; };
      const w = await tgtOne(sig, 'tp');
      const coarse = tgtWalk(sig, hr.map(([time, high, low, close]) => ({ time, high, low, close })), 60, 'tp');
      // A walk kept before the head (no fh) is read once more; one with it is kept.
      state.signals = [sig];
      Object.assign(state.ui, { sigKind: 'trendline', sigTgt: '1R', sigHold: 'tp' });
      const k = tgtHoldKey(sig, 'tp');
      tgtCache()[k] = Object.assign({}, coarse);
      await tgtLoad([{ signal: sig, trade: null }]);
      const again = tgtCache()[k];
      tgtRetry();
      await tgtLoad([{ signal: sig, trade: null }]);
      return { need: tgtNeedsHead(sig, 'tp'), needRecent: tgtNeedsHead(Object.assign({}, sig, { date: new Date().toISOString().slice(0, 10) }), 'tp'), fh: w.fh, head: sc(w), coarse: sc(coarse), again: again && again.fh === 1 && sc(again) };
    }, [day, hr]);
    check(r.need === true && r.needRecent === false, 'a 40-day window needs the 15m head, a fresh one does not: ' + JSON.stringify(r));
    check(r.fh === 1 && JSON.stringify(r.head) === '["Trail TP",0.9495]', '15m head: Trail TP ends at +1R on the dip: ' + JSON.stringify(r.head));
    check(JSON.stringify(r.coarse) === '["Trail TP",2.44875]', 'one 1h candle hides the dip: ' + JSON.stringify(r.coarse));
    check(JSON.stringify(r.again) === '["Trail TP",0.9495]', 'a walk kept without the head is read again: ' + JSON.stringify(r.again));
    // Reads: 15m from the alert, then 1h from a whole-hour cut ~18.75 days later, to now;
    // twice for tgtOne and the re-read, none for the walk already kept with the head.
    const cut = Math.floor((t0 * 1000 + 1800 * 900e3) / 3600e3) * 3600;
    const want = JSON.stringify([['15m', t0 - Q, cut], ['1h', cut]]);
    const got = JSON.stringify(reads.slice(0, 2).map((x, i) => i ? x.slice(0, 2) : x));
    check(reads.length === 4 && got === want && JSON.stringify(reads.slice(2, 4).map(x => x.slice(0, 2))) === JSON.stringify([['15m', t0 - Q], ['1h', cut]]), 'two reads per walk: ' + JSON.stringify(reads) + ' want ' + want);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'Exit at: old alerts walk 15m candles first (Trail TP not flattered by 1h-1d candles)';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

async function nsePathsRun() {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  // A 4H NSE zone alert, long 100, stop 98 (2%), sent Tue 20 Oct 2026 10:00 IST.
  // 15m candles: fills at 10:00 (close 100.2), best 103.1 (+3.1%) on 22 Oct 11:00,
  // stopped (97.9) on 27 Oct 14:00, still inside its 20 4H candles (10 NSE days).
  const alertMs = Date.parse('2026-10-20T10:00:00+05:30');
  const zone = { market: 'NSE', symbol: 'ABC.NS', side: 'long', filled: true, net_realized_r: 0.9, stop_price: 98, zone_bottom: 99, zone_top: 100, alert_time: '2026-10-20T10:00:00+05:30', timeframe: '4h', rebuild: true, news_window: false };
  const files = {
    'zone_rebuild_4h.jsonl': [zone, Object.assign({}, zone, { market: 'CRYPTO', symbol: 'BTCUSD' }), Object.assign({}, zone, { symbol: 'NOPE.NS', filled: false })].map(x => JSON.stringify(x)).join('\n'),
    'fibtl_rebuild_records.jsonl': JSON.stringify({ id: 'f1', market: 'nse', symbol: 'XYZ.NS', tf: '1d', sent_ts: alertMs / 1000, plan: { entry: 50, sl: 49, side: 'short' } }),
    'fibtl_rebuild_results.json': JSON.stringify({ f1: { filled: true, outcome: 'timeout' } })
  };
  const bars = [];
  for (let d = 20; d <= 31; d++) {
    const day = Date.parse('2026-10-' + d + 'T09:15:00+05:30'), dow = new Date(day + 5.5 * 3600e3).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (let i = 0; i < 25; i++) {
      const t = day + i * 900e3;
      let b = [100.5, 99.5, 100];
      if (t === alertMs) b = [100.3, 99.9, 100.2];
      if (t === Date.parse('2026-10-22T11:00:00+05:30')) b = [103.1, 100.5, 102];
      if (t === Date.parse('2026-10-27T14:00:00+05:30')) b = [100, 97.9, 98.5];
      bars.push([t / 1000, ...b]);
    }
  }
  let put = null, yahooAsks = [], existing = null;
  const fake = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/scanner/')) { const f = files[u.pathname.slice(9)]; res.writeHead(f ? 200 : 404); return res.end(f || ''); }
    if (u.pathname.startsWith('/v8/finance/chart/')) {
      yahooAsks.push(decodeURIComponent(u.pathname.slice(18)) + ' ' + u.searchParams.get('interval'));
      const p1 = +u.searchParams.get('period1'), p2 = +u.searchParams.get('period2'), list = decodeURIComponent(u.pathname.slice(18)) === 'ABC.NS' ? bars.filter(b => b[0] >= p1 && b[0] <= p2) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ chart: { result: [{ timestamp: list.map(b => b[0]), indicators: { quote: [{ high: list.map(b => b[1]), low: list.map(b => b[2]), close: list.map(b => b[3]) }] } }] } }));
    }
    if (u.pathname === '/repos/victus/sync/contents/nse-paths.json') {
      if (req.method === 'GET') {
        if (!existing) { res.writeHead(404); return res.end('{}'); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(/raw/.test(req.headers.accept || '') ? JSON.stringify(existing) : JSON.stringify({ sha: 'abc' }));
      }
      let body = ''; req.on('data', c => body += c); req.on('end', () => { put = JSON.parse(body); res.writeHead(201); res.end('{}'); }); return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(r => fake.listen(0, r));
  const fb = 'http://127.0.0.1:' + fake.address().port;
  Object.assign(process.env, { SCANNER_BASE: fb + '/scanner', YAHOO_BASE: fb, GITHUB_API_URL: fb, GITHUB_REPOSITORY: 'victus/sync', GITHUB_TOKEN: 'tok', JOURNAL_BRANCH: 'main' });
  let file = null;
  try {
    const tool = await import('../tools/nse-paths.mjs?' + Date.now());
    const log = console.log; console.log = () => {};
    try { await tool.main(Date.parse('2026-11-20T12:00:00Z')); } finally { console.log = log; }
    file = put && JSON.parse(Buffer.from(put.content, 'base64').toString());
    const p = file && file.paths['ABC|long|98|2026-10-20 10:00'];
    check(p && p.m === 0.031 && p.sl === 1 && p.done === 1, 'ABC walked: ' + JSON.stringify(file && file.paths));
    const pt = file && file.paths['ABC|long|98|2026-10-20 10:00|tp'];
    check(pt && pt.sl === 1 && pt.done === 1 && pt.tr === 1 && JSON.stringify(pt.p) === JSON.stringify(p.p), 'ABC till TP / SL walk (stopped inside the window, same path, walked for Trail TP): ' + JSON.stringify(pt));
    // Move SL's path: fill close +0.1R, +0.25R (dip -0.25R), +1.55R, then stopped at -1.05R.
    check(p && JSON.stringify(p.p) === '[[0.1,0.1],[0.25,-0.25],[1.55,-0.25]]' && p.ta === -1.05, 'ABC path for Move SL: ' + JSON.stringify(p));
    // A summary kept before Move SL (no path) is walked again on the next run.
    existing = { v: 1, paths: { 'ABC|long|98|2026-10-20 10:00': { m: 0.031, sl: 1, e: 0, done: 1 } } }; put = null; yahooAsks = [];
    const log2 = console.log; console.log = () => {};
    try { await tool.main(Date.parse('2026-11-20T12:00:00Z')); } finally { console.log = log2; }
    const again = put && JSON.parse(Buffer.from(put.content, 'base64').toString()).paths['ABC|long|98|2026-10-20 10:00'];
    check(again && Array.isArray(again.p) && again.p.length === 3 && put.sha === 'abc', 'old NSE summary walked again: ' + JSON.stringify(again));
    // A "till TP / SL" summary kept before Trail TP (no tr) is walked again too.
    existing = { v: 1, paths: { 'ABC|long|98|2026-10-20 10:00': p, 'ABC|long|98|2026-10-20 10:00|tp': { m: 0.06, sl: 0, e: 0.06, done: 1, p: [[3, 0.1]], ta: 2.9 } } }; put = null; yahooAsks = [];
    console.log = () => {};
    try { await tool.main(Date.parse('2026-11-20T12:00:00Z')); } finally { console.log = log2; }
    const againTp = put && JSON.parse(Buffer.from(put.content, 'base64').toString()).paths['ABC|long|98|2026-10-20 10:00|tp'];
    check(againTp && againTp.tr === 1 && againTp.sl === 1 && yahooAsks.length === 1, 'old till TP / SL summary walked again for Trail TP: ' + JSON.stringify(againTp));
    existing = null;
    check(file && JSON.stringify(Object.keys(file.paths)) === '["ABC|long|98|2026-10-20 10:00","ABC|long|98|2026-10-20 10:00|tp"]', 'only graded NSE alerts (no crypto, no unfilled, no timeout), both holds: ' + JSON.stringify(file && Object.keys(file.paths)));
    check(JSON.stringify(yahooAsks) === '["ABC.NS 15m"]', 'one 15m read for the one symbol: ' + JSON.stringify(yahooAsks));
    // Window: 20 NSE 4H candles after the fill. A stop on the 11th trading day is outside it.
    const w = tool.walkAlert({ side: 'long', entry: 100, stop: 98, alertMs, tf: '4h' }, bars.map(b => ({ t: b[0] * 1000, h: b[1], l: b[0] * 1000 >= Date.parse('2026-10-27T09:15:00+05:30') ? 100 : b[2], c: b[3] })).concat(['2026-11-02T09:15', '2026-11-02T13:15', '2026-11-03T09:15'].map(x => ({ t: Date.parse(x + ':00+05:30'), h: 100.4, l: x.endsWith('03T09:15') ? 90 : 99.8, c: 100.1 }))), 15);
    check(w && w.sl === 0 && w.done === 1 && w.e === 0.001, 'stop after 20 NSE candles is outside the window: ' + JSON.stringify(w));
    const wTp = tool.walkAlert({ side: 'long', entry: 100, stop: 98, alertMs, tf: '4h' }, bars.map(b => ({ t: b[0] * 1000, h: b[1], l: b[0] * 1000 >= Date.parse('2026-10-27T09:15:00+05:30') ? 100 : b[2], c: b[3] })).concat(['2026-11-02T09:15', '2026-11-02T13:15', '2026-11-03T09:15'].map(x => ({ t: Date.parse(x + ':00+05:30'), h: 100.4, l: x.endsWith('03T09:15') ? 90 : 99.8, c: 100.1 }))), 15, 'tp');
    check(wTp && wTp.sl === 1 && wTp.done === 1, 'till TP / SL: the same stop on the 11th day counts: ' + JSON.stringify(wTp));
    // Long 100, stop 99 (1%): past the biggest target (3R / 3%) the walk goes on until price falls back
    // 2R / 2% (the biggest Trail TP step + gap) from its best on a later candle.
    const tw = extra => tool.walkAlert({ side: 'long', entry: 100, stop: 99, alertMs, tf: '4h' }, [[0, 100.2, 99.9, 100.1], [1, 104, 101, 103.5], [2, 103.8, 102.5, 103]].concat(extra).map(([i, h, l, c]) => ({ t: alertMs + i * 900e3, h, l, c })), 15, 'tp');
    const twOpen = tw([]), twDone = tw([[3, 103, 101.9, 102]]);
    check(twOpen && twOpen.done === 0 && twOpen.tr === 1 && twDone && twDone.done === 1 && twDone.tr === 1 && twDone.ta === 1.9, 'NSE till TP / SL past 3R: open until a 2R fall back: ' + JSON.stringify([twOpen, twDone]));
    check(tool.tfBucket(Date.parse('2026-10-20T13:14:00+05:30'), 240) !== tool.tfBucket(Date.parse('2026-10-20T13:15:00+05:30'), 240), 'NSE 4H candle turns at 13:15');
  } catch (e) { errs.push('tool threw: ' + e.message); }
  fake.close();

  // The journal side: same alert, its summary read from the sync repo.
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  let reads = 0;
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.github.com/'), r => r.abort());
  await ctx.route('https://api.github.com/**', route => {
    if (/\/repos\/victus\/sync\/contents\/nse-paths\.json/.test(route.request().url())) { reads++; return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify(file || {}) }); }
    return route.fulfill({ status: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.evaluate(() => {
      state.signals = [{ id: 'n1', key: 'nk1', date: '2026-10-20', time: '10:00', symbol: 'ABC', side: 'long', score: '', market: 'NSE', timeframe: '4h', channel: 'NSE 4h', filled: true, outcome: '+1R', resultR: 0.9, price: 100, stop: 98, zoneLow: 99, zoneHigh: 100, srcRank: 3 }];
      state.sync = { token: 'tok', repo: 'victus/sync', branch: 'main', auto: false, lastAt: '', lastSha: '' };
      Object.assign(state.ui, { sigKind: 'zone', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '1R', sigNoFee: false });
      switchTab('signals'); renderAll();
    });
    await page.waitForFunction(() => /1 of 1 graded alerts have price data/.test(document.getElementById('sigTgtCmp').innerText), null, { timeout: 10000 });
    const rows = await page.$$eval('#sigTgtCmp > div > table tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    // NSE fee 0.1063% on a 2% stop = 0.0532R; stop = -1 - 0.98*0.05/2 - 0.0532 = -1.0777R
    const has = (k, t) => check(rows.some(r => r.startsWith(k + ' ') && r.includes(t)), k + ' row should show ' + t + ': ' + JSON.stringify(rows));
    has('1R', '+0.95R'); has('1.5R', '+1.45R'); has('2R', '-1.08R'); has('3R', '-1.08R'); has('1%', '+0.45R'); has('3%', '+1.45R');
    check(reads === 1, 'nse-paths.json read once: ' + reads);
    // BE at 1R: armed at +1.55R, back through entry before 2R: 0 - 0.05/2 - 0.0532 = -0.08R.
    await page.evaluate(() => { state.ui.sigStop = { mode: 'be', beAt: 1 }; renderSignalsTable(); });
    const rowsBe = await page.$$eval('#sigTgtCmp > div > table tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    check(rowsBe.some(r => r.startsWith('2R ') && r.includes('-0.08R')) && rowsBe.some(r => r.startsWith('1R ') && r.includes('+0.95R')), 'NSE with BE at 1R: ' + JSON.stringify(rowsBe));
    await page.evaluate(() => { state.ui.sigStop = { mode: 'off' }; renderSignalsTable(); });
    const strip = await page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
    check(/Total R \+0\.95R/.test(strip) && !/NSE without prices/.test(strip), 'NSE strip at 1R: ' + strip);
    // No sync: says how to get NSE prices.
    await page.evaluate(() => { state.sync = null; nsePaths = null; renderSignalsTable(); });
    const off = await page.evaluate(() => document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '));
    check(/1 NSE without prices: turn on GitHub sync/.test(off), 'no-sync note: ' + off);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'NSE exit at: Yahoo job + journal re-score, by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('nse paths: ' + e); });
}
// Alerts live in IndexedDB. An older build's alerts in localStorage (4.2 MB,
// enough to trip the 80% warning) move across on first open, leave
// localStorage, clear the warning and survive a reload and a new alert.
async function sigStoreRun(seed) {
  const errs = [];
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  const sigs = [];
  for (let i = 0; i < 2600; i++) sigs.push({ id: 'old' + i, date: '2026-10-' + String(1 + i % 28).padStart(2, '0'), time: '10:00', side: i % 2 ? 'long' : 'short', symbol: 'BTC', price: 60000 + i, stop: 59000, channel: 'fib', kind: 'fib', note: 'x'.repeat(1500) });
  await ctx.addInitScript(([s, g]) => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); localStorage.setItem('tapeAndTarget.signals', g); sessionStorage.setItem('seeded', '1'); } }, [JSON.stringify(seed), JSON.stringify(sigs)]);
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  page.on('dialog', d => d.dismiss());
  await page.goto(base, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  const idbCount = () => page.evaluate(() => idbGet(SIG_KEY).then(v => JSON.parse(v || '[]').length));
  const a = await page.evaluate(() => ({ n: state.signals.length, ls: localStorage.getItem(SIG_KEY), warn: !document.getElementById('storageWarn').classList.contains('hidden'), line: document.getElementById('storageUsage').innerText, trades: state.trades.length }));
  if (a.n !== sigs.length) errs.push('expected ' + sigs.length + ' alerts after migration, found ' + a.n);
  if (a.ls !== null) errs.push('old localStorage alerts copy should be removed after the move');
  if (a.warn) errs.push('storage warning should clear once alerts are in IndexedDB');
  if (!/separate, much larger store/.test(a.line)) errs.push('storage line should say alerts are kept separately: ' + a.line);
  if (a.trades !== seed.trades.length) errs.push('trades changed during the move: ' + a.trades);
  if (await idbCount() !== sigs.length) errs.push('IndexedDB should hold every alert');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => state.signals.length);
  if (b !== sigs.length) errs.push('after reload expected ' + sigs.length + ' alerts, found ' + b);
  await page.evaluate(() => { state.signals = state.signals.concat([{ id: 'new1', date: '2026-10-31', time: '11:00', side: 'long', symbol: 'ETH', price: 3000, stop: 2950, channel: 'fib', kind: 'fib' }]); save(); });
  await page.waitForTimeout(800);
  if (await idbCount() !== sigs.length + 1) errs.push('a new alert should be saved to IndexedDB');
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(1500);
  const c = await page.evaluate(() => ({ n: state.signals.length, has: state.signals.some(g => g.id === 'new1'), ls: localStorage.getItem(SIG_KEY) }));
  if (c.n !== sigs.length + 1 || !c.has) errs.push('new alert lost after reload: ' + JSON.stringify({ n: c.n, has: c.has }));
  if (c.ls !== null) errs.push('alerts were written back to localStorage');
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'alerts stored in IndexedDB');
  errs.forEach(e => { console.log('     ' + e); failures.push('alert store: ' + e); });
}
function thinkingShown(s) { return /(^|\n)thinking/.test(s); }

// Weekly audit, 2026-11-01: typos and odd input are turned away with a reason
// instead of breaking totals, the layout or the goal.
async function badInputRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  let confirms = 0;
  page.on('dialog', d => { confirms++; d.dismiss(); });
  const lastToast = () => page.evaluate(() => { const c = document.getElementById('toastContainer'); return c && c.lastElementChild ? c.lastElementChild.innerText : ''; });
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.evaluate(() => state.accounts.forEach(a => { a.maxTradesPerDay = 0; a.dailyLossLimit = 0; }));
    const log = async f => {
      await page.evaluate(() => openTrade(null));
      await page.waitForSelector('#modalSheet:not(.hidden)');
      for (const [k, v] of Object.entries(f)) await page.fill('#' + k, v);
      const n0 = await page.evaluate(() => state.trades.length);
      await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(100);
      const r = { saved: await page.evaluate(n0 => state.trades.length > n0, n0), toast: await lastToast() };
      await page.evaluate(() => closeModalSheet());
      return r;
    };
    const huge = await log({ mSymbol: 'ETHUSD', mEntry: '1e300', mExit: '1e301', mQty: '1e10' });
    check(!huge.saved && /too big/.test(huge.toast), 'huge numbers saved: ' + JSON.stringify(huge));
    const future = await log({ mSymbol: 'ETHUSD', mDate: '2099-01-01', mEntry: '100', mExit: '110', mQty: '1' });
    check(!future.saved && /between 2000 and today/.test(future.toast), '2099 trade saved: ' + JSON.stringify(future));
    const old = await log({ mSymbol: 'ETHUSD', mDate: '1970-01-01', mEntry: '100', mExit: '110', mQty: '1' });
    check(!old.saved, '1970 trade saved');
    const long = await log({ mSymbol: 'X'.repeat(500), mEntry: '100', mExit: '110', mQty: '1' });
    const sym = await page.evaluate(() => Math.max(...state.trades.map(t => t.symbol.length)));
    check(long.saved && sym <= 30, 'long symbol: ' + JSON.stringify({ long, sym }));
    await page.evaluate(() => { switchTab('analysis'); renderAnalysis(); });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(wide <= 1, 'long symbol widens Analysis by ' + wide);
    // A record from a backup or GitHub that would overflow is dropped on load.
    const dropped = await page.evaluate(() => sanitizeState({ trades: [{ id: 'big', date: '2026-10-01', direction: 'long', entry: 1e300, exit: 1e301, qty: 1e10 }] }).trades.length);
    check(dropped === 0, 'overflowing trade kept by the loader');
    // Withdrawals: dated today's trading day, no future dates, more than the balance asks first.
    await page.evaluate(() => { switchTab('dashboard'); openWithdraw(); });
    const def = await page.evaluate(() => [document.getElementById('wdDate').value, todayDay()]);
    check(def[0] === def[1], 'withdrawal date not the trading day: ' + def);
    await page.selectOption('#wdAcc', 'acc_cry'); await page.fill('#wdAmt', '10'); await page.fill('#wdDate', '2099-05-05');
    await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(100);
    check(await page.evaluate(() => (state.withdrawals || []).length) === 0 && /between 2000 and today/.test(await lastToast()), 'future withdrawal saved');
    await page.fill('#wdDate', def[1]); await page.fill('#wdAmt', '99999999');
    await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(100);
    check(confirms === 1 && await page.evaluate(() => (state.withdrawals || []).length) === 0, 'withdrawal over the balance not questioned: ' + confirms);
    await page.evaluate(() => closeModalSheet());
    // Signals: a custom range picked backwards shows the same alerts as forwards.
    const rng = await page.evaluate(() => { state.ui.sigPeriod = { mode: 'custom', from: '2026-10-30', to: '2026-10-01' }; const a = sigPeriodRange(); state.ui.sigPeriod = { mode: 'custom', from: '2026-10-01', to: '2026-10-30' }; return [a, sigPeriodRange()]; });
    check(JSON.stringify(rng[0]) === JSON.stringify(rng[1]), 'backwards custom range: ' + JSON.stringify(rng));
    // Goal: a ticked target left empty is pointed out, not silently dropped.
    await page.evaluate(() => openGoal('new'));
    await page.waitForSelector('#modalSheet:not(.hidden)');
    await page.fill('#gv_net_pnl', '');
    const g0 = await page.evaluate(() => state.goals.length);
    await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(100);
    check(await page.evaluate(() => state.goals.length) === g0 && /Profit: enter a number above 0/.test(await lastToast()), 'empty goal target accepted');
    await page.evaluate(() => closeModalSheet());
    // Book rules: risk is a % of the balance, so 500% is a typo.
    await page.evaluate(() => { switchTab('data'); openBookEditor('acc_cry'); });
    await page.waitForSelector('#modalSheet:not(.hidden)');
    await page.fill('#bkRisk', '500');
    await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(100);
    check(await page.evaluate(() => acct('acc_cry').maxRiskPct) === 1.5 && /100 at most/.test(await lastToast()), 'risk 500% saved');
    await page.fill('#bkRisk', '2'); await page.fill('#bkTrades', '0.4');
    await page.click('#modalSheetSaveBtn'); await page.waitForTimeout(100);
    check(await page.evaluate(() => acct('acc_cry').maxTradesPerDay) === 0 && /1 or more/.test(await lastToast()), '0.4 trades a day saved');
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'bad input: huge numbers, odd dates, long symbols, withdrawals, ranges, goals, book rules';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Signals breakdown cards: they stack in balanced columns with no hole under a short
// one, every group is one row, a long symbol list keeps its best and worst rows, a
// one-group breakdown folds into a line, and the numbers are checked by hand.
async function sigBreakdownRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, timezoneId: 'Asia/Kolkata' });
  await ctx.route(url => !url.href.startsWith(base), r => r.abort());
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  const open = sigs => page.evaluate(list => {
    state.signals = list;
    Object.assign(state.ui, { sigKind: 'zone', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '', sigNoFee: false, sigSkipTiny: false });
    switchTab('signals'); renderAll();
  }, sigs);
  const look = () => page.evaluate(() => {
    const grid = document.getElementById('sigBdGrid');
    const cols = Array.from(grid.querySelectorAll(':scope > .bd-col'));
    const shown = Array.from(grid.querySelectorAll('.bd-card')).filter(c => !c.classList.contains('hidden'));
    const rowsOf = id => Array.from(document.querySelectorAll('#' + id + ' .sb-row:not(.hd)')).map(r => r.innerText.replace(/\s+/g, ' ').trim());
    return {
      cols: cols.length, colH: cols.map(c => Math.round(c.getBoundingClientRect().height)),
      first: cols.map(c => { const k = c.querySelector('.bd-card:not(.hidden) h3'); return k ? k.innerText : ''; }),
      shown: shown.map(c => c.querySelector('h3').innerText),
      top: document.getElementById('sigBdTop').innerText.replace(/\s+/g, ' ').trim(),
      rowH: Math.max(...Array.from(document.querySelectorAll('#sigBdGrid .sb-row')).map(r => r.getBoundingClientRect().height)),
      sym: rowsOf('sigBySymbol'), score: rowsOf('sigByScore'), more: (document.querySelector('#sigBySymbol .sb-more') || {}).innerText || '',
      note: document.querySelector('#sigBySymbol').parentElement.querySelector('.bd-note').innerText,
      totShown: getComputedStyle(document.querySelector('#sigByOutcome .sb-row:not(.hd) .sb-tot')).display !== 'none',
      barShown: getComputedStyle(document.querySelector('#sigByOutcome .sb-row:not(.hd) .sb-bar')).display !== 'none',
      tip: (document.querySelector('#sigBySymbol .sb-row:not(.hd)') || {}).title || '',
      wide: Math.max(...shown.map(c => c.scrollWidth - c.clientWidth)),
      pageWide: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });
  try {
    await page.goto(base, { waitUntil: 'load' });
    // 18 symbols, two channels, one timeframe, scores 6-8. AAAUSD: +1.9R and -1.08R on
    // 1% stops = 2 alerts, 50% won, total +0.82R, average +0.41R and +0.41%.
    const sigs = [];
    const add = (i, sym, r, score, chan) => sigs.push({ id: 'b' + i, key: 'kb' + i, kind: 'zone', date: '2026-10-' + String(1 + i % 28).padStart(2, '0'), time: String(9 + i % 12).padStart(2, '0') + ':15',
      symbol: sym, side: 'long', score: String(score), market: 'CRYPTO', timeframe: '4H', channel: chan, filled: true, outcome: r > 0 ? '+2R' : 'SL', resultR: r, hasReportR: true, price: 100, entry: 100, stop: 99 });
    add(0, 'AAAUSD', 1.9, 8, 'CRYPTO 4H'); add(1, 'AAAUSD', -1.08, 8, 'CRYPTO 4H');
    for (let i = 2; i < 36; i++) add(i, 'S' + String((i % 17) + 1).padStart(2, '0') + 'USD', [1.9, -1.08, -1.08, 0.9][i % 4] * (1 + (i % 5) / 10), 6 + i % 3, i % 3 ? 'CRYPTO 4H' : 'CRYPTO 1D');
    await open(sigs);
    await page.waitForTimeout(150);
    let v = await look();
    check(v.cols === 3, 'three columns at 1600px: ' + v.cols);
    check(v.first[0] === 'By outcome', 'first card starts the first column: ' + JSON.stringify(v.first));
    const tallest = Math.max(...v.colH), shortest = Math.min(...v.colH);
    check(tallest - shortest < 140, 'columns end close together: ' + JSON.stringify(v.colH));
    check(!v.shown.includes('By timeframe') && /Same for all 36 graded alerts/.test(v.top) && /Timeframe 4H/.test(v.top), 'one-group timeframe folds into the line: ' + v.top + ' / ' + v.shown.join(', '));
    check(v.shown.includes('By signal score') && v.score.map(r => r.split(' ').slice(0, 2).join(' ')).join(',') === 'Score 8,Score 7,Score 6', 'scores in order: ' + JSON.stringify(v.score));
    check(v.rowH < 36, 'each group is one short row: ' + v.rowH);
    check(v.totShown && v.barShown, 'a wide card shows the total and the bar');
    check(v.sym.length === 12 && v.more === 'Show 6 more' && v.note === '18 symbols', 'long symbol list cut to 12: ' + v.sym.length + ' ' + v.more + ' ' + v.note);
    const tot = r => parseFloat(r.split(' ')[3]);
    check(/alerts · \d+% won · total [+-]\d+\.\d+R \([+-]\d+\.\d+%\) · average/.test(v.tip), 'row tooltip has the full figures: ' + v.tip);
    check(v.wide <= 0, 'nothing spills out of a card: ' + v.wide);
    // Show all, then back: the cards are laid out again.
    const cut = v.sym.map(tot);
    await page.click('#sigBySymbol .sb-more');
    v = await look();
    check(v.sym.length === 18 && v.more === 'Show less' && v.cols === 3, 'show all symbols: ' + v.sym.length + ' ' + v.more);
    const all = v.sym.map(tot);
    check(all.every((x, i) => !i || all[i - 1] >= x) && JSON.stringify(cut) === JSON.stringify(all.slice(0, 6).concat(all.slice(12))), 'the cut list is the 6 best and 6 worst: ' + cut.join(',') + ' / ' + all.join(','));
    const aaa = v.sym.find(r => r.startsWith('AAAUSD'));
    check(aaa === 'AAAUSD 2 50% +0.82R +0.41R +0.41%', 'AAAUSD by hand: ' + aaa);
    await page.click('#sigBySymbol .sb-more');
    v = await look();
    check(v.sym.length === 12 && v.more === 'Show 6 more', 'back to 12: ' + v.sym.length);
    // Laptop and phone widths: fewer columns, the bar and then the total drop out.
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.waitForTimeout(150);
    v = await look();
    check(v.cols === 3 && v.totShown && !v.barShown, '1366px: 3 columns, total kept, bar dropped: ' + JSON.stringify([v.cols, v.totShown, v.barShown]));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    v = await look();
    check(v.cols === 1 && !v.totShown && !v.barShown && v.wide <= 0 && v.pageWide <= 0, 'phone: one column, no sideways scroll: ' + JSON.stringify([v.cols, v.totShown, v.wide, v.pageWide]));
    await page.click('#sigBySymbol .sb-more');
    v = await look();
    check(v.sym.includes('AAAUSD 2 50% +0.41R +0.41%'), 'phone row: ' + v.sym.find(r => r.startsWith('AAA')));
    // Drawn while the tab is hidden, laid out once it shows.
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.evaluate(() => { switchTab('dashboard'); renderAll(); });
    await page.evaluate(() => switchTab('signals'));
    await page.waitForTimeout(150);
    v = await look();
    check(v.cols === 3 && v.colH.every(h => h > 100), 'laid out after the tab shows again: ' + JSON.stringify(v.colH));
    // No graded alert: one note, not eight empty cards.
    await open(sigs.map(g => Object.assign({}, g, { filled: undefined, resultR: undefined, hasReportR: false, outcome: '' })));
    await page.waitForTimeout(100);
    v = await page.evaluate(() => ({ shown: document.querySelectorAll('#sigBdGrid .bd-card:not(.hidden)').length, top: document.getElementById('sigBdTop').innerText }));
    check(v.shown === 0 && /can be measured/.test(v.top), 'no graded alert: one note: ' + JSON.stringify(v));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'Signals breakdowns: balanced columns, one row per group, best and worst symbols, by hand';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Nifty options: a Nifty entry and stop turn into the CALL or PUT to buy, its strike,
// expiry and lots. Every premium, lot count and loss is worked out again here by hand,
// with a Black-Scholes written separately (its normal curve integrated numerically).
async function optionsRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const pdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const cdf = x => { const n = 4000, a = 0, h = (x - a) / n; let t = pdf(a) + pdf(x); for (let i = 1; i < n; i++) t += (i % 2 ? 4 : 2) * pdf(a + i * h); return 0.5 + t * h / 3; };
  const bs = (call, S, K, T, v, r = 0.065) => { const d1 = (Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)), d2 = d1 - v * Math.sqrt(T); return call ? S * cdf(d1) - K * Math.exp(-r * T) * cdf(d2) : K * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1); };
  const buyCost = (q, b, brok = 20) => { const t = q * b, x = t * (0.0003553 + 1e-6); return t + brok + x + t * 0.00003 + 0.18 * (brok + x); };
  const delta = (S, K, T, v, r = 0.065) => cdf((Math.log(S / K) + (r + v * v / 2) * T) / (v * Math.sqrt(T)));
  const fees = (q, b, sl, brok = 20) => { const buy = q * b, sell = q * sl, txn = (buy + sell) * 0.0003553, sebi = (buy + sell) * 1e-6; return 2 * brok + sell * 0.0015 + txn + sebi + buy * 0.00003 + 0.18 * (2 * brok + txn + sebi); };
  const rupees = t => Number(String(t).replace(/[^\d.-]/g, ''));
  // Friday 6 Nov 2026, 11:43 IST. Tue 10 Nov and Tue 24 Nov are NSE holidays.
  const NOW = Date.parse('2026-11-06T06:13:00Z');
  const YR = 365 * 864e5;
  for (const vp of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push(vp.width + 'px page error: ' + (e.stack || e.message)));
    await page.clock.setFixedTime(new Date(NOW));
    const w = vp.width + 'px ';
    try {
      await page.goto(base, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      await page.click('#accountsBar button[data-cur="INR"]');
      await page.evaluate(() => switchTab('calculator'));
      await page.locator('#calcViewSeg button', { hasText: 'Nifty options' }).click();
      check(await page.isVisible('#optCard') && !(await page.isVisible('#quickSizeCard')), w + 'Nifty options tab did not open its card');
      // Before any level: it says what CE and PE mean.
      check(/CALL \(CE\)/.test(await page.innerText('#optOut')) && /PUT \(PE\)/.test(await page.innerText('#optOut')), w + 'empty card does not explain CE / PE');
      // The expiry list: Tuesdays, holiday weeks a day early, monthlies marked.
      const exps = await page.$$eval('#optExp option', o => o.map(x => x.value + '|' + x.textContent));
      check(exps.some(x => x.startsWith('2026-11-09|') && /Tue holiday/.test(x)) && exps.some(x => x.startsWith('2026-11-17|'))
        && exps.some(x => x.startsWith('2026-11-23|') && /monthly/.test(x) && /Tue holiday/.test(x)) && exps.some(x => x.startsWith('2026-12-29|') && /monthly/.test(x))
        && !exps.some(x => /^2026-11-(10|24)\|/.test(x)), w + 'expiries: ' + JSON.stringify(exps));
      // A 4H long from the test NSE book's balance: 25,600 entry, 25,450 stop, ₹10,000 risk.
      await page.fill('#optEntry', '25600'); await page.fill('#optSl', '25450'); await page.fill('#optRisk', '10000');
      await page.waitForTimeout(100);
      const T = (Date.parse('2026-11-17T10:00:00Z') - NOW) / YR, Th = T - 1 / 365;
      const buy = await page.innerText('#optBuy');
      check(/^BUY NIFTY 25,600 CE · Tue 17 Nov$/.test(buy), w + '4H long picks ' + buy + ' (want 25,600 CE, 17 Nov: the first expiry 5+ days out)');
      // By hand: premium at entry, at the stop (now) and at the target (after a day), lots inside ₹10,000.
      const p0 = bs(true, 25600, 25600, T, 0.14), pSl = bs(true, 25450, 25600, T, 0.14), pT = bs(true, 25750, 25600, Th, 0.14);
      const loss = n => n * 65 * (p0 - pSl) + fees(n * 65, p0, pSl);
      let lots = 0; while (loss(lots + 1) <= 10000) lots++;
      const gain = lots * 65 * (pT - p0) - fees(lots * 65, p0, pT);
      const shown = await page.evaluate(() => ({ cost: document.getElementById('optCost').innerText, loss: document.getElementById('optLoss').innerText, gain: document.getElementById('optGain').innerText, out: document.getElementById('optOut').innerText }));
      const prem = rupees(/premium about (₹[\d,.]+)/.exec(shown.out)[1]);
      check(Math.abs(prem - p0) < 0.01 && lots === 2 && new RegExp('\\b' + lots + ' lots = 130 qty').test(shown.out), w + 'premium ' + prem + ' vs ' + p0.toFixed(2) + ' by hand, lots ' + lots + ': ' + shown.out.slice(0, 200));
      check(Math.abs(rupees(shown.cost) - buyCost(lots * 65, p0)) <= 0.5 && Math.abs(rupees(shown.loss) + loss(lots)) <= 0.5 && Math.abs(rupees(shown.gain) - gain) <= 0.5,
        w + 'cost/loss/gain ' + JSON.stringify([shown.cost, shown.loss, shown.gain]) + ' vs ' + [buyCost(lots * 65, p0), -loss(lots), gain].map(x => x.toFixed(0)));
      // Account size: a bought option costs its whole premium, so the lots are also capped by what
      // the account pays for. ₹30,000 buys 1 lot of the ATM (₹17,969 a lot), though the risk allows 2.
      await page.fill('#optCap', '30000');
      const capAtm = Math.floor(30000 / buyCost(65, p0));
      const a30 = await page.evaluate(() => ({ out: document.getElementById('optOut').innerText, rows: [...document.querySelectorAll('#optTable tbody tr')].map(r => ({ k: r.cells[0].innerText.split('\n')[0].replace(/ pick$/, ''), lots: r.cells[3].innerText.replace(/\s+/g, ' ') })) }));
      const atmRow = a30.rows.find(r => r.k === '25,600 CE');
      check(capAtm === 1 && atmRow && atmRow.lots === '1 acct 1' && /Account ₹30,000: 1 lot of 25,\d{3} CE costs ₹[\d,]+, so it pays for \d+ lots?; your risk allows \d+\./.test(a30.out),
        w + 'account ₹30,000: ' + JSON.stringify(atmRow) + ' ' + a30.out.slice(0, 300));
      // The pick's lots, by hand: the smaller of what ₹30,000 pays for and what ₹10,000 of risk allows.
      const pk30 = Number(/NIFTY ([\d,]+) CE/.exec(await page.innerText('#optBuy'))[1].replace(/,/g, ''));
      const q0 = bs(true, 25600, pk30, T, 0.14), qSl = bs(true, 25450, pk30, T, 0.14);
      let capL = 0; while (buyCost((capL + 1) * 65, q0) <= 30000) capL++;
      let riskL = 0; while ((riskL + 1) * 65 * (q0 - qSl) + fees((riskL + 1) * 65, q0, qSl) <= 10000) riskL++;
      const want30 = Math.min(capL, riskL), pickCost = rupees(await page.innerText('#optCost'));
      check(want30 >= 1 && new RegExp('\\b' + want30 + (want30 === 1 ? ' lot' : ' lots') + ' = ' + want30 * 65 + ' qty').test(a30.out) && Math.abs(pickCost - buyCost(want30 * 65, q0)) <= 0.5 && pickCost <= 30000,
        w + pk30 + ' CE with ₹30,000: want ' + want30 + ' lots (account ' + capL + ', risk ' + riskL + '), cost ' + pickCost);
      // ₹5,000 can't pay for a lot near the money: the nearest strike it can (delta 0.15+), by hand.
      await page.fill('#optCap', '5000');
      let far = null;
      for (let o = 4; o <= 40 && !far; o++) { const K = 25600 + 50 * o; if (delta(25600, K, T, 0.14) < 0.15) break; if (buyCost(65, bs(true, 25600, K, T, 0.14)) <= 5000) far = K; }
      const o5 = await page.innerText('#optOut');
      check(far && (await page.innerText('#optBuy')).includes(far.toLocaleString('en-IN') + ' CE') && /Strikes nearer the money cost more than your account/.test(o5),
        w + 'account ₹5,000 should point to ' + far + ' CE: ' + await page.innerText('#optBuy'));
      // ₹500 pays for nothing worth buying: says so, no BUY.
      await page.fill('#optCap', '500');
      check(!/^BUY/.test(await page.innerText('#optBuy')) && /Your ₹500 account can't pay for 1 lot/.test(await page.innerText('#optOut')), w + 'account ₹500 not flagged: ' + (await page.innerText('#optOut')).slice(0, 160));
      // Risk from the account: 2% of ₹2,00,000 = ₹4,000 when no amount is typed.
      await page.fill('#optRisk', ''); await page.fill('#optCap', '200000'); await page.selectOption('#optRiskPct', '2');
      check(await page.getAttribute('#optRisk', 'placeholder') === 'auto ₹4,000' && /Risk ₹4,000: 2% of the account\./.test(await page.innerText('#optOut')), w + 'risk % of account: ' + await page.getAttribute('#optRisk', 'placeholder'));
      await page.fill('#optCap', '-5');
      check(/Account size -5 looks wrong; not used/.test(await page.innerText('#optOut')), w + 'negative account not refused');
      await page.fill('#optCap', ''); await page.selectOption('#optRiskPct', '1'); await page.fill('#optRisk', '10000');
      check(loss(lots) <= 10000 && loss(lots + 1) > 10000, w + 'lots do not fill the risk');
      // A 2R target moves the target price and the profit; a typed level wins over R.
      await page.selectOption('#optTgtR', '2');
      check((await page.innerText('#optGain')) !== shown.gain && /Nifty 25,900, 2R/.test(await page.innerText('#optOut')), w + '2R target not used');
      await page.fill('#optTarget', '25800');
      check(/Nifty 25,800\)/.test(await page.innerText('#optOut')), w + 'typed target not used');
      // Tap another strike, then back to auto.
      await page.click('#optTable tr[data-off="1"]');
      check(/^BUY NIFTY 25,650 CE/.test(await page.innerText('#optBuy')) && /Picked by you/.test(await page.innerText('#optOut')), w + 'tapping OTM 1 did not pick it');
      await page.locator('#optOut button', { hasText: 'Back to auto' }).click();
      check(/^BUY NIFTY 25,600 CE/.test(await page.innerText('#optBuy')), w + 'back to auto did not restore the pick');
      // A stop above the entry is a PUT; the strikes run down from the money.
      await page.fill('#optTarget', ''); await page.selectOption('#optTgtR', '1');
      await page.fill('#optSl', '25700');
      check(/^BUY NIFTY 25,\d{3} PE · Tue 17 Nov$/.test(await page.innerText('#optBuy')) && /Nifty down: buy a PUT/.test(await page.innerText('#optOut')), w + 'short did not give a PUT: ' + await page.innerText('#optBuy'));
      const peRows = await page.$$eval('#optTable tbody tr', r => r.map(x => x.cells[0].innerText.split('\n')[0].replace(/ pick$/, '')));
      check(peRows[0] === '25,700 PE' && peRows[2] === '25,600 PE' && peRows[5] === '25,450 PE', w + 'PE strikes: ' + JSON.stringify(peRows));
      // The app's price for the shown strike sets the volatility: that strike then shows exactly that price.
      const lbl = await page.innerText('#optCalLbl');
      await page.fill('#optCalPrem', '250');
      await page.waitForTimeout(100);
      const k = /^([\d,]+) PE/.exec(lbl)[1];
      const row = await page.$$eval('#optTable tbody tr', (r, k) => { const x = r.find(y => y.cells[0].innerText.startsWith(k + ' PE')); return x ? x.cells[1].innerText.split('\n')[0] : null; }, k);
      check(rupees(row) === 250 && /Volatility read from your price/.test(await page.innerText('#optCalNote')) && !/\(estimate\)/.test(await page.innerText('#optOut')), w + 'calibrated ' + lbl + ' shows ' + row);
      // Nifty at another level when the price was read: the entry premium moves by about delta x the gap.
      await page.fill('#optCalSpot', '25650');
      const row2 = rupees(await page.$$eval('#optTable tbody tr', (r, k) => r.find(y => y.cells[0].innerText.startsWith(k + ' PE')).cells[1].innerText.split('\n')[0], k));
      check(row2 > 250 && row2 < 250 + 50, w + 'price read at 25,650 should put the 25,600 premium a little above ₹250: ' + row2);
      await page.click('#optCalClear');
      check(await page.inputValue('#optCalPrem') === '' && /\(estimate\)/.test(await page.innerText('#optOut')), w + 'Clear did not go back to VIX');
      // Too little risk for one lot: no BUY, and says so.
      await page.fill('#optRisk', '500');
      check(!/^BUY/.test(await page.innerText('#optBuy')) && /Over your ₹500 risk/.test(await page.innerText('#optOut')) && /Raise the risk, move the stop closer, or skip/.test(await page.innerText('#optOut')), w + 'over-risk not flagged: ' + (await page.innerText('#optOut')).slice(0, 160));
      // No account typed: the NSE book's balance is the account, and the risk its max risk %.
      await page.fill('#optRisk', '');
      const auto = await page.evaluate(() => { const a = state.accounts.find(x => x.market === 'nse'), b = bookBalance(a); return { bal: money(b, 'INR', 0), want: money(b * a.maxRiskPct / 100, 'INR', 0), ph: document.getElementById('optRisk').placeholder, cph: document.getElementById('optCap').placeholder, out: document.getElementById('optOut').innerText }; });
      check(auto.ph === 'auto ' + auto.want && auto.cph === 'Test NSE ' + auto.bal && auto.out.includes('Risk ' + auto.want + ': 1% of the account.') && auto.out.includes('Account ' + auto.bal + ' (Test NSE balance)'), w + 'auto account / risk: ' + JSON.stringify({ ph: auto.ph, cph: auto.cph, want: auto.want }));
      // Mistakes: a typo'd level, a stop on the entry, a target the wrong side, odd VIX / lot / brokerage.
      await page.fill('#optEntry', '256000000');
      check(/does not look like a Nifty level/.test(await page.innerText('#optOut')) && !(await page.$('#optBuy')), w + 'huge entry not refused');
      await page.fill('#optEntry', '-25600');
      check(/Type the Nifty level/.test(await page.innerText('#optOut')), w + 'negative entry not refused');
      await page.fill('#optEntry', '25600'); await page.fill('#optSl', '25600');
      check(/same as the entry/.test(await page.innerText('#optOut')), w + 'stop on the entry not refused');
      await page.fill('#optSl', '25450'); await page.fill('#optTarget', '25500'); await page.fill('#optVix', '900'); await page.click('#optMore summary'); await page.fill('#optLot', '-5'); await page.fill('#optBrok', '99999');
      const odd = await page.innerText('#optOut');
      check(/wrong side of the entry/.test(odd) && /India VIX 900 looks wrong; using 14/.test(odd) && /Lot size -5 looks wrong; using 65/.test(odd) && /Brokerage ₹99999 an order looks wrong; using ₹20/.test(odd) && /Nifty 25,750, 1R/.test(odd) && /\b65 qty|130 qty|195 qty/.test(odd), w + 'odd inputs: ' + odd.slice(0, 400));
      await page.fill('#optVix', '14'); await page.fill('#optLot', '65'); await page.fill('#optBrok', '20'); await page.fill('#optTarget', '');
      // Kept after a reload.
      await page.fill('#optRisk', '10000');
      await page.reload({ waitUntil: 'load' }); await page.waitForTimeout(300);
      await page.evaluate(() => switchTab('calculator'));
      check(await page.inputValue('#optEntry') === '25600' && await page.inputValue('#optSl') === '25450' && /^BUY NIFTY 25,600 CE/.test(await page.innerText('#optBuy')), w + 'not kept after reload');
      // In dollars on the header, the money also shows in $ (option prices stay in ₹).
      await page.click('#accountsBar button[data-cur="USD"]');
      await page.evaluate(() => switchTab('calculator'));
      check(/In dollars \(₹85 a \$\): pay ≈ \$/.test(await page.innerText('#optOut')) && /₹/.test(await page.innerText('#optCost')), w + 'dollar line missing');
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      check(wide <= 1, w + 'page scrolls sideways by ' + wide);
      // Intraday on Monday 9 Nov (expiry day, Tue 10 Nov a holiday): skip today's expiry for next week's.
      await page.clock.setFixedTime(new Date('2026-11-09T04:00:00Z'));
      await page.selectOption('#optTf', 'intra');
      check(/· Tue 17 Nov$/.test(await page.innerText('#optBuy')) && /Auto \(Tue 17 Nov\)/.test(await page.$eval('#optExp option', o => o.textContent)), w + 'intraday on expiry day: ' + await page.innerText('#optBuy'));
      // Picking today's expiry by hand warns about its last day.
      await page.selectOption('#optExp', '2026-11-09');
      check(/loses value fastest on its last day/.test(await page.innerText('#optOut')), w + 'last-day warning missing');
      // A 1W setup reaches into 2027, whose holidays are not known yet.
      await page.selectOption('#optTf', '1w');
      check(/· Tue 29 Dec$/.test(await page.innerText('#optBuy')), w + '1W expiry: ' + await page.innerText('#optBuy'));
      await page.clock.setFixedTime(new Date('2026-12-20T04:00:00Z'));
      await page.fill('#optEntry', '25601');
      check(/holidays after 2026 are not in yet/.test(await page.innerText('#optOut')), w + '2027 holiday warning missing');
    } catch (e) {
      errs.push(w + 'threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
    }
    await ctx.close();
  }
  // The NSE futures fee preset carries Budget 2026's STT (0.05% on the sell) and NSE's 0.00183%.
  {
    const ctx = await browser.newContext();
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    const page = await ctx.newPage();
    await page.goto(base, { waitUntil: 'load' });
    const got = await page.evaluate(() => calcPresetPercent('nse-futures'));
    const b = 2 * 20 / 500000 * 100, x = 2 * 0.00183, sebi = 2 * 0.0001;
    const want = +(b + 0.05 + x + sebi + 0.002 + 0.18 * (b + x + sebi)).toFixed(3);
    check(got === want, 'NSE futures preset ' + got + '% vs ' + want + '% by hand');
    await ctx.close();
  }
  const label = 'Nifty options: CE / PE, strike, expiry and lots, re-priced by hand';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

// Weekly audit, 2026-11-08: the candle summaries behind "Exit at" live in IndexedDB,
// not in the ~5 MB of localStorage the trades need; an old copy moves across. Offline
// (or with Delta unreachable) the price reads stop instead of firing one per alert.
async function tgtStoreRun(seed) {
  const errs = [];
  const check = (ok, msg) => { if (!ok) errs.push(msg); };
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, timezoneId: 'Asia/Kolkata' });
  let calls = 0, deltaUp = false;
  await ctx.route(url => !url.href.startsWith(base) && !url.href.startsWith('https://api.india.delta.exchange/'), r => r.abort());
  await ctx.route('https://api.india.delta.exchange/**', route => {
    if (!/history\/candles.*symbol=C\d/.test(route.request().url())) return route.abort(); // the alerts' candles only (not the BTC day)
    calls++;
    if (!deltaUp) return route.abort();
    return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' }, body: JSON.stringify({ success: true, result: [] }) });
  });
  await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); localStorage.setItem('tapeAndTarget.sigTgt', JSON.stringify({ 'old|long|100|99': { m: 0.021, sl: 1, e: 0, done: 1 } })); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push('page error: ' + e.message));
  try {
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => tgtReady, null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const moved = await page.evaluate(async () => ({ local: localStorage.getItem('tapeAndTarget.sigTgt'), idb: Object.keys(JSON.parse(await idbGet('tapeAndTarget.sigTgt') || '{}')), mem: Object.keys(tgtCache()) }));
    check(moved.local === null && moved.idb.indexOf('old|long|100|99') !== -1 && moved.mem.indexOf('old|long|100|99') !== -1, 'old copy not moved to IndexedDB: ' + JSON.stringify(moved));
    // Over two megabytes of summaries: the trades still save, and nothing lands in localStorage.
    const big = await page.evaluate(async () => {
      for (let i = 0; i < 12000; i++) tgtCache()['big' + i + '|long|100|99'] = { m: 0.02, sl: 0, e: 0.01, done: 1, p: Array.from({ length: 12 }, (_, j) => [j / 10, -j / 20]), ta: 0.5 };
      tgtSave(); await new Promise(r => setTimeout(r, 800));
      state.trades.push(Object.assign({}, state.trades[0], { id: 'after-big', symbol: 'AFTERBIG' })); const ok = save();
      return { ok, local: localStorage.getItem('tapeAndTarget.sigTgt'), size: JSON.stringify(tgtCache()).length, broken: storageBroken };
    });
    check(big.ok && big.local === null && big.size > 2e6 && !big.broken, 'big candle cache vs trades: ' + JSON.stringify(Object.assign({}, big, { local: big.local && big.local.length })));
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => tgtReady, null, { timeout: 5000 });
    const back = await page.evaluate(() => ({ n: Object.keys(tgtCache()).length, trade: state.trades.some(t => t.symbol === 'AFTERBIG') }));
    check(back.n >= 12001 && back.trade, 'after reload: ' + JSON.stringify(back));
    // 40 graded alerts, Exit at 1R. Offline: no reads at all, and the strip says why.
    await page.evaluate(() => { tgtMem = {}; });
    await ctx.setOffline(true);
    await page.evaluate(() => {
      const sg = i => ({ id: 'o' + i, key: 'ko' + i, kind: 'trendline', date: '2026-10-01', time: '10:00', symbol: 'C' + i, side: 'long', score: '', market: 'CRYPTO', timeframe: '4H', channel: 'CRYPTO 4H',
        filled: true, outcome: 'SL', resultR: -1, hasReportR: true, price: 100, stop: 99, entry: 100 });
      state.signals = Array.from({ length: 40 }, (_, i) => sg(i));
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'alerts', mktFilter: '', sigTgt: '1R', sigHold: '20', sigCoins: '' });
      switchTab('signals'); renderAll();
    });
    await page.waitForTimeout(1500);
    const off = await page.evaluate(() => document.getElementById('view-signals').innerText);
    check(calls === 0 && /offline: prices load once the connection is back/.test(off), 'offline reads: ' + calls + ' ' + (off.match(/What if[^\n]*/) || [''])[0]);
    // Online but Delta unreachable: it gives up after a dozen failed reads, not 40.
    await ctx.setOffline(false);
    await page.waitForFunction(() => !tgtBusy && tgtFail > 0, null, { timeout: 10000 });
    await page.waitForTimeout(500);
    const failed = calls;
    check(failed >= 12 && failed <= 16, 'reads with Delta down: ' + failed);
    // Delta back, Retry reads the rest.
    deltaUp = true;
    await page.evaluate(() => tgtRetry());
    await page.waitForFunction(() => !tgtBusy && !tgtProg, null, { timeout: 10000 });
    await page.waitForTimeout(500);
    check(calls - failed === 40, 'Retry read every alert: ' + (calls - failed));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  const label = 'Exit at prices: kept in IndexedDB, none read offline, stop when Delta is down';
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label);
  errs.forEach(e => { console.log('     ' + e); failures.push(label + ': ' + e); });
}

const data = fixture();
for (const [name, vp] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  await run(name + ', empty journal', vp, null);
  await run(name + ', sample journal', vp, data);
}
await run('desktop, storage nearly full', { width: 1366, height: 900 }, data, 4300000);
await sigStoreRun(data);
await currencyRun(data);
await backtestRun(data);
await coindcxRun(data);
await fixesRun(data);
await cdxSizeRun(data);
await reviewRun(data);
await withdrawRun(data);
await tradingDayRun(data);
await goalPlannerRun(data);
await optionsRun(data);
await goalPctRun(data);
await deltaShareRun(data);
await alertRefreshRun(data);
await zoneRebuildRun(data);
await autoKeepRun(data);
await importNowRun(data);
await deltaImportRun(data);
await fibTlRun(data);
await sigBacktestRun(data);
await sigRedesignRun(data);
await demoAccountRun(data);
await demoRealRun(data);
await demoDeepRun(data);
await cleanupRun(data);
await behaviourRun(data);
await setupLevelRun(data);
await analysisFiltersRun(data);
await anDemoRun(data);
await statRowsRun(data);
await chartsRun(data);
await alertPriceMatchRun(data);
await aiReviewRun(data);
await layoutRun(data);
await cleanRun(data);
await whatsNewRun(data);
await syncSettingsRun(data);
await keysLockRun(data);
await exitTargetRun(data);
await stopMoveRun(data);
await slTypeRun(data);
await holdPctRun(data);
await trailRun(data);
await tgtHeadRun(data);
await sigBreakdownRun(data);
await nsePathsRun();
await badInputRun(data);
await tgtStoreRun(data);

await browser.close();
server.close();
if (failures.length) { console.log('\n' + failures.length + ' problem(s) found'); process.exit(1); }
console.log('\nAll checks passed');
