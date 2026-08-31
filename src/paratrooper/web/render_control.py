"""Wake/sleep the Render worker so it only bills while a job is running.

Render background workers can't scale to zero, so the web service drives the
worker's lifecycle over the Render API: **resume** when a batch is enqueued,
**suspend** once the queue has stayed drained for a linger window (default 5
min; ``PARATROOPER_WORKER_LINGER_S`` — see ``app.py``), so back-to-back turns
don't each pay a cold boot. Jobs wait durably in the Key Value list while the
worker boots (~30-60s), so nothing is lost during the wake.

Configured by two env vars on the WEB service — ``RENDER_API_KEY`` (Account
Settings -> API Keys) and ``RENDER_WORKER_SERVICE_ID`` (the worker's ``srv-...``
id from its dashboard URL). If either is unset, :func:`RenderControl.from_env`
returns ``None`` and the app runs the worker always-on as before (local dev,
or hosts without this API). Calls are best-effort: a failed resume/suspend is
logged loudly, never raised — a stuck-on worker costs money, not correctness,
and a failed resume leaves the job queued for the next wake.
"""

from __future__ import annotations

import logging
import os

import httpx

logger = logging.getLogger(__name__)

_API_BASE = "https://api.render.com/v1"
_TIMEOUT = httpx.Timeout(15.0)


class RenderControl:
    def __init__(self, api_key: str, worker_service_id: str) -> None:
        self._headers = {"Authorization": f"Bearer {api_key}", "Accept": "application/json"}
        self.worker_id = worker_service_id

    @classmethod
    def from_env(cls) -> RenderControl | None:
        api_key = os.environ.get("RENDER_API_KEY")
        service_id = os.environ.get("RENDER_WORKER_SERVICE_ID")
        if not api_key or not service_id:
            return None  # feature off -> worker stays always-on
        return cls(api_key, service_id)

    async def _post(self, action: str) -> bool:
        url = f"{_API_BASE}/services/{self.worker_id}/{action}"
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(url, headers=self._headers)
        except httpx.HTTPError as exc:
            logger.error("render %s failed for %s: %s", action, self.worker_id, exc)
            return False
        # 202 = accepted. A resume on a service that is not suspended comes
        # back 400 with this exact complaint — the worker is already awake,
        # which is the state the call wanted, so it is success, not an error
        # (before this check every such call cried wolf in the error log)
        if resp.status_code == 400 and action == "resume" and "suspended by a user" in resp.text:
            logger.info("render resume for %s: already awake", self.worker_id)
            return True
        if resp.status_code >= 400:
            logger.error(
                "render %s for %s returned %s: %s",
                action, self.worker_id, resp.status_code, resp.text[:200],
            )
            return False
        return True

    async def resume_worker(self) -> bool:
        """Wake the worker (call when a job is enqueued). Idempotent."""
        return await self._post("resume")

    async def suspend_worker(self) -> bool:
        """Sleep the worker (called after the queue stays drained for the
        linger window). Idempotent."""
        return await self._post("suspend")
