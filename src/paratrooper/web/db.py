"""Thread/message persistence (SQLite on the web service's persistent disk).

One row per message — the PWA's history source, distinct from the agent's
git-based memory. On reconnect the PWA fetches messages ``since`` its last-seen
sequence number. Synchronous (stdlib sqlite3) behind a lock; async handlers call
it via ``asyncio.to_thread``.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path

from .models import ThreadMessage

_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   TEXT NOT NULL,
    role        TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    ts          TEXT NOT NULL,
    kind        TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint     TEXT PRIMARY KEY,
    subscription TEXT NOT NULL
);
"""


class ThreadStore:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def add_message(self, msg: ThreadMessage) -> int:
        """Persist a message; returns its sequence number."""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO messages(thread_id, role, body, attachments, ts, kind) "
                "VALUES (?,?,?,?,?,?)",
                (msg.thread_id, msg.role, msg.body, json.dumps(msg.attachments), msg.ts, msg.kind),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def _rows(self, sql: str, params: tuple) -> list[ThreadMessage]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [
            ThreadMessage(
                thread_id=r["thread_id"],
                role=r["role"],
                body=r["body"],
                attachments=json.loads(r["attachments"]),
                ts=r["ts"],
                kind=r["kind"],
            )
            for r in rows
        ]

    def messages(self, thread_id: str, *, since_seq: int = 0) -> list[tuple[int, ThreadMessage]]:
        """All messages in a thread after ``since_seq`` (for reconnect catch-up),
        oldest-first, paired with their sequence numbers."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE thread_id=? AND seq>? ORDER BY seq",
                (thread_id, since_seq),
            ).fetchall()
        return [
            (
                r["seq"],
                ThreadMessage(
                    thread_id=r["thread_id"], role=r["role"], body=r["body"],
                    attachments=json.loads(r["attachments"]), ts=r["ts"], kind=r["kind"],
                ),
            )
            for r in rows
        ]

    def recent(self, thread_id: str, *, n: int = 10) -> list[ThreadMessage]:
        """The last ``n`` messages (oldest-first) — used as job context."""
        msgs = self._rows(
            "SELECT * FROM (SELECT * FROM messages WHERE thread_id=? ORDER BY seq DESC LIMIT ?) "
            "ORDER BY seq",
            (thread_id, n),
        )
        return msgs

    # --- web push subscriptions (Phase 6) ---

    def add_subscription(self, endpoint: str, subscription_json: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO push_subscriptions(endpoint, subscription) VALUES (?,?)",
                (endpoint, subscription_json),
            )
            self._conn.commit()

    def subscriptions(self) -> list[dict]:
        with self._lock:
            rows = self._conn.execute("SELECT subscription FROM push_subscriptions").fetchall()
        return [json.loads(r["subscription"]) for r in rows]

    def remove_subscription(self, endpoint: str) -> None:
        with self._lock:
            self._conn.execute("DELETE FROM push_subscriptions WHERE endpoint=?", (endpoint,))
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()
