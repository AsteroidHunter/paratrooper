"""Wire contracts between the PWA, the web service, and the worker.

The web<->worker message contract (architecture → Service Mechanisms): a Job
flows web->worker carrying only keys/paths (never blobs — large files go through
the inbox store), and a stream of Results flows worker->web which the web service
relays to the PWA over the socket and persists to the thread.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ResultKind = Literal["working", "log", "screenshot", "pr", "done", "error"]


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
    ``pr`` carries {branch, url}."""

    job_id: str
    kind: ResultKind
    payload: Any = None


class ThreadMessage(BaseModel):
    """One persisted chat message (the PWA's history unit)."""

    thread_id: str
    role: Literal["user", "agent", "system"]
    body: str = ""
    attachments: list[str] = Field(default_factory=list)
    ts: str  # ISO-8601
    kind: str | None = None  # for agent messages: log|screenshot|pr|done|error


class UploadResponse(BaseModel):
    inbox_key: str
    content_type: str | None = None
    size: int


class SendRequest(BaseModel):
    """PWA -> web: a chat message (text + optional already-uploaded attachments)."""

    thread_id: str
    text: str = ""
    attachments: list[str] = Field(default_factory=list)


class PublishRequest(BaseModel):
    """PWA -> web /publish: merge the PR the agent opened (the Publish tap)."""

    thread_id: str
    pr: str  # PR url or number
