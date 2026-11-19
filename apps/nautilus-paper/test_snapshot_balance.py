"""The account snapshot reads one exchange's balance once, and a failed snapshot does not kill the run.

Run 9c9620b0 (Live, 2026-11-14) died here. The snapshot asked every market of an exchange for the
account's cash in turn, while the Live position check refreshed that cash from another thread every
ten seconds. The refresh landed between two markets, their rows disagreed, the watchdog raised
"markets disagree on shared venue balance" and the engine stopped without a word; the API only saw
the silence and reported "No Nautilus heartbeat for 60 seconds".

These tests need no network and no Nautilus node:
.local/nautilus-hl-fast5-rc7-20261018/.venv/bin/python -B apps/nautilus-paper/test_snapshot_balance.py
"""
import sys
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import live_venues  # noqa: E402
from runtime import PINE_STRATEGY, SNAPSHOT_FAILURES_BEFORE_STOP, make_controller  # noqa: E402

COUNTERS = ("brokerRevision", "publicFrames", "pendingOrders", "signals", "intents", "fills",
            "rejectedSignals", "stalePriceObservationsSkipped")
PAIRS = ("xyz:BRENTOIL", "xyz:CL", "xyz:GOLD", "xyz:SILVER")


class MovingBalanceStrategy:
    """One market whose exchange account reports a different cash on every reading.

    This is the race itself: between two readings another thread (the Live position check, or a
    fill) has already written a newer balance.
    """

    def __init__(self, spec, first):
        self.spec = spec
        self.next_cash = first
        self.reads = 0

    def cash_balance(self):
        self.reads += 1
        cash = self.next_cash
        self.next_cash = f"{float(cash) - 0.37:.5f}"  # the next reader would see this one
        return cash

    def account_snapshot(self, cash=None):
        return {"venue": self.spec.display, "cashBalance": self.cash_balance() if cash is None else cash,
                **{name: 0 for name in COUNTERS}, "priceReady": True, "positions": []}


def controller_with(tracks):
    events = []
    emitter = SimpleNamespace(on_failure=None, sync=lambda: None,
                              emit=lambda kind, **fields: events.append({"type": kind, **fields}))
    config = {"mode": "public", "volatilityExpiresAtMs": 10 ** 15, "nativeStrategy": PINE_STRATEGY,
              "capitalPerVenue": 10_000, "tracks": tracks}
    return make_controller(config, emitter), events


class SnapshotBalanceTests(unittest.TestCase):
    def controller(self):
        tracks = ([{"venue": "hyperliquid", "market": market} for market in PAIRS]
                  + [{"venue": "lighter", "market": market} for market in ("XAU", "XAG")])
        controller, events = controller_with(tracks)
        for index, (key, spec) in enumerate(controller.specs.items()):
            controller.strategies[key] = MovingBalanceStrategy(spec, f"{307.60131 - index:.5f}")
        return controller, events

    def test_the_race_is_real_when_every_market_reads_for_itself(self):
        """Without the fix the four Hyperliquid markets really do report different balances."""
        controller, _ = self.controller()
        rows = [strategy.account_snapshot() for key, strategy in controller.strategies.items()
                if strategy.spec.venue_key == "hyperliquid"]
        self.assertEqual(len({row["cashBalance"] for row in rows}), len(rows))

    def test_one_reading_per_exchange_for_the_whole_snapshot(self):
        controller, events = self.controller()
        controller.snapshot()  # used to raise ValueError("markets disagree on shared venue balance")
        accounts = {account["venue"]: account for account in events[-1]["accounts"]}
        self.assertEqual(sorted(accounts), ["Hyperliquid", "Lighter"])
        reads = {}
        for strategy in controller.strategies.values():
            reads[strategy.spec.display] = reads.get(strategy.spec.display, 0) + strategy.reads
        # One reading for all four Hyperliquid markets, one for both Lighter markets.
        self.assertEqual(reads, {"Hyperliquid": 1, "Lighter": 1})
        self.assertEqual(accounts["Hyperliquid"]["cashBalance"], "307.60131")
        self.assertEqual(len(accounts["Hyperliquid"]["positions"]), 0)

    def test_every_market_of_an_exchange_shows_the_same_balance(self):
        controller, events = self.controller()
        for _ in range(5):
            controller.snapshot()
        for account in events[-1]["accounts"]:
            self.assertIsInstance(account["cashBalance"], str)
        # Each snapshot reads once per exchange, so the number moves by one step, not by four.
        balances = [next(account["cashBalance"] for account in event["accounts"] if account["venue"] == "Hyperliquid")
                    for event in events if event["type"] == "snapshot"]
        self.assertEqual(balances, ["307.60131", "307.23131", "306.86131", "306.49131", "306.12131"])


