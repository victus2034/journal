// Delta Exchange import, run by GitHub Actions on lakky's PC (a self-hosted runner).
//
// Delta India makes every API key name at least one IP address, and a phone's
// IP (Jio, IPv4 and IPv6) keeps changing, so the journal's in-page import fails
// there with ip_not_whitelisted_for_api_key. This runs the same import on the
// PC, whose public IPv4 the key is whitelisted for (the same PC that runs the
// CoinDCX import), and adds the new trades to journal.json, the file the
// journal syncs. Every device then gets them with its next sync. The in-page
// import keeps working on a device Delta accepts; both tag each trade with the
// Delta order that closed it, so a trade one of them brought in is never added
// twice (the journal's merge keeps one copy per tag as well).
//
// Where it left off (the newest fill read and the positions still open then)
// is kept in journal.json as `deltaImport`, with the reason when a run fails,
// which the journal's Delta card shows. The wallet figure goes in
// `deltaBalance`, the field the journal already shares between devices.
//
// Environment (GitHub sets the ones marked *):
//   DELTA_API_KEY, DELTA_API_SECRET       the repo's Actions secrets (a Read Data key)
//   GITHUB_TOKEN                          the job's token (contents: write)
//   GITHUB_REPOSITORY*, GITHUB_API_URL*   where journal.json lives
//   JOURNAL_BRANCH                        its branch (main)
//   JOURNAL_TZ                            the clock trades are written in (Asia/Kolkata)
//   DELTA_BASE                            tests point this at a fake Delta
//   IP_URL                                where this PC's public IP is read (api.ipify.org)
import crypto from 'node:crypto';
import fs from 'node:fs';

const env = process.env;
const DELTA_BASE = (env.DELTA_BASE || 'https://api.india.delta.exchange').replace(/\/+$/, '');
const GH_API = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const REPO = env.GITHUB_REPOSITORY || '', BRANCH = env.JOURNAL_BRANCH || 'main', SYNC_PATH = 'journal.json';
const TZ = env.JOURNAL_TZ || 'Asia/Kolkata';
const IP_URL = env.IP_URL || 'https://api.ipify.org';
// The journal's own limits: 60 pages of 200 fills, and the checklist every new trade starts with.
const PAGE_SIZE = 200, MAX_PAGES = 60, RULE_COUNT = 5;
// The shared wallet figure is written when it moves, or hourly while it holds.
const BAL_HOLD_MS = 60 * 60e3;

