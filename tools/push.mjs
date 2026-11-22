// Phone alerts, sent by the Delta and CoinDCX imports (lakky, 22 Nov: "phone push alerts").
//
// The journal's Settings → Connections → Phone alerts card turns them on: it
// makes a long random topic for ntfy (a free push service, no account), which
// the ntfy app on the phone subscribes to, and saves it in journal.json as
// `push` with the alert types picked there. The imports read it and, after
// they saved what they found, send one alert per kind:
//   trades    trades that closed (Delta trades, CoinDCX transactions with a P&L)
//   money     Delta deposits / withdrawals the import logged; CoinDCX wallet
//             money no trade explains, two runs in a row
//   problems  an import failing two runs in a row, then once when it works again
// ntfy.sh passes them to Apple's push service, so an iPhone gets them with the
// app closed. Anyone who knows the topic could read them, so it is long and
// random, and the journal can make a new one.
//
// What each import remembers between runs (an outage already reported, CoinDCX
// wallet money not explained yet) is `pushSent` in journal.json, which the
// journal carries as it is. Without `push` nothing here sends or writes anything.
//
//   NTFY_URL   where alerts go (https://ntfy.sh; tests point it at a fake)

const TOPIC_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function pushConfig(data, env = process.env) {
  const p = data && data.push;
  if (!p || typeof p !== 'object' || Array.isArray(p) || p.on === false || !TOPIC_RE.test(String(p.topic || ''))) return null;
  return {
    topic: String(p.topic), base: String(env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
    trades: p.trades !== false, money: p.money !== false, problems: p.problems !== false
  };
}

// One alert. Never throws: an alert that can't go out must not fail the import.
// Returns '' when sent, else why not.
export async function sendPush(cfg, msg) {
  const body = { topic: cfg.topic, title: String(msg.title).slice(0, 120), message: String(msg.message || msg.title).slice(0, 1500), priority: msg.priority || 3 };
  if (msg.tags && msg.tags.length) body.tags = msg.tags;
  try {
    const r = await fetch(cfg.base + '/', { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'victus-journal-import' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return r.ok ? '' : `ntfy answered ${r.status}`;
  } catch (e) { return `could not reach ntfy (${String((e && e.message) || e).slice(0, 80)})`; }
}
export async function sendAll(cfg, alerts) {
  const out = [];
  for (const a of alerts) {
    const why = await sendPush(cfg, a);
    out.push(why ? `phone alert "${a.title}" not sent: ${why}` : `phone alert sent: ${a.title}`);
  }
  return out;
}

// ---- what each import remembers ----
export function sentOf(data, key) {
  const s = data && data.pushSent && typeof data.pushSent === 'object' && !Array.isArray(data.pushSent) ? data.pushSent[key] : null;
  return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
}
// Saves this import's part; true when it changed. `updatedAt` stays even when
// nothing is left, so a device's older copy never wins a merge and brings it back.
export function setSent(data, key, next) {
  const tidy = {};
  Object.keys(next).forEach(k => {
    const v = next[k];
    if (v && typeof v === 'object') { if (Object.keys(v).length) tidy[k] = v; } else if (v) tidy[k] = v;
  });
  if (JSON.stringify(tidy) === JSON.stringify(sentOf(data, key))) return false;
  const o = {};
  const cur = data.pushSent && typeof data.pushSent === 'object' && !Array.isArray(data.pushSent) ? data.pushSent : {};
  Object.keys(cur).forEach(k => { if (k !== key && k !== 'updatedAt') o[k] = cur[k]; });
  if (Object.keys(tidy).length) o[key] = tidy;
  o.updatedAt = new Date().toISOString();
  data.pushSent = o;
  return true;
}

// ---- the alerts ----
const SYM = { USD: '$', INR: '₹' };
// "+$1.20" / "−₹63.00"; unsigned: "₹63.00".
export function money(v, cur, unsigned) {
  const a = Math.abs(v), d = a > 0 && a < 0.01 ? 4 : 2;
  return (unsigned ? '' : v < 0 ? '−' : '+') + (SYM[cur] || '') + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many || one + 's'); }

// lines: [{ label, pnl }] in one currency.
export function tradesAlert(name, lines, cur) {
  if (!lines.length) return null;
  const total = lines.reduce((s, x) => s + x.pnl, 0), shown = lines.slice(0, 6).map(x => `${x.label} ${money(x.pnl, cur)}`);
  if (lines.length > 6) shown.push(`+ ${lines.length - 6} more`);
  return { title: `${name}: ${plural(lines.length, 'trade')} closed, ${money(total, cur)}`, message: shown.join('\n'), tags: [total >= 0 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'] };
}
// moves: [{ amount (+ in, − out), date 'YYYY-MM-DD' }]
export function movesAlert(name, moves, cur) {
  if (!moves.length) return null;
  const day = d => { const t = new Date(d + 'T00:00:00Z'); return isFinite(t) ? t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : d; };
  const one = m => `${m.amount >= 0 ? 'Deposit' : 'Withdrawal'} ${money(m.amount, cur)} · ${day(m.date)}`;
  const shown = moves.slice(0, 6).map(one);
  if (moves.length > 6) shown.push(`+ ${moves.length - 6} more`);
  return {
    title: moves.length === 1 ? `${name}: ${one(moves[0]).replace(/ · .*$/, '').toLowerCase()}` : `${name}: ${plural(moves.length, 'deposit / withdrawal', 'deposits / withdrawals')}`,
    message: shown.join('\n') + '\nAdded to Money in / out in the journal.', tags: ['moneybag']
  };
}
// An import failing two runs in a row is one alert; the first run that works after it is another.
// prevNote: the reason the last run left in journal.json; note: this run's (or '').
export function outageStep(cfg, was, prevNote, note, name) {
  const down = !!(was && was.down);
  if (note && prevNote && !down && cfg.problems) {
    return { down: true, alert: { title: `${name} import is failing`, message: `${note}\nNew trades and the wallet don't come in until this is fixed.`, tags: ['warning'], priority: 4 } };
  }
  if (!note && down) {
    return { down: false, alert: cfg.problems ? { title: `${name} import works again`, message: 'New trades and the wallet are coming in again.', tags: ['white_check_mark'] } : null };
  }
  return { down: down && cfg.problems, alert: null };
}
