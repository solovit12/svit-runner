"""Python strategy SDK on the shared order engine; no Nautilus or network."""

from decimal import Decimal
import tempfile
from pathlib import Path
import unittest

from pine_orders import ARRIVAL_MS, TRIGGER_DELAY_MS
from psr_sdk import Param, Strategy
from psr_sdk.packs import discover, load_strategy
from psr_sdk.runner import StrategyError, StrategyRunner

T0 = 1_791_000_000_000
H = 3_600_000


def bar(index, close, high=None, low=None):
    return {"openTime": T0 + index * H, "closeTime": T0 + (index + 1) * H, "open": close,
            "high": high or close, "low": low or close, "close": close, "volume": 1}


class Recorder(Strategy):
    timeframe = "1h"
    params = {"size": Param(float, 1.0, min=0.1, max=5)}

    def __init__(self):
        self.events = []

    def on_bar(self, ctx, item):
        self.events.append(("bar", ctx.is_history, item.close))
        if not ctx.is_history and item.close > 100 and ctx.position == 0:
            ctx.entry("L", "long", size=ctx.params["size"])
            ctx.exit("XL", "L", profit_ticks=100, loss_ticks=50)
        if not ctx.is_history and item.close < 95:
            ctx.close("L")

    def on_fill(self, ctx, fill):
        self.events.append(("fill", fill.category, fill.side, fill.qty, fill.leg))

    def on_order_rejected(self, ctx, order_id, reason):
        self.events.append(("rejected", order_id))


class IocLevels(Strategy):
    """Places an IOC limit entry on the quote that reaches its level."""
    timeframe = "1h"

    def __init__(self):
        self.events = []

    def on_quote(self, ctx, quote):
        if ctx.position == 0 and "L" not in {o["id"] for o in ctx.orders.values()} and quote.ask <= 99:
            ctx.entry("L", "long", limit=Decimal("99.00"), ioc=True)
            ctx.exit("XL", "L", profit_percent=1.2, loss_percent=1.0, profit_type="market")

    def on_fill(self, ctx, fill):
        self.events.append(("fill", fill.category, fill.qty, fill.price, fill.leg))

    def on_order_rejected(self, ctx, order_id, reason):
        self.events.append(("rejected", order_id, reason))


class Broken(Strategy):
    def on_bar(self, ctx, item):
        raise RuntimeError("boom")


