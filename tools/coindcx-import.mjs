// CoinDCX futures import, run by GitHub Actions in the journal's sync repo.
//
// CoinDCX's API doesn't answer web pages, so the journal can't read it itself.
// This reads every futures transaction with the key kept in the sync repo's
// Actions secrets and adds the new ones to journal.json, the file the journal
// syncs. Each device gets them with its next sync, in the CoinDCX book an
// uploaded report fills; a transaction a report already has counts once there.
// It also reads the futures wallets, so the journal can show CoinDCX's own
// balance for the CoinDCX book instead of one worked out from the trades, and
// the fills (price, side and size), so it can tell which scanner alert a
// CoinDCX trade was taken off.
//
// Environment (GitHub sets the ones marked *):
//   COINDCX_API_KEY, COINDCX_API_SECRET   the repo's Actions secrets
//   GITHUB_TOKEN                          the job's token (contents: write)
//   GITHUB_REPOSITORY*, GITHUB_API_URL*   where journal.json lives
//   JOURNAL_BRANCH                        its branch (main)
//   JOURNAL_TZ                            the clock CoinDCX's reports use (Asia/Kolkata)
//   COINDCX_BASE                          tests point this at a fake CoinDCX
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const env = process.env;
const CDX_BASE = (env.COINDCX_BASE || 'https://api.coindcx.com').replace(/\/+$/, '');
const GH_API = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const REPO = env.GITHUB_REPOSITORY || '', BRANCH = env.JOURNAL_BRANCH || 'main', SYNC_PATH = 'journal.json';
const TZ = env.JOURNAL_TZ || 'Asia/Kolkata';
const CDX_FILE = 'cdx-api', CDX_BROKER = 'CoinDCX';
const CDX_PAGE = 100, CDX_MAX_PAGES = 100;
const TX_PATH = '/exchange/v1/derivatives/futures/positions/transactions', POS_PATH = '/exchange/v1/derivatives/futures/positions';
const WALLET_PATH = '/exchange/v1/derivatives/futures/wallets', FILLS_PATH = '/exchange/v1/derivatives/futures/trades';
// Fills: the first read goes back 90 days, later ones to 3 days before the
// newest fill kept, newest first, a week (7 days counting both ends) per call;
// the journal keeps the newest 5000.
const FILL_FIRST_DAYS = 90, FILL_OVERLAP_DAYS = 3, FILL_STEP_DAYS = 6, FILL_MAX = 5000, DAY_MS = 864e5;

// ---- the journal's own helpers, as index.html has them ----
function num(v) {
  if (v == null) return NaN;
  const t = String(v).trim().replace(/[,₹$\s]/g, '');
  const m = t.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}
