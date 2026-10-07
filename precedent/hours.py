"""US cash-market hours and the closed windows between them."""
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
HOLIDAYS = {date(2026, 6, 19), date(2026, 7, 3), date(2026, 9, 7), date(2026, 11, 26), date(2026, 12, 25)}


def ms(d, t):
    return int(datetime.combine(d, t, NY).timestamp() * 1000)


def ny_date(t_ms):
    return datetime.fromtimestamp(t_ms / 1000, timezone.utc).astimezone(NY).date()


def closed_windows(start_ms, end_ms):
    """-> [(close_ms, open_ms, id)] for every 16:00 close -> next 09:30 open inside the range. id is the open's date."""
    out, prev = [], None
    d = ny_date(start_ms)
    while d <= ny_date(end_ms):
        if d.weekday() < 5 and d not in HOLIDAYS:
            o = ms(d, time(9, 30))
            if prev and prev >= start_ms and o <= end_ms:
                out.append((prev, o, d.isoformat()))
            prev = ms(d, time(16, 0))
        d += timedelta(days=1)
    return out
