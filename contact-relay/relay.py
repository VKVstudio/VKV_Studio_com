"""Fixed-recipient Workspace relay. Importing this module performs no I/O."""

from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import smtplib
import socket
import sqlite3
import ssl
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from email.message import EmailMessage
from email.policy import SMTP
from typing import Callable, Iterator
from uuid import UUID


PROTOCOL = "VKV-CONTACT-RELAY/1"
PATH = "/_internal/vkv-contact"
SOCKET_PATH = "/run/vkvstudio-contact-relay.sock"
MAILBOX = "valerii@vkvstudio.com"
MAX_BODY = 16_384
MAX_HEADERS = 8192
MAX_IDS = 10_000
MAX_NONCES = 512
MAX_DB_PAGES = 1024
SMTP_SECONDS = 7.0
KEY_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,31}\Z")
# Deliberately the same conservative ASCII mailbox grammar as Zod's email().
EMAIL = re.compile(
    r"(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+\-]@"
    r"([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}\Z"
)


class Rejected(Exception):
    """An intentionally generic HTTP failure, without input or secret details."""

    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status = status
        self.code = code


@dataclass(frozen=True)
class Request:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes


@dataclass(frozen=True)
class Mail:
    request_id: str
    reply_email: str
    text: str

    def envelope(self) -> dict[str, object]:
        return {"version": 1, "requestId": self.request_id,
                "replyEmail": self.reply_email, "text": self.text}

    def canonical(self) -> bytes:
        return json.dumps(self.envelope(), sort_keys=True, ensure_ascii=False,
                          separators=(",", ":")).encode("utf-8")


def unique_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate-key")
        result[key] = value
    return result


def validate_mail(body: bytes) -> Mail:
    """Independent, dependency-free server validation of the entire envelope."""
    if not 1 <= len(body) <= MAX_BODY:
        raise Rejected(413, "invalid")
    try:
        value = json.loads(body.decode("utf-8", errors="strict"),
                           object_pairs_hook=unique_object)
        if not isinstance(value, dict) or set(value) != {
            "version", "requestId", "replyEmail", "text"
        }:
            raise ValueError("keys")
        if type(value["version"]) is not int or value["version"] != 1:
            raise ValueError("version")
        request_id, email, text = value["requestId"], value["replyEmail"], value["text"]
        if not isinstance(request_id, str) or not re.fullmatch(
            r"(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
            r"|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)",
            request_id
        ) or str(UUID(request_id)) != request_id:
            raise ValueError("request-id")
        if not isinstance(email, str) or len(email) > 254 or EMAIL.fullmatch(email) is None:
            raise ValueError("email")
        if not isinstance(text, str) or not 20 <= len(text) <= 8192:
            raise ValueError("text")
        if any((ord(c) < 32 and c not in "\t\n\r") or ord(c) == 127
               or 0xD800 <= ord(c) <= 0xDFFF for c in text):
            raise ValueError("control")
        return Mail(request_id, email, text)
    except (UnicodeError, ValueError, TypeError, RecursionError) as error:
        raise Rejected(422, "invalid") from error


