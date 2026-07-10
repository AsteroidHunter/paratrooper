"""Two-tier memory backed by a changelog committed in the website repo.

* **Hot digest** — the last ``N = 10`` entries, rendered into the session
  preamble so the agent starts each request already aware of recent history.
* **Cold tool** — :meth:`fetch_history` reads older entries by count or index
  range (the agent calls it only when it needs to look further back).

The changelog is JSONL (one entry per line) at ``config.changelog``, *inside*
the website repo — so each new entry is part of the feature branch and merges
**alongside the pin change it documents** (one entry per merged update). git
history is the authoritative store; this is the agent-readable index over it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

HOT_DIGEST_N = 10


@dataclass
class ChangelogEntry:
    ts: str  # ISO-8601; caller stamps it (worker uses real time; tests pass fixed values)
    pin_id: str
    action: str  # add | archive | edit | replace
    summary: str
    pr: str | None = None  # PR url/number
    branch: str | None = None
    extra: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = {"ts": self.ts, "pin_id": self.pin_id, "action": self.action, "summary": self.summary}
        if self.pr:
            d["pr"] = self.pr
        if self.branch:
            d["branch"] = self.branch
        d.update(self.extra)
        return d


class Changelog:
    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)

    def read_all(self) -> list[dict]:
        """All entries, oldest-first. Missing file -> empty. Malformed lines are
        skipped (a partial write shouldn't crash the digest)."""
        if not self.path.is_file():
            return []
        entries: list[dict] = []
        for line in self.path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return entries

    def append(self, entry: ChangelogEntry | dict) -> dict:
        """Append one entry (creating the file/parent dir if needed). Returns the
        written dict. Called when finalizing a change so it rides the PR branch."""
        data = entry.to_dict() if isinstance(entry, ChangelogEntry) else dict(entry)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(data, ensure_ascii=False) + "\n")
        return data

    def hot_digest(self, n: int = HOT_DIGEST_N) -> list[dict]:
        """The last ``n`` entries, most-recent-first (the session preamble)."""
        return list(reversed(self.read_all()[-n:]))

    def fetch_history(
        self, n: int | None = None, *, start: int | None = None, end: int | None = None
    ) -> list[dict]:
        """Cold lookup. ``n`` -> the last ``n`` entries (most-recent-first);
        otherwise a ``[start:end]`` slice over the oldest-first list. No args ->
        everything, most-recent-first."""
        entries = self.read_all()
        if n is not None:
            return list(reversed(entries[-n:]))
        if start is not None or end is not None:
            return entries[start:end]
        return list(reversed(entries))


def format_digest(entries: list[dict]) -> str:
    """Render entries (most-recent-first) into a compact preamble block."""
    if not entries:
        return "No prior pinboard updates recorded."
    lines = ["Recent pinboard updates (most recent first):"]
    for e in entries:
        date = str(e.get("ts", "")).split("T")[0]
        pr = f" [{e['pr']}]" if e.get("pr") else ""
        action, pid, summary = e.get("action", "?"), e.get("pin_id", "?"), e.get("summary", "")
        lines.append(f"- {date}: {action} '{pid}' — {summary}{pr}")
    return "\n".join(lines)
