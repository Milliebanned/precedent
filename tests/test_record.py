import json
import os
import unittest
from datetime import datetime, timezone

from precedent import backtest, build, hours
from precedent.data import ROOT


def ms(*a):
    return int(datetime(*a, tzinfo=timezone.utc).timestamp() * 1000)


class Hours(unittest.TestCase):
    def test_weeknight_and_weekend(self):
        w = hours.closed_windows(ms(2026, 9, 10), ms(2026, 9, 15))
        self.assertEqual([x[2] for x in w], ["2026-09-11", "2026-09-14"])
        self.assertEqual((w[0][1] - w[0][0]) / 3_600_000, 17.5)      # Thursday close -> Friday open
        self.assertEqual((w[1][1] - w[1][0]) / 3_600_000, 65.5)      # Friday close -> Monday open

    def test_holiday_is_skipped(self):
        w = hours.closed_windows(ms(2026, 9, 4), ms(2026, 9, 9))
        self.assertEqual(w[0][2], "2026-09-08")                      # Labor Day: Friday close -> Tuesday open


class Record(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.load(open(os.path.join(ROOT, "docs", "data.json")))

    def test_paths_start_at_the_close_and_fit_their_window(self):
        for s in self.data["sessions"]:
            n = (s["open"] - s["close"]) // build.BUCKET
            self.assertEqual(len(s["btc"]), n + 1)
            for tk, paths in self.data["paths"].items():
                if s["id"] in paths:
                    p = paths[s["id"]]
                    self.assertEqual(p["c"][0], 0)
                    self.assertEqual(len(p["c"]), n + 1)
                    self.assertIsNotNone(p["x"])

    def test_extremes_bracket_the_close(self):
        p = self.data["paths"]["NVDA"][self.data["sessions"][-1]["id"]]
        for c, lo, hi in zip(p["c"], p["lo"], p["hi"]):
            if None not in (c, lo, hi):
                self.assertLessEqual(lo, hi)


class Study(unittest.TestCase):
    def test_stats(self):
        s = backtest.stats([0.01, -0.02, 0.0, 0.03])
        self.assertAlmostEqual(s["return"], 1.01 * 0.98 * 1.03 - 1)
        self.assertAlmostEqual(s["max_drawdown"], -0.02)
        self.assertEqual(s["traded"], 3)


if __name__ == "__main__":
    unittest.main()
