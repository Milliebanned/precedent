"""Earnings dates from bitget-mcp-server (https://agent.bitget.com/mcp, free, no key), cached in data/earnings.json.

-> {ticker: [session ids]} where a session id is the date of the cash open that follows the release.
"""
import json
import os
import subprocess
from datetime import date, timedelta

from .data import ROOT, TICKERS
from .hours import HOLIDAYS

URL = "https://agent.bitget.com/mcp"
PATH = os.path.join(ROOT, "data", "earnings.json")
HEAD = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "User-Agent": "precedent/1.0"}


def _post(payload, sid=None):
    """-> (session id, body). curl with DNS-over-HTTPS first: some networks fail to resolve bitget hosts."""
    head = {**HEAD, **({"Mcp-Session-Id": sid} if sid else {})}
    for doh in (["--doh-url", "https://1.1.1.1/dns-query"], []) * 2:
        cmd = ["curl", "-s", "-m", "40", "-D", "-", *doh, "-d", json.dumps(payload), URL]
        for k, v in head.items():
            cmd += ["-H", f"{k}: {v}"]
        out = subprocess.run(cmd, capture_output=True, text=True).stdout
        if out:
            headers, _, body = out.partition("\n\n")
            got = [l.split(":", 1)[1].strip() for l in headers.splitlines() if l.lower().startswith("mcp-session-id:")]
            return (got[0] if got else sid), body
    raise RuntimeError("bitget-mcp-server unreachable")


def _next_open(d):
    d += timedelta(days=1)
    while d.weekday() >= 5 or d in HOLIDAYS:
        d += timedelta(days=1)
    return d


def fetch(start="2026-06-01", end="2026-12-31"):
    sid, _ = _post({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "precedent", "version": "1.0"}}})
    _post({"jsonrpc": "2.0", "method": "notifications/initialized"}, sid)
    out = {}
    for n, tk in enumerate(t for t in TICKERS if t not in ("SPY", "QQQ")):
        _, body = _post({"jsonrpc": "2.0", "id": 2 + n, "method": "tools/call", "params": {"name": "do_query", "arguments": {
            "entry_id": "equity_calendar", "params": {"symbol": tk, "start_date": start, "end_date": end}}}}, sid)
        rows = []
        for line in body.splitlines():
            if line.startswith("data: "):
                data = json.loads(json.loads(line[6:])["result"]["content"][0]["text"]).get("data") or {}
                rows = data.get("results", []) if isinstance(data, dict) else []
        days = set()
        for row in rows:
            day = row.get("perf_brief_dsclsr_date") or row.get("perf_report_dsclsr_date") \
                or row.get("perf_briefing_fore_dsclsr_date") or row.get("perf_report_fore_dsclsr_date")
            if not day:
                continue
            d = date.fromisoformat(day[:10])
            if row.get("is_trading_time") == "盘前":   # released before the open: that morning's session
                days.add(d.isoformat())
            else:
                # The feed dates an after-close release one trading day early; the gap shows up two opens later.
                days.add(_next_open(_next_open(d)).isoformat())
        out[tk] = sorted(days)
    if not any(out.values()):
        raise RuntimeError("the calendar came back empty; keeping the cached file")
    json.dump(out, open(PATH, "w"), indent=1, sort_keys=True)
    return out


def load():
    return json.load(open(PATH)) if os.path.exists(PATH) else fetch()


if __name__ == "__main__":
    print(json.dumps(fetch(), indent=1))