class SnapshotFailureTests(unittest.TestCase):
    """A snapshot is a report, not a trade: one that fails must not kill the engine in silence."""

    def controller(self):
        controller, events = controller_with([{"venue": "lighter", "market": "XAU"}])
        controller.snapshot = Mock(side_effect=ValueError("markets disagree on shared venue balance"))
        return controller, events

    def test_a_single_failure_is_announced_and_the_run_goes_on(self):
        controller, events = self.controller()
        self.assertTrue(controller.snapshot_guarded())
        self.assertFalse(controller.failed)
        self.assertEqual([event["type"] for event in events], ["event"])
        self.assertIn("account snapshot failed (1)", events[-1]["message"])

    def test_a_good_snapshot_forgets_the_failures(self):
        controller, _ = self.controller()
        controller.snapshot_guarded()
        controller.snapshot_guarded()
        self.assertEqual(controller.snapshot_failures, 2)
        controller.snapshot = Mock()
        self.assertTrue(controller.snapshot_guarded())
        self.assertEqual(controller.snapshot_failures, 0)

    def test_failing_for_about_a_minute_stops_the_run_with_a_reason(self):
        controller, _ = self.controller()
        for attempt in range(1, SNAPSHOT_FAILURES_BEFORE_STOP):
            self.assertTrue(controller.snapshot_guarded(), attempt)
        self.assertFalse(controller.snapshot_guarded())
        self.assertTrue(controller.failed)
        self.assertIn(f"snapshot failed {SNAPSHOT_FAILURES_BEFORE_STOP} times in a row", controller.stop_reason)


class HyperliquidAccountTests(unittest.TestCase):
    """An unanswered info API read keeps the last account: a hiccup must not change the number."""

    def venue(self):
        venue = live_venues.HyperliquidVenue()
        venue.address = "0x" + "ab" * 20
        venue._spot_collateral = False  # no unified account: the dexes hold the collateral
        return venue

    def read(self, venue, value, fail=False):
        def info(body, timeout=5):
            if fail:
                raise TimeoutError("the info API did not answer")
            return {"marginSummary": {"accountValue": value if body.get("dex") is None else "0"},
                    "assetPositions": []}

        original = live_venues.hyperliquid_info
        live_venues.hyperliquid_info = info
        try:
            return venue.cash()
        finally:
            live_venues.hyperliquid_info = original

    def test_an_unanswered_read_keeps_the_last_balance(self):
        venue = self.venue()
        self.assertEqual(self.read(venue, "150.5"), Decimal("150.5"))
        venue._account = (venue._account[0] - live_venues.HYPERLIQUID_ACCOUNT_MAX_AGE_S - 1, venue._account[1])
        self.assertEqual(self.read(venue, "0", fail=True), Decimal("150.5"))

    def test_the_first_read_still_reports_its_failure(self):
        venue = self.venue()  # nothing read yet: there is no number to stand in for the account
        with self.assertRaises(TimeoutError):
            self.read(venue, "0", fail=True)

    def test_the_position_check_still_sees_an_unanswered_exchange(self):
        venue = self.venue()
        self.read(venue, "150.5")
        original = live_venues.hyperliquid_info

        def info(body, timeout=5):
            raise TimeoutError("the info API did not answer")

        live_venues.hyperliquid_info = info
        try:  # fetch_positions reads afresh: a silent exchange must not look like "no positions"
            with self.assertRaises(TimeoutError):
                venue.fetch_positions()
        finally:
            live_venues.hyperliquid_info = original


if __name__ == "__main__":
    unittest.main(verbosity=2)