class IocTest(unittest.TestCase):
    def setUp(self):
        self.runner = StrategyRunner(IocLevels, params={}, venue="lighter", market="SOL", mintick="0.01")
        self.runner.warm_up([bar(0, 100)])
        self.runner.start(T0 + H)
        self.events = self.runner.strategy.events
        self.at = T0 + H + 1000

    def place(self):
        self.runner.on_quote("98.90", "99.00", self.at)  # touch: the strategy sends the IOC
        self.assertEqual(self.runner.manager.take_requests(), [])  # still travelling
        self.runner.on_quote("99.10", "99.20", self.at + ARRIVAL_MS)  # price left; the IOC still arrives
        [request] = self.runner.manager.take_requests()
        self.assertEqual((request.ioc, request.limit, request.side), (True, Decimal("99.00"), "buy"))
        return request

    def test_unfilled_ioc_is_rejected_with_reason_and_never_rests(self):
        request = self.place()
        self.runner.exec_result(request.id, filled=0, average=0, opened=0, now_ms=self.at + 201, reason="price_left_limit")
        self.assertEqual(self.events, [("rejected", "L", "price_left_limit")])
        self.assertEqual(self.runner.ctx.position, 0.0)
        self.assertNotIn("entry:L", self.runner.orders)
        self.runner.on_quote("99.10", "99.20", self.at + 500)
        self.assertEqual(self.runner.manager.take_requests(), [])

    def test_partial_ioc_opens_real_size_and_market_take_profit_from_average(self):
        request = self.place()
        self.runner.exec_result(request.id, filled="3", average="98.995", opened="3", now_ms=self.at + 201)
        self.assertEqual(self.events, [("fill", "entry", 3.0, 98.995, "limit")])
        self.assertEqual(self.runner.ctx.trades[0].entry_price, 98.995)
        tp = Decimal("98.995") * Decimal("1.012")  # 100.18294
        self.runner.on_quote("100.18", "100.20", self.at + 300)
        self.assertEqual(self.runner.manager.take_requests(), [])
        self.runner.on_quote(str(tp), "100.20", self.at + 400)  # reached: trigger, not a resting limit
        self.assertEqual(self.runner.manager.take_requests(), [])
        self.runner.evaluate(self.at + 400 + TRIGGER_DELAY_MS)
        [exit_request] = self.runner.manager.take_requests()
        self.assertEqual((exit_request.limit, exit_request.close_qty, exit_request.side), (None, Decimal("3"), "sell"))
        self.runner.exec_result(exit_request.id, filled="3", average="100.10", opened="0", now_ms=self.at + 710)
        self.assertEqual(self.events[-1], ("fill", "exit", 3.0, 100.1, "profit"))
        self.assertEqual(self.runner.ctx.position, 0.0)

    def test_percent_stop_loss(self):
        request = self.place()
        self.runner.exec_result(request.id, filled="2", average="99", opened="2", now_ms=self.at + 201)
        self.runner.on_quote("98.02", "98.05", self.at + 300)  # SL 98.01 not reached
        self.runner.evaluate(self.at + 900)
        self.assertEqual(self.runner.manager.take_requests(), [])
        self.runner.on_quote("98.01", "98.05", self.at + 1000)
        self.runner.evaluate(self.at + 1000 + TRIGGER_DELAY_MS)
        [stop] = self.runner.manager.take_requests()
        self.assertEqual((stop.limit, stop.close_qty), (None, Decimal("2")))

    def test_ioc_needs_a_limit(self):
        with self.assertRaises(ValueError):
            self.runner.ctx.entry("X", "long", ioc=True)


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.runner = StrategyRunner(Recorder, params={"size": 0.5}, venue="lighter", market="SOL", mintick="0.01")
        self.runner.warm_up([bar(0, 99), bar(1, 101)])
        self.runner.start(T0 + 2 * H)
        self.events = self.runner.strategy.events

    def fill(self, request, qty, price, at):
        self.runner.exec_result(request.id, filled=qty, average=price,
                                opened=max(Decimal(0), Decimal(qty) - request.close_qty), now_ms=at)

    def test_entry_with_an_amount_in_usdc(self):
        class Fixed(Strategy):
            timeframe = "1m"
            warmup_bars = 0

            def on_quote(self, ctx, quote):
                if not ctx.orders and ctx.position == 0:
                    ctx.entry("U", "long", usdc=2000)
                    for bad in ({"usdc": 2000, "size": 2}, {"usdc": 0}):
                        try:
                            ctx.entry("V", "long", **bad)
                        except ValueError:
                            ctx.state.setdefault("refused", []).append(bad)

        runner = StrategyRunner(Fixed, params={}, venue="lighter", market="SOL", mintick="0.01")
        runner.start(T0)
        runner.on_quote("100.9", "101.0", T0)
        runner.evaluate(T0 + ARRIVAL_MS)
        [request] = runner.manager.take_requests()
        self.assertEqual((request.open_side, request.notional, request.size_scale), ("long", Decimal("2000"), Decimal("1")))
        self.assertEqual(len(runner.ctx.state["refused"]), 2)

    def test_history_bars_warm_up_without_trading(self):
        self.assertEqual(self.events[:2], [("bar", True, 99.0), ("bar", True, 101.0)])
        self.assertEqual(self.runner.orders, {})

    def test_entry_with_brackets_executes_through_the_shared_engine(self):
        at = T0 + 3 * H
        self.runner.on_bar(bar(2, 101), at)
        self.runner.on_quote("100.9", "101.0", at + ARRIVAL_MS)
        [request] = self.runner.manager.take_requests()
        self.assertEqual((request.side, request.open_side, request.size_scale), ("buy", "long", Decimal("0.5")))
        self.fill(request, "4", "101.0", at + ARRIVAL_MS + 5)
        self.assertEqual(self.events[-1], ("fill", "entry", "long", 4.0, "market"))
        self.assertEqual(self.runner.ctx.position, 4.0)
        self.assertEqual(self.runner.ctx.trades[0].entry_price, 101.0)
        # Take-profit from the real entry: 101.00 + 100 ticks = 102.00.
        self.runner.on_quote("102.00", "102.1", at + 1000)
        [tp] = self.runner.manager.take_requests()
        self.assertEqual((tp.side, tp.limit, tp.close_qty), ("sell", Decimal("102.00"), Decimal("4")))
        self.fill(tp, "4", "102.00", at + 1001)
        self.assertEqual(self.events[-1], ("fill", "exit", "long", 4.0, "profit"))
        self.assertEqual(self.runner.ctx.position, 0.0)
        self.assertEqual(self.runner.ledger, {})
        self.assertEqual(self.runner.orders, {})  # exits end with their trades

    def test_stop_loss_and_market_close(self):
        at = T0 + 3 * H
        self.runner.on_bar(bar(2, 101), at)
        self.runner.on_quote("100.9", "101.0", at + ARRIVAL_MS)
        [request] = self.runner.manager.take_requests()
        self.fill(request, "4", "101.0", at + 300)
        self.runner.on_quote("100.50", "100.6", at + 400)  # stop 100.50 crossed
        self.runner.evaluate(at + 400 + TRIGGER_DELAY_MS)
        [stop] = self.runner.manager.take_requests()
        self.assertEqual((stop.side, stop.limit), ("sell", None))
        self.fill(stop, "1", "100.4", at + 800)  # partial
        self.assertEqual(self.runner.ctx.position, 3.0)
        # A bar below 95 closes the rest at market (the triggered stop keeps working too).
        self.runner.on_bar(bar(3, 94), at + H)
        self.assertIn("exit:close:L", self.runner.orders)

    def test_close_request_closes_at_market_and_the_strategy_goes_on(self):
        """The owner's "Close positions": the position goes at market, the runner keeps running."""
        at = T0 + 3 * H
        self.runner.on_bar(bar(2, 101), at)
        self.runner.on_quote("100.9", "101.0", at + ARRIVAL_MS)
        [request] = self.runner.manager.take_requests()
        self.fill(request, "4", "101.0", at + 300)
        self.assertEqual(self.runner.ctx.position, 4.0)
        self.runner.close_request("the owner pressed Close positions", at + 400)
        self.assertIn("exit:close:*", self.runner.orders)     # queued the moment the owner asked
        self.runner.on_quote("100.9", "101.0", at + 400 + ARRIVAL_MS)
        [close] = self.runner.manager.take_requests()
        self.assertEqual((close.side, close.limit, close.close_qty), ("sell", None, Decimal("4")))
        self.assertEqual((close.kind, close.why), ("exit", "the owner pressed Close positions"))
        self.fill(close, "4", "100.9", at + 400 + ARRIVAL_MS + 10)
        self.assertEqual(self.runner.ctx.position, 0.0)
        self.assertTrue(self.runner.started)          # the run goes on
        # ... and the same strategy enters again on its own rule, as after any other exit.
        self.runner.on_bar(bar(4, 101), at + 2 * H)
        self.runner.on_quote("100.9", "101.0", at + 2 * H + ARRIVAL_MS)
        [again] = self.runner.manager.take_requests()
        self.assertEqual((again.side, again.open_side), ("buy", "long"))

    def test_close_request_without_a_position_sends_nothing(self):
        self.runner.close_request("the owner pressed Close positions", T0 + 3 * H)
        self.assertEqual(self.runner.manager.take_requests(), [])

    def test_entry_without_real_size_is_reported_as_rejected(self):
        at = T0 + 3 * H
        self.runner.on_bar(bar(2, 101), at)
        self.runner.on_quote("100.9", "101.0", at + ARRIVAL_MS)
        [request] = self.runner.manager.take_requests()
        self.runner.exec_result(request.id, filled=0, average=0, opened=0, now_ms=at + 300, reason="notional_below_minimum")
        self.assertEqual(self.events[-1], ("rejected", "L"))
        self.assertEqual(self.runner.ledger, {})

    def test_strategy_exceptions_stop_with_a_named_error(self):
        runner = StrategyRunner(Broken, params={}, venue="lighter", market="SOL", mintick="0.01")
        with self.assertRaisesRegex(StrategyError, "Broken.on_bar: RuntimeError: boom"):
            runner.warm_up([bar(0, 1)])

    def test_unknown_or_invalid_params_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "unknown parameter"):
            StrategyRunner(Recorder, params={"x": 1}, venue="lighter", market="SOL", mintick="0.01")
        with self.assertRaisesRegex(ValueError, "at most 5"):
            StrategyRunner(Recorder, params={"size": 9}, venue="lighter", market="SOL", mintick="0.01")


