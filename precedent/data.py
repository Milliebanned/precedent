"""Bitget public spot candles (no API key), 15-minute bars cached as CSV in data/candles/."""
import csv
import json
import os
import subprocess
import sys
import time
import urllib.parse

STEP = 15 * 60 * 1000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, "data", "candles")
TICKERS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "SPY", "QQQ", "COIN"]
BTC = "BTCUSDT"


def symbol(ticker):
    return f"R{ticker}USDT"


def load(sym):
    """-> [(ts_ms, open, high, low, close)], ascending."""
    with open(os.path.join(DIR, sym + ".csv")) as f:
        return [(int(r[0]), float(r[1]), float(r[2]), float(r[3]), float(r[4])) for r in csv.reader(f)]


def _page(sym, end_ms):
    q = urllib.parse.urlencode({"symbol": sym, "granularity": "15min", "endTime": end_ms, "limit": 200})
    url = "https://api.bitget.com/api/v2/spot/market/history-candles?" + q
    for i in range(8):
        try:
            # DNS-over-HTTPS first, plain DNS on the retry: some networks fail to resolve api.bitget.com
            cmd = ["curl", "-s", "-m", "25"] + ([] if i % 2 else ["--doh-url", "https://1.1.1.1/dns-query"]) + [url]
            body = json.loads(subprocess.run(cmd, capture_output=True, text=True).stdout)
            if body.get("code") == "00000":
                return body["data"]
        except ValueError:
            pass
        time.sleep(1 + i)
    raise RuntimeError(f"no data for {sym}")


def refresh(sym):
    """Append every closed candle since the last one on disk."""
    path = os.path.join(DIR, sym + ".csv")
    with open(path) as f:
        rows = {int(r[0]): r for r in csv.reader(f)}
    now = int(time.time() * 1000)
    last_closed = now // STEP * STEP - STEP
    end, newest = now, max(rows)
    while end > newest:
        page = _page(sym, end)
        if not page:
            break
        for r in page:
            if int(r[0]) <= last_closed:
                rows[int(r[0])] = [r[0], r[1], r[2], r[3], r[4], r[6]]
        first = min(int(r[0]) for r in page)
        if first >= end:
            break
        end = first
        time.sleep(0.4)
    with open(path, "w", newline="") as f:
        csv.writer(f).writerows(rows[k] for k in sorted(rows))
    return len(rows)


if __name__ == "__main__":
    for s in [symbol(t) for t in TICKERS] + [BTC]:
        print(s, refresh(s))
        sys.stdout.flush()