function sum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function uniq(a) { const s = {}, o = []; a.forEach(x => { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
function btRound(v) { return Math.round(v * 1e8) / 1e8; }
function btHash(s) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 2246822519); }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

// ---- CoinDCX ----
// Every private call sends a JSON body carrying a millisecond timestamp,
// signed with an HMAC-SHA256 (hex) of that exact body. Most are POSTs; the
// wallets are a GET that still carries the body, which fetch() won't send,
// so the request is made by hand.
function send(url, method, headers, body) {
  return new Promise(resolve => {
    const u = new URL(url), lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method, headers: Object.assign({ 'Content-Length': Buffer.byteLength(body) }, headers), timeout: 30000 }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
      res.on('error', e => resolve({ status: 0, network: e.code || e.message }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('no answer in 30 seconds'), { code: 'no answer in 30 seconds' })));
    // No answer at all; kept apart from a mistake in this script.
    req.on('error', e => resolve({ status: 0, network: e.code || e.message }));
    req.end(body);
  });
}
async function cdxCall(path, params, method = 'POST') {
  const body = JSON.stringify(Object.assign({ timestamp: Date.now() }, params || {}));
  const sig = crypto.createHmac('sha256', env.COINDCX_API_SECRET).update(body).digest('hex');
  const r = await send(CDX_BASE + path, method, { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sig }, body);
  if (!r.status) return { ok: false, status: 0, network: String(r.network), body: null };
  let data; try { data = r.text ? JSON.parse(r.text) : null; } catch (e) { data = { raw: r.text.slice(0, 400) }; }
  return { ok: r.status === 200, status: r.status, body: data };
}
// A list, or a list inside an object. An empty answer or a bare message
// (not an error) means nothing to list; anything else is not understood.
function cdxList(body) {
  if (Array.isArray(body)) return body;
  if (body == null) return [];
  if (typeof body !== 'object') return null;
  const inner = body.transactions || body.positions || body.trades || body.data;
  if (Array.isArray(inner)) return inner;
  if (body.status === 'error' || Number(body.code) >= 400) return null;
  return Object.keys(body).every(k => /^(message|status|code)$/.test(k)) ? [] : null;
}
// No answer, a refused key or server, the rate limit or an outage stops the
// import; a margin type CoinDCX won't list (never used, say) only skips that one.
function cdxFatal(r) { return !r || !r.status || r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500; }
// Its times are milliseconds; a date written out is read as one too.
function cdxMs(v) {
  const n = typeof v === 'number' ? v : /^\s*\d+(\.\d+)?\s*$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  return isFinite(n) && n > 1e12 ? n : NaN;
}
// Pages until a short one. A page that repeats the one before (an answer
// that ignores paging) or the cap ends it too, so it can't loop forever.
async function cdxPages(path, params) {
  let all = [], prevFirst = null;
  for (let page = 1; ; page++) {
    const r = await cdxCall(path, Object.assign({}, params, { page: String(page), size: String(CDX_PAGE) }));
    const rows = r.ok ? cdxList(r.body) : null;
    if (!rows) throw (r.ok ? { status: r.status, body: { raw: 'an answer that is not a list' } } : r);
    const first = rows.length ? JSON.stringify(rows[0]) : '';
    if (rows.length && first === prevFirst) return { rows: all, capped: false };
    prevFirst = first;
    all = all.concat(rows);
    if (rows.length < CDX_PAGE || page >= CDX_MAX_PAGES) return { rows: all, capped: rows.length >= CDX_PAGE };
  }
}
// The documented call takes no position ids; an older form wanted them, so a
// refused call is tried once more with the ids of every position.
async function cdxTransactions(mc) {
  const params = { stage: 'all', margin_currency_short_name: [mc] };
  try {
    return await cdxPages(TX_PATH, params);
  } catch (r) {
    if (!r || (r.status !== 400 && r.status !== 422)) throw r;
    const p = await cdxPages(POS_PATH, { margin_currency_short_name: [mc] });
    const ids = uniq(p.rows.map(x => x && x.id ? String(x.id) : '').filter(Boolean));
    return ids.length ? cdxPages(TX_PATH, Object.assign({ position_ids: ids.join(',') }, params)) : { rows: [], capped: false };
  }
}
// Report times are Indian clock time (the report says 05:30 for a funding at
// midnight UTC), so API times are written the same way whatever the server's clock.
let clock;
function cdxLocalTime(ms) {
  clock = clock || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = {};
  clock.formatToParts(new Date(ms)).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
// One transaction as a report row: amount is its P&L and fee_amount its fee,
// both in the margin currency (rupees for INR-M). Stage "funding" is a
// funding charge; default, exit, tpsl_exit and liquidation are order fills.
function cdxRow(tx, mc) {
  if (!tx || typeof tx !== 'object') return null;
  const ms = cdxMs(tx.created_at), amount = num(tx.amount), fee = num(tx.fee_amount);
  const sym = String(tx.pair || '').trim().slice(0, 30), stage = String(tx.stage || '').toLowerCase();
  if (!sym || !isFinite(ms) || !isFinite(amount)) return null;
  const f = isFinite(fee) ? Math.abs(fee) : 0, kind = stage === 'funding' ? 'funding' : 'order';
  const cur = String(tx.margin_currency_short_name || mc).toUpperCase() === 'INR' ? 'INR' : 'USD';
  // Its own id when CoinDCX sends one; else one made from what tells it
  // apart, the same on every run.
  const id = tx.id ? String(tx.id).slice(0, 80) : 'cdx' + btHash([sym, tx.parent_id, tx.position_id, stage, tx.created_at, tx.amount, tx.fee_amount].join('|'));
  return {
    id, file: CDX_FILE, sym, at: cdxLocalTime(ms), kind, type: kind === 'funding' ? 'By Funding' : stage === 'liquidation' ? 'Liquidation' : 'By Order',
    gross: btRound(amount), settle: 0, fee: btRound(f), net: btRound(amount - f), cur
  };
}
function oneLine(v) { return String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); }
function cdxWhy(r) {
  if (r && r.network) return `Could not reach CoinDCX (${oneLine(r.network)}). If this keeps happening, CoinDCX may not accept GitHub's servers.`;
  const said = r && r.body && (r.body.message || r.body.error || r.body.raw);
  const text = said ? oneLine(typeof said === 'string' ? said : JSON.stringify(said)) : '';
  if (r && r.status === 401) return "CoinDCX refused the key (401). Check both secrets were copied in full, and that the key isn't bound to an IP address (GitHub's servers change address).";
  if (r && r.status === 403) return `CoinDCX refused the request (403${text ? ': ' + text : ''}). Either the key is bound to an IP address, or CoinDCX doesn't accept GitHub's servers, which are outside India.`;
  if (r && r.status === 429) return 'CoinDCX says too many requests. The next run tries again.';
  if (r && r.status >= 500) return `CoinDCX is having trouble (it answered ${r.status}). The next run tries again.`;
  if (r && r.status) return `CoinDCX answered ${r.status}${text ? ': ' + text : ''}.`;
  return 'Import failed: ' + oneLine((r && r.message) || r || 'unknown reason');
}
// Rupee (INR-M) and USDT futures one after the other: amounts come in each
// one's own currency. Either fails the run only when it can't be a margin
// type that simply isn't in use.
async function readCoindcx() {
  const got = [], skipped = [];
  let capped = false;
  for (const mc of ['INR', 'USDT']) {
    try {
      const r = await cdxTransactions(mc);
      capped = capped || r.capped;
      r.rows.forEach(tx => got.push([tx, mc]));
    } catch (r) {
      if (cdxFatal(r)) throw r;
      skipped.push({ mc, r });
    }
  }
  if (skipped.length === 2) throw skipped[0].r;
  const rows = [], seen = {};
  let unread = 0;
  got.forEach(([tx, mc]) => {
    const row = cdxRow(tx, mc);
    if (!row) unread++;
    else if (!seen[row.id]) { seen[row.id] = 1; rows.push(row); }
  });
  return { rows, unread, skipped, capped };
}

