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
    check(/^Report Overview Review( \d+)? Position size Trades Market days AI review$/.test((await page.innerText('#anSecBar')).replace(/\s+/g, ' ').trim()) && !(await page.$('[data-btsec]')), 'report book sections: ' + await page.innerText('#anSecBar'));
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
    check((await page.evaluate(() => reportTrades().find(t => t.symbol === 'LNK/USDT' || /LNK/.test(t.symbol)) || {})).setup === 'TRENDLINE', 'setup from the alert on a CoinDCX trade');
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
    // A goal needs trading days left: near a month's end there are none, so run
    // as of the 20th at the latest.
    { const d = new Date(); if (d.getDate() > 20) { d.setDate(20); await page.clock.setFixedTime(d); } }
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
      return { bal: bookBalance(acct('acc_nse')), start: balanceAtStart(acct('acc_nse'), iso(new Date())) };
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
      return { bal: bookBalance(acct('acc_nse')), start: balanceAtStart(acct('acc_nse'), iso(new Date())), got: goalWithdrawn(g, 'INR'), card: document.getElementById('goalCurrent').innerText,
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

// Delta's wallet figure travels through sync (never the key): the device with
// the key fetches it, and a device without one shows that figure instead of its
// own trade sum. Two pages stand in for a PC and a phone.
async function deltaShareRun(seed) {
  const errs = [];
  const check = (ok, what) => { if (!ok) errs.push(what); };
  const open = async vp => {
    const ctx = await browser.newContext({ viewport: vp });
    await ctx.route(url => !url.href.startsWith(base), r => r.abort());
    await ctx.addInitScript(s => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('tapeAndTarget.v2', s); sessionStorage.setItem('seeded', '1'); } }, JSON.stringify(seed));
    const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('page error: ' + (e.stack || e.message)));
    page.on('dialog', d => d.accept());
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    return { ctx, page };
  };
  const pc = await open({ width: 1366, height: 900 }), phone = await open({ width: 390, height: 844 });
  try {
    const sent = await pc.page.evaluate(async () => {
      state.delta = Object.assign(state.delta || {}, { key: 'k', secret: 's' });
      let eq = '0.01';
      window.deltaCall = () => Promise.resolve({ ok: true, status: 200, body: { meta: { net_equity: eq }, result: [] } });
      await fetchLiveBalance();
      const first = JSON.parse(JSON.stringify(syncPayload(state)));
      // A minute later the figure moved a little: the shared one waits, so no push per poll.
      eq = '0.02'; state.delta.shared.at -= 60 * 1000; const was = state.delta.shared.value;
      await fetchLiveBalance();
      return { p: first, held: state.delta.shared.value === was, local: bookBalance(acct(deltaAccountId())) };
    });
    check(sent.p.deltaBalance && sent.p.deltaBalance.value === 0.01 && !JSON.stringify(sent.p).includes('"key"') && !JSON.stringify(sent.p).includes('"secret"') && sent.held && sent.local === 0.02,
      'PC payload: ' + JSON.stringify({ bal: sent.p.deltaBalance, held: sent.held, local: sent.local }));
    const got = await phone.page.evaluate(p => {
      const before = bookBalance(acct(deltaAccountId()));
      state = mergeState(state, p); adoptSyncedBalance(); save();
      state.ui.account = deltaAccountId(); renderAll(); applyLiveBalance();
      const tag = document.getElementById('topBalLive');
      // An older figure from GitHub never replaces the newer one held here.
      const stale = mergeState(JSON.parse(JSON.stringify(state)), Object.assign({}, p, { deltaBalance: { value: 33.23, field: 'net equity', at: p.deltaBalance.at - 3600e3 } }));
      return { before, after: bookBalance(acct(deltaAccountId())), top: document.getElementById('topBalVal').innerText, tag: tag.classList.contains('hidden') ? '' : tag.innerText,
        title: tag.title, stale: stale.delta.liveBalance.value, key: !!(state.delta && state.delta.key) };
    }, sent.p);
    check(got.after === 0.01 && got.before !== 0.01 && got.top.includes('0.01') && /LIVE|LAST KNOWN/.test(got.tag) && /another device/.test(got.title) && got.stale === 0.01 && !got.key,
      'phone after sync: ' + JSON.stringify(got));
    // A PC that held Delta's figure from before this build, with Delta not answering
    // now, still sends it the moment the journal opens.
    const old = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await old.route(url => !url.href.startsWith(base), r => r.abort());
    const seeded = Object.assign({}, seed, { delta: { key: 'k', secret: 's', liveBalance: { value: 0.01, field: 'net equity', at: Date.now() - 3 * 3600e3 } } });
    await old.addInitScript(s => { localStorage.setItem('tapeAndTarget.v2', s); }, JSON.stringify(seeded));
    const oldPage = await old.newPage();
    await oldPage.goto(base, { waitUntil: 'load' }); await oldPage.waitForTimeout(2600);
    const boot = await oldPage.evaluate(() => ({ p: syncPayload(state).deltaBalance, live: liveDeltaBalance && liveDeltaBalance.value }));
    await old.close();
    check(boot.p && boot.p.value === 0.01 && boot.live === 0.01, 'held figure not sent on opening: ' + JSON.stringify(boot));
    // The phone keeps it after a reload.
    await phone.page.reload({ waitUntil: 'load' }); await phone.page.waitForTimeout(300);
    const kept = await phone.page.evaluate(() => bookBalance(acct(deltaAccountId())));
    check(kept === 0.01, 'phone after reload: ' + kept);
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await pc.ctx.close(); await phone.ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Delta balance shared to a device without the key');
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
    await page.clock.runFor(15 * 60e3); await page.waitForTimeout(300);
    const card = await page.evaluate(() => { switchTab('data'); renderDataView(); return document.getElementById('cdxStatus').innerText; });
    check(dispatched.length === 2 && /GitHub said 403/.test(card) && /Actions: Read and write/.test(card), 'card after a refused start: ' + JSON.stringify({ n: dispatched.length, card }));
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Alerts and the CoinDCX import keep refreshing while the journal stays open');
  errs.forEach(e => { console.log('     ' + e); failures.push('auto keep: ' + e); });
}