class StatusTest(unittest.TestCase):
    def runner(self):
        return StrategyRunner(Recorder, params={}, venue="lighter", market="BRENTOIL", mintick="0.01")

    def test_a_panel_is_checked_kept_and_removed(self):
        runner = self.runner()
        runner.now_ms = 123
        runner.ctx.status("BRENTOIL/WTI", "BRENTOIL/WTI: long BRENTOIL, short WTI", markets=["BRENTOIL", "WTI"],
                          lines=["r 832.1, entry 818.3"], progress={"label": "to take-profit", "value": 13.8,
                                                                    "target": 25, "unit": "bp", "left_percent": 0.112,
                                                                    "left_usd": 2.24, "usd": None})
        self.assertEqual(runner.panels["BRENTOIL/WTI"], {
            "key": "BRENTOIL/WTI", "title": "BRENTOIL/WTI: long BRENTOIL, short WTI", "at": 123,
            "markets": ["BRENTOIL", "WTI"], "lines": ["r 832.1, entry 818.3"],
            "progress": {"label": "to take-profit", "value": 13.8, "target": 25.0, "unit": "bp",
                         "leftPercent": 0.112, "leftUsd": 2.24}})
        runner.ctx.status("BRENTOIL/WTI", None)
        self.assertEqual(runner.panels, {})

    def test_bad_panels_raise_and_the_count_is_capped(self):
        runner = self.runner()
        for bad in ({"value": 1, "target": 0}, {"value": float("nan"), "target": 1}, {"value": 1}):
            with self.assertRaises((ValueError, KeyError)):
                runner.ctx.status("k", "title", progress=bad)
        with self.assertRaises(ValueError):
            runner.ctx.status("k", "title", progress={"value": 1, "target": 2, "stop": 5})
        runner.ctx.status("k", "title", progress={"value": -1, "target": 2, "stop": -150})
        self.assertEqual(runner.panels["k"]["progress"]["stop"], -150.0)
        runner.ctx.status("k", None)
        with self.assertRaises(ValueError):
            runner.ctx.status("k", "title", lines="one string")
        with self.assertRaises(ValueError):
            runner.ctx.status("k", "  ")
        for index in range(12):
            runner.ctx.status(f"k{index}", "t", lines=["x" * 500] * 9, markets=["M"] * 9)
        self.assertEqual(len(runner.panels), 8)
        self.assertEqual(len(runner.panels["k0"]["lines"]), 6)
        self.assertEqual(len(runner.panels["k0"]["lines"][0]), 200)
        self.assertEqual(len(runner.panels["k0"]["markets"]), 4)
        runner.ctx.status("k0", "replaced")
        self.assertEqual(runner.panels["k0"]["title"], "replaced")


