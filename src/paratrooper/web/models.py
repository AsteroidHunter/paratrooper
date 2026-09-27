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

# The chat that existed before there were chats. It keeps this id for good, so
# an upgrade loses nothing, and it is the chat a socket without a ``thread``
# parameter and a push without a named chat belong to.
DEFAULT_THREAD_ID = "default"

# What a chat id may be made of. The results channel and the interrupt payload
# are split on ':' (queue.py), so an id carrying one would be misread there.
# The service mints its own ids (16 hex characters); this is the outer bound.
THREAD_ID_PATTERN = r"^[A-Za-z0-9_-]{1,64}$"


class EventPolicy(BaseModel):
    """Per-kind event behavior — the one row that used to be five scattered
    conditionals (relay ephemerality/terminality, push text, job context).

    ``notifies`` replaced the literal notification body that used to sit here.
    Whether a kind wakes the phone is a property of the kind and belongs in this
    table; what the banner SAYS names a deployment, and that moved into the
    configuration source. :func:`push.notification_text` joins the two.
    """

    ephemeral: bool = False  # sockets only: never persisted, never replayed
    persist: bool = True
    notifies: bool = False  # does this kind wake the phone at all?
    terminal: bool = False  # ends the job: relay releases the thread's batch
    context: Literal["text", "pr_ref", "skip"] = "text"  # job-context projection
    # an agent row of this kind draws a bubble, so it counts as unread in the
    # chat list until its chat has been on screen past it
    unread: bool = False


EVENT_POLICY: dict[str, EventPolicy] = {
    # persisted (not ephemeral) so it survives as the thread's pickup watermark:
    # the phone derives its Read receipt from stored working rows, so the label
    # must replay after a reopen. Renders nothing; never job context.
    "working": EventPolicy(context="skip"),
    "typing": EventPolicy(ephemeral=True, persist=False, context="skip"),
    "log": EventPolicy(unread=True),
    "update": EventPolicy(unread=True),
    # a screenshot payload is a multi-MB base64 data URI — it must never be
    # pasted into the agent prompt as "context"
    "screenshot": EventPolicy(notifies=True, context="skip", unread=True),
    "pr": EventPolicy(notifies=True, context="pr_ref", unread=True),
    "done": EventPolicy(notifies=True, terminal=True, unread=True),
    "error": EventPolicy(notifies=True, terminal=True, unread=True),
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
    message is handled, so the rerun answers everything with one reply.

    ``sent_at`` is the COMPOSE time: the instant the phone drew the bubble, sent
    as ISO-8601 and stored as the message's own ``ts``. The thread is ordered by
    that time on both sides, so a message whose send failed keeps its slot and
    later messages land below it, and a Try Again — which repeats this request
    with the same ``sent_at`` — resends in place instead of jumping to the end.
    Optional: a client too old to send one gets the server clock, as before."""

    thread_id: str = Field(pattern=THREAD_ID_PATTERN)
    text: str = ""
    attachments: list[str] = Field(default_factory=list)
    retract_seqs: list[int] = Field(default_factory=list)
    sent_at: str | None = None


class ThreadSummary(BaseModel):
    """One row of the chat list: what the drawer shows for a chat. Everything
    but the id is derived from the chat's stored rows when the list is asked
    for (db.py ``thread_list``), so it can never disagree with them."""

    id: str
    title: str  # the first user text, trimmed, or "New chat"
    preview: str  # one line for the newest row that draws something
    updated: str  # ISO-8601 time of that row, or when the chat was made
    unread: int  # replies that draw a bubble, not yet on screen


class PublishRequest(BaseModel):
    """PWA -> web /publish: merge the PR the agent opened (the Publish tap)."""

    thread_id: str
    pr: str  # PR url or number
