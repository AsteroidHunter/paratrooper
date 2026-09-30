"""Wire contracts between the PWA, the web service, and the worker.

The web<->worker message contract (architecture → Service Mechanisms): a Job
flows web->worker carrying only keys/paths (never blobs — large files go through
the inbox store), and a stream of Results flows worker->web which the web service
relays to the PWA over the socket and persists to the thread.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ResultKind = Literal[
    "working", "typing", "log", "screenshot", "pr", "update", "reaction", "done", "error",
]

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
    # the agent's tapback on one of his messages (the react_to_message tool): state
    # about a message, kept in its own table, never a row of the thread, never
    # job context as a row (job_context words it), never a push
    "reaction": EventPolicy(persist=False, context="skip"),
    "done": EventPolicy(notifies=True, terminal=True, unread=True),
    "error": EventPolicy(notifies=True, terminal=True, unread=True),
    # system rows: the enqueue marker is bookkeeping, not chat content
    "job": EventPolicy(context="skip"),
    "published": EventPolicy(),
}


class ReactionTarget(BaseModel):
    """One of the owner's recent messages a job may put a reaction on: its
    number, and its words as the agent would quote them ("a photo" for a photo
    sent with none). The worker's react_to_message tool picks from these."""

    seq: int
    text: str


class JobMessage(BaseModel):
    """web -> worker (Key Value queue). Attachments are inbox keys, not blobs."""

    job_id: str
    thread_id: str
    type: Literal["pin_update"] = "pin_update"
    text: str = ""
    attachments: list[str] = Field(default_factory=list)  # inbox keys
    context: list[str] = Field(default_factory=list)  # recent thread lines
    pin_hint: str | None = None
    # his last few messages in this chat, oldest first, newest last: what the
    # agent's reaction tool can name. Empty from a web build that predates it.
    reactable: list[ReactionTarget] = Field(default_factory=list)


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


# --- reactions (tapbacks) ---------------------------------------------------

# Messages' six fixed tapbacks, in the order its bar shows them. Stored by these
# names: HA HA, !! and ? have no emoji of their own, so the six are words, and
# every other reaction is the one emoji itself.
TAPBACKS: tuple[str, ...] = ("heart", "like", "dislike", "haha", "emphasize", "question")

# What else may name one of the six: the words the agent might reach for, and
# the emoji the phone draws AS the tapback (so his thumbs up from the keyboard
# and the bar's thumbs up are one reaction, and the recents never repeat the
# six). The red heart is deliberately not here: in Messages the red heart emoji
# and the heart tapback are two different reactions.
_TAPBACK_ALIASES: dict[str, str] = {
    "love": "heart", "loved": "heart", "\U0001FA77": "heart",
    "thumbs up": "like", "thumbsup": "like", "thumbs_up": "like", "liked": "like",
    "\U0001F44D": "like",
    "thumbs down": "dislike", "thumbsdown": "dislike", "thumbs_down": "dislike",
    "disliked": "dislike", "\U0001F44E": "dislike",
    "ha ha": "haha", "ha_ha": "haha", "laugh": "haha", "laughed": "haha",
    "!!": "emphasize", "emphasis": "emphasize", "emphasized": "emphasize",
    "exclaim": "emphasize", "\u203c": "emphasize", "\u203c\ufe0f": "emphasize",
    "?": "question", "questioned": "question", "\u2753": "question",
}

# the code points one emoji may be built from: pictographs and symbols, and the
# marks that join or modify them (skin tones and flags sit inside the first
# range). Letters, digits (outside a keycap), spaces and punctuation are not.
_EMOJI_RANGES = (
    (0x1F000, 0x1FAFF),
    (0x2600, 0x27BF), (0x2B00, 0x2BFF), (0x2190, 0x21FF), (0x2300, 0x23FF),
    (0x25A0, 0x25FF), (0x2934, 0x2935), (0x3030, 0x3030), (0x303D, 0x303D),
    (0x3297, 0x3297), (0x3299, 0x3299), (0xE0020, 0xE007F),
)
_EMOJI_SINGLES = {0x00A9, 0x00AE, 0x203C, 0x2049, 0x2122, 0x2139, 0x24C2}
_EMOJI_MARKS = {0x200D, 0xFE0F, 0xFE0E, 0x20E3}
_KEYCAP_BASES = set("0123456789#*")
# the longest single emoji in use is a tag flag or a family, seven to eleven
# code points; anything longer is several
_EMOJI_MAX_POINTS = 16


def _pictograph(cp: int) -> bool:
    return cp in _EMOJI_SINGLES or any(lo <= cp <= hi for lo, hi in _EMOJI_RANGES)


def _one_emoji(value: str) -> bool:
    """Whether ``value`` is one emoji and nothing else, as far as the service
    needs to know: made only of emoji code points, with every pictograph after
    the first joined on by a zero width joiner, except a flag's second regional
    indicator. The phone reads the grapheme properly (emoji.ts); this is the
    fence that keeps words and runs of emoji out of the table."""
    if not value or len(value) > _EMOJI_MAX_POINTS:
        return False
    points = [ord(c) for c in value]
    if value[0] in _KEYCAP_BASES:
        return points[1:] in ([0x20E3], [0xFE0F, 0x20E3])
    pictographs = 0
    previous = None
    for cp in points:
        if cp in _EMOJI_MARKS:
            previous = cp
            continue
        if not _pictograph(cp):
            return False
        regional = 0x1F1E6 <= cp <= 0x1F1FF
        modifier = 0x1F3FB <= cp <= 0x1F3FF
        tag = 0xE0020 <= cp <= 0xE007F
        if pictographs and not (previous == 0x200D or modifier or tag):
            flag_pair = regional and pictographs == 1 and 0x1F1E6 <= points[0] <= 0x1F1FF
            if not flag_pair:
                return False
        if not (modifier or tag):
            pictographs += 1
        previous = cp
    return pictographs >= 1


def normalize_reaction(value: object) -> str | None:
    """The stored form of a reaction, or None when ``value`` is not one: a
    tapback name (or a name or emoji that stands for one), else one emoji."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    lowered = " ".join(text.lower().split())
    if lowered in TAPBACKS:
        return lowered
    if lowered in _TAPBACK_ALIASES:
        return _TAPBACK_ALIASES[lowered]
    return text if _one_emoji(text) else None


class Reaction(BaseModel):
    """One person's reaction on one message: the wire shape of the snapshot
    and of each live change (db.py keeps one row per chat, message and who)."""

    target: int  # the seq of the message reacted to
    role: Literal["user", "agent"]
    reaction: str  # a tapback name or one emoji
    ts: str  # when it was set, server clock


class ReactRequest(BaseModel):
    """PWA -> web: his reaction on one message of one chat. ``reaction`` None
    (or empty) takes his reaction off; the phone decides the toggle."""

    thread_id: str = Field(pattern=THREAD_ID_PATTERN)
    seq: int = Field(gt=0)
    reaction: str | None = None


class PublishRequest(BaseModel):
    """PWA -> web /publish: merge the PR the agent opened (the Publish tap)."""

    thread_id: str
    pr: str  # PR url or number
