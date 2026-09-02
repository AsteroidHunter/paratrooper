"""Wire contracts between the PWA, the web service, and the worker.

The web<->worker message contract (architecture → Service Mechanisms): a Job
flows web->worker carrying only keys/paths (never blobs — large files go through
the inbox store), and a stream of Results flows worker->web which the web service
relays to the PWA over the socket and persists to the thread.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ResultKind = Literal["working", "typing", "log", "screenshot", "pr", "update", "done", "error"]

# kinds the web service persists on its own authority (no ResultMessage behind them)
SYSTEM_KINDS = ("job", "published")


class EventPolicy(BaseModel):
    """Per-kind event behavior — the one row that used to be five scattered
    conditionals (relay ephemerality/terminality, push text, job context)."""

    ephemeral: bool = False  # sockets only: never persisted, never replayed
    persist: bool = True
    push_text: str | None = None  # notification body; None -> kind never pushes
    terminal: bool = False  # ends the job: relay releases the thread's batch
    context: Literal["text", "pr_ref", "skip"] = "text"  # job-context projection


EVENT_POLICY: dict[str, EventPolicy] = {
    # persisted (not ephemeral) so it survives as the thread's pickup watermark:
    # the phone derives its Read receipt from stored working rows, so the label
    # must replay after a reopen. Renders nothing; never job context.
    "working": EventPolicy(context="skip"),
    "typing": EventPolicy(ephemeral=True, persist=False, context="skip"),
    "log": EventPolicy(),
    "update": EventPolicy(),
    # a screenshot payload is a multi-MB base64 data URI — it must never be
    # pasted into the agent prompt as "context"
    "screenshot": EventPolicy(push_text="Paratrooper sent a board preview 📸", context="skip"),
    "pr": EventPolicy(
        push_text="Your pin is ready. Tap to review and publish 🪂", context="pr_ref"
    ),
    "done": EventPolicy(push_text="Paratrooper finished your update.", terminal=True),
    "error": EventPolicy(push_text="Paratrooper hit a problem with your update.", terminal=True),
    # system rows: the enqueue marker is bookkeeping, not chat content
    "job": EventPolicy(context="skip"),
    "published": EventPolicy(),
}


class JobMessage(BaseModel):
    """web -> worker (Key Value queue). Attachments are inbox keys, not blobs."""

    job_id: str
    thread_id: str
    type: Literal["pin_update"] = "pin_update"
    text: str = ""
    attachments: list[str] = Field(default_factory=list)  # inbox keys
    context: list[str] = Field(default_factory=list)  # recent thread lines
    pin_hint: str | None = None


class ResultMessage(BaseModel):
    """worker -> web (streamed). ``screenshot`` payload carries an image ref;
    ``pr`` carries {branch, url}; ``update`` carries a short agent-authored
    interim text (the post_update tool) that lands as a normal bubble mid-job."""

    job_id: str
    kind: ResultKind
    payload: Any = None


class ThreadEvent(BaseModel):
    """THE canonical chat event: what gets persisted, what rides the socket
    (live and replay, identical frames), what the client stores. A worker
    ``ResultMessage`` maps into this exactly once, in the web relay — nothing
    downstream sees worker wire types. ``payload`` is any JSON value; user
    message text is a plain string payload."""

    thread_id: str
    role: Literal["user", "agent", "system"]
    kind: str | None = None  # ResultKind or system kind; None for user messages
    payload: Any = None
    attachments: list[str] = Field(default_factory=list)
    ts: str  # ISO-8601, server clock


class UploadResponse(BaseModel):
    inbox_key: str
    content_type: str | None = None
    size: int


class SendRequest(BaseModel):
    """PWA -> web: a chat message (text + optional already-uploaded attachments).
    ``retract_seqs`` are agent replies the client held unseen when this send
    outran them — the server deletes those rows (the take-back) before the
    message is handled, so the rerun answers everything with one reply."""

    thread_id: str
    text: str = ""
    attachments: list[str] = Field(default_factory=list)
    retract_seqs: list[int] = Field(default_factory=list)


class PublishRequest(BaseModel):
    """PWA -> web /publish: merge the PR the agent opened (the Publish tap)."""

    thread_id: str
    pr: str  # PR url or number