// Fib / trendline / 1D+ zone results priced as the scanner prices them (its
// fib_trendline_trades.booked_r at the 1R booking: Delta fee, breakeven offset and
// stop slippage), 1D+ zones shown as zones, and a 1W result that closes weeks after
// its alert still reaches the journal.
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
  ].join('\n') + '\n';
  const done = o => ({ filled: true, resolved: true, outcome: o });
  const res = { a: done('SL'), b: done('BE'), c: done('SL'), d: done('BE'), w: done('2R') };
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
      const out = {}; parseFibTl(r, JSON.stringify(x)).records.forEach(g => { out[g.key] = { r: g.resultR, kind: g.kind, daily: g.scoredDaily, lo: g.zoneLow }; });
      return out;
    }, [recs, res]);
    // booked_r(plan, market, result)[0] from the scanner, for these plans
    const want = { a: -1.0437, b: -0.019627, c: -1.07765, d: -0.01818 };
    Object.keys(want).forEach(k => check(got[k] && Math.abs(got[k].r - want[k]) < 1e-4, `R of ${k}: ${got[k] && got[k].r} want ${want[k]}`));
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
    check(typeof w === 'number' && w > 1.9, '1W result never arrived: ' + w);
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
    // L4: risk 3.6883 on 4127.38 = 0.08936%; 2R less 0.0826% / 0.08936% = 2 - 0.9243
    const l4r = 2 - 0.0826 / (Math.abs(4127.3808 - 4123.6925) / 4127.3808 * 100);
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
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Signals backtest report: drawn when opened, numbers by hand');
  errs.forEach(e => { console.log('     ' + e); failures.push('signals backtest: ' + e); });
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
        chans: [...document.querySelectorAll('#anChanSel option')].map(o => o.innerText), hint: document.getElementById('anFilterHint').innerText };
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
    check(/\+\$1\.40/.test(w.net) && /\+\$1\.50/.test(wo.net) && /before fees/.test(wo.hint), 'fees with / without: ' + JSON.stringify([w.net, wo.net, wo.hint]));
    const day1 = await read({ anPeriod: '1d' });
    const cust = await read({ anPeriod: 'custom', anCustom: { from: d, to: d } });
    const swap = await read({ anPeriod: 'custom', anCustom: { from: d, to: '2000-01-01' } });
    check(day1.cnt.all === 0, '1 day: ' + JSON.stringify(day1.cnt));
    check(cust.cnt.all === 9 && cust.n === 9 && cust.hint.indexOf(d + ' → ' + d) === 0, 'custom range: ' + JSON.stringify([cust.cnt, cust.n, cust.hint]));
    check(swap.cnt.all > 9, 'custom range given backwards still reads from 2000 to the day: ' + JSON.stringify(swap.cnt));
    // Clicking through the bar works too.
    await page.evaluate(() => { Object.assign(state.ui, { anKind: '', anPeriod: 'all' }); renderAnalysis(); });
    await page.click('#anKindBar button[data-ankind="fib"]');
    await page.selectOption('#anLvlSel', 'L2');
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
  } catch (e) {
    errs.push('threw: ' + e.message.split('\n').slice(0, 4).join(' | '));
  }
  await ctx.close();
  console.log((errs.length ? 'FAIL ' : 'ok   ') + 'Analysis filters: alert type, period, channel, level, trendline type, fees');
  errs.forEach(e => { console.log('     ' + e); failures.push('analysis filters: ' + e); });
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
    check(/^Overview\|Review(\s*\d+)?\|Position size\|Trades\|Market days\|AI review$/.test(v.anSecs), 'analysis sections: ' + v.anSecs);
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
    check(/^\*Equity & calendar\|Day's trades\|Week & grade\|Time & habits$/.test(v.tabs) && /^Overview\|Review\(\d+\)\|Position size/.test(v.anTabs), 'dashboard and analysis tabs: ' + v.tabs + ' / ' + v.anTabs);
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
      Object.assign(state.ui, { sigKind: 'trendline', sigPeriod: { mode: 'all', from: '', to: '' }, sigChan: '', sigDay: '', sigSec: 'edge', mktFilter: '', sigTgt: '' });
      switchTab('signals'); renderAll();
    });
    await page.waitForFunction(() => /2 of 3 graded alerts have price data/.test(document.getElementById('sigTgtCmp').innerText) && !/reading/.test(document.getElementById('sigTgtCmp').innerText), null, { timeout: 10000 });
    const rows = await page.$$eval('#sigTgtCmp tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    // costs 0.0826R; SL = -1 - 0.99*0.05 - 0.0826 = -1.1321; B time exit = 0.3 - 0.0826 = 0.2174
    const want = ['Scanner 2 50% -0.10R -0.05R 0.90 -0.10%', '1R 2 100% +1.13R +0.57R ∞ +1.13%', '1.5R 2 100% +1.63R +0.82R ∞ +1.63%', '2R best 2 100% +2.13R +1.07R ∞ +2.13%', '3R 2 50% -0.91R -0.46R 0.19 -0.91%', '1% 2 100% +1.13R +0.57R ∞ +1.13%', '2% 2 100% +2.13R +1.07R ∞ +2.13%', '3% 2 50% -0.91R -0.46R 0.19 -0.91%'];
    check(JSON.stringify(rows) === JSON.stringify(want), 'compare rows:\n       ' + rows.join('\n       '));
    check(calls === 2, 'one candle read per crypto alert, none for NSE: ' + calls);
    // Pick 2R: the whole tab re-scores, and By outcome speaks in targets.
    await page.click('#sigTgtBar button[data-tgt="2R"]');
    const v = await page.evaluate(() => ({ strip: document.getElementById('sigEdgeStrip').innerText.replace(/\s+/g, ' '), out: document.getElementById('sigByOutcome').innerText.replace(/\s+/g, ' '),
      on: document.querySelector('#sigTgtCmp tr[data-tgt="2R"]').className, kept: Object.keys(JSON.parse(localStorage.getItem('tapeAndTarget.sigTgt') || '{}')).length,
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
    const rowsNf = await page.$$eval('#sigTgtCmp tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
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
// NSE "Exit at": the sync repo's job reads Yahoo candles (a fake one here) and writes
// nse-paths.json; the journal reads it with its sync token and re-scores NSE alerts.
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
  let put = null, yahooAsks = [];
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
      if (req.method === 'GET') { res.writeHead(404); return res.end('{}'); }
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
    check(file && Object.keys(file.paths).length === 1, 'only graded NSE alerts (no crypto, no unfilled, no timeout): ' + JSON.stringify(file && Object.keys(file.paths)));
    check(JSON.stringify(yahooAsks) === '["ABC.NS 15m"]', 'one 15m read for the one symbol: ' + JSON.stringify(yahooAsks));
    // Window: 20 NSE 4H candles after the fill. A stop on the 11th trading day is outside it.
    const w = tool.walkAlert({ side: 'long', entry: 100, stop: 98, alertMs, tf: '4h' }, bars.map(b => ({ t: b[0] * 1000, h: b[1], l: b[0] * 1000 >= Date.parse('2026-10-27T09:15:00+05:30') ? 100 : b[2], c: b[3] })).concat(['2026-11-02T09:15', '2026-11-02T13:15', '2026-11-03T09:15'].map(x => ({ t: Date.parse(x + ':00+05:30'), h: 100.4, l: x.endsWith('03T09:15') ? 90 : 99.8, c: 100.1 }))), 15);
    check(w && w.sl === 0 && w.done === 1 && w.e === 0.001, 'stop after 20 NSE candles is outside the window: ' + JSON.stringify(w));
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
    const rows = await page.$$eval('#sigTgtCmp tbody tr', trs => trs.map(tr => tr.innerText.replace(/\s+/g, ' ').trim()));
    // NSE fee 0.1063% on a 2% stop = 0.0532R; stop = -1 - 0.98*0.05/2 - 0.0532 = -1.0777R
    const has = (k, t) => check(rows.some(r => r.startsWith(k + ' ') && r.includes(t)), k + ' row should show ' + t + ': ' + JSON.stringify(rows));
    has('1R', '+0.95R'); has('1.5R', '+1.45R'); has('2R', '-1.08R'); has('3R', '-1.08R'); has('1%', '+0.45R'); has('3%', '+1.45R');
    check(reads === 1, 'nse-paths.json read once: ' + reads);
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
await goalPctRun(data);
await deltaShareRun(data);
await alertRefreshRun(data);
await zoneRebuildRun(data);
await autoKeepRun(data);
await fibTlRun(data);
await sigBacktestRun(data);
await cleanupRun(data);
await behaviourRun(data);
await setupLevelRun(data);
await analysisFiltersRun(data);
await aiReviewRun(data);
await layoutRun(data);
await cleanRun(data);
await whatsNewRun(data);
await exitTargetRun(data);
await nsePathsRun();

await browser.close();
server.close();
if (failures.length) { console.log('\n' + failures.length + ' problem(s) found'); process.exit(1); }
console.log('\nAll checks passed');
