import bisect
import importlib.util
from pathlib import Path
import random
import unittest

spec = importlib.util.spec_from_file_location('traffic', Path(__file__).parents[1] / 'fleet-roles' / 'traffic.py')
traffic = importlib.util.module_from_spec(spec)
spec.loader.exec_module(traffic)


class BaselineTrafficTest(unittest.TestCase):
    def test_short_and_long_variation_stays_within_chart_bounds(self):
        for seed in range(10):
            cadence = traffic.BaselineCadence(random.Random(seed))
            now = 0
            arrivals = []
            rates = []
            while now < 7200:
                arrivals.append(now)
                rate = cadence.rate(now)
                self.assertTrue(0.5 <= rate <= 1.5)
                rates.append(rate)
                now += 1 / rate
            self.assertGreater(max(rates) - min(rates), 0.5)
            counts = []
            for end in range(180, 7200):
                count5 = bisect.bisect_right(arrivals, end) - bisect.bisect_right(arrivals, end - 5)
                self.assertTrue(30 <= count5 * 12 <= 90, (seed, end, count5))
                count180 = bisect.bisect_right(arrivals, end) - bisect.bisect_right(arrivals, end - 180)
                self.assertTrue(90 <= count180 <= 270, (seed, end, count180))
                counts.append(count180)
            self.assertGreater(max(counts) - min(counts), 25)
