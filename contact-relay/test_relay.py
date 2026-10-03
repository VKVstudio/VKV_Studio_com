"""Offline regression tests. Synthetic fixtures are retained for review."""

from __future__ import annotations

import hashlib
import hmac
import json
from pathlib import Path
import sqlite3
import ssl
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent))
import relay


NOW = 1_791_000_000
KEY = bytes(range(32))  # Deterministic synthetic fixture; never a deployment key.
KEY_ID = "unit-test"
REQUEST_ID = "43b2b2aa-a13b-4c4e-8a6d-9a5b9187de13"
MAIL = relay.Mail(REQUEST_ID, "visitor@example.com", "Synthetic enquiry only. Проверка 🧪.")
# Retain synthetic ledgers in the operating system temporary directory.
FIXTURES = Path(tempfile.gettempdir())


def identifier(number: int) -> str:
    return str(UUID(int=number, version=4))


def signed(body: bytes | None = None, *, nonce: str = "A" * 32, timestamp: int = NOW,
           method: str = "POST", path: str = relay.PATH) -> relay.Request:
    body = MAIL.canonical() if body is None else body
    material = "\n".join((relay.PROTOCOL, KEY_ID, method, path, str(timestamp), nonce,
                           hashlib.sha256(body).hexdigest()))
    signature = hmac.new(KEY, material.encode("ascii"), hashlib.sha256).hexdigest()
    return relay.Request(method, path, {
        "x-vkv-relay-key-id": KEY_ID, "x-vkv-relay-time": str(timestamp),
        "x-vkv-relay-nonce": nonce, "x-vkv-relay-signature": signature,
    }, body)


def wire(body: bytes = b"", *, method: str = "GET", path: str = relay.PATH + "/readiness",
         extra: str = "") -> bytes:
    return (f"{method} {path} HTTP/1.1\r\nHost: api.vkvstudio.com\r\n"
            f"Content-Length: {len(body)}\r\nContent-Type: application/json\r\n"
            f"{extra}\r\n").encode("ascii") + body


class FakeConnection:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = chunks
        self.timeouts: list[float] = []
        self.output = b""
        self.closed = False

    def recv(self, size: int) -> bytes:
        if not self.chunks:
            return b""
        block = self.chunks.pop(0)
        if len(block) > size:
            self.chunks.insert(0, block[size:])
        return block[:size]

    def settimeout(self, timeout: float) -> None:
        self.timeouts.append(timeout)

    def sendall(self, data: bytes) -> None:
        self.output += data

    def close(self) -> None:
        self.closed = True


class MailValidationTests(unittest.TestCase):
    def test_valid_unicode_and_strict_canonical_envelope(self) -> None:
        self.assertEqual(relay.validate_mail(MAIL.canonical()), MAIL)
        self.assertEqual(json.loads(MAIL.canonical())["version"], 1)

    def test_mail_address_controls_extra_fields_types_and_size(self) -> None:
        for change in (
            {"to": "other@example.com"}, {"version": True}, {"version": 1.0},
            {"version": 2}, {"replyEmail": "other@example.com\r\nBcc:x@example.com"},
            {"replyEmail": "one@example.com,two@example.com"}, {"replyEmail": "Name <x@a.com>"},
            {"replyEmail": "кириллица@example.com"}, {"replyEmail": "a..b@example.com"},
            {"replyEmail": "a" * 255 + "@example.com"}, {"requestId": "no"},
            {"text": "short"}, {"text": "x" * 8193}, {"text": "x" * 30 + "\x00"},
            {"text": "x" * 30 + "\x7f"}, {"text": "x" * 30 + "\ud800"},
            {"text": None}, {"html": "<h1>hello</h1>"}
        ):
            with self.subTest(change=list(change)):
                value = {**MAIL.envelope(), **change}
                with self.assertRaises(relay.Rejected):
                    relay.validate_mail(json.dumps(value).encode())

    def test_duplicate_json_invalid_utf8_depth_and_body_bytes(self) -> None:
        for body in (b'{"version":1,"version":1}', b'\xff', b"[]", b"{" + b" " * 16384,
                     b"[" * 2000 + b"]" * 2000):
            with self.subTest(length=len(body)), self.assertRaises(relay.Rejected):
                relay.validate_mail(body)


