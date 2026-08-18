"""Per-thread message batching + interrupt (checklist 4.3b).

Messages are **debounce-batched**, not acted on one-by-one. First message with
no job running starts a quiet window (default 7s) that each further message
resets; on expiry the buffered messages bundle into ONE job. A message arriving
while a job is IN FLIGHT **supersedes** it: the run is cancelled through the
same interrupt used for STOP (so nothing of it is ever saved — the relay
swallows a superseded job's results), its batch folds back in front of the new
message, and the same quiet window re-arms; a burst of texts therefore ends in
exactly one fresh run and one reply. **STOP/CANCEL** (case-insensitive, whole
message or leading token) bypasses the timer: discard a pending batch and/or
interrupt a running job — and never starts (or restarts) a job.

Transport-agnostic: the coordinator calls injected ``enqueue``/``interrupt``
callbacks, so it's driven directly in tests with a tiny window.
"""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

# one quiet window for both jobs of the timer: batching sends before a run and
# holding the rerun after a mid-run send are the same mechanism (same timer,
# same buffer), so they share the one number
DEFAULT_WINDOW = 7.0
# if no done/error ever arrives (missed event, worker died), stop blocking the
# thread forever: consider the job abandoned after this long
JOB_DEADLINE = 30 * 60.0
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
    started_at: float = 0.0  # monotonic; for the stuck-job watchdog
    # what went into the running job, so a mid-run send can fold it back into
    # the buffer for the rerun
    running_batch: list[tuple[str, list[str]]] = field(default_factory=list)
    # job cancelled because newer messages arrived (a rerun is pending): the
    # relay swallows every result it still emits — nothing of it gets saved
    superseded: str | None = None


class ThreadCoordinator:
    def __init__(
        self,
        enqueue: EnqueueCb,
        interrupt: InterruptCb,
        *,
        window: float = DEFAULT_WINDOW,
        job_deadline: float = JOB_DEADLINE,
    ) -> None:
        self._enqueue = enqueue
        self._interrupt = interrupt
        self._window = window
        self._deadline = job_deadline
        self._threads: dict[str, _ThreadState] = {}

    def _state(self, thread_id: str) -> _ThreadState:
        st = self._threads.setdefault(thread_id, _ThreadState())
        # watchdog: a job whose completion event never arrived must not block
        # the thread forever (its batch is abandoned with it)
        if st.running_job and (time.monotonic() - st.started_at) > self._deadline:
            st.running_job = None
            st.running_batch = []
            st.superseded = None
        return st

    async def handle_message(self, thread_id: str, text: str, attachments: list[str]) -> str:
        """Ingest one PWA message. Returns a short status: 'buffered',
        'superseded' (an in-flight run was cancelled for a rerun),
        'interrupted', or 'discarded'."""
        st = self._state(thread_id)

        if is_stop_word(text):
            # STOP kills everything pending — the batch, the window, and any
            # in-flight run — and never leads to a rerun (a rerun waiting out
            # its quiet window dies here too)
            self._cancel_timer(st)
            st.buffer.clear()
            st.running_batch = []
            if st.running_job is not None:
                await self._interrupt(thread_id, st.running_job)
                return "interrupted"
            return "discarded"

        st.buffer.append((text, attachments))
        if st.running_job is not None and st.running_job != st.superseded:
            # a send while a run is in flight: that reply would be stale before
            # it exists. Cancel the run NOW (same machinery as STOP — nothing
            # of it gets saved) and fold its messages back in front, so the one
            # fresh run after the quiet window covers everything.
            st.superseded = st.running_job
            st.buffer = st.running_batch + st.buffer
            st.running_batch = []
            await self._interrupt(thread_id, st.superseded)
            self._arm_timer(thread_id)
            return "superseded"
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
            # a still-cancelling superseded run holds the slot: job_finished
            # re-arms the window once its terminal lands, so nothing is lost
            return
        texts = [t for t, _ in st.buffer]
        attachments: list[str] = []
        for _, atts in st.buffer:
            attachments.extend(atts)
        st.running_batch = st.buffer[:]
        st.buffer.clear()
        job_id = uuid.uuid4().hex[:12]
        st.running_job = job_id
        st.started_at = time.monotonic()
        st.timer = None
        await self._enqueue(thread_id, job_id, "\n".join(t for t in texts if t), attachments)

    async def job_finished(self, thread_id: str) -> None:
        """Called when the running job ends. If messages buffered up meanwhile,
        make sure a quiet window is ticking for them — without resetting one a
        mid-run send already armed (the window counts from the last SEND)."""
        st = self._state(thread_id)
        st.running_job = None
        st.running_batch = []
        st.superseded = None
        if st.buffer and (st.timer is None or st.timer.done()):
            self._arm_timer(thread_id)

    def was_superseded(self, thread_id: str, job_id: str) -> bool:
        """True while ``job_id`` is a run cancelled by newer messages (rerun
        pending). The relay checks this to swallow the dying run's results —
        the cancel came before anything was saved, and stays that way."""
        st = self._threads.get(thread_id)
        return st is not None and st.superseded == job_id

    def has_pending(self) -> bool:
        """True while any thread has a running job or a buffered batch — i.e.
        the worker is still needed (used to decide when to suspend it)."""
        return any(st.running_job or st.buffer for st in self._threads.values())
