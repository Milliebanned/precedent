"""Turn the candles into docs/data.json: every closed-market window for every stock token, as a price path.

A path is sampled every 30 minutes from the 16:00 New York close to the next 09:30 open, each point being the
token's return since the close. The page searches these paths for past windows that look like a trade idea.
"""
import json
import os
import statistics
import time

from . import earnings
from .backtest import Prices
from .data import BTC, ROOT, STEP, TICKERS, symbol
from .hours import closed_windows

BUCKET = 30 * 60 * 1000
EXIT_AFTER = 15 * 60 * 1000
UNIT = 1e-5            # returns are stored as integers of 0.001%
VOL_DAYS = 20


def _r(x, ref):
    return None if x is None else round((x / ref - 1) / UNIT)


def normal_day(px, sym, closes):
    """Std-dev of the last 20 cash close-to-close returns before this window."""
    p = [px.at(sym, c) for c in closes[-(VOL_DAYS + 1):]]
    rets = [b / a - 1 for a, b in zip(p, p[1:]) if a and b]
    return statistics.pstdev(rets) if len(rets) >= 10 else None


def path(px, sym, close, open_):
    """-> {c, lo, hi, x} or None. c[k] is the return at close + k*30min; lo/hi the extremes inside that half hour."""
    ref = px.at(sym, close)
    if not ref:
        return None
    n = (open_ - close) // BUCKET
    rows, ts = px.rows[sym], px.ts[sym]
    c, lo, hi = [0], [None], [None]
    import bisect
    for k in range(1, n + 1):
        t = close + k * BUCKET
        c.append(_r(px.at(sym, t), ref))
        seg = rows[bisect.bisect_left(ts, t - BUCKET):bisect.bisect_left(ts, t)]
        lo.append(_r(min(r[3] for r in seg), ref) if seg else None)
        hi.append(_r(max(r[2] for r in seg), ref) if seg else None)
    return {"c": c, "lo": lo, "hi": hi, "x": _r(px.at(sym, open_ + EXIT_AFTER, BUCKET), ref)}


def build(now_ms=None):
    px = Prices()
    now_ms = now_ms or int(time.time() * 1000)
    first, last = px.ts[BTC][0], px.ts[BTC][-1] + STEP
    wins = closed_windows(first, now_ms + 12 * 86_400_000)
    done = [w for w in wins if w[1] + EXIT_AFTER <= last]
    cal = earnings.load()
    sessions, tickers = [], {t: {} for t in TICKERS}
    for i, (close, open_, sid) in enumerate(done):
        kind = "weekend" if open_ - close > 24 * 3_600_000 else "overnight"
        btc = path(px, BTC, close, open_)
        if not btc:
            continue
        closes = [w[0] for w in done[:i + 1]]
        any_stock = False
        for tk in TICKERS:
            p = path(px, symbol(tk), close, open_)
            vol = normal_day(px, symbol(tk), closes)
            # Before August the tokens did not trade on weekends: a window with under half its points is unusable.
            if not p or p["x"] is None or not vol or sum(v is not None for v in p["c"]) < len(p["c"]) / 2:
                continue
            p["vol"] = round(vol / UNIT)
            p["ref"] = px.at(symbol(tk), close)
            if sid in cal.get(tk, []):
                p["earn"] = 1
            tickers[tk][sid] = p
            any_stock = True
        if any_stock:
            sessions.append({"id": sid, "kind": kind, "close": close, "open": open_, "btc": btc["c"], "btc_x": btc["x"]})
    upcoming = [{"id": sid, "kind": "weekend" if o - c > 24 * 3_600_000 else "overnight", "close": c, "open": o,
                 "earn": [t for t in TICKERS if sid in cal.get(t, [])]}
                for c, o, sid in wins if o + EXIT_AFTER > last][:8]
    vol_now = {t: round(normal_day(px, symbol(t), [w[0] for w in wins if w[0] <= last]) / UNIT) for t in TICKERS}
    out = {"built": now_ms, "data_to": last, "unit": UNIT, "bucket_min": 30, "cost_per_side": 0.0015,
           "tickers": TICKERS, "sessions": sessions, "paths": tickers, "upcoming": upcoming, "vol_now": vol_now}
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)
    with open(os.path.join(ROOT, "docs", "data.json"), "w") as f:
        json.dump(out, f, separators=(",", ":"))
    return out


if __name__ == "__main__":
    o = build()
    print(len(o["sessions"]), "windows", o["sessions"][0]["id"], "→", o["sessions"][-1]["id"],
          {t: len(p) for t, p in o["paths"].items()}, "next:", [u["id"] for u in o["upcoming"][:3]])
