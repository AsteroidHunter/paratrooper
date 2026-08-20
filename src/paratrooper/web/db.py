"""Thread/event persistence (SQLite on the web service's persistent disk).

One row per ThreadEvent — the PWA's history source, distinct from the agent's
git-based memory. The stored event is canonical: replay re-sends exactly what
was broadcast live. On reconnect the PWA fetches events ``since`` its last-seen
sequence number. Synchronous (stdlib sqlite3) behind a lock; async handlers call
it via ``asyncio.to_thread``.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from pathlib import Path

from .models import ThreadEvent
from .thumbs import image_dims

logger = logging.getLogger(__name__)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   TEXT NOT NULL,
    role        TEXT NOT NULL,
    kind        TEXT,
    payload     TEXT NOT NULL DEFAULT 'null', -- JSON-encoded event payload
    attachments TEXT NOT NULL DEFAULT '[]',
    ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, seq);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint     TEXT PRIMARY KEY,
    subscription TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
    key          TEXT PRIMARY KEY,   -- inbox key already stored in messages.attachments
    thumb        BLOB NOT NULL,      -- small webp; the only pixels that outlive the inbox TTL
    content_type TEXT NOT NULL DEFAULT 'image/webp',
    ts           TEXT NOT NULL,
    width        INTEGER,            -- thumb pixel size, NULL on pre-dims rows;
    height       INTEGER             -- the client reserves image boxes from these
);
"""