// ---- the journal's own helpers, as index.html has them ----
function num(v) {
  if (v == null) return NaN;
  const t = String(v).trim().replace(/[,₹$\s]/g, '');
  const m = t.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
}
function sum(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }
function uniq(a) { const s = {}, o = []; a.forEach(x => { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3); }
// Delta's created_at carries six fraction digits; Date.parse only trusts milliseconds.
function deltaMicros(isoStr) {
  const t = Date.parse(String(isoStr).replace(/(\.\d{3})\d+/, '$1'));
  return isFinite(t) ? t * 1000 : 0;
}
// The day and HH:MM a trade is written with, on the journal's clock (the
// browser uses the phone's; this uses JOURNAL_TZ, whatever the PC's clock).
let clock;
function localParts(when) {
  clock = clock || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = {};
  clock.formatToParts(new Date(when)).forEach(x => { p[x.type] = x.value; });
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
function nearlyEqual(a, b, tolRel) {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) <= scale * tolRel;
}
function findExistingTrade(existingByKey, key, qty, entry, exit) {
  const list = existingByKey[key];
  if (!list) return null;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (nearlyEqual(t.qty, qty, 0.01) && nearlyEqual(t.entry, entry, 0.005) && nearlyEqual(t.exit, exit, 0.005)) return t;
  }
  return null;
}
// The journal's deltaFillsToTrades: fills are executions, rebuilt into trades
// per symbol and tagged with the order that closed each one. `resume` says
// where the previous run left each symbol (fills up to `upTo` are done, except
// for a symbol still open, rebuilt from the fill that opened it). Keep the two
// in step: tests/smoke.mjs runs both on the same fills.
function fillsToTrades(fills, account, seenOrders, existingByKey, contractValues, resume) {
  contractValues = contractValues || {};
  resume = resume || null;
  const stillOpen = {}, skipped = [], bySym = {}, trades = [], matched = [];
  fills.forEach(f => { (bySym[f.product_symbol] = bySym[f.product_symbol] || []).push(f); });
  Object.keys(bySym).forEach(sym => {
    const list = bySym[sym].slice().sort((a, b) => a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0);
    if (!(contractValues[sym] > 0)) { skipped.push(sym); return; }
    const cv = contractValues[sym];
    const openAt = resume && resume.open ? resume.open[sym] : null;
    const skipTo = resume ? Math.max(resume.upTo || 0, (resume.skip && resume.skip[sym]) || 0) : 0;
    const fresh = f => { const t = deltaMicros(f.created_at); return openAt ? t >= openAt : t > skipTo; };
    const use = resume ? list.filter(fresh) : list;
    let pos = 0, eQty = 0, eVal = 0, xQty = 0, xVal = 0, fees = 0, dir = null, startT = null;
    function emit(closeOrderId, closeAt) {
      const src = 'delta:' + closeOrderId;
      if (seenOrders[src]) return;
      const open = localParts(startT), close = localParts(closeAt);
      const entry = +(eVal / eQty).toFixed(6), exit = +(xVal / xQty).toFixed(6);
      const key = account.id + '|' + sym + '|' + open.day + '|' + dir;
      // Logged by hand before Delta brought it in: that trade gets the order tag.
      const already = findExistingTrade(existingByKey, key, eQty, entry, exit);
      if (already) { matched.push([already, src]); seenOrders[src] = true; return; }
      trades.push({
        id: uid(), accountId: account.id, date: open.day,
        time: open.hm, exitTime: close.hm, exitDate: close.day,
        symbol: sym, direction: dir,
        entry, exit,
        stop: 0, qty: +eQty.toFixed(6), fees: +fees.toFixed(6),
        leverage: account.defaultLeverage || 1,
        setup: '', rules: new Array(RULE_COUNT).fill(false), notes: '',
        src
      });
      seenOrders[src] = true;
    }
    use.forEach(f => {
      const qty = Math.abs(num(f.size)) * cv;
      const price = num(f.price);
      const fee = num(f.commission) || 0;
      if (!qty || !isFinite(price)) return;
      const signed = f.side === 'buy' ? qty : -qty;
      if (pos === 0) {
        dir = signed > 0 ? 'long' : 'short';
        startT = f.created_at; eQty = qty; eVal = qty * price; fees = fee; pos = signed;
        return;
      }
      if ((pos > 0) === (signed > 0)) {
        eQty += qty; eVal += qty * price; fees += fee; pos += signed;
        return;
      }
      const posBefore = pos;
      const close = Math.min(qty, Math.abs(posBefore));
      const feeClose = fee * (close / qty);
      xQty += close; xVal += close * price; fees += feeClose;
      pos = posBefore + signed;
      if (close >= Math.abs(posBefore) - 1e-9) {
        emit(f.order_id, f.created_at);
        pos = 0; eQty = 0; eVal = 0; xQty = 0; xVal = 0; fees = 0; dir = null; startT = null;
        const leftover = qty - close;
        if (leftover > 1e-9) {
          dir = signed > 0 ? 'long' : 'short';
          startT = f.created_at; eQty = leftover; eVal = leftover * price;
          fees = fee - feeClose; pos = signed > 0 ? leftover : -leftover;
        }
      }
    });
    if (pos !== 0 && startT) stillOpen[sym] = deltaMicros(startT);
  });
  return { trades, matched, open: stillOpen, skipped: uniq(skipped) };
}
// The trades go into the crypto book (preferring one named Delta), as in the journal.
function deltaAccount(data) {
  const crypto = (Array.isArray(data.accounts) ? data.accounts : []).filter(a => a && a.id && a.market === 'crypto' && !a.reportBroker);
  return crypto.find(a => /delta/i.test(String(a.name || ''))) || crypto[0] || null;
}
function parseDeltaBalance(body) {
  const meta = body && body.meta;
  const eq = meta && parseFloat(meta.net_equity);
  if (isFinite(eq)) return { value: eq, field: 'net equity' };
  const rows = (body && body.result) || [];
  const usd = rows.filter(r => /^(USD|USDT|USDC)$/i.test(r.asset_symbol || (r.asset && r.asset.symbol) || ''));
  const vals = usd.map(r => parseFloat(r.balance)).filter(isFinite);
  if (vals.length) return { value: sum(vals), field: 'wallet balance' };
  return null;
}

