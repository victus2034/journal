"""Independent retest of the journal's Signals "Exit at" what-if (lakky, 2026-11-12: "i told you
to recheck backtest result of journal and most of the times its differ ... make sure it wont
happen again").

Written from the stated rules, not from index.html: it picks the alerts itself from the
scanner's raw rebuild records, sets the candle SL itself, and plays every trade candle by
candle on Delta's 15m candles (no path summary). tests/smoke.mjs (parityRun) runs the journal
on the same alerts and candles and fails if any trade differs, so the two cannot drift apart.

The rules (each one lakky's):
- Alerts: crypto fib / trendline rebuild rows, news-window rows left out, channel = CRYPTO 4H /
  1D / 1W / 1MO, IST date range, trendline type (support / resistance / support broken /
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
  last close). Costs: 0.0826% round trip (off with no fees), every stop fills 0.05% past it.

python3 tools/signals-retest.py FIXTURE.json.gz COMBOS.json OUT.json [--app APP.json]
FIXTURE: {now, records, results, candles: {"SYM_15m": [[time s, open, high, low, close], ...]}}.
With --app (the journal's own per-alert results, {combo: {key: r}}), every trade is compared
and the exit code is 1 if any differs.
"""
import gzip, json, math, sys
from bisect import bisect_left
from datetime import datetime, timezone, timedelta

IST = timezone(timedelta(hours=5, minutes=30))
TFM = {"4h": 240, "1d": 1440, "1w": 10080, "1M": 43200}
CHAN = {"4h": "CRYPTO 4H", "1d": "CRYPTO 1D", "1w": "CRYPTO 1W", "1M": "CRYPTO 1MO"}
COST, SLIP, BARS, RESM = 0.0826, 0.05, 20, 15
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

    def between(sym, res, a, b):
        t, rows = series.get(sym + "_" + res, ([], []))
        return rows[bisect_left(t, a):bisect_left(t, b)]

    def alerts(c):
        out = []
        for r in fx["records"]:
            if r.get("market") != "crypto" or r.get("kind") != c["kind"]:
                continue
            if fx["results"].get(r["id"], {}).get("news_window"):
                continue
            day = datetime.fromtimestamp(r["sent_ts"], IST).strftime("%Y-%m-%d")
            if (c.get("chan") and CHAN.get(r["tf"]) != c["chan"]) or not (c["from"] <= day <= c["to"]):
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

    def candle_stop(sym, tf, t0, entry, s, mode, gap):
        T = entry * (1 - s * gap / 100)
        w = b = None
        for k in reversed(tf_candles_before(sym, tf, t0)):
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

    def play(sym, tf, t0, late, s, c, entry, stop):
        tfms, rk = TFM[tf] * 60000, abs(entry - stop) / entry
        risk = rk * 100
        cost = 0 if c.get("nofee") else COST / risk
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
        resms = RESM * 60000
        bars = [b for b in between(sym, "15m", (t0 - resms) // 1000, now + 1) if b[0] * 1000 + resms > t0]
        i0 = 0
        if late:
            edge = entry * (1 + s * (3 if TFM[tf] >= 10080 else 0.75) / 100)
            bi = next((i for i, b in enumerate(bars) if (b[3] <= edge if s > 0 else b[2] >= edge)), None)
            i0 = len(bars) if bi is None else bi + 1
        fi = next((i for i in range(i0, len(bars)) if bars[i][0] * 1000 < t0 + BARS * tfms and (bars[i][3] <= entry if s > 0 else bars[i][2] >= entry)), None)
        if fi is None:
            return {"filled": False, "r": None, "label": "no fill"}
        R = lambda p: s * (p - entry) / entry / rk
        sl_r = -1 - (stop / entry) * SLIP / risk - cost
        exit_at = lambda lvl: lvl - (1 + s * lvl * risk / 100) * SLIP / risk - cost
        end = math.inf if c.get("hold", "tp") == "tp" else bars[fi][0] * 1000 + BARS * tfms
        f = bars[fi]
        hit = lambda b, p: (b[3] <= p if s > 0 else b[2] >= p)
        if hit(f, stop):
            return {"filled": True, "r": sl_r, "label": "SL"}
        moved, why, tgt = None, "", tR
        best = max(0.0, R(f[4]))
        if best >= tR - 1e-9 and step is None:
            return {"filled": True, "r": tR - cost, "label": "Target"}

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
                return {"filled": True, "r": sl_r, "label": "SL"}
            if moved is not None and lo <= moved + 1e-9:
                return {"filled": True, "r": exit_at(moved), "label": why}
            if step is None and hi >= tR - 1e-9:
                return {"filled": True, "r": tR - cost, "label": "Target"}
            pend = events(hi)
        if end != math.inf and last[0] * 1000 + resms >= end:
            return {"filled": True, "r": R(last[4]) - cost, "label": "Time exit"}
        return {"filled": True, "r": None, "label": "open"}

    report, bad = {}, 0
    for c in combos:
        res = {}
        for r in alerts(c):
            t0, s = r["sent_ts"] * 1000, 1 if r["plan"]["side"] == "long" else -1
            sym = r["symbol"]
            late = bool(r.get("rebuild")) and r["kind"] in ("fib", "trendline") and not r["key"].endswith("|br")
            entry, stop = float(r["plan"]["entry"]), float(r["plan"]["sl"])
            sl = c.get("sl") or {}
            if sl.get("mode") in ("wick", "body", "near"):
                stop = candle_stop(sym, r["tf"], t0, entry, s, sl["mode"], sl.get("gap", 0.75))
            elif sl.get("mode") == "pct":
                stop = entry * (1 - s * sl.get("pct", 1) / 100)
            if stop is None or not (stop < entry if s > 0 else stop > entry):
                res[r["id"]] = {"filled": None, "r": None, "label": "no stop"}
                continue
            res[r["id"]] = play(sym, r["tf"], t0, late, s, c, entry, stop)
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