def authenticate(request: Request, key_id: str, key: bytes, now: int) -> tuple[str, int]:
    headers = request.headers
    timestamp = headers.get("x-vkv-relay-time", "")
    nonce = headers.get("x-vkv-relay-nonce", "")
    signature = headers.get("x-vkv-relay-signature", "")
    if (headers.get("x-vkv-relay-key-id") != key_id
            or re.fullmatch(r"[1-9][0-9]{9}", timestamp) is None
            or re.fullmatch(r"[A-Za-z0-9_-]{32}", nonce) is None
            or re.fullmatch(r"[a-f0-9]{64}", signature) is None):
        raise Rejected(401, "unauthorized")
    seconds = int(timestamp)
    if not now - 120 <= seconds <= now + 30:
        raise Rejected(401, "unauthorized")
    material = "\n".join((PROTOCOL, key_id, request.method, request.path,
                           timestamp, nonce, hashlib.sha256(request.body).hexdigest()))
    expected = hmac.new(key, material.encode("ascii"), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise Rejected(401, "unauthorized")
    return nonce, seconds + 120


class Ledger:
    """Bounded transport metadata only. No addresses or mail text are persisted."""

    def __init__(self, path: Path) -> None:
        self.path = path.resolve()
        if path.is_symlink() or not self.path.parent.is_dir():
            raise ValueError("ledger-path")
        with self.connect() as db:
            db.execute("PRAGMA page_size=4096")
            db.execute("PRAGMA journal_mode=TRUNCATE")
            db.execute("CREATE TABLE IF NOT EXISTS nonces ("
                       "key_id TEXT NOT NULL, nonce TEXT NOT NULL, expiry INTEGER NOT NULL, "
                       "PRIMARY KEY (key_id, nonce))")
            db.execute("CREATE TABLE IF NOT EXISTS requests ("
                       "request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, "
                       "status TEXT NOT NULL CHECK(status IN "
                       "('dispatching','queued','unknown','unavailable')), "
                       "created INTEGER NOT NULL)")
            db.execute("CREATE TABLE IF NOT EXISTS attempts (created INTEGER NOT NULL)")
            db.execute("UPDATE requests SET status='unknown' WHERE status='dispatching'")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=0.25)
        try:
            db.execute("PRAGMA busy_timeout=250")
            db.execute("PRAGMA journal_mode=TRUNCATE")
            db.execute("PRAGMA synchronous=FULL")
            db.execute(f"PRAGMA max_page_count={MAX_DB_PAGES}")
            db.execute("PRAGMA journal_size_limit=65536")
            with db:
                yield db
        finally:
            db.close()

    def ready(self) -> bool:
        # mode=ro plus query_only: readiness must never create/modify a ledger,
        # consume a nonce, dispatch SMTP or perform a checkpoint/cleanup write.
        try:
            with closing(sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True,
                                         timeout=0.25)) as db:
                db.execute("PRAGMA query_only=ON")
                return (db.execute("PRAGMA quick_check(1)").fetchone() == ("ok",)
                        and db.execute("SELECT count(*) FROM requests").fetchone()[0] <= MAX_IDS
                        and db.execute("SELECT count(*) FROM nonces").fetchone()[0] <= MAX_NONCES
                        and db.execute("SELECT count(*) FROM attempts").fetchone()[0] <= 30)
        except sqlite3.Error:
            return False

    def claim(self, key_id: str, nonce: str, expiry: int, mail: Mail, now: int) -> str:
        payload_hash = hashlib.sha256(mail.canonical()).hexdigest()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM nonces WHERE expiry < ?", (now,))
            if db.execute("SELECT 1 FROM nonces WHERE key_id=? AND nonce=?",
                          (key_id, nonce)).fetchone():
                return "replay"
            if db.execute("SELECT count(*) FROM nonces").fetchone()[0] >= MAX_NONCES:
                return "unavailable"
            db.execute("INSERT INTO nonces VALUES (?, ?, ?)", (key_id, nonce, expiry))
            previous = db.execute("SELECT payload_hash, status FROM requests WHERE request_id=?",
                                  (mail.request_id,)).fetchone()
            if previous:
                if previous[0] != payload_hash:
                    return "conflict"
                if previous[1] != "unavailable":
                    return "unknown" if previous[1] == "dispatching" else str(previous[1])
            if not previous and db.execute("SELECT count(*) FROM requests").fetchone()[0] >= MAX_IDS:
                return "unavailable"
            # Count attempts, including unsuccessful/unknown submissions, in
            # rolling windows. Backwards clock shifts fail conservatively.
            db.execute("DELETE FROM attempts WHERE created <= ?", (now - 86_400,))
            if (db.execute("SELECT count(*) FROM attempts WHERE created > ?",
                           (now - 60,)).fetchone()[0] >= 5
                    or db.execute("SELECT count(*) FROM attempts").fetchone()[0] >= 30):
                return "rate-limit"
            if db.execute("SELECT 1 FROM requests WHERE status='dispatching' LIMIT 1").fetchone():
                return "unavailable"
            db.execute("INSERT INTO attempts VALUES (?)", (now,))
            if previous:
                # Only a new authenticated POST/nonce can retry an attempt that
                # provably failed before send_message. Never an automatic retry.
                db.execute("UPDATE requests SET status='dispatching' WHERE request_id=?",
                           (mail.request_id,))
            else:
                db.execute("INSERT INTO requests VALUES (?, ?, 'dispatching', ?)",
                           (mail.request_id, payload_hash, now))
            return "dispatch"

    def finish(self, request_id: str, status: str) -> None:
        if status not in {"queued", "unavailable", "unknown"}:
            raise ValueError("outcome")
        with self.connect() as db:
            db.execute("UPDATE requests SET status=? WHERE request_id=? AND status='dispatching'",
                       (status, request_id))


