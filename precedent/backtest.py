"""Does Bitcoin's move while the US market is closed tell you where stock tokens go into the open?

One rule family, replayed on Bitget 15-minute candles. A rule is picked on the in-sample sessions only
(`select`), then run once on the untouched out-of-sample sessions (`test`).
"""
import bisect
import itertools
import json
import math
import os
import statistics
import sys

from .data import BTC, ROOT, STEP, TICKERS, load, symbol
from .hours import closed_windows, ny_date

COST = 0.0015            # per side: 0.10% fee + 0.05% slippage
WEIGHT, GROSS = 0.10, 0.50   # equity per position, and the cap on all positions together
EXIT_AFTER = 15 * 60 * 1000  # flat 15 minutes after the cash open
STALE = 60 * 60 * 1000       # a token with no trade in the last hour is not tradable
VOL_BARS = 14 * 96           # Bitcoin's own noise: 14 days of 15-minute returns
OOS_FROM = "2026-09-08"      # sessions opening on or after this date are out-of-sample
MIN_TRADED = 10              # a rule must trade on at least this many in-sample sessions to be picked

UNIVERSES = {
    "all": TICKERS,
    "COIN": ["COIN"],
    "index": ["SPY", "QQQ"],
    "megacap": ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "META"],
}
GRID = {
    "signal": ["btc", "lag"],        # lag = only names that have not yet moved with Bitcoin
    "side": [1, -1],                 # 1 follows Bitcoin, -1 bets against it
    "hours_before_open": [2, 4, 8],
    "min_z": [0.5, 1.0, 1.5],        # how unusual Bitcoin's move must be
    "universe": list(UNIVERSES),
}


class Prices:
    def __init__(self):
        self.rows = {s: load(s) for s in [symbol(t) for t in TICKERS] + [BTC]}
        self.ts = {s: [r[0] for r in rows] for s, rows in self.rows.items()}
        btc = self.rows[BTC]
        self.btc_ret = [math.log(b[4] / a[4]) for a, b in zip(btc, btc[1:])]

    def at(self, sym, t, stale=STALE):
        """Close of the last candle that finished at or before t, or None if it is too old."""
        i = bisect.bisect_right(self.ts[sym], t - STEP) - 1
        if i < 0 or t - (self.ts[sym][i] + STEP) > stale:
            return None
        return self.rows[sym][i][4]

    def btc_noise(self, t):
        """Std-dev of Bitcoin's 15-minute returns over the 14 days before t."""
        i = bisect.bisect_right(self.ts[BTC], t - STEP) - 1
        w = self.btc_ret[max(0, i - VOL_BARS):i]
        return statistics.pstdev(w) if len(w) >= VOL_BARS // 2 else None


def sessions(px):
    first, last = px.ts[BTC][0] + VOL_BARS // 2 * STEP, px.ts[BTC][-1]
    return closed_windows(first, last - EXIT_AFTER)


def trades(px, rule, session):
    """The rule's positions for one closed window -> [{ticker, side, entry, exit, ret}]."""
    close, open_, sid = session
    t = open_ - rule["hours_before_open"] * 3_600_000
    b0, b1, noise = px.at(BTC, close), px.at(BTC, t), px.btc_noise(t)
    if not (b0 and b1 and noise):
        return []
    btc_move = b1 / b0 - 1
    z = btc_move / (noise * math.sqrt((t - close) / STEP))
    if abs(z) < rule["min_z"]:
        return []
    way = 1 if btc_move > 0 else -1
    out = []
    for tk in UNIVERSES[rule["universe"]]:
        s = symbol(tk)
        ref, entry, exit_ = px.at(s, close), px.at(s, t), px.at(s, open_ + EXIT_AFTER, 30 * 60 * 1000)
        if not (ref and entry and exit_):
            continue
        if rule["signal"] == "lag" and (entry / ref - 1) * way > 0.25 * abs(btc_move):
            continue  # already moved with Bitcoin
        side = way * rule["side"]
        out.append({"session": sid, "ticker": tk, "side": side, "time": t, "entry": entry, "exit": exit_,
                    "btc_move": btc_move, "z": z, "ret": side * (exit_ / entry - 1) - 2 * COST})
    return out


