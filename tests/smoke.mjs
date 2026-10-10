// Opens index.html in headless Chromium and fails on any script error.
// Runs twice: with an empty browser, and with a small made-up journal so the
// charts, tables and stats actually render. Every tab is opened on desktop
// and phone widths. Outside requests (CDN, GitHub, Delta) are blocked, so the
// check never depends on the network. One more pass fills storage to 86%
// and expects the storage warning. The last pass uploads a made-up CoinDCX
// trade report (.xlsx, then the same as .csv), checks every number it shows
// against the report, in Analysis and on the Dashboard, and switches brokers.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { EXPECTED, backtestXlsx, backtestCsv } from './backtest-fixture.mjs';

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
    check(all.inr.n === before.nse.n + EXPECTED.closed.length && near(all.inr.net, before.nse.net + EXPECTED.closedNet), `All accounts in INR: ${JSON.stringify(all.inr)}, Test NSE alone ${before.nse.n} trades ${before.nse.net}`);
    check(all.usd.n === before.usd.n && near(all.usd.net, before.usd.net), 'All accounts in USD changed: ' + JSON.stringify(all.usd));
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
    check((await page.evaluate(() => btShown.length)) === 0 && (v.lines.find(l => l.startsWith('CoinDCX')) || '').startsWith('CoinDCX — 0'), 'period 7 days did not narrow the report: ' + v.lines.join(' | '));
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
      ensureReportBooks(state); renderAnalysis();
    });
    v = await view();
    check(v.bar.join(',') === 'All books,Test NSE,Test Crypto,CoinDCX,Dhan,Test Crypto report,Test Crypto report INR', 'report broker named like a book, in two currencies: ' + v.bar.join(','));
    check((v.lines.find(l => l.startsWith('Dhan')) || '').includes('+₹' + EXPECTED.closedNet.toFixed(2)) && v.lines.some(l => l.startsWith('Test Crypto report +$5.00 1 ')) && v.lines.some(l => l.startsWith('Test Crypto report INR +₹7.00 1 ')), 'results by broker mixed brokers: ' + v.lines.join(' | '));
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

const data = fixture();
for (const [name, vp] of [['desktop', { width: 1366, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  await run(name + ', empty journal', vp, null);
  await run(name + ', sample journal', vp, data);
}
await run('desktop, storage nearly full', { width: 1366, height: 900 }, data, 4300000);
await backtestRun(data);

await browser.close();
server.close();
if (failures.length) { console.log('\n' + failures.length + ' problem(s) found'); process.exit(1); }
console.log('\nAll checks passed');
