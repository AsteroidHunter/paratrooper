"""Worker service loop: consume jobs from Key Value, run them, stream results back.

Bridges Phase 4's queue to Phase 3's ``run_job``. One job at a time (the web
coordinator guarantees one in-flight job per thread, and a single worker instance
processes sequentially). A concurrent interrupt listener cancels the running job
when a STOP/CANCEL for its thread arrives, then reports it so the web releases
the next batch.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import signal
from pathlib import Path

from redis import exceptions as redis_exc

from ..agent.config import (
    Config,
    github_token,
    load_config,
    load_worker_secrets,
    take_spotify_credentials,
)
from ..agent.siterepo import SiteRepo
from ..agent.worker import Job, run_job
from .inbox import DiskInbox, RedisInbox, key_age_seconds
from .models import JobMessage, ResultMessage
from .queue import JobQueue, connect

logger = logging.getLogger(__name__)

# transient transport failures: retry with a short pause, never kill the process
_REDIS_TRANSIENT = (redis_exc.ConnectionError, redis_exc.TimeoutError)


def _missing_photos_message(keys: list[str], ttl: int) -> str:
    """What to tell the owner when photos he sent are not in the shared store.

    The store lets a blob go at exactly one moment, when its TTL runs out, and
    that TTL counts from the upload and is never refreshed. So "it ran out of
    time" is checkable rather than guessable: every key carries the second it
    was minted. Say it only when every missing photo really is past the TTL. A
    photo that went missing for any other reason would make that sentence false,
    and a wrong reason sends him looking in the wrong place (it once told him
    photos had expired 93ms after he sent them). Otherwise say only what is
    known, which is that they are not there.

    Wording rule for anything he reads: plain words, nothing from inside the
    machine. He sent photos from his phone; he never staged anything.
    """
    ages = [key_age_seconds(k) for k in keys]
    past_ttl = all(age is not None and age >= ttl for age in ages)
    many = len(keys) > 1
    if past_ttl:
        hours = round(ttl / 3600)
        return (
            f"{'Those photos are' if many else 'That photo is'} older than {hours} hours, "
            f"and I only keep photos for that long. "
            f"Please send {'them' if many else 'it'} again."
        )
    return (
        f"I couldn't find {'those photos' if many else 'that photo'} when I went to "
        f"open {'them' if many else 'it'}. Please send {'them' if many else 'it'} again."
    )


def _screenshot_data_uri(path: str) -> str:
    """Read a worker-local PNG into a data URI. Web and worker don't share a
    disk on Render, so the screenshot rides the result channel as base64 rather
    than a path the PWA can't resolve."""
    data = base64.b64encode(Path(path).read_bytes()).decode()
    return f"data:image/png;base64,{data}"


