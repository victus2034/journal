"""Independent retest of the journal's Signals tab (lakky, 2026-11-12: "i told you to recheck
backtest result of journal and most of the times its differ ... make sure it wont happen again";
2026-11-23: "do a backtest of all the alerts and make sure it matches with the backtest of journal
with all conditions").

Written from the stated rules, not from index.html: it reads the scanner's own files, picks the
alerts itself, applies every filter of the tab itself, sets the SL itself, books the scanner's
results itself and plays every trade candle by candle (no path summary). tests/smoke.mjs
(parityRun) runs the journal on the same alerts and candles and fails if any trade differs, and
tools/signals-audit.mjs does the same on a full snapshot of real data.

Which alerts (each rule lakky's):
- Fib / trendline: the scanner's rebuilt history (fibtl_rebuild_*, from 1 Jun) and, from its
  cutoff minute (IST) on, the live alerts (fib_trendline_alert_records / _results; the level
  what-ifs fib_level_results). A rebuilt row whose fill fell in a news window is left out.
- Zones (S/R): the rebuilt zones (zone_rebuild_4h, zone_rebuild_htf, from 1 Sep) and, from their
  cutoff on, the live ones (crypto / NSE alert logs, the scanner's pending and finalized grades;
  one alert = symbol, minute, timeframe, side; the most final grade wins; 30m zones are gone).
  Before the cutoff a live copy is dropped, not merged: a rebuilt zone with no stop has no Exit at.
- Only symbols the scanner still watches (its config.py lists: crypto, gold / silver, xStocks)
  and NSE from 1 Sep 2026.
- Every alert's time is its IST minute.

Filters, in the tab's order: Level / Levels on / Type (fib: the level it entered at, from the
record; Level = every fib played at that level - its own alert or the scanner's what-if, same
stop; Type: support / resistance / their breaks / touches / breaks, from the record's line and
broken flag), SL, Early entry, Market (Indian = NSE), Channel, Period (IST dates; a range picked backwards is the same days), Assets and
Coins (crypto only, not with Indian or an NSE channel: coins / xStocks / gold-silver from the
scanner's lists; Top 3 / 5 by market cap or by alerts; Top 10 / 20 / 30 by 30-day CoinDCX volume
among coins on both brokers, from the scanner's research/out/top30; CoinDCX / Delta = the
broker lists the coin: research/out/demo_sl_audit/coindcx_specs.json, Delta's product list),
BTC day (BTC's market going into the UTC day from closed Delta 1d candles: EMA20 / ATR14, 0.75
ATR band, EMA vs 5 days before, 40 candles first), BTC move (BTC's last closed 15m close at the
alert vs the UTC day's open, +-1.5%, with / against / flat for the alert's side), tiny stops
(under 0.2% left out of the stats when picked).

Scanner exit (no Exit at): the scanner's result booked the way lakky trades it: a fib or
trendline (or a plan with a 1R target) is out in full at +1R when the scanner's trade reached 1R
or 2R, -1R at its stop, breakeven (0.0933% past entry crypto, 0.120% NSE) only where the BE stop
closed it before 1R; other plans (1D+ zones) are held for 2R (+2R, or the BE / stop that closed
it after 1R); a timeout or open trade has no R; 4H zones keep the scanner's own net R. Every R
less the round trip (0.0826% crypto, 0.1063% NSE, of the stop %), every stop 0.05% slipped. No
fees adds the round trip back. The journal keeps these R to 4 decimals (not the 4H zones' net R).

Exit at (1R-3R, 1-3%):
- Fill: a rebuilt touch row waits for the first 15m candle reaching the band (0.75%, 3% on
  1W / 1M) and fills from the next candle on; others fill from the alert. The fill must come
  within 20 candles of the alert's timeframe.
- Stop: the alert's; or the last closed candle of the alert's timeframe before the alert whose
  wick / body / closer of the two is at least the gap past entry (1W = Monday weeks and 1M =
  calendar months built from days, a partial first one dropped, 300 looked back); a fixed % from
  entry; fib Next level (just past the next deeper level by 25% of a box, box = 0.11 of the move)
  or L4 box (L4's own stop for every level).
- Exit: a candle touching the stop and the target counts as the stop; the fill candle counts
  only its close. Move SL (BE / SL shift) and Trail TP move the stop from the next candle, the
  higher stop wins; a Move SL trigger at or past the target never fires; Trail TP locks the
  first target. Hold: till TP / SL, or 20 candles after the fill (closed at the last close).
  Costs: 0.0826% round trip (NSE 0.1063%; off with no fees), every stop fills 0.05% past it.
- NSE: played on the NSE job's 60m candles (Yahoo); "20 candles" counts NSE candles of the
  alert's timeframe (4H = 09:15-13:15 and 13:15-15:30 IST, days, Monday weeks, months), so nights,
  weekends and holidays don't count. The candle SL looks at the job's own 4H / 1D / 1W / 1M
  candles closed before the alert, 300 back.
- Partial: a share closes at a level (a limit, no slippage) on the first candle reaching it,
  after the stop check; another share at the Move SL trigger when "book" is set. Shares of the
  whole position, lowest level first. Without Trail TP a level at or past the target books
  nothing. Fees stay one round trip.
- Early entry: the order fills early% before the entry; break alerts keep theirs. Only the fill
  moves; the trade is played in the alert's R, then counted from the fill to the stop:
  (R x risk - adv) / (risk + adv), the fee on the fill's own stop %.

Stats (the tab's strip): alerts, filled / no fill, win rate (R > 0), total R, total % (R x stop
%), average R, profit factor, max drawdown and longest losing run (alerts in the order sent),
best / worst; alerts of one minute in key order.

    python3 tools/signals-retest.py FIXTURE.json.gz COMBOS.json OUT.json [--app APP.json]
    python3 tools/signals-retest.py --data DIR --nse DIR --config config.py --research DIR COMBOS.json OUT.json [--app APP.json]

FIXTURE: {now, records, results, candles: {"SYM_15m": [[time s, o, h, l, c], ...]}, nse: {...}}.
DIR (tools/signals-audit.mjs's snapshot): state/<file>.gz, candles/<SYM>_<res>.json.gz,
products.json, meta.json. --research: the scanner's research/out (top30, demo_sl_audit).
With --app (the journal's own results), every alert, trade and strip number is compared and the
exit code is 1 if any differs.
"""
import gzip, json, math, os, re, struct, sys
from decimal import Decimal, ROUND_HALF_UP
from bisect import bisect_left, bisect_right
from datetime import date, datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
TFM = {"4h": 240, "1d": 1440, "1w": 10080, "1M": 43200}
CHAN = {"4h": "4H", "1d": "1D", "1w": "1W", "1M": "1MO"}
COST, SLIP, BARS, RESM = {"crypto": 0.0826, "nse": 0.1063}, 0.05, 20, 15
BE_PCT = {"crypto": 0.0933, "nse": 0.120}
NSE_TF = {"4h": "4H", "1d": "1D", "1w": "1W", "1M": "1M"}
NSE_SINCE = "2026-09-01"
FIB = {"L1": 0.34, "L2": 0.45, "L3": 0.55, "L4": 0.66}
TOP_CAP = ["BTC", "ETH", "XRP", "BNB", "SOL", "DOGE", "ADA", "HYPE", "LINK", "AVAX"]  # lakky's market-cap order
TOL = 2e-3


