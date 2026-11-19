"""Long pause and silence policy without network or accelerated runtime flags."""
import json
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from runtime import PINE_STRATEGY, make_controller as RuntimeController
from test_lifecycle import has_native

HOUR_MS = 3_600_000
# The built-in strategy is private; the public edition checks the Pine controller only.
KINDS = (PINE_STRATEGY, None) if has_native() else (PINE_STRATEGY,)


class RecoveryPolicyTests(unittest.TestCase):
    def controller(self, kind=None):
        events = []
        emitter = SimpleNamespace(on_failure=None, emit=lambda kind, **fields: events.append({'type': kind, **fields}))
        config = {'mode': 'public', 'volatilityExpiresAtMs': 10**15, **({'nativeStrategy': kind} if kind else {})}
        controller = RuntimeController(config, emitter)
        now = time.time_ns() // 1_000_000
        controller.snapshot = Mock()
        for key in controller.specs:
            controller.strategies[key] = SimpleNamespace(
                pause_for_recovery=Mock(), invalidate_inputs=Mock(), reconnect_socket=Mock(),
                observe_diagnostics=Mock(), signal=SimpleNamespace(last_closed_hour_ms=now//HOUR_MS*HOUR_MS),
                last_quote_ms=now, last_book_ms=now, last_quote_event_ms=now, last_book_event_ms=now,
                run_config={'maxQuoteAgeMs': 1000, 'maxBookAgeMs': 1000},
                input_diagnostics=lambda at_ms=None: ([], {}))
        return controller, events

    def test_ten_minute_pause_keeps_waiting_and_stop_remains_available(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                self.ten_minute_pause(kind)

    def ten_minute_pause(self, kind):
        controller, events = self.controller(kind)
        start = time.monotonic_ns()
        with patch('runtime.time.monotonic_ns', return_value=start):
            controller.begin_recovery('hyperliquid')
            controller.check_recovery()
        with patch('runtime.time.monotonic_ns', return_value=start + 600_000_000_000):
            for _ in range(50):
                controller.check_recovery()
            self.assertTrue(controller.recovering)
            self.assertFalse(controller.stopping)
            checks = [json.loads(e['message'].removeprefix('Recovery diagnostic: ')) for e in events
                      if e.get('message', '').startswith('Recovery diagnostic: ')]
            self.assertEqual(len(checks), 2)
            controller.request_stop('user stops long pause')
            self.assertTrue(controller.stop_event.is_set())
            self.assertFalse(controller.failed)
            self.assertTrue(any('duration 600000 ms' in e.get('message', '') for e in events))

    def test_silent_feed_pauses_before_requesting_existing_client_reconnect(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                self.silent_feed(kind)

    def silent_feed(self, kind):
        controller, events = self.controller(kind)
        controller.connected_endpoints.add('hyperliquid-data-streams')
        strategy = controller.strategies['hyperliquid']
        strategy.reconnect_socket.side_effect = lambda *args: self.assertTrue(controller.recovering)
        controller.recover_silent_feed('hyperliquid')
        strategy.reconnect_socket.assert_called_once()
        client, endpoint = strategy.reconnect_socket.call_args.args
        self.assertEqual(str(client), str(controller.specs['hyperliquid'].source_venue))
        self.assertEqual(endpoint, 'hyperliquid-data-streams')
        self.assertFalse(controller.recovery_gaps['hyperliquid']['connected'])
        # Only the silent venue's markets pause; the other venue keeps trading.
        for key, strategy in controller.strategies.items():
            expected = 1 if controller.specs[key].venue_key == 'hyperliquid' else 0
            self.assertEqual(strategy.pause_for_recovery.call_count, expected, key)
        self.assertTrue(any('reconnect requested' in e.get('message', '') for e in events))

    def test_a_reconnected_market_without_a_book_is_resubscribed_and_never_reconnected(self):
        controller, events = self.controller(PINE_STRATEGY)
        controller.config['mode'] = 'public'
        key = next(k for k, spec in controller.specs.items() if spec.venue_key == 'lighter')
        bridge = SimpleNamespace(resubscribe_book=Mock())
        controller.bridges = {key: bridge}
        controller.connected_endpoints.add('lighter-data-streams')
        start = time.monotonic_ns()
        with patch('runtime.time.monotonic_ns', return_value=start):
            controller.begin_recovery(key)
            controller.socket_state('lighter-data-streams', 'CONNECTED')
        second = 1_000_000_000
        # 10 s, then 30 s, 1 min and every 5 min; the venue socket is never reconnected for one market.
        for at_s, resubscribes, reconnects in ((5, 0, 0), (10, 1, 0), (39, 1, 0), (41, 2, 0), (102, 3, 0), (403, 4, 0), (704, 5, 0)):
            with patch('runtime.time.monotonic_ns', return_value=start + at_s * second):
                controller.revive_stalled_tracks()
            self.assertEqual(bridge.resubscribe_book.call_count, resubscribes, at_s)
            self.assertEqual(controller.strategies[key].reconnect_socket.call_count, reconnects, at_s)
        # Once the market has its book again, nothing more is requested.
        controller.recovery_gaps[key]['book_ready'] = True
        with patch('runtime.time.monotonic_ns', return_value=start + 2_000 * second):
            controller.revive_stalled_tracks()
        self.assertEqual(bridge.resubscribe_book.call_count, 5)
        self.assertTrue(any('resubscribing (attempt 1)' in e.get('message', '') for e in events))

    def test_one_silent_market_is_resubscribed_without_touching_its_venue(self):
        controller, events = self.controller(PINE_STRATEGY)
        controller.config['mode'] = 'public'
        keys = [k for k, spec in controller.specs.items() if spec.venue_key == 'lighter']
        key = keys[0]
        controller.bridges = {key: SimpleNamespace(resubscribe_book=Mock())}
        controller.recover_silent_market(key)
        controller.bridges[key].resubscribe_book.assert_called_once()
        self.assertTrue(controller.track_recovering(key))
        for other in controller.specs:
            if other != key:
                self.assertFalse(controller.track_recovering(other), other)
                self.assertEqual(controller.strategies[other].pause_for_recovery.call_count, 0, other)
            self.assertEqual(controller.strategies[other].reconnect_socket.call_count, 0, other)

    def test_pine_and_python_recovery_does_not_read_native_hourly_signal(self):
        # Pine/Python tracks have no built-in strategy signal (signal is None);
        # a short data gap must not crash the recovery check (run 2095ef54).
        controller, _ = self.controller(PINE_STRATEGY)
        for strategy in controller.strategies.values():
            strategy.signal = None
        controller.begin_recovery('lighter')
        blockers, _ = controller.recovery_input_state()
        self.assertNotIn('hourly_candles_not_ready', blockers)


class OtherVenuesAtTheGapTests(unittest.TestCase):
    """A gap on one exchange records what the others were doing in the same second.

    2026-11-14: Hyperliquid alone was silent for 90 s (HTTP 502 from its API) while Lighter kept
    delivering. Without this line the journal does not say whose side a silence is on.
    """

    def controller(self, tracks=None):
        events = []
        emitter = SimpleNamespace(on_failure=None, sync=lambda: None,
                                  emit=lambda kind, **fields: events.append({'type': kind, **fields}))
        config = {'mode': 'public', 'volatilityExpiresAtMs': 10 ** 15, 'nativeStrategy': PINE_STRATEGY,
                  **({'tracks': tracks} if tracks else {})}
        controller = RuntimeController(config, emitter)
        controller.snapshot = Mock()
        controller.flush_diagnostics = Mock()
        for key in controller.specs:
            controller.strategies[key] = SimpleNamespace(pause_for_recovery=Mock(), invalidate_inputs=Mock())
        return controller, events

    def messages(self, events):
        return [event['message'] for event in events if event['type'] == 'event']

    def test_another_exchange_still_delivering_points_at_the_silent_one(self):
        controller, events = self.controller()
        now = time.time_ns() // 1_000_000
        controller.last_public_ms['lighter'] = now - 300
        controller.last_public_ms['hyperliquid'] = now - 90_000
        controller.begin_recovery('hyperliquid')
        line = next(message for message in self.messages(events) if 'went silent' in message)
        self.assertIn('Hyperliquid went silent; last public data elsewhere: Lighter ', line)
        self.assertIn("this server's connection is working, so the silence is on its side", line)
        self.assertNotIn('Hyperliquid ', line.split('elsewhere:')[1])  # only the other exchanges

    def test_every_exchange_quiet_points_at_this_server(self):
        controller, events = self.controller()
        now = time.time_ns() // 1_000_000
        controller.last_public_ms['lighter'] = now - 70_000
        controller.last_public_ms['hyperliquid'] = now - 70_000
        controller.begin_recovery('hyperliquid')
        line = next(message for message in self.messages(events) if 'went silent' in message)
        self.assertIn("this server's connection may be the cause", line)

    def test_an_exchange_that_never_delivered_is_named_as_such(self):
        controller, events = self.controller()
        controller.last_public_ms['lighter'] = None
        controller.begin_recovery('hyperliquid')
        self.assertIn('Lighter nothing yet', next(m for m in self.messages(events) if 'went silent' in m))

    def test_a_one_exchange_run_says_there_is_nothing_to_compare(self):
        controller, events = self.controller([{'venue': 'lighter', 'market': 'XAU'}])
        controller.begin_recovery('lighter:XAU')
        line = next(message for message in self.messages(events) if 'went silent' in message)
        self.assertIn('this run trades no other exchange, so there is nothing to compare it with', line)

    def test_the_line_is_written_once_per_gap_not_per_market(self):
        controller, events = self.controller([{'venue': 'hyperliquid', 'market': 'xyz:GOLD'},
                                              {'venue': 'hyperliquid', 'market': 'xyz:SILVER'},
                                              {'venue': 'lighter', 'market': 'XAU'}])
        controller.last_public_ms['lighter:XAU'] = time.time_ns() // 1_000_000
        controller.begin_recovery('hyperliquid:xyz:GOLD')
        controller.begin_recovery('hyperliquid:xyz:SILVER')
        self.assertEqual(len([m for m in self.messages(events) if 'went silent' in m]), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