def smtp_send(mail: Mail, factory: Callable[..., smtplib.SMTP] = smtplib.SMTP) -> str:
    """Only called by the isolated SMTP child (fake factory in unit tests)."""
    client: smtplib.SMTP | None = None
    attempted = False
    try:
        message = EmailMessage(policy=SMTP)
        message["From"] = MAILBOX
        message["To"] = MAILBOX
        message["Reply-To"] = mail.reply_email
        message["Subject"] = "VKVstudio project enquiry"
        message["Message-ID"] = f"<{mail.request_id}@vkvstudio.com>"
        message.set_content(mail.text)
        client = factory("smtp-relay.gmail.com", 587, timeout=5)
        if client.ehlo()[0] != 250:
            return "unavailable"
        client.starttls(context=ssl.create_default_context())
        if client.ehlo()[0] != 250:
            return "unavailable"
        attempted = True
        refused = client.send_message(message, from_addr=MAILBOX, to_addrs=[MAILBOX])
        return "unknown" if refused else "queued"
    except Exception:
        # No exception details: smtplib errors can contain addresses and data.
        return "unknown" if attempted else "unavailable"
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


def dispatch_smtp(mail: Mail) -> str:
    """One owned child, no inherited environment, secret fd or automatic retry."""
    started = time.monotonic()
    try:
        child = subprocess.Popen(
            [sys.executable, "-I", "-B", str(Path(__file__).resolve()), "--smtp-child"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            close_fds=True, env={}
        )
    except OSError:
        return "unavailable"
    try:
        output, _ = child.communicate(input=mail.canonical(),
                                      timeout=max(0.001, SMTP_SECONDS - (time.monotonic() - started)))
        if child.returncode == 0 and output in {b"queued\n", b"unavailable\n", b"unknown\n"}:
            return output.decode("ascii").strip()
        return "unknown"
    except (subprocess.TimeoutExpired, OSError):
        # DATA may already have been accepted. Never respawn or claim failure.
        child.kill()
        child.communicate()
        return "unknown"


class Application:
    def __init__(self, ledger: Ledger, key_id: str, key: bytes,
                 dispatch: Callable[[Mail], str] = dispatch_smtp,
                 clock: Callable[[], float] = time.time) -> None:
        if KEY_ID.fullmatch(key_id) is None or len(key) != 32:
            raise ValueError("configuration")
        self.ledger, self.key_id, self.key = ledger, key_id, key
        self.dispatch, self.clock = dispatch, clock

    def handle(self, request: Request) -> tuple[int, dict[str, object]]:
        try:
            if (request.method, request.path) not in {
                ("GET", PATH + "/readiness"), ("POST", PATH)
            }:
                raise Rejected(404, "not-found")
            now = int(self.clock())
            nonce, expiry = authenticate(request, self.key_id, self.key, now)
            if request.method == "GET":
                if request.body or not self.ledger.ready():
                    raise Rejected(503, "unavailable")
                return 200, {"ok": True, "transport": "workspace-smtp"}
            mail = validate_mail(request.body)
            outcome = self.ledger.claim(self.key_id, nonce, expiry, mail, now)
            if outcome == "dispatch":
                try:
                    outcome = self.dispatch(mail)
                except Exception:
                    outcome = "unknown"
                if outcome not in {"queued", "unavailable", "unknown"}:
                    outcome = "unknown"
                try:
                    self.ledger.finish(mail.request_id, outcome)
                except sqlite3.Error:
                    outcome = "unknown"
            if outcome == "queued":
                return 202, {"ok": True, "status": "queued", "requestId": mail.request_id}
            status = {"replay": 401, "conflict": 409, "rate-limit": 429,
                      "unavailable": 503, "unknown": 502}[outcome]
            code = "delivery-unknown" if outcome in {"conflict", "unknown"} else outcome
            raise Rejected(status, code)
        except Rejected as error:
            return error.status, {"ok": False, "code": error.code}
        except sqlite3.Error:
            return 503, {"ok": False, "code": "unavailable"}


def parse_head(head: bytes) -> tuple[str, str, dict[str, str], int]:
    try:
        lines = head.decode("ascii", errors="strict").split("\r\n")
        if len(lines) > 65 or not re.fullmatch(r"(?:GET|POST) [^ ]+ HTTP/1\.1", lines[0]):
            raise ValueError("request-line")
        method, path, _ = lines[0].split(" ")
        if (method, path) not in {("GET", PATH + "/readiness"), ("POST", PATH)}:
            raise Rejected(404, "not-found")
        headers: dict[str, str] = {}
        for line in lines[1:]:
            if ":" not in line:
                raise ValueError("header")
            name, value = line.split(":", 1)
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
                raise ValueError("name")
            if any(ord(c) < 32 or ord(c) > 126 for c in value):
                raise ValueError("value")
            name, value = name.lower(), value.strip(" ")
            if name in headers or name in {
                "transfer-encoding", "content-encoding", "authorization", "proxy-authorization",
                "cookie", "expect", "upgrade", "trailer"
            }:
                raise ValueError("forbidden-header")
            headers[name] = value
        if headers.get("host") != "api.vkvstudio.com":
            raise ValueError("host")
        length = headers.get("content-length", "0" if method == "GET" else "")
        if re.fullmatch(r"0|[1-9][0-9]{0,4}", length) is None:
            raise ValueError("length")
        size = int(length)
        if size > MAX_BODY:
            raise Rejected(413, "invalid")
        if method == "GET" and size != 0:
            raise ValueError("readiness-body")
        if method == "POST" and (size == 0 or re.fullmatch(
                r"application/json(?:\s*;\s*charset=utf-8)?", headers.get("content-type", ""),
                flags=re.IGNORECASE) is None):
            raise Rejected(415, "content-type")
        return method, path, headers, size
    except (ValueError, UnicodeError, IndexError) as error:
        raise Rejected(400, "invalid") from error


def read_request(connection: socket.socket, clock: Callable[[], float] = time.monotonic) -> Request:
    deadline = clock() + 3.0
    data = bytearray()

    def receive() -> bytes:
        remaining = deadline - clock()
        if remaining <= 0:
            raise Rejected(408, "timeout")
        connection.settimeout(remaining)
        try:
            block = connection.recv(4096)
        except (TimeoutError, OSError) as error:
            raise Rejected(408, "timeout") from error
        if not block:
            raise Rejected(400, "invalid")
        return block

    while b"\r\n\r\n" not in data:
        data.extend(receive())
        end = data.find(b"\r\n\r\n")
        if (end < 0 and len(data) >= MAX_HEADERS) or end + 4 > MAX_HEADERS:
            raise Rejected(431, "headers")
    end = data.index(b"\r\n\r\n")
    method, path, headers, size = parse_head(bytes(data[:end]))
    body = data[end + 4:]
    while len(body) < size:
        body.extend(receive())
    if len(body) != size:
        raise Rejected(400, "invalid")
    return Request(method, path, headers, bytes(body))


def serve_connection(connection: socket.socket, app: Application) -> None:
    try:
        try:
            status, value = app.handle(read_request(connection))
        except Rejected as error:
            status, value = error.status, {"ok": False, "code": error.code}
        except Exception:
            status, value = 503, {"ok": False, "code": "unavailable"}
        body = json.dumps(value, separators=(",", ":")).encode("ascii")
        head = (f"HTTP/1.1 {status} Relay\r\nContent-Type: application/json; charset=utf-8\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\nCache-Control: no-store\r\n"
                "X-Content-Type-Options: nosniff\r\n\r\n").encode("ascii")
        connection.settimeout(1.0)
        connection.sendall(head + body)
    except OSError:
        pass
    finally:
        connection.close()


def serve_systemd(app: Application) -> None:
    if (os.name != "posix" or os.environ.get("LISTEN_PID") != str(os.getpid())
            or os.environ.get("LISTEN_FDS") != "1"
            or os.environ.get("LISTEN_FDNAMES") != "contact-relay"):
        raise ValueError("socket-activation")
    listener = socket.socket(fileno=3)
    if (listener.family != socket.AF_UNIX or listener.type != socket.SOCK_STREAM
            or listener.getsockname() != SOCKET_PATH
            or listener.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN) != 1):
        listener.close()
        raise ValueError("socket-activation")
    listener.set_inheritable(False)
    slots = threading.BoundedSemaphore(8)

    def worker(connection: socket.socket) -> None:
        try:
            serve_connection(connection, app)
        finally:
            slots.release()

    while True:
        connection, _ = listener.accept()
        if not slots.acquire(blocking=False):
            connection.close()
            continue
        try:
            threading.Thread(target=worker, args=(connection,), daemon=True).start()
        except RuntimeError:
            connection.close()
            slots.release()


def main() -> int:
    parser = argparse.ArgumentParser(description="Fixed-recipient website relay")
    parser.add_argument("--smtp-child", action="store_true")
    parser.add_argument("--systemd-socket", action="store_true")
    parser.add_argument("--database", type=Path)
    parser.add_argument("--credential", type=Path)
    parser.add_argument("--key-id")
    args = parser.parse_args()
    if args.smtp_child:
        try:
            mail = validate_mail(sys.stdin.buffer.read(MAX_BODY + 1))
            outcome = smtp_send(mail)
        except Exception:
            outcome = "unavailable"
        sys.stdout.write(outcome + "\n")
        return 0
    if not args.systemd_socket or not args.database or not args.credential or not args.key_id:
        parser.error("explicit socket, database, credential and key ID are required")
    try:
        with args.credential.open("rb") as credential:
            encoded = credential.read(66)
        if re.fullmatch(rb"[a-f0-9]{64}\n?", encoded) is None:
            raise ValueError("credential")
        key = bytes.fromhex(encoded.decode("ascii").strip())
        app = Application(Ledger(args.database), args.key_id, key)
        serve_systemd(app)
    except Exception:
        sys.stderr.write("contact relay unavailable\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
