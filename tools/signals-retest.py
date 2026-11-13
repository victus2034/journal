"""Independent retest of the journal's Signals "Exit at" what-if (lakky, 2026-11-12: "i told you
to recheck backtest result of journal and most of the times its differ ... make sure it wont
happen again").

Written from the stated rules, not from index.html: it picks the alerts itself from the
scanner's raw rebuild records, sets the candle SL itself, and plays every trade candle by
candle on Delta's 15m candles (no path summary). tests/smoke.mjs (parityRun) runs the journal
on the same alerts and candles and fails if any trade differs, so the two cannot drift apart.

The rules (each one lakky's):
- Alerts: fib / trendline rebuild rows, crypto and NSE, news-window rows left out, channel =
  CRYPTO / NSE 4H / 1D / 1W / 1MO (none: both markets), IST date range, trendline type (support / resistance / support broken /
  resistance broken = line 0/1 x side), fib level from the key's tag (old keys: zone 1 = L1,
  zone 2 = L3).
- Fill: a history touch row waits for the first 15m candle reaching the band (0.75%, 3% on
  1W / 1M) and fills from the next candle on; break rows fill from the alert. The fill must
  come within 20 candles of the alert's timeframe.
- Stop: the alert's; or the last closed candle of the alert's timeframe before the alert
  whose wick / body / closer of the two is at least the gap past entry (1W = Monday weeks and
  1M = calendar months built from days, a partial first one dropped, 300 looked back);
  or a fixed % from entry.
- Exit: a candle touching the stop and the target counts as the stop; the fill candle counts
  only its close. Move SL (BE / SL shift) and Trail TP move the stop from the next candle,
  the higher stop wins; a Move SL trigger at or past the target never fires; Trail TP
  locks the first target. Hold: till TP / SL, or 20 candles after the fill (closed at the
  last close). Costs: 0.0826% round trip (NSE 0.1063%; off with no fees), every stop fills
  0.05% past it.
- NSE (2026-11-13): played on the 60m candles the journal's NSE job publishes from Yahoo
  (fixture "nse": its files, float32 prices written short). "20 candles" (the fill window and
  the hold) counts NSE candles of the alert's timeframe: 4H = 09:15-13:15 and 13:15-15:30 IST,
  days, Monday weeks, calendar months (IST), so nights, weekends and holidays don't count.
  The candle SL looks at the job's own 4H / 1D / 1W / 1M candles closed before the alert
  (4H at 13:15 / 15:30, a day at 15:30, a week at the next Monday 09:15, a month at the next
  month's first 09:15 IST), 300 back.
- Partial (2026-11-13): a share of the position closes at a level (a limit, no slippage) on
  the first candle reaching it, after the stop check (the fill candle: its close); another
  share at the Move SL trigger when "book" is set. Shares of the whole position, lowest
  level first, never more than what is left. Without Trail TP a level at or past the target
  books nothing. Every later exit is for the rest; fees stay one round trip on the whole.

python3 tools/signals-retest.py FIXTURE.json.gz COMBOS.json OUT.json [--app APP.json]
FIXTURE: {now, records, results, candles: {"SYM_15m": [[time s, open, high, low, close], ...]},
nse: {"SYM.a.json": file text, "SYM.b.json": ...}}.
With --app (the journal's own per-alert results, {combo: {key: r}}), every trade is compared
and the exit code is 1 if any differs.
"""
import gzip, json, math, struct, sys
from bisect import bisect_left
from datetime import date, datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
TFM = {"4h": 240, "1d": 1440, "1w": 10080, "1M": 43200}
CHAN = {"4h": "4H", "1d": "1D", "1w": "1W", "1M": "1MO"}
COST, SLIP, BARS, RESM = {"crypto": 0.0826, "nse": 0.1063}, 0.05, 20, 15
NSE_TF = {"4h": "4H", "1d": "1D", "1w": "1W", "1M": "1M"}


def f32(v):
    return struct.unpack("f", struct.pack("f", v))[0]


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
TOL = 2e-3