// The INR and USDT futures wallets (for the rupee and dollar CoinDCX books).
// The total is what is free plus the margin locked in orders and positions,
// isolated (locked_balance) and cross; CoinDCX's docs give balance +
// locked_balance, and INR futures have no cross margin.
async function readWallets() {
  const r = await cdxCall(WALLET_PATH, {}, 'GET');
  const list = r.ok ? cdxList(r.body) : null;
  if (!list) throw (r.ok ? { status: r.status, body: { raw: 'an answer that is not a list' } } : r);
  const w = {};
  list.forEach(x => {
    if (!x || typeof x !== 'object') return;
    const c = String(x.currency_short_name || '').toUpperCase(), k = c === 'INR' ? 'INR' : c === 'USDT' ? 'USD' : null;
    const parts = [x.balance, x.locked_balance, x.cross_order_margin, x.cross_user_margin].map(num);
    if (k && isFinite(parts[0])) w[k] = btRound(sum(parts.map(v => isFinite(v) ? v : 0)));
  });
  return w;
}
// In one order, INR then USD, as the journal keeps them.
function walletOf(w) {
  const o = {};
  if (w && typeof w.INR === 'number') o.INR = w.INR;
  if (w && typeof w.USD === 'number') o.USD = w.USD;
  return Object.keys(o).length ? o : null;
}