// ---- Delta ----
// Every private call is signed: HMAC-SHA256 (hex) of method + timestamp + path + query.
async function deltaCall(path, query = '', signed = true) {
  const qs = query ? '?' + query : '';
  const headers = { 'User-Agent': 'journal-delta-import', Accept: 'application/json' };
  if (signed) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    headers['api-key'] = env.DELTA_API_KEY;
    headers.timestamp = timestamp;
    headers.signature = crypto.createHmac('sha256', env.DELTA_API_SECRET).update('GET' + timestamp + path + qs).digest('hex');
  }
  let res, text;
  try {
    res = await fetch(DELTA_BASE + path + qs, { headers, signal: AbortSignal.timeout(30000) });
    text = await res.text();
  } catch (e) {
    throw { network: (e && e.cause && e.cause.code) || (e && e.name === 'TimeoutError' ? 'no answer in 30 seconds' : (e && e.message) || String(e)) };
  }
  let body; try { body = text ? JSON.parse(text) : {}; } catch (e) { body = { raw: text.slice(0, 200) }; }
  if (res.status !== 200) throw { status: res.status, body };
  return body;
}
async function fetchFills(startMicros) {
  let fills = [], after = null, pages = 0;
  for (;;) {
    pages++;
    const q = 'page_size=' + PAGE_SIZE + (startMicros ? '&start_time=' + startMicros : '') + (after ? '&after=' + after : '');
    const body = await deltaCall('/v2/fills', q);
    const rows = Array.isArray(body.result) ? body.result : [];
    fills = fills.concat(rows);
    after = body.meta && body.meta.after;
    if (!(after && rows.length && pages < MAX_PAGES)) return { fills, capped: pages >= MAX_PAGES && !!after };
  }
}
// A fill's size is in contracts; each perpetual has its own contract value. Public, unsigned.
async function fetchContractValues() {
  const body = await deltaCall('/v2/products', 'contract_types=perpetual_futures&page_size=1000', false);
  const map = {};
  (Array.isArray(body.result) ? body.result : []).forEach(p => { if (p && p.symbol) map[p.symbol] = num(p.contract_value); });
  return map;
}
// The IP this PC goes out on, for the reason a refused key gives.
async function publicIp() {
  try {
    const r = await fetch(IP_URL, { signal: AbortSignal.timeout(8000) });
    const t = r.ok ? (await r.text()).trim() : '';
    return /^(\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,39}$/i.test(t) ? t : '';
  } catch (e) { return ''; }
}
function oneLine(v) { return String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160); }
function deltaWhy(r, ip) {
  if (r && r.network) return `Could not reach Delta (${oneLine(r.network)}). If this keeps happening, check the PC's internet.`;
  const err = r && r.body && r.body.error, code = err && (err.code || (typeof err === 'string' ? err : ''));
  if (code === 'ip_not_whitelisted_for_api_key') return ip
    ? `Delta refused this PC's IP ${ip}: it isn't whitelisted on the key. On Delta, add ${ip} to the key's IPs (or make a Read Data key for it and update the two secrets).`
    : "Delta refused this PC's IP: it isn't whitelisted on the key. Open api.ipify.org on the PC and add that IP to the key on Delta.";
  if (code === 'invalid_api_key') return 'Delta refused the key. Check DELTA_API_KEY and DELTA_API_SECRET were copied in full.';
  if (code === 'insufficient_permissions') return "This Delta key doesn't have Read Data permission.";
  if (code === 'expired_signature' || code === 'signature_expired') return "Delta says the request was too old: check the PC's clock is right.";
  if (code) return `Delta refused the request (${oneLine(code)}).`;
  if (r && r.contracts) return "Delta's contract sizes could not be read, so nothing was imported (quantities would be wrong). The next run tries again.";
  if (r && r.status === 429) return 'Delta says too many requests. The next run tries again.';
  if (r && r.status >= 500) return `Delta is having trouble (it answered ${r.status}). The next run tries again.`;
  if (r && r.status) return `Delta answered ${r.status}${r.body && r.body.raw ? ': ' + oneLine(r.body.raw) : ''}.`;
  return 'Import failed: ' + oneLine((r && r.message) || r || 'unknown reason');
}
// Delta names the IP it saw on a refusal; else the PC asks api.ipify.org.
async function refusedIp(r) {
  const err = r && r.body && r.body.error;
  if (!err || err.code !== 'ip_not_whitelisted_for_api_key') return '';
  const seen = err.context && (err.context.client_ip || err.context.ip);
  return /^[0-9a-f.:]{3,45}$/i.test(String(seen || '')) ? String(seen) : publicIp();
}