def r4(v):
    """A result kept to 4 decimals, as the journal stores the scanner's (JavaScript's toFixed(4))."""
    return None if v is None else float(Decimal(v).quantize(Decimal("1e-4"), rounding=ROUND_HALF_UP))


def f32(v):
    return struct.unpack("f", struct.pack("f", v))[0]


def jl(text):
    out = []
    for line in (text or "").replace("\r", "").split("\n"):
        if not line.strip():
            continue
        try:
            out.append(json.loads(re.sub(r'([:\[,]\s*)-?(?:NaN|Infinity)\b', r'\1null', line)))
        except ValueError:
            pass
    return out


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else None


def ist(ts):
    d = datetime.fromtimestamp(ts, IST)
    return d.strftime("%Y-%m-%d"), d.strftime("%H:%M"), int(ts // 60 * 60 * 1000)


def base_of(sym):
    b = re.sub(r"[^A-Z0-9]", "", re.split(r"[/:]", str(sym or "").upper())[0])
    return re.sub(r"(USDT|USDC|USD)$", "", b)


def nse_bucket(ms, tf):
    """The NSE candle of timeframe tf (minutes) the moment ms is in, as a growing number."""
    d = datetime.fromtimestamp(ms / 1000, IST)
    day = date(d.year, d.month, d.day).toordinal()
    if tf >= 43200:
        return d.year * 12 + d.month
    if tf >= 10080:
        return day - d.weekday()
    if tf >= 1440:
        return day
    return day * 2 + (1 if d.hour * 60 + d.minute >= 13 * 60 + 15 else 0)


def nse_closed_at(t, tf):
    """When the NSE candle opened at t (s) has closed, in ms."""
    d = datetime.fromtimestamp(t, IST)
    if tf == 240:
        return (t + (4 * 3600 if d.hour * 60 + d.minute < 13 * 60 + 15 else 2 * 3600 + 15 * 60)) * 1000
    if tf == 1440:
        return (t + 6 * 3600 + 15 * 60) * 1000
    if tf == 10080:
        return (t + 7 * 86400) * 1000
    nxt = (d.replace(day=1) + timedelta(days=32)).replace(day=1, hour=9, minute=15, second=0, microsecond=0)
    return nxt.timestamp() * 1000


def load(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        return json.load(f)


# ---------------------------------------------------------------- the scanner's results, booked
def book(x, entry, sl, mkt, side, tp1):
    """(filled, outcome, R) of one scanner result, booked as lakky trades it (see the docstring)."""
    risk = abs(entry - sl) / entry * 100 if entry > 0 else 0
    cost = COST[mkt] / risk if risk > 0 else 0
    s = -1 if side == "short" else 1
    slr = lambda: -1 - (sl / entry * SLIP / risk if risk > 0 else 0) - cost
    ber = lambda: ((BE_PCT[mkt] - (1 + s * BE_PCT[mkt] / 100) * SLIP) / risk if risk > 0 else 0) - cost
    if not x:
        return None, "", None
    o = x.get("outcome")
    if o == "no fill":
        return False, o, None
    if not x.get("filled"):
        return None, "", None
    if tp1 and o in ("1R", "2R"):
        return True, "+1R", 1 - cost
    if o == "2R":
        return True, "+2R", 2 - cost
    if o == "1R":
        if x.get("be"):
            return True, "BE", ber()
        if x.get("sl"):
            return True, "SL", slr()
        return True, "timeout" if x.get("resolved") else "open", None
    if o == "SL":
        return True, "SL", slr()
    if o == "BE":
        return True, "BE", ber()
    return True, "timeout" if o == "timeout" else "open", None


# ---------------------------------------------------------------- loading
class Data:
    pass


def fibtl_alert(r, res, lv, mkt_ok):
    """One fib / trendline / 1D+ zone record -> an alert, or None."""
    plan = r.get("plan") or {}
    entry, sl = num(plan.get("entry")), num(plan.get("sl"))
    if not r.get("id") or not r.get("sent_ts") or entry is None or sl is None:
        return None
    x = res.get(r["id"])
    if r.get("rebuild") and x and x.get("news_window"):
        return None
    mkt = "nse" if r.get("market") == "nse" else "crypto"
    d, hm, t0 = ist(r["sent_ts"])
    kind = {"trendline": "trendline", "zone": "zone"}.get(r.get("kind"), "fib")
    tp1 = plan.get("target_r") == 1 or kind in ("fib", "trendline")
    filled, outcome, rr = book(x, entry, sl, mkt, plan.get("side"), tp1)
    rr = r4(rr)
    key = str(r["id"])
    parts = str(r.get("key") or "").split("|")
    a = dict(key=key, kind=kind, mkt=mkt, raw=r.get("symbol"), sym=str(r.get("symbol") or "").split("/")[0].replace(".NS", "").upper(),
             tf=r.get("tf"), chan=("NSE " if mkt == "nse" else "CRYPTO ") + CHAN.get(r.get("tf"), str(r.get("tf")).upper()),
             side="short" if plan.get("side") == "short" else "long", entry=entry, stop=sl, t0=t0, date=d, time=hm,
             rb=bool(r.get("rebuild")), brk=bool(r.get("broken")) or key.startswith("tlbreak|"), scan=(filled, outcome, rr), tp1=tp1)
    a["s"] = -1 if a["side"] == "short" else 1
    if kind == "trendline":
        a["line"] = r["line"] if r.get("line") in (0, 1) else (int(parts[3]) if len(parts) > 3 and parts[3] in ("0", "1") else (1 if a["side"] == "short" else 0))
    if kind == "fib":
        lvl = r.get("level") if r.get("level") in FIB else None
        if not lvl and len(parts) > 6:
            tag = parts[7].split("@")[0] if len(parts) > 7 else ""
            lvl = tag if tag in FIB else {"1": "L1", "2": "L3"}.get(parts[6])
        a["lvl"] = lvl
        a["top"] = num(r.get("top")) if num(r.get("top")) is not None else (float(parts[5]) if len(parts) > 5 else None)
        w = (lv or {}).get(r["id"]) if lv else None
        if isinstance(w, dict):
            a["whatif"] = {}
            for k in ("L1", "L2", "L4"):
                y = w.get(k)
                if not isinstance(y, dict) or num(y.get("entry")) is None:
                    continue
                if y.get("outcome") == "not reached":
                    a["whatif"][k] = (y["entry"], (False, "", None))
                else:
                    f_, o_, r_ = book(y, y["entry"], sl, mkt, plan.get("side"), tp1)
                    a["whatif"][k] = (y["entry"], (f_, o_, r4(r_)))
    return a


def zone_alerts(files, zr_cut, watch_ok):
    """4H zones: rebuilt, finalized, pending and live rows, one per symbol / minute / tf / side."""
    best = {}
    def put(row, rank):
        d, hm, _ = ist(row["when"].timestamp())
        if str(row["tf"]).lower() == "30m" or (zr_cut and not row["rb"] and d + " " + hm < zr_cut):
            return  # 30m zones are gone; before the cutoff the rebuilt history replaces every other copy
        k = row["key"]
        cur = best.get(k)
        if cur is None:
            best[k] = dict(row, rank=rank)
            return
        lo, hi = (cur, dict(row, rank=rank)) if cur["rank"] <= rank else (dict(row, rank=rank), cur)
        out = dict(lo)
        for f, v in hi.items():
            if f != "filled" and v not in (None, ""):
                out[f] = v
        out["filled"] = hi["filled"] if hi["rank"] >= 3 else True if hi["filled"] is True else lo["filled"]
        out["rank"] = hi["rank"]
        best[k] = out
    def key(sym, when, tf, side):
        return "|".join([str(sym or "").upper(), when.strftime("%Y-%m-%dT%H:%M"), str(tf or ""), "short" if side == "short" else "long"])
    for name, mkt in (("crypto_alert_records.jsonl", "CRYPTO"), ("nse_alert_records.jsonl", "NSE")):
        for r in jl(files.get(name)):
            try:
                when = datetime.fromisoformat(str(r["delivered_at_utc"]).replace("Z", "+00:00"))
            except (KeyError, ValueError):
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            when = when.astimezone(timezone.utc)
            put(dict(key=key(r.get("symbol"), when, r.get("timeframe"), r.get("side")), when=when, raw=r.get("symbol"), side=r.get("side"), market=mkt,
                     tf=r.get("timeframe"), stop=num(r.get("stop_price")), lo=num(r.get("zone_bottom")), hi=num(r.get("zone_top")), filled=None, r=None, rb=False), 1)
    for name, rank, rbfile in (("daily_backtest_pending_records.jsonl", 2, False), ("daily_backtest_finalized_records.jsonl", 3, False), ("zone_rebuild_4h.jsonl", 3, True)):
        if rbfile and not zr_cut:
            continue
        for r in jl(files.get(name)):
            try:
                when = datetime.fromisoformat(str(r["alert_time"]).replace("Z", "+00:00"))
            except (KeyError, ValueError):
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            when = when.astimezone(timezone.utc)
            if r.get("rebuild") and r.get("news_window"):
                continue
            put(dict(key=key(r.get("symbol"), when, r.get("timeframe"), r.get("side")), when=when, raw=r.get("symbol") or r.get("display_symbol"), side=r.get("side"),
                     market=r.get("market") or "", tf=r.get("timeframe"), stop=num(r.get("stop_price")), lo=num(r.get("zone_bottom")), hi=num(r.get("zone_top")),
                     filled=True if r.get("filled") is True else (False if r.get("outcome") == "zone_not_touched" else None),
                     r=num(r.get("net_realized_r")), rb=bool(r.get("rebuild"))), rank)
    out = []
    for z in best.values():
        d, hm, t0 = ist(z["when"].timestamp())
        side = "short" if z["side"] == "short" else "long"
        lo, hi = z["lo"], z["hi"]
        if lo is None or hi is None:
            continue
        entry = max(lo, hi) if side == "long" else min(lo, hi)
        mkt = "nse" if str(z["market"]).lower() == "nse" else "crypto"
        a = dict(key=z["key"], kind="zone", mkt=mkt, raw=z["raw"], sym=str(z["raw"] or "").split("/")[0].replace(".NS", "").upper(), tf=z["tf"],
                 chan=(str(z["market"]) + " " + str(z["tf"])).strip().upper(), side=side, s=-1 if side == "short" else 1, entry=entry, stop=z["stop"],
                 t0=t0, date=d, time=hm, rb=z["rb"], brk=False, scan=(z["filled"], "", z["r"]), tp1=False)
        out.append(a)
    return out


def watch_lists(config_text):
    """The scanner's config.py lists -> {base: "coin" | "other" | "stock"}."""
    kinds = {}
    for name, kind in (("CRYPTO_WATCHLIST", "coin"), ("OTHER_WATCHLIST", "other"), ("XSTOCK_WATCHLIST", "stock")):
        m = re.search(r"^" + name + r"\s*(?::[^=\n]*)?=\s*\[([\s\S]*?)^\]", config_text or "", re.M)
        if not m:
            continue
        for q in re.findall(r"[\"']([A-Za-z0-9]+)[\"']", re.sub(r"#.*", "", m.group(1))):
            b = base_of(q)
            kinds[b] = kind
            if kind == "stock" and b[-1:] in ("X", "B") and len(b) > 2:
                kinds[b[:-1]] = kind
    return kinds


def series_from(rows, now):
    rows = sorted((r for r in rows if r[0] <= now and min(r[1:5]) > 0), key=lambda r: r[0])
    return ([r[0] for r in rows], rows)


def load_fixture(path):
    fx = load(path)
    D = Data()
    D.now = fx["now"]
    D.series = {k: series_from(rows, D.now) for k, rows in fx["candles"].items()}
    D.nse_files = fx.get("nse") or {}
    D.alerts = [a for a in (fibtl_alert(r, fx["results"], None, None) for r in fx["records"] if r.get("market") in ("crypto", "nse")) if a]
    D.kinds = None  # every symbol is watched
    D.dcx, D.delta, D.vol = set(), set(), {}
    return D


def load_snapshot(data, nse_dir, config, research):
    D = Data()
    meta = json.load(open(os.path.join(data, "meta.json")))
    D.now = meta["end"]
    files = {}
    for f in os.listdir(os.path.join(data, "state")):
        with gzip.open(os.path.join(data, "state", f), "rt") as fh:
            files[f[:-3]] = fh.read()
    D.series = {}
    for f in os.listdir(os.path.join(data, "candles")):
        with gzip.open(os.path.join(data, "candles", f), "rt") as fh:
            D.series[f[:-8]] = series_from(json.load(fh), D.now)
    D.nse_files = {}
    if nse_dir:
        for f in os.listdir(nse_dir):
            if f.endswith((".a.json", ".b.json")):
                D.nse_files[f] = open(os.path.join(nse_dir, f)).read()
    D.kinds = watch_lists(open(config).read()) if config else None
    prods = json.load(open(os.path.join(data, "products.json")))["result"]
    live = [p for p in prods if p.get("contract_type") == "perpetual_futures" and (not p.get("state") or p["state"] == "live")
            and float(p.get("contract_value") or 0) > 0 and float(p.get("tick_size") or 0) > 0 and float(p.get("initial_margin") or 0) > 0]
    D.delta = {p["symbol"] for p in live}
    D.alias = {p["symbol"][:-4]: p["symbol"] for p in live if "bStocks" in (p.get("short_description") or "") and p["symbol"].endswith("BUSD")}
    D.dcx = set(json.load(open(os.path.join(research, "demo_sl_audit", "coindcx_specs.json")))["instruments"]) if research else set()
    D.vol = {x["dcx_symbol"]: x["dcx30"] for x in json.load(open(os.path.join(research, "top30", "top30.json")))} if research else {}

    def cutoff(text):
        try:
            m = json.loads(text or "null")
            d = datetime.fromisoformat(m["cutoff"].replace("Z", "+00:00")).astimezone(IST)
            return d.strftime("%Y-%m-%d %H:%M")
        except Exception:  # noqa: BLE001
            return None
    fr, zr = cutoff(files.get("fibtl_rebuild_meta.json")), cutoff(files.get("zone_rebuild_meta.json"))
    res_live = json.loads(files.get("fib_trendline_results.json") or "{}")
    lv = json.loads(files.get("fib_level_results.json") or "{}")
    res_rb = json.loads(files.get("fibtl_rebuild_results.json") or "{}")
    res_zr = json.loads(files.get("zone_rebuild_htf_results.json") or "{}")
    alerts = {}
    for r in jl(files.get("fib_trendline_alert_records.jsonl")):
        a = fibtl_alert(r, res_live, lv, None)
        if not a:
            continue
        cut = zr if a["kind"] == "zone" else fr
        if cut and a["date"] + " " + a["time"] < cut:
            continue  # before the rebuild's cutoff: the rebuilt history has it
        alerts[a["key"]] = a
    if zr:
        for r in jl(files.get("zone_rebuild_htf.jsonl")):
            a = fibtl_alert(r, res_zr, None, None)
            if a:
                alerts[a["key"]] = a
    if fr:
        for r in jl(files.get("fibtl_rebuild_records.jsonl")):
            a = fibtl_alert(r, res_rb, None, None)
            if a:
                alerts[a["key"]] = a
    for a in zone_alerts(files, zr, None):
        alerts[a["key"]] = a
    out = []
    for a in alerts.values():
        if a["mkt"] == "nse":
            if a["date"] < NSE_SINCE:
                continue
        elif D.kinds is not None and base_of(a["raw"]) not in D.kinds:
            continue  # a symbol the scanner no longer watches
        out.append(a)
    D.alerts = out
    return D


# ---------------------------------------------------------------- the audit
def main(argv):
    snap = "--data" in argv
    opt = lambda k: argv[argv.index(k) + 1] if k in argv else None
    pos = [a for i, a in enumerate(argv[1:], 1) if not a.startswith("--") and not argv[i - 1].startswith("--")]
    if snap:
        D = load_snapshot(opt("--data"), opt("--nse"), opt("--config"), opt("--research"))
        combos, out_path = load(pos[0]), pos[1]
    else:
        D = load_fixture(pos[0])
        combos, out_path = load(pos[1]), pos[2]
    app = load(opt("--app")) if opt("--app") else None
    now = D.now
    series = D.series
    # NSE: each symbol's two files, laid together; "NSE:SYM_60", "NSE:SYM_4H", ...
    nse = {}
    for name, text in sorted(D.nse_files.items()):
        j = json.loads(text)
        for k, rows in j["s"].items():
            got = nse.setdefault(name[:-7] + "_" + k, {})
            for r in rows:
                got[r[0]] = [r[0]] + [f32(v) if j.get("f32") else float(v) for v in r[1:5]]
    for k, got in nse.items():
        series["NSE:" + k] = series_from(list(got.values()), now)
    nse_syms = {k.split(":")[1].rsplit("_", 1)[0] for k in series if k.startswith("NSE:")}

    def between(sym, res, a, b):
        t, rows = series.get(sym + "_" + res, ([], []))
        return rows[bisect_left(t, a):bisect_left(t, b)]

    def dsym(a):
        """Delta's name for an alert's symbol (bStocks under their alias)."""
        s = re.sub(r"[/_\-\s]", "", str(a["raw"] or "").upper().replace("B-", "", 1) if str(a["raw"] or "").upper().startswith("B-") else str(a["raw"] or "").upper())
        s = s[:-1] if s.endswith("USDT") else s
        s = s if s.endswith("USD") else s + "USD"
        if snap and s not in D.delta and D.alias.get(s[:-3]) in D.delta:
            return D.alias[s[:-3]]
        return s

    # ---- coins
    def kind_of(a):
        if a["mkt"] == "nse":
            return "nse"
        b = base_of(a["raw"])
        if D.kinds is None:
            return "coin"
        return D.kinds.get(b, "")

    def coin_of(a):
        return base_of(a["raw"]) if kind_of(a) == "coin" else ""

    def on_dcx(a):
        return a["mkt"] != "nse" and base_of(a["raw"]) in D.dcx

    def on_delta(a):
        return a["mkt"] != "nse" and dsym(a) in D.delta

    # ---- BTC day and BTC move
    btc_days = {}
    t1d, rows1d = series.get("BTCUSD_1d", ([], []))
    for r in rows1d:
        if r[0] >= now - 400 * 86400:
            btc_days[datetime.fromtimestamp(r[0], timezone.utc).strftime("%Y-%m-%d")] = r
    today = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m-%d")
    trend = {}
    days = sorted(d for d in btc_days if d < today)
    ema, rows = None, []
    for i, d in enumerate(days):
        o, h, l, c = btc_days[d][1:5]
        pc = btc_days[days[i - 1]][4] if i else o
        ema = c if ema is None else c * (2 / 21) + ema * (1 - 2 / 21)
        rows.append((d, c, ema, max(h, pc) - min(l, pc)))
    for i in range(39, len(rows)):
        atr = sum(x[3] for x in rows[i - 13:i + 1]) / 14
        if not atr > 0:
            continue
        dist, slope = (rows[i][1] - rows[i][2]) / atr, (rows[i][2] - rows[i - 5][2]) / atr
        nxt = (datetime.strptime(rows[i][0], "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        trend[nxt] = "bull" if dist >= 0.75 and slope > 0 else "bear" if dist <= -0.75 and slope < 0 else "side"
    btc15 = {r[0]: r[4] for r in series.get("BTCUSD_15m", ([], []))[1] if r[0] >= now - 400 * 86400}

    def btc_day(a):
        return trend.get(datetime.fromtimestamp(a["t0"] / 1000, timezone.utc).strftime("%Y-%m-%d"))

    def btc_move(a):
        t = (a["t0"] // 1000) // 900 * 900 - 900
        p = next((btc15[t - 900 * j] for j in range(4) if btc15.get(t - 900 * j, 0) > 0), None)
        day = btc_days.get(datetime.fromtimestamp(a["t0"] / 1000, timezone.utc).strftime("%Y-%m-%d"))
        if not p or not day or not day[1] > 0:
            return None
        pct = (p - day[1]) / day[1] * 100
        if abs(pct) < 1.5:
            return "flat"
        return "with" if (pct > 0) == (a["side"] == "long") else "against"

    # ---- SL
    def tf_candles_before(sym, tf, t0):
        if tf in ("4h", "1d"):
            return [r for r in between(sym, tf, 0, t0 // 1000 + 1) if r[0] * 1000 + TFM[tf] * 60000 <= t0][-300:]
        days, out = between(sym, "1d", (t0 - 1900 * 86400000) // 1000, t0 // 1000 + 1), []
        for r in days:
            dt = datetime.fromtimestamp(r[0], timezone.utc)
            if tf == "1w":
                b = (dt - timedelta(days=dt.weekday())).replace(hour=0, minute=0, second=0)
                e = b + timedelta(days=7)
            else:
                b = dt.replace(day=1, hour=0, minute=0, second=0)
                e = (b + timedelta(days=32)).replace(day=1)
            if out and out[-1][0] == b:
                o = out[-1]; o[2] = max(o[2], r[2]); o[3] = min(o[3], r[3]); o[4] = r[4]
            else:
                out.append([b, r[1], r[2], r[3], r[4], e])
        if out and days and datetime.fromtimestamp(days[0][0], timezone.utc) != out[0][0]:
            out = out[1:]
        return [o for o in out if o[5].timestamp() * 1000 <= t0][-300:]

    def nse_candles_before(sym, tf, t0):
        rows = series.get("NSE:" + sym + "_" + NSE_TF[tf], ([], []))[1]
        return [r for r in rows if nse_closed_at(r[0], TFM[tf]) <= t0][-300:]

    def candle_stop(a, entry, mode, gap):
        s, T = a["s"], entry * (1 - a["s"] * gap / 100)
        w = b = None
        ks = nse_candles_before(a["sym"], a["tf"], a["t0"]) if a["mkt"] == "nse" else tf_candles_before(dsym(a), a["tf"], a["t0"])
        if not ks:
            return None
        for k in reversed(ks):
            lw = k[3] if s > 0 else k[2]
            bd = min(k[1], k[4]) if s > 0 else max(k[1], k[4])
            if w is None and (lw <= T if s > 0 else lw >= T):
                w = lw
            if b is None and (bd <= T if s > 0 else bd >= T):
                b = bd
            if w is not None and b is not None:
                break
        if mode == "wick":
            return w
        if mode == "body":
            return b
        return b if w is None else w if b is None else (max(w, b) if s > 0 else min(w, b))

    def fib_stop(a, lvl, entry, mode):
        """Next level: just past the next deeper level; L4 box: past L4. Past = 25% of a box (0.11 of the move)."""
        top = a.get("top")
        if top is None or lvl not in FIB:
            return None
        span = (entry - top) / FIB[lvl]  # top -> base
        nxt = {"L1": FIB["L2"], "L2": FIB["L3"], "L3": FIB["L4"], "L4": FIB["L4"] + 0.11}[lvl] if mode == "next" else FIB["L4"]
        return top + (nxt + 0.11 * 0.25) * span

    # ---- the walk
    def play(a, c, entry, stop, fill):
        sym, tf, t0, s, mkt = a["sym"], a["tf"], a["t0"], a["s"], a["mkt"]
        late = a["rb"] and a["kind"] in ("fib", "trendline") and not a["brk"]
        tfms, rk = TFM[tf] * 60000, abs(entry - stop) / entry
        risk = rk * 100
        adv = s * (fill - entry) / entry * 100
        cost = 0 if c.get("nofee") else COST[mkt] / (abs(fill - stop) / fill * 100)
        real = lambda g: (g * risk - adv) / (risk + adv) - cost
        tg = c["tgt"]
        pc = tg.endswith("%")
        tR = float(tg[:-1]) / risk if pc else float(tg[:-1])
        inR = (lambda v: v / risk) if pc else (lambda v: v)
        st = c.get("stop") or {}
        mv_at = mv_to = None
        if st.get("mode") == "be":
            mv_at, mv_to = inR(st.get("beAtP" if pc else "beAt", 1)), 0.0
        elif st.get("mode") == "shift":
            mv_at, mv_to = inR(st.get("shAtP" if pc else "shAt", 1)), inR(st.get("shToP" if pc else "shTo", 0.5 if pc else 0.75))
        if mv_at is not None and mv_at >= tR - 1e-9:
            mv_at = None
        tr = c.get("trail") or {}
        step = inR(tr.get("stepP" if pc else "step", 0.25)) if tr.get("on") else None
        gap = inR(tr.get("gapP" if pc else "gap", 0.25)) if tr.get("on") else None
        pt = c.get("part") or {}
        parts = []
        if pt.get("q"):
            parts.append([inR(pt.get("atP" if pc else "at", 0.5 if pc else 1)), pt["q"] / 100])
        if pt.get("beQ") and mv_at is not None:
            parts.append([mv_at, pt["beQ"] / 100])
        parts = sorted(p for p in parts if step is not None or p[0] < tR - 1e-9)
        bk = {"got": 0.0, "left": 1.0, "n": 0}

        def book_at(fav):
            for p in parts:
                if len(p) == 2 and bk["left"] > 1e-9 and fav >= p[0] - 1e-9:
                    q = min(p[1], bk["left"])
                    bk["got"] += q * p[0]
                    bk["left"] -= q
                    bk["n"] += 1
                    p.append(1)
            return bk["left"] <= 1e-9

        def done(r, label):
            if label == "Partial":
                return {"filled": True, "r": real(bk["got"]), "label": label}
            return {"filled": True, "r": real(bk["got"] + bk["left"] * r), "label": ("Part + " if bk["n"] else "") + label}
        if mkt == "nse":
            resms = 60 * 60000
            bars = [b for b in series.get("NSE:" + sym + "_60", ([], []))[1] if b[0] * 1000 + resms > t0]
            idx, last = [], None
            for b in bars:
                k = nse_bucket(b[0] * 1000, TFM[tf])
                if k != last:
                    idx.append((idx[-1] + 1) if idx else 0)
                    last = k
                else:
                    idx.append(idx[-1])
            in_window = lambda i: idx[i] < BARS
        else:
            resms = RESM * 60000
            bars = [b for b in between(dsym(a), "15m", (t0 - resms) // 1000, now + 1) if b[0] * 1000 + resms > t0]
            in_window = lambda i: bars[i][0] * 1000 < t0 + BARS * tfms
        if not bars:
            return {"filled": None, "r": None, "label": "no candles"}
        i0 = 0
        if late:
            edge = entry * (1 + s * (3 if TFM[tf] >= 10080 else 0.75) / 100)
            bi = next((i for i, b in enumerate(bars) if (b[3] <= edge if s > 0 else b[2] >= edge)), None)
            i0 = len(bars) if bi is None else bi + 1
        fi = next((i for i in range(i0, len(bars)) if in_window(i) and (bars[i][3] <= fill if s > 0 else bars[i][2] >= fill)), None)
        if fi is None:
            # Not reached while the fill window is still open: waiting, not "no fill".
            wait = not any(i >= BARS for i in idx) if mkt == "nse" else bars[-1][0] * 1000 + resms < t0 + BARS * tfms
            return {"filled": None if wait else False, "r": None, "label": "waiting" if wait else "no fill"}
        R = lambda p: s * (p - entry) / entry / rk
        sl_r = -1 - (stop / entry) * SLIP / risk
        exit_at = lambda lvl: lvl - (1 + s * lvl * risk / 100) * SLIP / risk
        end = math.inf if c.get("hold", "tp") == "tp" else bars[fi][0] * 1000 + BARS * tfms
        nse_over = False
        if mkt == "nse" and end != math.inf:
            eb = next((b for i, b in enumerate(bars) if idx[i] >= idx[fi] + BARS), None)
            end, nse_over = (eb[0] * 1000, True) if eb else (math.inf, False)
        f = bars[fi]
        hit = lambda b, p: (b[3] <= p if s > 0 else b[2] >= p)
        if hit(f, stop):
            return done(sl_r, "SL")
        moved, why, tgt = None, "", tR
        best = max(0.0, R(f[4]))
        if book_at(best):
            return done(0, "Partial")
        if best >= tR - 1e-9 and step is None:
            return done(tR, "Target")

        def events(fav):
            nonlocal tgt
            ch = []
            if step is not None:
                while fav >= tgt - 1e-9:
                    ch.append((max(tR, tgt - gap), "Trail TP"))
                    tgt += step
            if mv_at is not None and fav >= mv_at - 1e-9:
                ch.append((mv_to, "BE" if mv_to == 0 else "SL shift"))
            return ch

        pend, last = events(best), f
        for b in bars[fi + 1:]:
            if b[0] * 1000 >= end:
                break
            for lvl, lab in pend:
                if moved is None or lvl > moved + 1e-9:
                    moved, why = lvl, lab
            pend, last = [], b
            lo, hi = R(b[3] if s > 0 else b[2]), R(b[2] if s > 0 else b[3])
            if hit(b, stop) and moved is None:
                return done(sl_r, "SL")
            if moved is not None and lo <= moved + 1e-9:
                return done(exit_at(moved), why)
            if book_at(hi):
                return done(0, "Partial")
            if step is None and hi >= tR - 1e-9:
                return done(tR, "Target")
            pend = events(hi)
        if (end != math.inf and last[0] * 1000 + resms >= end) or nse_over:
            return done(R(last[4]), "Time exit")
        return {"filled": True, "r": None, "label": "open"}

    # ---- one setting
    def period(c):
        p = c.get("period")
        if not p:
            f, t = c.get("from") or "", c.get("to") or ""
            return (t, f) if f and t and f > t else (f, t)  # picked backwards: the same days
        if p == "all":
            return "", ""
        t = datetime.fromtimestamp(now, IST).date()
        if p == "1d":
            return t.isoformat(), t.isoformat()
        if p == "7d":
            return (t - timedelta(days=6)).isoformat(), t.isoformat()
        if p == "1m":
            y, m = (t.year, t.month - 1) if t.month > 1 else (t.year - 1, 12)
            d = date(y, m, 1) + timedelta(days=t.day - 1)  # the day overflows into the next month, as a calendar would
            return d.isoformat(), t.isoformat()
        return "", ""

    def view(c):
        """The alerts the tab shows for setting c, each as (alert, entry, stop, fill, scanner result)."""
        kind = c["kind"]
        pool = [a for a in D.alerts if a["kind"] == kind]
        rows = []
        lvl_off = set(c.get("lvlOff") or []) if kind == "fib" else set()
        tl = c.get("tl") if kind == "trendline" else None
        lvl = c.get("lvl") if kind == "fib" else None
        for a in pool:
            if lvl_off and a.get("lvl") in lvl_off:
                continue
            if tl in ("touch", "br"):
                if a["brk"] != (tl == "br"):
                    continue
            elif tl:
                want = {"support": (0, "long"), "resistance": (1, "short"), "spbr": (0, "short"), "rsbr": (1, "long")}[tl]
                if (a["line"], a["side"]) != want:
                    continue
            entry, scan, at = a["entry"], a["scan"], a.get("lvl")
            if lvl:
                if a.get("lvl") != lvl:
                    w = (a.get("whatif") or {}).get(lvl)
                    if not w or not w[0] > 0:
                        continue
                    entry, scan, at = w[0], w[1], lvl
            rows.append(dict(a=a, entry=entry, stop=a["stop"], scan=scan, at=at))
        tgt = c.get("tgt") or ""
        # SL (a fixed Exit at only; fib types on fib alerts only)
        sl = c.get("sl") or {}
        if tgt and sl.get("mode") and not (sl["mode"] in ("next", "box") and kind != "fib"):
            for x in rows:
                a, e = x["a"], x["entry"]
                m = sl["mode"]
                if m == "pct":
                    v = e * (1 - a["s"] * sl.get("pct", 1) / 100)
                elif m in ("next", "box"):
                    v = fib_stop(a, x["at"], e, m)
                elif a["mkt"] == "nse" and (a["sym"] not in nse_syms or a["tf"] not in NSE_TF):
                    v = None
                else:
                    v = candle_stop(a, e, m, sl.get("gap", 0.75))
                x["stop"] = v if v is not None and v > 0 and (v < e if a["s"] > 0 else v > e) else None
                x["slx"] = True
        for x in rows:
            x["fill"] = x["entry"]
            if tgt and c.get("early") and not x["a"]["brk"] and x["stop"] is not None:
                x["fill"] = x["entry"] * (1 + x["a"]["s"] * c["early"] / 100)
                x["ee"] = True
        has = {"crypto": any(x["a"]["mkt"] != "nse" for x in rows), "nse": any(x["a"]["mkt"] == "nse" for x in rows)}
        mk = c.get("market") or ""
        if mk:
            rows_m = [x for x in rows if (x["a"]["mkt"] == "nse") == (mk == "nse")]
        else:
            rows_m = rows
        chan = c.get("chan") or ""
        if chan and mk and not any(x["a"]["chan"] == chan for x in rows_m) and any(x["a"]["chan"] == chan for x in rows):
            chan = ""
        chan_rows = [x for x in rows_m if x["a"]["chan"] == chan] if chan else rows_m
        f, t = period(c)
        rng = [x for x in chan_rows if (not f or x["a"]["date"] >= f) and (not t or x["a"]["date"] <= t)]
        crypto_here = has["crypto"] and mk != "nse" and not (chan and chan_rows and all(x["a"]["mkt"] == "nse" for x in chan_rows))
        out = rng
        if crypto_here:
            asset = c.get("asset") or ""
            if asset:
                out = [x for x in out if kind_of(x["a"]) == {"crypto": "coin", "xstock": "stock"}[asset]]
            coins = c.get("coins") or ""
            if coins in ("dcx", "delta"):
                test = on_dcx if coins == "dcx" else on_delta
                if out:
                    out = [x for x in out if test(x["a"])]
            elif coins:
                counts = {}
                for x in out:
                    k = coin_of(x["a"])
                    if k:
                        counts[k] = counts.get(k, 0) + 1
                n = {"top3": 3, "top5": 5, "top10": 10, "top20": 20, "top30": 30}.get(coins)
                if coins == "picks":
                    keep = c.get("picks") or ["BTC", "ETH", "SOL"]
                elif coins in ("top10", "top20", "top30"):
                    both = [k for k in counts if k in D.dcx and (k + "USD") in D.delta]
                    keep = sorted(both, key=lambda k: (-(D.vol.get(k) or 0), -counts[k], k))[:n]
                elif c.get("coinRank") == "alerts":
                    keep = sorted(counts, key=lambda k: (-counts[k], k))[:n]
                else:
                    keep = TOP_CAP[:n]
                out = [x for x in out if coin_of(x["a"]) in keep]
        if c.get("btc"):
            out = [x for x in out if btc_day(x["a"]) == c["btc"]]
        if c.get("mv"):
            out = [x for x in out if btc_move(x["a"]) == c["mv"]]
        if c.get("skipTiny"):
            out = [x for x in out if not (x["stop"] is not None and abs(x["fill"] - x["stop"]) / x["fill"] * 100 < 0.2)]
        return out

    def result(x, c):
        a = x["a"]
        tgt = c.get("tgt") or ""
        if not tgt:
            filled, _, r = x["scan"]
            if r is not None and c.get("nofee"):
                r += COST[a["mkt"]] / (abs(x["entry"] - x["stop"]) / x["entry"] * 100)
            return {"filled": filled, "r": r, "label": "scanner"}
        if x["stop"] is None:
            return {"filled": x["scan"][0], "r": None, "label": "no stop"}
        if a["mkt"] == "nse" and a["sym"] not in nse_syms:
            return {"filled": x["scan"][0], "r": None, "label": "no NSE candles"}
        if a["tf"] not in TFM:
            return {"filled": x["scan"][0], "r": None, "label": "timeframe"}
        o = play(a, c, x["entry"], x["stop"], x["fill"])
        if o["label"] == "no candles":
            o["filled"] = x["scan"][0]
        return o

    def stats(rows):
        g = sorted(((x["a"]["date"] + " " + x["a"]["time"] + "\0" + x["a"]["key"], x["res"]["r"], x) for x in rows if x["res"]["r"] is not None), key=lambda y: y[0])
        rs = [y[1] for y in g]
        n = len(rs)
        wins = [r for r in rs if r > 0]
        gw, gl = sum(wins), -sum(r for r in rs if r < 0)
        eq = peak = dd = 0.0
        ls = mls = 0
        for r in rs:
            eq += r
            peak = max(peak, eq)
            dd = max(dd, peak - eq)
            ls = ls + 1 if r < 0 else 0
            mls = max(mls, ls)
        pcts = [y[1] * abs(y[2]["fill"] - y[2]["stop"]) / y[2]["fill"] * 100 for y in g]
        return {"alerts": len(rows), "filled": sum(1 for x in rows if x["res"]["filled"] is True), "nofill": sum(1 for x in rows if x["res"]["filled"] is False),
                "n": n, "wins": len(wins), "total": sum(rs), "pct": sum(pcts) if pcts else None, "avg": sum(rs) / n if n else None,
                "pf": (gw / gl if gl > 0 else (math.inf if gw > 0 else None)), "dd": dd, "mls": mls, "best": max(rs) if rs else None, "worst": min(rs) if rs else None,
                "order": [y[2]["a"]["key"] for y in g]}

    def strip_diff(st, sp, empty):
        """The tab's strip text against the retest's numbers; [] when they agree."""
        bad = []
        if not st["alerts"]:
            # Nothing left: the strip says which filter emptied the view instead of numbers.
            return [] if empty and not sp else [f"empty view: strip {sorted(sp)} reason {empty!r}"]
        val = lambda k: (sp.get(k) or {}).get("val", "")
        sub = lambda k: (sp.get(k) or {}).get("sub", "")
        fl = lambda t: float(re.sub(r"[^0-9.\-]", "", t.replace("−", "-"))) if re.search(r"\d", t or "") else None
        if val("Alerts") != str(st["alerts"]):
            bad.append(f"Alerts {val('Alerts')} vs {st['alerts']}")
        if val("Filled") != str(st["filled"]) or not sub("Filled").startswith(f"{st['nofill']} no fill"):
            bad.append(f"Filled {val('Filled')} / {sub('Filled')} vs {st['filled']} / {st['nofill']} no fill")
        if st["n"]:
            if sub("Win rate") != f"{st['wins']}W / {st['n'] - st['wins']}L":
                bad.append(f"Win rate {sub('Win rate')} vs {st['wins']}W / {st['n'] - st['wins']}L")
            tot = fl(val("Total R").split("R")[0])
            if tot is None or abs(tot - st["total"]) > 0.006 + 1e-9 * abs(st["total"]):
                bad.append(f"Total R {val('Total R')} vs {st['total']:+.3f}")
            m = re.search(r"\(([+-]?[\d.]+)%\)", val("Total R").replace("−", "-"))
            if st["pct"] is not None and m and abs(float(m.group(1)) - st["pct"]) > 0.006:
                bad.append(f"Total % {m.group(1)} vs {st['pct']:+.3f}")
            avg = fl(val("Average R").split("R")[0])
            if avg is None or abs(avg - st["avg"]) > 0.006:
                bad.append(f"Average R {val('Average R')} vs {st['avg']:+.3f}")
            pf = val("Profit factor")
            if st["pf"] is None:
                ok = pf == "—"
            elif st["pf"] == math.inf:
                ok = pf == "∞"
            else:
                ok = fl(pf) is not None and abs(fl(pf) - st["pf"]) <= 0.006
            if not ok:
                bad.append(f"Profit factor {pf} vs {st['pf']}")
            dd = val("Max drawdown")
            if (fl(dd) or 0) != round(-st["dd"], 2) and abs((fl(dd) or 0) + st["dd"]) > 0.006:
                bad.append(f"Max drawdown {dd} vs -{st['dd']:.3f}")
            if not re.search(r"worst run: %d loss" % st["mls"], sub("Max drawdown")):
                bad.append(f"worst run {sub('Max drawdown')} vs {st['mls']}")
        return bad

    report, bad = {}, 0
    for c in combos:
        if app is not None and c["name"] not in app:
            print(f"{c['name']}: not in the journal's run")
            continue
        rows = view(c)
        for x in rows:
            x["res"] = result(x, c)
        res = {x["a"]["key"]: x["res"] for x in rows}
        st = stats(rows)
        report[c["name"]] = {"rows": res, "stats": {k: v for k, v in st.items() if k != "order"}}
        line = f"{c['name']}: {len(res)} alerts, {st['n']} with a result, {st['total']:+.2f}R"
        if app is not None:
            got = app.get(c["name"])
            if got is None:
                line += " | not in the journal's run"
                print(line)
                continue
            full = isinstance(got, dict) and "rows" in got
            gr = {k: (v[0] if full else v) for k, v in (got["rows"] if full else got).items()}
            miss = sorted(set(res) ^ set(gr))
            diff = [k for k in res if k in gr and not ((res[k]["r"] is None and gr[k] is None) or (res[k]["r"] is not None and gr[k] is not None and abs(res[k]["r"] - gr[k]) < TOL))]
            fdiff = [k for k in res if full and k in gr and got["rows"][k][1] != res[k]["filled"]] if full else []
            sdiff = strip_diff(st, got.get("strip") or {}, got.get("empty")) if full and not miss and not diff and not fdiff else []
            bad += len(miss) + len(diff) + len(fdiff) + len(sdiff)
            line += f" | journal {sum(v for v in gr.values() if v is not None):+.2f}R | {len(miss)} alerts in one only, {len(diff)} trades differ" + (f", {len(fdiff)} fills differ, {len(sdiff)} strip numbers differ" if full else "")
            for k in (miss + diff + fdiff)[:5]:
                line += f"\n    {k}: retest {res.get(k)} journal {(got['rows'] if full else got).get(k, 'missing')}"
            for s_ in sdiff[:5]:
                line += f"\n    strip: {s_}"
        print(line)
    with open(out_path, "w") as f:
        json.dump(report, f)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