def run(px, rule, sess):
    """-> per-session portfolio returns and every trade."""
    rets, all_trades = [], []
    for s in sess:
        tr = trades(px, rule, s)
        w = min(WEIGHT, GROSS / len(tr)) if tr else 0
        for x in tr:
            x["weight"] = w
        rets.append(sum(x["ret"] * w for x in tr))
        all_trades += tr
    return rets, all_trades


def stats(rets, tr=()):
    eq, peak, dd = 1.0, 1.0, 0.0
    for r in rets:
        eq *= 1 + r
        peak = max(peak, eq)
        dd = min(dd, eq / peak - 1)
    sd = statistics.pstdev(rets) if len(rets) > 1 else 0
    down = math.sqrt(sum(min(r, 0) ** 2 for r in rets) / len(rets)) if rets else 0
    traded = [r for r in rets if r]
    return {
        "sessions": len(rets), "traded": len(traded), "trades": len(tr),
        "return": eq - 1,
        "sharpe": statistics.mean(rets) / sd * math.sqrt(252) if sd else 0.0,
        "sortino": statistics.mean(rets) / down * math.sqrt(252) if down else 0.0,
        "max_drawdown": dd,
        "win_rate": sum(r > 0 for r in traded) / len(traded) if traded else 0.0,
    }


def split(sess):
    return [s for s in sess if s[2] < OOS_FROM], [s for s in sess if s[2] >= OOS_FROM]


def rules():
    for combo in itertools.product(*GRID.values()):
        yield dict(zip(GRID, combo))


def select(px):
    ins, _ = split(sessions(px))
    board = []
    for r in rules():
        rets, tr = run(px, r, ins)
        board.append({"rule": r, **stats(rets, tr)})
    board.sort(key=lambda b: -b["sharpe"])
    ok = [b for b in board if b["traded"] >= MIN_TRADED]
    out = {"in_sample": [ins[0][2], ins[-1][2]], "sessions": len(ins), "rules_tried": len(board),
           "rules_profitable": sum(b["return"] > 0 for b in board), "chosen": ok[0], "top": ok[:10]}
    json.dump(out, open(os.path.join(ROOT, "results", "selection.json"), "w"), indent=1)
    return out


def test(px):
    chosen = json.load(open(os.path.join(ROOT, "results", "selection.json")))["chosen"]["rule"]
    ins, oos = split(sessions(px))
    out = {"rule": chosen}
    for name, sess in (("in_sample", ins), ("out_of_sample", oos), ("full", ins + oos)):
        rets, tr = run(px, chosen, sess)
        out[name] = {"from": sess[0][2], "to": sess[-1][2], **stats(rets, tr)}
    json.dump(out, open(os.path.join(ROOT, "results", "report.json"), "w"), indent=1)
    return out


if __name__ == "__main__":
    px = Prices()
    f = lambda b: (f"{b['return']:+.2%} sharpe {b['sharpe']:5.2f} dd {b['max_drawdown']:.2%} "
                   f"win {b['win_rate']:.0%} traded {b['traded']}/{b['sessions']} trades {b['trades']}")
    if sys.argv[1:] == ["select"]:
        o = select(px)
        print(f"in-sample {o['in_sample']} · {o['sessions']} sessions · "
              f"{o['rules_profitable']} of {o['rules_tried']} rules profitable")
        for b in o["top"]:
            print(f(b), b["rule"])
    elif sys.argv[1:] == ["test"]:
        o = test(px)
        print(o["rule"])
        for k in ("in_sample", "out_of_sample", "full"):
            print(f"{k:14} {o[k]['from']} → {o[k]['to']}  {f(o[k])}")