def load(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt") as f:
        return json.load(f)


def main(argv):
    fx, combos, out_path = load(argv[1]), load(argv[2]), argv[3]
    app = load(argv[argv.index("--app") + 1]) if "--app" in argv else None
    now = fx["now"]
    series = {}
    for k, rows in fx["candles"].items():
        rows = sorted((r for r in rows if r[0] <= now and min(r[1:5]) > 0), key=lambda r: r[0])
        series[k] = ([r[0] for r in rows], rows)
    # NSE: each symbol's two files, laid together; "SYM_60", "SYM_4H", ... like the crypto ones.
    nse = {}
    for name, text in sorted((fx.get("nse") or {}).items()):
        if not name.endswith((".a.json", ".b.json")):
            continue
        j = json.loads(text)
        for k, rows in j["s"].items():
            got = nse.setdefault(name[:-7] + "_" + k, {})
            for r in rows:
                got[r[0]] = [r[0]] + [f32(v) if j.get("f32") else float(v) for v in r[1:5]]
    for k, got in nse.items():
        rows = sorted((r for r in got.values() if r[0] <= now and min(r[1:5]) > 0), key=lambda r: r[0])
        series["NSE:" + k] = ([r[0] for r in rows], rows)

    def between(sym, res, a, b):
        t, rows = series.get(sym + "_" + res, ([], []))
        return rows[bisect_left(t, a):bisect_left(t, b)]

    def alerts(c):
        out = []
        for r in fx["records"]:
            if r.get("market") not in ("crypto", "nse") or r.get("kind") != c["kind"]:
                continue
            if fx["results"].get(r["id"], {}).get("news_window"):
                continue
            day = datetime.fromtimestamp(r["sent_ts"], IST).strftime("%Y-%m-%d")
            if (c.get("chan") and r["market"].upper() + " " + CHAN.get(r["tf"], "") != c["chan"]) or not (c["from"] <= day <= c["to"]):
                continue
            side = r["plan"]["side"]
            if c.get("tl"):
                want = {"support": (0, "long"), "resistance": (1, "short"), "spbr": (0, "short"), "rsbr": (1, "long")}[c["tl"]]
                if (int(r["key"].split("|")[3]), side) != want:
                    continue
            if c.get("lvl"):
                parts = r["key"].split("|")
                tag = parts[7] if len(parts) > 7 else ""
                if (tag if tag in ("L1", "L2", "L3", "L4") else {"1": "L1", "2": "L3"}.get(parts[6], "")) != c["lvl"]:
                    continue
            out.append(r)
        return out

    def tf_candles_before(sym, tf, t0):
        if tf in ("4h", "1d"):
            return [r for r in between(sym, tf, 0, t0 // 1000 + 1) if r[0] * 1000 + TFM[tf] * 60000 <= t0][-300:]
        days, out = between(sym, "1d", 0, t0 // 1000 + 1), []
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

    def candle_stop(sym, tf, t0, entry, s, mode, gap, mkt):
        T = entry * (1 - s * gap / 100)
        w = b = None
        for k in reversed(nse_candles_before(sym, tf, t0) if mkt == "nse" else tf_candles_before(sym, tf, t0)):
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

    def play(sym, tf, t0, late, s, c, entry, stop, mkt):
        tfms, rk = TFM[tf] * 60000, abs(entry - stop) / entry
        risk = rk * 100
        cost = 0 if c.get("nofee") else COST[mkt] / risk
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
        if mv_at is not None and mv_at >= tR:
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

        def book(fav):
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
                return {"filled": True, "r": bk["got"] - cost, "label": label}
            return {"filled": True, "r": bk["got"] + bk["left"] * r - cost, "label": ("Part + " if bk["n"] else "") + label}
        if mkt == "nse":
            # NSE: Yahoo's 60m candles; "20 candles" are NSE candles of the alert's timeframe.
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
            bars = [b for b in between(sym, "15m", (t0 - resms) // 1000, now + 1) if b[0] * 1000 + resms > t0]
            in_window = lambda i: bars[i][0] * 1000 < t0 + BARS * tfms
        i0 = 0
        if late:
            edge = entry * (1 + s * (3 if TFM[tf] >= 10080 else 0.75) / 100)
            bi = next((i for i, b in enumerate(bars) if (b[3] <= edge if s > 0 else b[2] >= edge)), None)
            i0 = len(bars) if bi is None else bi + 1
        fi = next((i for i in range(i0, len(bars)) if in_window(i) and (bars[i][3] <= entry if s > 0 else bars[i][2] >= entry)), None)
        if fi is None:
            return {"filled": False, "r": None, "label": "no fill"}
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
        if book(best):
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
            if book(hi):
                return done(0, "Partial")
            if step is None and hi >= tR - 1e-9:
                return done(tR, "Target")
            pend = events(hi)
        if (end != math.inf and last[0] * 1000 + resms >= end) or nse_over:
            return done(R(last[4]), "Time exit")
        return {"filled": True, "r": None, "label": "open"}

    report, bad = {}, 0
    for c in combos:
        res = {}
        for r in alerts(c):
            t0, s = r["sent_ts"] * 1000, 1 if r["plan"]["side"] == "long" else -1
            mkt = r["market"]
            sym = r["symbol"].split("/")[0].upper() if mkt == "nse" else r["symbol"]
            if mkt == "nse" and sym.endswith(".NS"):
                sym = sym[:-3]
            late = bool(r.get("rebuild")) and r["kind"] in ("fib", "trendline") and not r["key"].endswith("|br")
            entry, stop = float(r["plan"]["entry"]), float(r["plan"]["sl"])
            sl = c.get("sl") or {}
            if sl.get("mode") in ("wick", "body", "near"):
                stop = candle_stop(sym, r["tf"], t0, entry, s, sl["mode"], sl.get("gap", 0.75), mkt)
            elif sl.get("mode") == "pct":
                stop = entry * (1 - s * sl.get("pct", 1) / 100)
            if stop is None or not (stop < entry if s > 0 else stop > entry):
                res[r["id"]] = {"filled": None, "r": None, "label": "no stop"}
                continue
            res[r["id"]] = play(sym, r["tf"], t0, late, s, c, entry, stop, mkt)
        report[c["name"]] = res
        graded = [v["r"] for v in res.values() if v["r"] is not None]
        line = f"{c['name']}: {len(res)} alerts, {len(graded)} with a result, {sum(graded):+.2f}R"
        if app is not None:
            got = app.get(c["name"], {})
            miss = sorted(set(res) ^ set(got))
            diff = [k for k in res if k in got and not ((res[k]["r"] is None and got[k] is None) or (res[k]["r"] is not None and got[k] is not None and abs(res[k]["r"] - got[k]) < TOL))]
            bad += len(miss) + len(diff)
            line += f" | journal {sum(v for v in got.values() if v is not None):+.2f}R | {len(miss)} alerts in one only, {len(diff)} trades differ"
            for k in (miss + diff)[:5]:
                line += f"\n    {k}: retest {res.get(k)} journal {got.get(k, 'missing')}"
        print(line)
    with open(out_path, "w") as f:
        json.dump(report, f)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
