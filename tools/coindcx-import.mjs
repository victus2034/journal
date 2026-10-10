// CoinDCX futures import, run by GitHub Actions in the journal's sync repo.
//
// CoinDCX's API doesn't answer web pages, so the journal can't read it itself.
// This reads every futures transaction with the key kept in the sync repo's
// Actions secrets and adds the new ones to journal.json, the file the journal
// syncs. Each device gets them with its next sync, in the CoinDCX book an
// uploaded report fills; a transaction a report already has counts once there.
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

const env = process.env;
const CDX_BASE = (env.COINDCX_BASE || 'https://api.coindcx.com').replace(/\/+$/, '');
const GH_API = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const REPO = env.GITHUB_REPOSITORY || '', BRANCH = env.JOURNAL_BRANCH || 'main', SYNC_PATH = 'journal.json';
const TZ = env.JOURNAL_TZ || 'Asia/Kolkata';
const CDX_FILE = 'cdx-api', CDX_BROKER = 'CoinDCX';
const CDX_PAGE = 100, CDX_MAX_PAGES = 100;
const TX_PATH = '/exchange/v1/derivatives/futures/positions/transactions', POS_PATH = '/exchange/v1/derivatives/futures/positions';

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
// Every private call is a POST whose JSON body carries a millisecond timestamp,
// signed with an HMAC-SHA256 (hex) of that exact body.
async function cdxCall(path, params) {
  const body = JSON.stringify(Object.assign({ timestamp: Date.now() }, params || {}));
  const sig = crypto.createHmac('sha256', env.COINDCX_API_SECRET).update(body).digest('hex');
  let res, text;
  try {
    res = await fetch(CDX_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AUTH-APIKEY': env.COINDCX_API_KEY, 'X-AUTH-SIGNATURE': sig },
      body, signal: AbortSignal.timeout(30000)
    });
    text = await res.text();
  } catch (e) {
    // No answer at all; kept apart from a mistake in this script.
    const why = e && e.name === 'TimeoutError' ? 'no answer in 30 seconds' : String((e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || e);
    return { ok: false, status: 0, network: why, body: null };
  }
  let data; try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 400) }; }
  return { ok: res.status === 200, status: res.status, body: data };
}
// A list, or a list inside an object. An empty answer or a bare message
// (not an error) means nothing to list; anything else is not understood.
function cdxList(body) {
  if (Array.isArray(body)) return body;
  if (body == null) return [];
  if (typeof body !== 'object') return null;
  const inner = body.transactions || body.positions || body.data;
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
// for the journal to show; nothing changes when there is nothing new to say.
function apply(data, rows, note) {
  const old = data.backtest;
  const bt = old && Array.isArray(old.files) && Array.isArray(old.rows) ? old : { files: [], rows: [] };
  const have = {};
  bt.rows.forEach(r => { if (r && r.id) have[r.id] = 1; });
  const fresh = rows.filter(r => !have[r.id]);
  const i = bt.files.findIndex(x => x && x.id === CDX_FILE), f = i >= 0 ? bt.files[i] : null;
  if (!fresh.length && (!f || (f.note || '') === (note || ''))) return { changed: false, added: 0, file: f };
  const now = new Date().toISOString();
  let rec;
  if (!fresh.length) {
    rec = Object.assign({}, f, { updatedAt: now });
    delete rec.note;
    if (note) rec.note = note;
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
    rec = {
      id: CDX_FILE, name: 'CoinDCX API', sheet: 'Futures transactions', broker, importedAt: f && f.importedAt ? f.importedAt : now, updatedAt: now,
      rows: rows.length, added: fresh.length, net: sum(mine.filter(r => r.cur === cur).map(r => Number(r.net))), cur, checked
    };
    if (note) rec.note = note;
  }
  if (i >= 0) bt.files[i] = rec; else bt.files.push(rec);
  data.backtest = bt;
  return { changed: true, added: fresh.length, file: rec };
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
  // The journal keeps 300 characters of it; the same here, or each would keep rewriting the other.
  const note = failed ? failed.slice(0, 300) : null;

  let res;
  for (let attempt = 1; ; attempt++) {
    res = apply(data, rows, note);
    if (!res.changed) break;
    data.savedAt = new Date().toISOString();
    const message = res.added ? `CoinDCX: ${res.added} new row${res.added === 1 ? '' : 's'}` : failed ? 'CoinDCX import failed' : 'CoinDCX import working again';
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
  if (res.added && !res.file.checked) msg += " · ⚠ the stored rows don't add up to what CoinDCX sent";
  report(msg, res.added > 0 && !res.file.checked);
  return res.added > 0 && !res.file.checked ? 1 : 0;
}

main().then(code => { process.exitCode = code; }, e => { report(String((e && e.message) || e), true); process.exitCode = 1; });