// ---- journal.json on GitHub ----
function gh(path, opts = {}) {
  return fetch(`${GH_API}/repos/${REPO}${path}`, Object.assign({}, opts, {
    headers: Object.assign({
      Authorization: 'Bearer ' + env.GITHUB_TOKEN, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'journal-delta-import'
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
    body: JSON.stringify({ message, content: Buffer.from(JSON.stringify(data)).toString('base64'), branch: BRANCH, sha })
  });
  if (res.status === 409) return false;
  if (!res.ok) throw new Error(`GitHub refused to save ${SYNC_PATH} (${res.status}). The workflow needs "permissions: contents: write".`);
  return true;
}

// What the journal file already says: Delta trades by order tag (deleted ones
// too, from their tombstones), and every trade by book, symbol, day and side,
// so a trade logged by hand is matched instead of doubled.
function known(data) {
  const seen = {}, existingByKey = {};
  (Array.isArray(data.trades) ? data.trades : []).forEach(t => {
    if (!t || typeof t !== 'object') return;
    if (t.src) seen[t.src] = true;
    const key = t.accountId + '|' + t.symbol + '|' + t.date + '|' + t.direction;
    (existingByKey[key] = existingByKey[key] || []).push(t);
  });
  Object.keys(data.tombstones || {}).forEach(k => { if (k.indexOf('trades:src:') === 0) seen[k.slice(11)] = true; });
  return { seen, existingByKey };
}
function resumeOf(data) {
  const d = data.deltaImport;
  const ok = d && typeof d === 'object' && d.lastFillTime > 0 && d.openPositions && typeof d.openPositions === 'object' && !Array.isArray(d.openPositions);
  return ok ? { lastFillTime: d.lastFillTime, openPositions: d.openPositions } : null;
}
// Adds what this run found: new trades (each tag once), where it left off, the
// reason it failed, the wallet figure. Nothing changes when nothing moved.
function apply(data, got, note, balance) {
  const was = data.deltaImport && typeof data.deltaImport === 'object' ? data.deltaImport : null;
  const { seen } = known(data);
  const fresh = got ? got.trades.filter(t => !seen[t.src]) : [];
  const tag = got ? got.matched.filter(([t, src]) => !t.src && !seen[src]) : [];
  const at = new Date().toISOString();
  const next = {
    lastFillTime: got && !got.capped ? got.lastFillTime : (was && was.lastFillTime) || 0,
    openPositions: got && !got.capped ? got.open : (was && was.openPositions) || {}
  };
  if (note) next.note = note;
  const moved = !was || was.lastFillTime !== next.lastFillTime || JSON.stringify(was.openPositions || {}) !== JSON.stringify(next.openPositions) || (was.note || '') !== (note || '');
  const old = data.deltaBalance && typeof data.deltaBalance === 'object' ? data.deltaBalance : null;
  const balMoved = !!balance && (!old || Math.abs(old.value - balance.value) >= 0.005 || Date.now() - (old.at || 0) >= BAL_HOLD_MS);
  if (!fresh.length && !tag.length && !moved && !balMoved) return { changed: false, added: 0 };
  tag.forEach(([t, src]) => { t.src = src; t.updatedAt = at; });
  if (fresh.length) data.trades = (Array.isArray(data.trades) ? data.trades : []).concat(fresh.map(t => Object.assign(t, { updatedAt: at })));
  // The balance before the record: the order the journal writes them in, so its sync has nothing to redo.
  if (balMoved) data.deltaBalance = { value: balance.value, field: balance.field, at: Date.now() };
  if (fresh.length || moved || tag.length) data.deltaImport = Object.assign(next, { updatedAt: at });
  return { changed: true, added: fresh.length, tagged: tag.length, noteMoved: !!was && (was.note || '') !== (note || ''), balMoved };
}

function report(text, bad) {
  console.log((bad ? '::error::' : '') + text);
  if (env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(env.GITHUB_STEP_SUMMARY, (bad ? '**Failed:** ' : '') + text + '\n'); } catch (e) {} }
}

async function main() {
  if (!env.DELTA_API_KEY || !env.DELTA_API_SECRET) {
    report('Add the DELTA_API_KEY and DELTA_API_SECRET secrets to this repository (Settings → Secrets and variables → Actions): a Delta key with Read Data, whitelisted for this PC\'s IP. Then run this again.', true);
    return 1;
  }
  if (!env.GITHUB_TOKEN || !REPO) { report('GITHUB_TOKEN and GITHUB_REPOSITORY are needed to save journal.json.', true); return 1; }
  try { localParts(Date.now()); } catch (e) { report(`JOURNAL_TZ "${TZ}" is not a time zone.`, true); return 1; }

  let { data, sha } = await readJournal();
  const account = deltaAccount(data);
  if (!account) { report('The journal has no crypto book to put Delta trades in. Add one in the journal (Settings → Books), sync, then run this again.', true); return 1; }

  // From where the last run left off, reaching back to the start of any
  // position still open then; the first run reads the whole history once
  // (trades already in the journal are matched by their order tag).
  const resume = resumeOf(data);
  const openStarts = resume ? Object.keys(resume.openPositions).map(k => resume.openPositions[k]).filter(v => v > 0) : [];
  const since = resume ? Math.min(resume.lastFillTime, ...openStarts) : 0;
  let got = null, failed = null, balance = null, balWhy = '';
  try {
    const [r, cv] = await Promise.all([fetchFills(since), fetchContractValues().catch(() => ({}))]);
    if (!Object.keys(cv).length) throw { contracts: true };
    const maxT = r.fills.reduce((m, f) => { const t = deltaMicros(f.created_at); return t > m ? t : m; }, resume ? resume.lastFillTime : 0);
    got = { fills: r.fills, capped: r.capped, cv, maxT, resume: resume ? { upTo: resume.lastFillTime, open: resume.openPositions } : null };
  } catch (r) {
    if (r instanceof Error) throw r;
    failed = deltaWhy(r, await refusedIp(r));
  }
  if (got) { try { balance = parseDeltaBalance(await deltaCall('/v2/wallet/balances')); if (!balance) balWhy = 'an answer with no balance in it'; } catch (r) { balWhy = deltaWhy(r, ''); } }
  const note = failed ? failed.slice(0, 300) : null;

  let res, built = null;
  for (let attempt = 1; ; attempt++) {
    // Rebuilt from the file as it is now, so a trade another device added meanwhile counts once.
    if (got) {
      const k = known(data);
      const b = fillsToTrades(got.fills, deltaAccount(data) || account, k.seen, k.existingByKey, got.cv, got.resume);
      built = { trades: b.trades, matched: b.matched, open: b.open, skipped: b.skipped, capped: got.capped, lastFillTime: got.maxT || 0 };
    }
    res = apply(data, built, note, balance);
    if (!res.changed) break;
    data.savedAt = new Date().toISOString();
    const message = res.added ? `Delta: ${res.added} new trade${res.added === 1 ? '' : 's'}` : res.tagged ? 'Delta: trades logged by hand matched' : failed ? 'Delta import failed' : res.noteMoved ? 'Delta import working again' : res.balMoved ? 'Delta balance' : 'Delta import position';
    if (await writeJournal(data, sha, message)) break;
    if (attempt >= 4) throw new Error(`${SYNC_PATH} kept changing while saving; the next run tries again.`);
    ({ data, sha } = await readJournal());
  }

  if (failed) { report(failed, true); return 1; }
  let msg = res.added ? `Imported ${res.added} new trade${res.added === 1 ? '' : 's'} from Delta` : 'Up to date, no new Delta trades';
  msg += ` · ${got.fills.length} fill${got.fills.length === 1 ? '' : 's'} read`;
  if (got.capped) msg += ' · stopped at the 12,000-fill read cap; the next run reads the same window again';
  if (built.skipped.length) msg += ` · skipped ${built.skipped.join(', ')} (Delta gave no contract size)`;
  if (balance) msg += ` · balance ${balance.value} (${balance.field})`;
  else if (balWhy) msg += ` · balance not read (${balWhy.replace(/\.$/, '')})`;
  report(msg, false);
  return 0;
}

main().then(code => { process.exitCode = code; }, e => { report(String((e && e.message) || e), true); process.exitCode = 1; });