class PackTest(unittest.TestCase):
    def test_private_pack(self):
        with tempfile.TemporaryDirectory() as tmp:
            pack = Path(tmp) / "my_private"
            pack.mkdir()
            (pack / "secret.py").write_text(
                "from psr_sdk import Strategy\nclass Edge(Strategy):\n    name = 'Edge'\n    timeframe = '5m'\n")
            (pack / "broken.py").write_text("raise ImportError('nope')\n")
            rows, errors = discover([str(pack)])
            ids = {row["id"] for row in rows}
            self.assertEqual(ids, {"my_private/secret:Edge"})
            self.assertEqual(errors[0]["module"], "broken")
            cls, digest = load_strategy("my_private/secret:Edge", [str(pack)])
            self.assertEqual((cls.name, len(digest)), ("Edge", 64))
            with self.assertRaisesRegex(ValueError, "not configured"):
                load_strategy("other/secret:Edge", [str(pack)])


class ReasonTest(unittest.TestCase):
    """Why an order was placed travels with it, so every fill says what caused it."""

    class Reasoned(Strategy):
        timeframe = "1h"
        warmup_bars = 0

        def on_quote(self, ctx, quote):
            if ctx.position == 0 and not ctx.orders:
                ctx.entry("L", "long", reason="r -8.3 bp from its 15-min mean")
                ctx.exit("XL", "L", profit_ticks=100, loss_ticks=50)
            elif ctx.position > 0 and quote.bid >= 100.2:
                ctx.close_all(reason="take-profit, r came back +12.0 bp")

    def setUp(self):
        self.runner = StrategyRunner(self.Reasoned, params={}, venue="lighter", market="SOL", mintick="0.01")
        self.runner.start(T0)
        self.at = T0 + 1000

    def test_the_strategy_names_the_entry_and_the_close(self):
        self.runner.on_quote("99.90", "100.00", self.at)
        self.runner.evaluate(self.at + ARRIVAL_MS)
        [entry] = self.runner.manager.take_requests()
        self.assertEqual(entry.why, "r -8.3 bp from its 15-min mean")
        self.runner.exec_result(entry.id, filled="2", average="100", opened="2", now_ms=self.at + ARRIVAL_MS)
        # 100.20: neither the take-profit (101.00) nor the stop (99.50); the strategy closes by itself.
        self.runner.on_quote("100.20", "100.30", self.at + 2000)
        self.runner.evaluate(self.at + 2000 + ARRIVAL_MS)
        [close] = self.runner.manager.take_requests()
        self.assertEqual((close.kind, close.why), ("exit", "take-profit, r came back +12.0 bp"))

    def test_an_exit_leg_without_a_reason_is_named_by_the_engine(self):
        self.runner.on_quote("99.90", "100.00", self.at)
        self.runner.evaluate(self.at + ARRIVAL_MS)
        [entry] = self.runner.manager.take_requests()
        self.runner.exec_result(entry.id, filled="2", average="100", opened="2", now_ms=self.at + ARRIVAL_MS)
        self.runner.on_quote("101.00", "101.10", self.at + 2000)   # take-profit 100 + 100 ticks
        self.runner.evaluate(self.at + 2000)
        [profit] = self.runner.manager.take_requests()
        self.assertEqual(profit.why, "take-profit order")

    def test_a_reason_is_text_and_is_cut_to_its_limit(self):
        self.runner.ctx.close(reason="x" * 500)
        self.assertEqual(len(self.runner.orders["exit:close:*"]["reason"]), 120)
        self.runner.ctx.close(reason="   ")
        self.assertNotIn("reason", self.runner.orders["exit:close:*"])


if __name__ == "__main__":
    unittest.main()