class Worker:
    def __init__(self, queue: JobQueue, *, auth_mode: str | None = None) -> None:
        self.queue = queue
        self.auth_mode = auth_mode
        self.inbox = RedisInbox(queue.r)  # shared store; web put, worker get
        self._config: Config | None = None
        self._current_thread: str | None = None
        self._current_job: str | None = None
        self._task: asyncio.Task | None = None
        self._shutting_down = False  # SIGTERM: requeue the in-flight job, exit clean

    def _cfg(self) -> Config:
        if self._config is None:
            self._config = load_config()
        return self._config

    async def _materialize(self, keys: list[str]) -> None:
        """Copy the uploaded photos out of the shared store into this worker's
        own local inbox, so the image tool can read them as plain files. This is
        a READ of the shared store: the copy is ours, the original is not.
        Anything not there raises an error worded for the owner, not a bare
        KeyError."""
        local = DiskInbox(self._cfg().inbox)
        missing = []
        for key in keys:
            try:
                await local.put(key, await self.inbox.get(key))
            except KeyError:
                missing.append(key)
        if missing:
            raise RuntimeError(_missing_photos_message(missing, self.inbox.ttl))

    async def _cleanup(self, keys: list[str]) -> None:
        """Delete the local scratch copies this job materialized, and nothing
        else.

        It used to delete the shared blob too, and that was the bug. Two stores
        with two different owners were being torn down as if the job owned both.
        The job creates the local copy and must destroy it. The shared blob is
        created by the web service when the photo is uploaded, its key is
        written into the persisted thread row, and a second job can be handed
        that same key: a message sent mid-run folds the running batch back into
        the buffer, so the rerun carries the very same keys. A job is a reader of
        that blob, never its owner, and a reader deleting what it read is how a
        rerun ends up with nothing to read.

        A job may run more than once on the same inputs, so it must not consume
        its own inputs. The lifetime of an upload belongs to the store: the TTL
        set at upload time is the reclamation mechanism, and one day of a few
        photos is the whole cost of leaving it to do its work.
        """
        local = DiskInbox(self._cfg().inbox)
        for key in keys:
            with contextlib.suppress(Exception):
                await local.delete(key)

    async def _on_event(self, thread_id: str, event: dict) -> None:
        await self.queue.publish_result(thread_id, ResultMessage(**event))

    async def _run_one(self, msg: JobMessage) -> None:
        job = Job(
            job_id=msg.job_id,
            thread_id=msg.thread_id,
            text=msg.text,
            attachments=msg.attachments,
            context=msg.context,
            pin_hint=msg.pin_hint,
        )

        async def on_event(event: dict) -> None:
            if event.get("kind") == "screenshot" and isinstance(event.get("payload"), str):
                with contextlib.suppress(OSError):
                    event = {**event, "payload": await asyncio.to_thread(
                        _screenshot_data_uri, event["payload"]
                    )}
            await self._on_event(msg.thread_id, event)

        try:
            # the agent is now actually on it -> phone shows typing dots
            await self.queue.publish_result(
                msg.thread_id, ResultMessage(job_id=msg.job_id, kind="working")
            )
            await self._materialize(msg.attachments)
            await run_job(job, config=self._cfg(), auth_mode=self.auth_mode, on_event=on_event)
        except asyncio.CancelledError:
            if self._shutting_down:
                raise  # deploy shutdown: job gets requeued whole; say nothing
            # user interrupt: tell the web so it releases the next batch
            await self.queue.publish_result(
                msg.thread_id,
                ResultMessage(job_id=msg.job_id, kind="error", payload="interrupted"),
            )
            raise
        except Exception as exc:
            # a failed job must surface to the phone AND must not kill the
            # worker loop (an uncaught KeyError here once took the whole
            # service down, silently eating the queued messages)
            logger.exception("job %s failed", msg.job_id)
            await self.queue.publish_result(
                msg.thread_id,
                ResultMessage(job_id=msg.job_id, kind="error", payload=str(exc)),
            )
        finally:
            # unconditional: this only removes the local copies this job made,
            # so it needs no exemptions. The shutdown exemption that used to sit
            # here existed to protect the shared blob for the requeued job, and
            # nothing touches the shared blob any more. A reader that never
            # deletes shared state does not have to know why it stopped.
            await self._cleanup(msg.attachments)

    async def _interrupt_listener(self) -> None:
        while True:  # re-subscribe after transient redis drops
            try:
                async for thread_id, job_id in self.queue.subscribe_interrupts():
                    current = thread_id == self._current_thread
                    if current and job_id in (None, self._current_job):
                        if self._task and not self._task.done():
                            self._task.cancel()
            except _REDIS_TRANSIENT as exc:
                logger.warning("interrupt listener redis error, resubscribing: %s", exc)
                await asyncio.sleep(2)

    def _bootstrap_checkout(self) -> None:
        """Clone the site repo on first boot and pin the bot commit identity on
        the checkout (idempotent) — the agent commits via its own shell, so the
        identity must already sit in the repo-local git config."""
        cfg = self._cfg()
        SiteRepo(
            cfg.site_root,
            default_branch=cfg.default_branch,
            github_token=github_token(),
            remote=cfg.remote,
            git_name=cfg.git_name,
            git_email=cfg.git_email,
        ).ensure_checkout()

    def _install_shutdown_handler(self) -> None:
        """Render deploys SIGTERM the old instance while it may be mid-job (this
        killed a job mid-screenshot and blocked its thread for 11 hours). On
        SIGTERM: flag shutdown and cancel the in-flight task; run() requeues it."""
        loop = asyncio.get_running_loop()

        def _on_term() -> None:
            self._shutting_down = True
            if self._task and not self._task.done():
                self._task.cancel()

        for sig in (signal.SIGTERM, signal.SIGINT):
            with contextlib.suppress(NotImplementedError):
                loop.add_signal_handler(sig, _on_term)

    async def run(self, *, idle_timeout: int = 5) -> None:
        await asyncio.to_thread(self._bootstrap_checkout)
        self._install_shutdown_handler()
        listener = asyncio.ensure_future(self._interrupt_listener())
        try:
            while not self._shutting_down:
                try:
                    msg = await self.queue.dequeue(timeout=idle_timeout)
                except _REDIS_TRANSIENT as exc:
                    logger.warning("dequeue redis error, retrying: %s", exc)
                    await asyncio.sleep(2)
                    continue
                if msg is None:
                    continue
                self._current_thread, self._current_job = msg.thread_id, msg.job_id
                self._task = asyncio.ensure_future(self._run_one(msg))
                # CancelledError = interrupt/shutdown; anything else was already
                # reported by _run_one — either way the loop must survive
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await self._task
                if self._shutting_down:
                    await self.queue.requeue_front(msg)
                    logger.info("shutdown: requeued in-flight job %s", msg.job_id)
                self._current_thread = self._current_job = self._task = None
        finally:
            listener.cancel()


def main() -> None:
    import os

    print(f"paratrooper worker starting, version "
          f"{os.environ.get('RENDER_GIT_COMMIT', 'dev')[:7]}", flush=True)
    # First: whatever the start-up wrapper handed over in its file, read and
    # the file deleted. Those values reach os.environ only now, after this
    # process started, so they are in no launch record.
    load_worker_secrets()
    # Then take the worker-only secrets out of the environment, before anything
    # can start a session. The agent's CLI inherits os.environ and the SDK can
    # only add to it, so a value still sitting there at session time is a value
    # in every shell the agent opens. Both readers keep what they took, so the
    # queue client and the Spotify helper work exactly as before.
    take_spotify_credentials()
    client = connect()  # takes the queue address, password and all, with it
    asyncio.run(Worker(JobQueue(client)).run())


if __name__ == "__main__":
    main()