class AuthenticationTests(unittest.TestCase):
    def test_exact_raw_bytes_and_time_boundaries(self) -> None:
        for offset in (-120, 0, 30):
            request = signed(timestamp=NOW + offset)
            self.assertEqual(relay.authenticate(request, KEY_ID, KEY, NOW),
                             ("A" * 32, NOW + offset + 120))
        body = json.dumps(MAIL.envelope(), indent=2).encode()
        self.assertEqual(relay.authenticate(signed(body), KEY_ID, KEY, NOW)[0], "A" * 32)

    def test_expired_future_forged_key_and_noncanonical_headers(self) -> None:
        for changes in (
            {"x-vkv-relay-time": str(NOW - 121)}, {"x-vkv-relay-time": str(NOW + 31)},
            {"x-vkv-relay-time": "0" + str(NOW)}, {"x-vkv-relay-time": str(NOW) + ".0"},
            {"x-vkv-relay-nonce": "A" * 31}, {"x-vkv-relay-nonce": "A" * 31 + "="},
            {"x-vkv-relay-signature": "0" * 64}, {"x-vkv-relay-key-id": "other"},
            {"x-vkv-relay-signature": signed().headers["x-vkv-relay-signature"].upper()},
        ):
            base = signed()
            bad = relay.Request(base.method, base.path, {**base.headers, **changes}, base.body)
            with self.subTest(changes=list(changes)), self.assertRaises(relay.Rejected):
                relay.authenticate(bad, KEY_ID, KEY, NOW)

    def test_tampered_body_path_method_fail_authentication(self) -> None:
        base = signed()
        for candidate in (
            relay.Request(base.method, base.path, base.headers, base.body + b" "),
            relay.Request("GET", base.path, base.headers, base.body),
            relay.Request(base.method, base.path + "/readiness", base.headers, base.body),
        ):
            with self.assertRaises(relay.Rejected):
                relay.authenticate(candidate, KEY_ID, KEY, NOW)


class ApplicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = Path(tempfile.mkdtemp(prefix="synthetic-", dir=FIXTURES))
        self.path = self.directory / "ledger.sqlite3"
        self.ledger = relay.Ledger(self.path)
        self.dispatch = Mock(return_value="queued")
        self.app = relay.Application(self.ledger, KEY_ID, KEY, self.dispatch, clock=lambda: NOW)

    def test_accepted_duplicate_with_fresh_nonce_does_not_send_again(self) -> None:
        first = self.app.handle(signed())
        second = self.app.handle(signed(nonce="B" * 32))
        self.assertEqual(first, (202, {"ok": True, "status": "queued", "requestId": REQUEST_ID}))
        self.assertEqual(second, first)
        self.dispatch.assert_called_once_with(MAIL)

    def test_same_nonce_and_different_payload_conflict(self) -> None:
        self.assertEqual(self.app.handle(signed())[0], 202)
        self.assertEqual(self.app.handle(signed())[0], 401)
        mail = relay.Mail(REQUEST_ID, MAIL.reply_email, MAIL.text + " changed")
        self.assertEqual(self.app.handle(signed(mail.canonical(), nonce="B" * 32))[0], 409)
        self.dispatch.assert_called_once()

    def test_same_payload_different_json_format_has_same_idempotency_hash(self) -> None:
        self.app.handle(signed())
        self.assertEqual(self.app.handle(signed(json.dumps(MAIL.envelope()).encode(),
                                                nonce="B" * 32))[0], 202)
        self.dispatch.assert_called_once()

    def test_readiness_is_authenticated_and_does_not_write_ledger(self) -> None:
        before = {path.name: (path.stat().st_mtime_ns, path.read_bytes())
                  for path in self.directory.iterdir()}
        request = signed(b"", method="GET", path=relay.PATH + "/readiness")
        for _ in range(520):
            self.assertEqual(self.app.handle(request), (200, {"ok": True, "transport": "workspace-smtp"}))
        after = {path.name: (path.stat().st_mtime_ns, path.read_bytes())
                 for path in self.directory.iterdir()}
        self.assertEqual(before, after)
        self.assertEqual(self.app.handle(relay.Request("GET", request.path, {}, b""))[0], 401)
        self.dispatch.assert_not_called()

    def test_invalid_payload_and_auth_never_dispatch(self) -> None:
        self.assertEqual(self.app.handle(signed(b"{}"))[0], 422)
        bad = signed()
        self.assertEqual(self.app.handle(relay.Request("POST", relay.PATH, {}, bad.body))[0], 401)
        self.dispatch.assert_not_called()

    def test_unknown_dispatch_errors_remain_unknown_after_restart(self) -> None:
        self.dispatch.side_effect = RuntimeError("synthetic unknown")
        self.assertEqual(self.app.handle(signed())[0], 502)
        ledger = relay.Ledger(self.path)
        app = relay.Application(ledger, KEY_ID, KEY, self.dispatch, clock=lambda: NOW)
        self.assertEqual(app.handle(signed(nonce="B" * 32))[0], 502)
        self.dispatch.assert_called_once()

    def test_crash_after_claim_never_redispatches(self) -> None:
        self.assertEqual(self.ledger.claim(KEY_ID, "A" * 32, NOW + 120, MAIL, NOW), "dispatch")
        self.ledger = relay.Ledger(self.path)
        self.app = relay.Application(self.ledger, KEY_ID, KEY, self.dispatch, clock=lambda: NOW)
        self.assertEqual(self.app.handle(signed(nonce="B" * 32))[0], 502)
        self.dispatch.assert_not_called()

    def test_concurrent_same_nonce_dispatches_once(self) -> None:
        barrier = threading.Barrier(4)
        results: list[int] = []

        def call() -> None:
            barrier.wait()
            results.append(self.app.handle(signed())[0])

        threads = [threading.Thread(target=call) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(5)
            self.assertFalse(thread.is_alive())
        self.assertEqual(sorted(results), [202, 401, 401, 401])
        self.dispatch.assert_called_once()

    def test_one_dispatch_at_a_time(self) -> None:
        self.ledger.claim(KEY_ID, "A" * 32, NOW + 120, MAIL, NOW)
        other = relay.Mail(identifier(2), MAIL.reply_email, MAIL.text)
        self.assertEqual(self.app.handle(signed(other.canonical(), nonce="B" * 32))[0], 503)
        self.dispatch.assert_not_called()

    def test_minute_day_attempt_budgets(self) -> None:
        for i in range(5):
            mail = relay.Mail(identifier(i + 1), MAIL.reply_email, MAIL.text)
            nonce = f"{i:032d}"
            self.assertEqual(self.ledger.claim(KEY_ID, nonce, NOW + 120, mail, NOW), "dispatch")
            self.ledger.finish(mail.request_id, "queued")
        self.assertEqual(self.app.handle(signed())[0], 429)
        with self.ledger.connect() as db:
            db.executemany("INSERT INTO attempts VALUES (?)", [(NOW - 300,) for _ in range(25)])
        self.assertEqual(self.app.handle(signed(nonce="B" * 32))[0], 429)

    def test_pre_data_failure_allows_only_explicit_retry_with_fresh_nonce(self) -> None:
        self.dispatch.side_effect = ["unavailable", "queued"]
        self.assertEqual(self.app.handle(signed())[0], 503)
        self.assertEqual(self.app.handle(signed())[0], 401)
        self.assertEqual(self.app.handle(signed(nonce="B" * 32))[0], 202)
        self.assertEqual(self.app.handle(signed(nonce="C" * 32))[0], 202)
        self.assertEqual(self.dispatch.call_count, 2)

    def test_repeated_same_id_pre_data_failures_count_all_attempts(self) -> None:
        self.dispatch.return_value = "unavailable"
        for i in range(5):
            self.assertEqual(self.app.handle(signed(nonce=f"{i:032d}"))[0], 503)
        self.assertEqual(self.app.handle(signed())[0], 429)
        self.assertEqual(self.dispatch.call_count, 5)
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM requests").fetchone()[0], 1)
            self.assertEqual(db.execute("SELECT count(*) FROM attempts").fetchone()[0], 5)
        # Five minute-separated batches exhaust the remaining rolling day budget.
        for batch in range(1, 6):
            self.app.clock = lambda batch=batch: NOW + batch * 61
            for attempt in range(5):
                self.assertEqual(self.app.handle(signed(nonce=f"{batch * 5 + attempt:032d}",
                                                         timestamp=NOW + batch * 61))[0], 503)
        self.app.clock = lambda: NOW + 366
        self.assertEqual(self.app.handle(signed(nonce="B" * 32, timestamp=NOW + 366))[0], 429)
        self.assertEqual(self.dispatch.call_count, 30)
        self.app.clock = lambda: NOW + 86_800
        self.assertEqual(self.app.handle(signed(nonce="C" * 32, timestamp=NOW + 86_800))[0], 503)
        self.assertEqual(self.dispatch.call_count, 31)
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM attempts").fetchone()[0], 1)

    def test_concurrent_fresh_nonce_retry_never_overlaps_smtp(self) -> None:
        self.dispatch.return_value = "unavailable"
        self.app.handle(signed())
        entered, release = threading.Event(), threading.Event()

        def held_dispatch(mail: relay.Mail) -> str:
            entered.set()
            self.assertTrue(release.wait(5))
            return "queued"

        self.dispatch.side_effect = held_dispatch
        results: list[int] = []
        thread = threading.Thread(target=lambda: results.append(self.app.handle(signed(nonce="B" * 32))[0]))
        thread.start()
        self.assertTrue(entered.wait(5))
        try:
            self.assertEqual(self.app.handle(signed(nonce="C" * 32))[0], 502)
        finally:
            release.set()
            thread.join(5)
        self.assertEqual(results, [202])
        self.assertEqual(self.dispatch.call_count, 2)

    def test_ledger_stores_no_body_address_and_enforces_storage_budgets(self) -> None:
        self.app.handle(signed())
        with self.ledger.connect() as db:
            self.assertEqual(db.execute("PRAGMA page_size").fetchone()[0], 4096)
            self.assertEqual(db.execute("PRAGMA max_page_count").fetchone()[0], 1024)
            self.assertEqual(db.execute("PRAGMA journal_size_limit").fetchone()[0], 65536)
            self.assertEqual(db.execute("PRAGMA busy_timeout").fetchone()[0], 250)
        content = self.path.read_bytes()
        self.assertNotIn(MAIL.reply_email.encode(), content)
        self.assertNotIn(MAIL.text.encode(), content)
        self.assertNotIn(KEY, content)

    def test_capacity_fails_closed_and_expired_nonce_is_pruned(self) -> None:
        with self.ledger.connect() as db:
            db.executemany("INSERT INTO nonces VALUES (?, ?, ?)",
                           [(KEY_ID, f"{i:032d}", NOW + 120) for i in range(relay.MAX_NONCES)])
        self.assertEqual(self.app.handle(signed())[0], 503)
        with self.ledger.connect() as db:
            db.execute("UPDATE nonces SET expiry=?", (NOW - 1,))
        self.assertEqual(self.app.handle(signed())[0], 202)
        self.dispatch.assert_called_once()

    def test_request_capacity_is_retained_and_fails_closed(self) -> None:
        with self.ledger.connect() as db:
            db.executemany("INSERT INTO requests VALUES (?, ?, 'unknown', ?)",
                           [(identifier(i), "0" * 64, NOW - 90000) for i in range(relay.MAX_IDS)])
        self.assertEqual(self.app.handle(signed())[0], 503)
        self.dispatch.assert_not_called()

    def test_ledger_failure_before_dispatch_and_after_acceptance(self) -> None:
        with patch.object(self.ledger, "claim", side_effect=sqlite3.OperationalError("synthetic")):
            self.assertEqual(self.app.handle(signed())[0], 503)
        self.dispatch.assert_not_called()
        with patch.object(self.ledger, "finish", side_effect=sqlite3.OperationalError("synthetic")):
            self.assertEqual(self.app.handle(signed())[0], 502)
        self.assertEqual(self.app.handle(signed(nonce="B" * 32))[0], 502)
        self.dispatch.assert_called_once()


class ParserTests(unittest.TestCase):
    def test_complete_and_fragmented_requests(self) -> None:
        data = wire(MAIL.canonical(), method="POST", path=relay.PATH)
        connection = FakeConnection([data[:17], data[17:80], data[80:]])
        result = relay.read_request(connection)
        self.assertEqual(result.body, MAIL.canonical())
        self.assertTrue(all(0 < value <= 3 for value in connection.timeouts))

    def test_duplicate_forbidden_headers_and_framing(self) -> None:
        for extra in (
            "Host: api.vkvstudio.com\r\n", "Transfer-Encoding: chunked\r\n",
            "Content-Encoding: gzip\r\n", "Authorization: Bearer synthetic\r\n",
            "Cookie: x=y\r\n", "Expect: 100-continue\r\n", "Trailer: X-Test\r\n",
            "Upgrade: websocket\r\n", "Bad Name: x\r\n", "X-Test:\tx\r\n",
            " Content-Length: 0\r\n", "X-Test: a\r\nX-Test: b\r\n"
        ):
            with self.subTest(extra=extra.split(":")[0]), self.assertRaises(relay.Rejected):
                relay.read_request(FakeConnection([wire(extra=extra)]))

    def test_path_query_host_length_pipeline_utf8_and_header_limits(self) -> None:
        baseline = wire()
        for data in (
            wire(path=relay.PATH + "/readiness?x=1"), wire(path="https://api.vkvstudio.com/"),
            baseline.replace(b"Host: api.vkvstudio.com", b"Host: other.example"),
            baseline.replace(b"Content-Length: 0", b"Content-Length: -1"),
            baseline.replace(b"Content-Length: 0", b"Content-Length: 00"),
            baseline.replace(b"Content-Length: 0", b"Content-Length: 16385"),
            baseline + baseline, baseline.replace(b"Host:", b"\xffHost:"),
            wire(extra="X-Large: " + "a" * 8192 + "\r\n"),
            wire(b"{}"), wire(b"{}", method="POST", path=relay.PATH)[:-1],
        ):
            with self.subTest(length=len(data)), self.assertRaises(relay.Rejected):
                relay.read_request(FakeConnection([data]))

    def test_whole_read_deadline_is_not_reset_between_chunks(self) -> None:
        clock = Mock(side_effect=[10.0, 10.1, 13.1])
        with self.assertRaises(relay.Rejected) as raised:
            relay.read_request(FakeConnection([b"GET ", b"x"]), clock=clock)
        self.assertEqual(raised.exception.status, 408)

    def test_connection_is_closed_and_errors_do_not_echo_inputs(self) -> None:
        connection = FakeConnection([wire(extra="Authorization: synthetic-private-input\r\n")])
        app = Mock()
        relay.serve_connection(connection, app)
        self.assertTrue(connection.closed)
        self.assertIn(b"Connection: close", connection.output)
        self.assertNotIn(b"synthetic-private-input", connection.output)
        app.handle.assert_not_called()


class SMTPTests(unittest.TestCase):
    def test_tls_verification_order_fixed_headers_and_envelope(self) -> None:
        client = Mock()
        client.ehlo.return_value = (250, b"hello")
        client.send_message.return_value = {}
        factory = Mock(return_value=client)
        self.assertEqual(relay.smtp_send(MAIL, factory), "queued")
        factory.assert_called_once_with("smtp-relay.gmail.com", 587, timeout=5)
        self.assertEqual([call[0] for call in client.method_calls],
                         ["ehlo", "starttls", "ehlo", "send_message", "close"])
        context = client.starttls.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        message = client.send_message.call_args.args[0]
        self.assertEqual(message["From"], relay.MAILBOX)
        self.assertEqual(message["To"], relay.MAILBOX)
        self.assertEqual(message["Reply-To"], MAIL.reply_email)
        self.assertEqual(message.get_content_type(), "text/plain")
        self.assertEqual(client.send_message.call_args.kwargs,
                         {"from_addr": relay.MAILBOX, "to_addrs": [relay.MAILBOX]})
        client.login.assert_not_called()

    def test_pre_dispatch_tls_or_ehlo_failure_is_unavailable(self) -> None:
        for stage in ("connect", "starttls", "ehlo"):
            client = Mock()
            client.ehlo.return_value = (250, b"ok")
            factory = Mock(return_value=client)
            if stage == "connect":
                factory.side_effect = OSError("synthetic")
            else:
                getattr(client, stage).side_effect = OSError("synthetic")
            self.assertEqual(relay.smtp_send(MAIL, factory), "unavailable")
            client.send_message.assert_not_called()

    def test_post_tls_ehlo_is_required(self) -> None:
        client = Mock()
        client.ehlo.side_effect = [(250, b"ok"), (500, b"failure")]
        self.assertEqual(relay.smtp_send(MAIL, Mock(return_value=client)), "unavailable")
        client.send_message.assert_not_called()

    def test_send_failure_is_unknown_and_close_after_acceptance_cannot_undo_receipt(self) -> None:
        client = Mock()
        client.ehlo.return_value = (250, b"ok")
        client.send_message.side_effect = OSError("synthetic")
        self.assertEqual(relay.smtp_send(MAIL, Mock(return_value=client)), "unknown")
        client.send_message.side_effect = None
        client.send_message.return_value = {}
        client.close.side_effect = OSError("synthetic")
        self.assertEqual(relay.smtp_send(MAIL, Mock(return_value=client)), "queued")

    def test_child_has_no_environment_credential_or_inherited_descriptors(self) -> None:
        child = Mock(returncode=0)
        child.communicate.return_value = (b"queued\n", None)
        with patch.object(relay.subprocess, "Popen", return_value=child) as start:
            self.assertEqual(relay.dispatch_smtp(MAIL), "queued")
        args, kwargs = start.call_args
        self.assertEqual(kwargs["env"], {})
        self.assertTrue(kwargs["close_fds"])
        self.assertEqual(args[0][-1], "--smtp-child")
        self.assertNotIn("--credential", args[0])
        self.assertEqual(child.communicate.call_args.kwargs["input"], MAIL.canonical())
        self.assertLessEqual(child.communicate.call_args.kwargs["timeout"], 7)
        self.assertNotIn(KEY, MAIL.canonical())

    def test_owned_child_timeout_is_killed_once_never_retried(self) -> None:
        child = Mock(returncode=1)
        child.communicate.side_effect = [subprocess.TimeoutExpired("synthetic", 7), (b"", None)]
        with patch.object(relay.subprocess, "Popen", return_value=child) as start:
            self.assertEqual(relay.dispatch_smtp(MAIL), "unknown")
        start.assert_called_once()
        child.kill.assert_called_once()

    def test_bad_child_receipt_is_unknown_and_failure_to_spawn_is_unavailable(self) -> None:
        child = Mock(returncode=0)
        child.communicate.return_value = (b"delivered\n", None)
        with patch.object(relay.subprocess, "Popen", return_value=child):
            self.assertEqual(relay.dispatch_smtp(MAIL), "unknown")
        with patch.object(relay.subprocess, "Popen", side_effect=OSError("synthetic")):
            self.assertEqual(relay.dispatch_smtp(MAIL), "unavailable")


class SocketActivationTests(unittest.TestCase):
    def test_socket_activation_required_before_accessing_any_descriptor(self) -> None:
        with patch.dict(relay.os.environ, {}, clear=True), self.assertRaises(ValueError):
            relay.serve_systemd(Mock())

    def test_exact_inherited_socket_and_eight_connection_limit_without_bind(self) -> None:
        listener = Mock()
        # The Windows test runtime need not provide AF_UNIX. This test models
        # the Linux descriptor contract without creating a real socket.
        listener.family = 1
        listener.type = relay.socket.SOCK_STREAM
        listener.getsockname.return_value = relay.SOCKET_PATH
        listener.getsockopt.return_value = 1
        connections = [FakeConnection([]) for _ in range(9)]
        listener.accept.side_effect = [(connection, "") for connection in connections] + [KeyboardInterrupt()]
        with patch.object(relay.socket, "AF_UNIX", 1, create=True), \
                patch.object(relay.os, "name", "posix"), patch.dict(relay.os.environ, {
            "LISTEN_PID": str(relay.os.getpid()), "LISTEN_FDS": "1", "LISTEN_FDNAMES": "contact-relay"
        }, clear=True), patch.object(relay.socket, "socket", return_value=listener) as obtain, \
                patch.object(relay.threading, "Thread") as thread:
            with self.assertRaises(KeyboardInterrupt):
                relay.serve_systemd(Mock())
        obtain.assert_called_once_with(fileno=3)
        listener.set_inheritable.assert_called_once_with(False)
        listener.bind.assert_not_called()
        listener.listen.assert_not_called()
        self.assertEqual(thread.call_count, 8)
        self.assertFalse(any(connection.closed for connection in connections[:8]))
        self.assertTrue(connections[8].closed)


if __name__ == "__main__":
    # Tripwires prove these tests cannot accidentally open sockets or spawn SMTP.
    with patch.object(relay.socket, "socket", side_effect=AssertionError("No real sockets in tests")), \
            patch.object(relay.subprocess, "Popen", side_effect=AssertionError("No real child in tests")):
        unittest.main(verbosity=2)