// Every fill of the INR and USDT futures from today (Indian date) back to
// `fromMs`: what the transactions leave out, the price, side and size of each.
// CoinDCX only goes back so far and says "From Date not in range" past that,
// so the weeks are read newest first and stop there. A margin type CoinDCX
// won't list only skips that one, as with the transactions.
function cdxDay(ms) { return new Date(ms).toISOString().slice(0, 10); }
function dayPlus(day, n) { return cdxDay(Date.parse(day + 'T00:00:00Z') + n * DAY_MS); }
function cdxOutOfRange(r) { return !!r && r.status === 400 && /range/i.test(String(r.body && (r.body.message || r.body.error) || '')); }
async function readFills(fromMs) {
  const got = [], skipped = [], stop = cdxDay(fromMs);
  for (const mc of ['INR', 'USDT']) {
    try {
      for (let to = cdxLocalTime(Date.now()).slice(0, 10), first = true; ; first = false) {
        const from = dayPlus(to, -FILL_STEP_DAYS);
        let r;
        try { r = await cdxPages(FILLS_PATH, { from_date: from, to_date: to, margin_currency_short_name: [mc] }); }
        catch (e) { if (!first && cdxOutOfRange(e)) break; throw e; }
        r.rows.forEach(x => got.push([x, mc]));
        if (from <= stop) break;
        to = from;
      }
    } catch (r) {
      if (cdxFatal(r)) throw r;
      skipped.push(r);
    }
  }
  if (skipped.length === 2) throw skipped[0];
  // Weeks share their end day, so a fill can come twice; each counts once.
  const fills = [], seen = {}, bad = {};
  let unread = 0, fields = '';
  got.forEach(([x, mc]) => {
    const f = cdxFill(x, mc);
    if (f) { if (!seen[f.id]) { seen[f.id] = 1; fills.push(f); } return; }
    const k = JSON.stringify(x);
    if (bad[k]) return;
    bad[k] = 1; unread++;
    if (!fields && x && typeof x === 'object') fields = Object.keys(x).slice(0, 12).join(', ');
  });
  return { fills, unread, fields };
}
// One fill, in the shape and key order the journal keeps: its time on the
// same Indian clock as the rows, the pair, buy or sell, price and size.
function cdxFill(x, mc) {
  if (!x || typeof x !== 'object') return null;
  const ms = cdxMs(x.timestamp != null ? x.timestamp : x.created_at), price = num(x.price), qty = Math.abs(num(x.quantity));
  const side = String(x.side || '').toLowerCase(), sym = String(x.pair || '').trim().slice(0, 30);
  if (!sym || !isFinite(ms) || !(price > 0) || !(qty > 0) || (side !== 'buy' && side !== 'sell')) return null;
  const cur = String(x.margin_currency_short_name || mc).toUpperCase() === 'INR' ? 'INR' : 'USD';
  const id = x.id ? String(x.id).slice(0, 80) : 'fill' + btHash([sym, x.order_id, x.timestamp, x.price, x.quantity, side].join('|'));
  return { id, at: cdxLocalTime(ms), sym, side, price: btRound(price), qty: btRound(qty), cur };
}
// The fills kept plus the ones just read, each once, oldest first, the newest FILL_MAX.
function mergeFills(old, add) {
  const by = {};
  (Array.isArray(old) ? old : []).concat(add).forEach(x => { if (x && x.id) by[x.id] = x; });
  return Object.keys(by).map(k => by[k]).sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(-FILL_MAX);
}
// Where the next read starts: a little before the newest fill kept, or 90 days back.
function fillsFrom(data) {
  const f = data.backtest && Array.isArray(data.backtest.files) ? data.backtest.files.find(x => x && x.id === CDX_FILE) : null;
  const last = f && Array.isArray(f.fills) && f.fills.length ? Date.parse(String(f.fills[f.fills.length - 1].at).replace(' ', 'T') + 'Z') : NaN;
  return isFinite(last) ? last - FILL_OVERLAP_DAYS * DAY_MS : Date.now() - FILL_FIRST_DAYS * DAY_MS;
}