def _event(r: sqlite3.Row) -> ThreadEvent:
    return ThreadEvent(
        thread_id=r["thread_id"],
        role=r["role"],
        kind=r["kind"],
        payload=json.loads(r["payload"]) if r["payload"] is not None else None,
        attachments=json.loads(r["attachments"]),
        ts=r["ts"],
    )


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
            self._migrate_body_to_payload()
            self._migrate_attachment_dims()
            self._migrate_backfill_thumb_dims()  # needs the columns above to exist

    def _migrate_attachment_dims(self) -> None:
        """Additive columns for thumbnail dimensions on DBs created before them.
        Idempotent (column-presence gated); legacy rows keep NULL and the client
        falls back to a fixed-ratio box for those."""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(attachments)")}
        for col in ("width", "height"):
            if col not in cols:
                self._conn.execute(f"ALTER TABLE attachments ADD COLUMN {col} INTEGER")
        self._conn.commit()

    def _migrate_backfill_thumb_dims(self) -> None:
        """One-time fill of width/height for previews stored before those
        columns existed, measured from each row's own thumb bytes. Without it
        those photos ship no dims, the client reserves them a fixed 4:3 box,
        and a portrait shot opens out of a landscape crop looking squished.

        Idempotent: a filled row can never match the WHERE again, so the second
        boot costs one empty query. Atomic (one explicit transaction), so a
        crash mid-way leaves every NULL in place and the next boot retries. A
        row whose bytes won't decode is skipped and keeps its NULLs: the
        client's fixed-ratio fallback exists for exactly that row, and one
        unreadable blob must never cost the service its startup. Those rows are
        re-tried on every later boot, which is one header read each."""
        keys = [
            r["key"] for r in self._conn.execute(
                "SELECT key FROM attachments WHERE width IS NULL OR height IS NULL"
            )
        ]
        if not keys:
            return  # fresh DB, or an earlier boot already filled them
        self._conn.execute("BEGIN")
        try:
            filled = 0
            for key in keys:
                # one blob at a time: previews run to hundreds of KB each and a
                # long photo history would otherwise all sit in memory at once
                row = self._conn.execute(
                    "SELECT thumb FROM attachments WHERE key=?", (key,)
                ).fetchone()
                dims = image_dims(row["thumb"]) if row else None
                if dims is None:
                    continue
                self._conn.execute(
                    "UPDATE attachments SET width=?, height=? WHERE key=?", (*dims, key)
                )
                filled += 1
            self._conn.commit()
        except BaseException:
            self._conn.rollback()
            raise
        if filled:  # silent on the boots after, where there is nothing to say
            logger.info(
                "filled thumbnail dimensions on %d of %d legacy attachment row(s)",
                filled, len(keys),
            )

    def _migrate_body_to_payload(self) -> None:
        """One-time cut from the legacy ``body`` TEXT column to JSON ``payload``:
        add payload, backfill every row, drop body. Idempotent (column-presence
        gated) and atomic (one explicit transaction), so a crash mid-way leaves
        the old schema intact and the next boot retries."""
        cols = {r["name"] for r in self._conn.execute("PRAGMA table_info(messages)")}
        if "body" not in cols:
            return  # fresh DB or already migrated
        if sqlite3.sqlite_version_info < (3, 35, 0):  # DROP COLUMN needs 3.35
            raise RuntimeError(
                f"sqlite {sqlite3.sqlite_version} < 3.35 cannot drop the legacy "
                "body column; refusing to run half-migrated"
            )
        self._conn.execute("BEGIN")
        try:
            if "payload" not in cols:
                self._conn.execute("ALTER TABLE messages ADD COLUMN payload TEXT")
            # pr rows persisted their {branch, url} payload as JSON text in body
            # (6da5b3c); every other row is plain text and stays a string payload
            rows = self._conn.execute(
                "SELECT seq, kind, body FROM messages WHERE payload IS NULL"
            ).fetchall()
            for r in rows:
                value = r["body"]
                if r["kind"] == "pr" and value:
                    try:
                        value = json.loads(value)
                    except json.JSONDecodeError:
                        pass  # a bare url stays a string payload
                self._conn.execute(
                    "UPDATE messages SET payload=? WHERE seq=?",
                    (json.dumps(value), r["seq"]),
                )
            self._conn.execute("ALTER TABLE messages DROP COLUMN body")
            self._conn.commit()
        except BaseException:
            self._conn.rollback()
            raise

    def add_message(self, event: ThreadEvent) -> int:
        """Persist an event verbatim; returns its sequence number."""
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO messages(thread_id, role, kind, payload, attachments, ts) "
                "VALUES (?,?,?,?,?,?)",
                (event.thread_id, event.role, event.kind, json.dumps(event.payload),
                 json.dumps(event.attachments), event.ts),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def delete_agent_messages(self, thread_id: str, seqs: list[int]) -> list[int]:
        """Delete agent-role events by seq within one thread — the send-time
        take-back of a reply the client held unseen. Validation IS the WHERE
        clause: a seq that is missing, lives in another thread, or is not
        agent-role deletes nothing and raises nothing. Returns the seqs
        actually deleted, ascending. AUTOINCREMENT never reuses a deleted
        seq, so client catch-up cursors stay truthful after a take-back."""
        if not seqs:
            return []
        marks = ",".join("?" for _ in seqs)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT seq FROM messages WHERE thread_id=? AND role='agent' "
                f"AND seq IN ({marks}) ORDER BY seq",
                (thread_id, *seqs),
            ).fetchall()
            deleted = [int(r["seq"]) for r in rows]
            if deleted:
                hitmarks = ",".join("?" for _ in deleted)
                self._conn.execute(
                    f"DELETE FROM messages WHERE seq IN ({hitmarks})", tuple(deleted)
                )
                self._conn.commit()
        return deleted

    def _rows(self, sql: str, params: tuple) -> list[ThreadEvent]:
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [_event(r) for r in rows]

    def messages(self, thread_id: str, *, since_seq: int = 0) -> list[tuple[int, ThreadEvent]]:
        """All events in a thread after ``since_seq`` (for reconnect catch-up),
        oldest-first, paired with their sequence numbers."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM messages WHERE thread_id=? AND seq>? ORDER BY seq",
                (thread_id, since_seq),
            ).fetchall()
        return [(r["seq"], _event(r)) for r in rows]

    def messages_page(
        self, thread_id: str, *, before_seq: int | None = None, limit: int = 50
    ) -> list[tuple[int, ThreadEvent]]:
        """The ``limit`` events immediately before ``before_seq`` (or the
        newest when None), oldest-first with seqs — the recent-first initial
        window and each pull-down-for-older page."""
        if before_seq is None:
            sql = ("SELECT * FROM (SELECT * FROM messages WHERE thread_id=? "
                   "ORDER BY seq DESC LIMIT ?) ORDER BY seq")
            params: tuple = (thread_id, limit)
        else:
            sql = ("SELECT * FROM (SELECT * FROM messages WHERE thread_id=? AND seq<? "
                   "ORDER BY seq DESC LIMIT ?) ORDER BY seq")
            params = (thread_id, before_seq, limit)
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [(r["seq"], _event(r)) for r in rows]

    def recent(self, thread_id: str, *, n: int = 10) -> list[ThreadEvent]:
        """The last ``n`` events (oldest-first) — used as job context."""
        return self._rows(
            "SELECT * FROM (SELECT * FROM messages WHERE thread_id=? ORDER BY seq DESC LIMIT ?) "
            "ORDER BY seq",
            (thread_id, n),
        )

    def unprocessed_user_messages(self) -> list[tuple[str, ThreadEvent]]:
        """User messages sent after the last enqueued job marker of their thread
        (role='system', kind='job' rows written at enqueue time). These are
        messages a web-service restart swallowed before they became a job —
        the boot-recovery feeds them back into the coordinator."""
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT * FROM messages m
                WHERE m.role = 'user'
                  AND m.seq > COALESCE((
                    SELECT MAX(j.seq) FROM messages j
                    WHERE j.thread_id = m.thread_id
                      AND j.role = 'system' AND j.kind = 'job'
                  ), 0)
                ORDER BY m.seq
                """
            ).fetchall()
        return [(r["thread_id"], _event(r)) for r in rows]

    # --- attachment thumbnails (photo history survives the inbox TTL) ---

    def add_thumbnail(self, key: str, thumb: bytes, *, ts: str,
                      content_type: str = "image/webp",
                      width: int | None = None, height: int | None = None) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO attachments(key, thumb, content_type, ts, width, height) "
                "VALUES (?,?,?,?,?,?)",
                (key, thumb, content_type, ts, width, height),
            )
            self._conn.commit()

    def thumbnail(self, key: str) -> tuple[bytes, str] | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT thumb, content_type FROM attachments WHERE key=?", (key,)
            ).fetchone()
        return (row["thumb"], row["content_type"]) if row else None

    def thumb_dims(self, keys: list[str]) -> dict[str, tuple[int, int]]:
        """Thumb pixel sizes for ``keys`` (rows with recorded dims only) — the
        client reserves each image's box from these before any pixels arrive."""
        if not keys:
            return {}
        marks = ",".join("?" for _ in keys)
        with self._lock:
            rows = self._conn.execute(
                f"SELECT key, width, height FROM attachments WHERE key IN ({marks}) "
                "AND width IS NOT NULL AND height IS NOT NULL",
                tuple(keys),
            ).fetchall()
        return {r["key"]: (r["width"], r["height"]) for r in rows}

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
