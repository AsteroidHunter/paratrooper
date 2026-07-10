"""Per-thread message batching + interrupt (checklist 4.3b).

Messages are **debounce-batched**, not acted on one-by-one. First message with
no job running starts a window (default 10s) that each further message resets;
on expiry the buffered messages bundle into ONE job. While a job runs, messages
buffer into the *next* batch and fire after it finishes. **STOP/CANCEL**
(case-insensitive, whole message or leading token) bypasses the timer: discard a
pending batch, or interrupt a running job — and never starts a job.

Transport-agnostic: the coordinator calls injected ``enqueue``/``interrupt``
callbacks, so it's driven directly in tests with a tiny window.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

DEFAULT_WINDOW = 10.0
_STOP_WORDS = {"STOP", "CANCEL"}

# (thread_id, job_id, text, attachments) -> awaitable
EnqueueCb = Callable[[str, str, str, list[str]], Awaitable[None]]
InterruptCb = Callable[[str, str], Awaitable[None]]  # (thread_id, job_id)


def is_stop_word(text: str) -> bool:
    """True if ``text`` is a STOP/CANCEL command (whole message or leading token)."""
    stripped = text.strip()
    if not stripped:
        return False
    first = stripped.split()[0].upper()
    return first in _STOP_WORDS


@dataclass
class _ThreadState:
    buffer: list[tuple[str, list[str]]] = field(default_factory=list)  # (text, attachments)
    timer: asyncio.Task | None = None
    running_job: str | None = None


class ThreadCoordinator:
    def __init__(
        self,
        enqueue: EnqueueCb,
        interrupt: InterruptCb,
        *,
        window: float = DEFAULT_WINDOW,
    ) -> None:
        self._enqueue = enqueue
        self._interrupt = interrupt
        self._window = window
        self._threads: dict[str, _ThreadState] = {}

    def _state(self, thread_id: str) -> _ThreadState:
        return self._threads.setdefault(thread_id, _ThreadState())

    async def handle_message(self, thread_id: str, text: str, attachments: list[str]) -> str:
        """Ingest one PWA message. Returns a short status: 'buffered',
        'interrupted', or 'discarded'."""
        st = self._state(thread_id)

        if is_stop_word(text):
            if st.running_job is not None:
                job_id = st.running_job
                await self._interrupt(thread_id, job_id)
                return "interrupted"
            self._cancel_timer(st)
            st.buffer.clear()
            return "discarded"

        st.buffer.append((text, attachments))
        if st.running_job is None:
            self._arm_timer(thread_id)
        return "buffered"

    def _cancel_timer(self, st: _ThreadState) -> None:
        if st.timer and not st.timer.done():
            st.timer.cancel()
        st.timer = None

    def _arm_timer(self, thread_id: str) -> None:
        st = self._state(thread_id)
        self._cancel_timer(st)
        st.timer = asyncio.ensure_future(self._after_window(thread_id))

    async def _after_window(self, thread_id: str) -> None:
        try:
            await asyncio.sleep(self._window)
        except asyncio.CancelledError:
            return
        await self._fire(thread_id)

    async def _fire(self, thread_id: str) -> None:
        st = self._state(thread_id)
        if not st.buffer or st.running_job is not None:
            return
        texts = [t for t, _ in st.buffer]
        attachments: list[str] = []
        for _, atts in st.buffer:
            attachments.extend(atts)
        st.buffer.clear()
        job_id = uuid.uuid4().hex[:12]
        st.running_job = job_id
        st.timer = None
        await self._enqueue(thread_id, job_id, "\n".join(t for t in texts if t), attachments)

    async def job_finished(self, thread_id: str) -> None:
        """Called when the running job ends. If messages buffered up meanwhile,
        open a fresh window for them (the next batch)."""
        st = self._state(thread_id)
        st.running_job = None
        if st.buffer:
            self._arm_timer(thread_id)

    def has_pending(self) -> bool:
        """True while any thread has a running job or a buffered batch — i.e.
        the worker is still needed (used to decide when to suspend it)."""
        return any(st.running_job or st.buffer for st in self._threads.values())