// ---- journal.json on GitHub ----
function gh(path, opts = {}) {
  return fetch(`${GH_API}/repos/${REPO}${path}`, Object.assign({}, opts, {
    headers: Object.assign({
      Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'journal-coindcx-import'
    }, opts.headers || {})
  }));
}
async function readJournal() {
  const ref = '?ref=' + encodeURIComponent(BRANCH);
  const res = await gh('/contents/' + SYNC_PATH + ref);
  if (res.status === 404) throw new Error(`${SYNC_PATH} isn't in ${REPO} (branch ${BRANCH}) yet. Turn on GitHub Sync in the journal first; this import adds to that file.`);
  if (!res.ok) throw new Error(`GitHub refused to read ${SYNC_PATH} (${res.status}).`);
  const j = await res.json();
  let text = '';
  if (j.content) text = Buffer.from(j.content, 'base64').toString('utf8');
  else if (j.size > 0) {
    // Above 1 MB GitHub sends no content here; ask for the raw file.
    const r2 = await gh('/contents/' + SYNC_PATH + ref, { headers: { Accept: 'application/vnd.github.raw+json' } });
    if (!r2.ok) throw new Error(`GitHub refused to read ${SYNC_PATH} (${r2.status}).`);
    text = await r2.text();
  }
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${SYNC_PATH} could not be read as a journal, so nothing was changed.`);
  return { data, sha: j.sha };
}
// false when another device saved in between (GitHub's 409): read and merge again.
async function writeJournal(data, sha, message) {
  const res = await gh('/contents/' + SYNC_PATH, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: Buffer.from(JSON.stringify(data, null, 2)).toString('base64'), branch: BRANCH, sha })
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`GitHub refused to save ${SYNC_PATH} (${res.status}). The workflow needs "permissions: contents: write".`);
  return true;
}

// New transactions go in as rows of the fixed "cdx-api" file, in the same
// shape (and key order) the journal writes its own, so its next sync finds
// nothing to rewrite. A failed run leaves its reason on that file (`note`)
// for the journal to show, and the wallets go there too (`wallet`, dated by
// when they last changed), then the fills (`fills`); nothing changes when
// there is nothing new to say.
function fileRecord(f, note, wallet, fills) {
  const rec = {
    id: f.id, name: f.name, sheet: f.sheet, broker: f.broker, importedAt: f.importedAt, updatedAt: f.updatedAt,
    rows: f.rows, added: f.added, net: f.net, cur: f.cur, checked: f.checked
  };
  if (note) rec.note = note;
  if (wallet) rec.wallet = wallet;
  if (fills && fills.length) rec.fills = fills;
  return rec;
}
function apply(data, rows, note, wallet, fills) {
  const old = data.backtest;
  const bt = old && Array.isArray(old.files) && Array.isArray(old.rows) ? old : { files: [], rows: [] };
  const have = {};
  bt.rows.forEach(r => { if (r && r.id) have[r.id] = 1; });
  const fresh = rows.filter(r => !have[r.id]);
  const i = bt.files.findIndex(x => x && x.id === CDX_FILE), f = i >= 0 ? bt.files[i] : null;
  const was = f ? walletOf(f.wallet) : null, now = walletOf(wallet);
  const walletMoved = !!now && JSON.stringify(now) !== JSON.stringify(was);
  const noteMoved = (f && f.note || '') !== (note || '');
  const hadFills = f && Array.isArray(f.fills) ? f.fills : [], keepFills = fills ? mergeFills(hadFills, fills) : hadFills;
  const fillsMoved = JSON.stringify(keepFills) !== JSON.stringify(hadFills);
  if (!fresh.length && (!f || (!noteMoved && !walletMoved && !fillsMoved))) return { changed: false, added: 0, file: f };
  const at = new Date().toISOString();
  const keep = walletMoved ? Object.assign({ at }, now) : f && f.wallet;
  let rec;
  if (!fresh.length) {
    rec = fileRecord(Object.assign({}, f, { updatedAt: at }), note, keep, keepFills);
  } else {
    // Under the broker name an uploaded CoinDCX report already uses, so both land in one book.
    const named = bt.files.find(x => x && x.id !== CDX_FILE && /coindcx/i.test(String(x.broker || '')));
    const broker = f && f.broker ? f.broker : named ? named.broker : CDX_BROKER;
    bt.rows = bt.rows.concat(fresh);
    const byId = {};
    bt.rows.forEach(r => { if (r && r.id) byId[r.id] = r; });
    // Read back: every transaction CoinDCX sent is in the file once, adding up to the same total.
    const checked = rows.every(r => byId[r.id]) && Math.abs(sum(rows.map(r => Number(byId[r.id].net))) - sum(rows.map(r => r.net))) < 0.005;
    const mine = bt.rows.filter(r => r && r.file === CDX_FILE), cur = mine.some(r => r.cur === 'INR') ? 'INR' : 'USD';
    rec = fileRecord({
      id: CDX_FILE, name: 'CoinDCX API', sheet: 'Futures transactions', broker, importedAt: f && f.importedAt ? f.importedAt : at, updatedAt: at,
      rows: rows.length, added: fresh.length, net: sum(mine.filter(r => r.cur === cur).map(r => Number(r.net))), cur, checked
    }, note, keep, keepFills);
  }
  if (i >= 0) bt.files[i] = rec; else bt.files.push(rec);
  data.backtest = bt;
  return { changed: true, added: fresh.length, file: rec, noteMoved, walletMoved, fillsMoved };
}

function report(text, bad) {
  console.log((bad ? '::error::' : '') + text);
  if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, (bad ? '**Failed:** ' : '') + text + '\n'); } catch (e) {} }
}

async function main() {
  if (!env.COINDCX_API_KEY || !env.COINDCX_API_SECRET) {
    report('Add the COINDCX_API_KEY and COINDCX_API_SECRET secrets to this repository (Settings → Secrets and variables → Actions), then run this again.', true);
    return 1;
  }
  if (!env.GITHUB_TOKEN || !REPO) { report('GITHUB_TOKEN and GITHUB_REPOSITORY are needed to save journal.json.', true); return 1; }
  try { cdxLocalTime(Date.now()); } catch (e) { report(`JOURNAL_TZ "${TZ}" is not a time zone.`, true); return 1; }

  let { data, sha } = await readJournal();
  let got = null, failed = null;
  try { got = await readCoindcx(); } catch (r) { failed = cdxWhy(r); }
  const rows = got ? got.rows : [];
  // The balance is a bonus: a wallet CoinDCX won't show doesn't stop the import.
  let wallet = null, walletWhy = '';
  if (got) { try { wallet = walletOf(await readWallets()); } catch (r) { walletWhy = cdxWhy(r); } }
  // So are the fills: without them the journal still has every trade, just not its side and price.
  let fillRead = null, fillsWhy = '';
  if (got) { try { fillRead = await readFills(fillsFrom(data)); } catch (r) { fillsWhy = cdxWhy(r); } }
  // The journal keeps 300 characters of it; the same here, or each would keep rewriting the other.
  const note = failed ? failed.slice(0, 300) : null;

  let res;
  for (let attempt = 1; ; attempt++) {
    res = apply(data, rows, note, wallet, fillRead && fillRead.fills);
    if (!res.changed) break;
    data.savedAt = new Date().toISOString();
    const message = res.added ? `CoinDCX: ${res.added} new row${res.added === 1 ? '' : 's'}` : failed ? 'CoinDCX import failed' : res.noteMoved ? 'CoinDCX import working again' : res.walletMoved ? 'CoinDCX wallet balance' : 'CoinDCX trade prices';
    if (await writeJournal(data, sha, message)) break;
    if (attempt >= 4) throw new Error(`${SYNC_PATH} kept changing while saving; the next run tries again.`);
    ({ data, sha } = await readJournal());
  }

  if (failed) { report(failed, true); return 1; }
  let msg = !rows.length ? 'No CoinDCX futures transactions found'
    : res.added ? `Imported ${res.added} new row${res.added === 1 ? '' : 's'} from CoinDCX` : 'Up to date, nothing new from CoinDCX';
  if (got.unread) msg += ` · ${got.unread} unreadable transaction${got.unread === 1 ? '' : 's'} skipped`;
  got.skipped.forEach(x => { msg += ` · ${x.mc} futures not read (${cdxWhy(x.r).replace(/\.$/, '')})`; });
  if (got.capped) msg += ' · stopped at the read cap, so the oldest part may be missing';
  if (wallet) msg += ' · wallet ' + Object.keys(wallet).map(k => (k === 'USD' ? 'USDT' : k) + ' ' + wallet[k]).join(', ');
  else if (walletWhy) msg += ` · wallet balance not read (${walletWhy.replace(/\.$/, '')})`;
  if (fillRead) msg += ` · ${fillRead.fills.length} fill${fillRead.fills.length === 1 ? '' : 's'} read`
    + (fillRead.unread ? `, ${fillRead.unread} unreadable (fields: ${fillRead.fields || 'none'})` : '');
  else if (fillsWhy) msg += ` · trade prices not read (${fillsWhy.replace(/\.$/, '')})`;
  if (res.added && !res.file.checked) msg += " · ⚠ the stored rows don't add up to what CoinDCX sent";
  report(msg, res.added > 0 && !res.file.checked);
  return res.added > 0 && !res.file.checked ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, e => { report(String((e && e.message) || e), true); process.exitCode = 1; });
