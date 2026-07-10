"""Resolve Spotify input to an embed URL the pin schema understands.

Two paths (architecture → Input Pipelines):
* **From a link** — rewrite ``/track/<id>`` to the ``/embed/track/<id>`` form
  (no auth, no network needed); oEmbed fills in the title best-effort.
* **From a song name** — client-credentials token -> Search API -> first track
  id -> embed URL. No user login; client id/secret come from env.

The embed URL matches the form the existing pins use
(``open.spotify.com/embed/track/<id>?utm_source=generator``). Functions are
synchronous so they're trivially unit-testable; the async tool wrappers offload
them to a thread.
"""

from __future__ import annotations

import base64
import re
from dataclasses import dataclass

import httpx

_ACCOUNTS = "https://accounts.spotify.com/api/token"
_SEARCH = "https://api.spotify.com/v1/search"
_OEMBED = "https://open.spotify.com/oembed"
_TRACK_RE = re.compile(r"open\.spotify\.com/(?:embed/)?track/([A-Za-z0-9]+)")
_TIMEOUT = httpx.Timeout(10.0)


@dataclass
class SpotifyResult:
    embed: str  # open.spotify.com/embed/track/<id>?utm_source=generator
    track_id: str
    title: str | None = None
    artist: str | None = None


def embed_url(track_id: str) -> str:
    return f"https://open.spotify.com/embed/track/{track_id}?utm_source=generator"


def track_id_from_url(url: str) -> str | None:
    """Extract the track id from a track or embed-track URL, else None."""
    m = _TRACK_RE.search(url)
    return m.group(1) if m else None


def _oembed_title(url: str, client: httpx.Client) -> str | None:
    try:
        resp = client.get(_OEMBED, params={"url": url})
        resp.raise_for_status()
        return resp.json().get("title")
    except (httpx.HTTPError, ValueError):
        return None  # title is a nicety; never fail the resolve over it


def resolve_link(url: str, *, client: httpx.Client | None = None) -> SpotifyResult:
    """Resolve a Spotify track link to an embed (URL rewrite + best-effort title).
    Raises ValueError if the URL isn't a recognizable track link."""
    track_id = track_id_from_url(url)
    if not track_id:
        raise ValueError(f"not a Spotify track URL: {url!r}")
    owns = client is None
    client = client or httpx.Client(timeout=_TIMEOUT)
    try:
        title = _oembed_title(url, client)
    finally:
        if owns:
            client.close()
    return SpotifyResult(embed=embed_url(track_id), track_id=track_id, title=title)


def client_credentials_token(client_id: str, client_secret: str, *, client: httpx.Client) -> str:
    """Fetch an app-only access token (client-credentials grant)."""
    auth = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
    resp = client.post(
        _ACCOUNTS,
        data={"grant_type": "client_credentials"},
        headers={"Authorization": f"Basic {auth}"},
    )
    resp.raise_for_status()
    return resp.json()["access_token"]


def resolve_name(
    query: str, client_id: str, client_secret: str, *, client: httpx.Client | None = None
) -> SpotifyResult:
    """Resolve a free-text song name to the best-matching track's embed via the
    Search API. Raises ValueError if nothing matches."""
    owns = client is None
    client = client or httpx.Client(timeout=_TIMEOUT)
    try:
        token = client_credentials_token(client_id, client_secret, client=client)
        resp = client.get(
            _SEARCH,
            params={"q": query, "type": "track", "limit": 1},
            headers={"Authorization": f"Bearer {token}"},
        )
        resp.raise_for_status()
        items = resp.json().get("tracks", {}).get("items", [])
        if not items:
            raise ValueError(f"no Spotify track found for {query!r}")
        track = items[0]
        artists = ", ".join(a["name"] for a in track.get("artists", []))
        return SpotifyResult(
            embed=embed_url(track["id"]),
            track_id=track["id"],
            title=track.get("name"),
            artist=artists or None,
        )
    finally:
        if owns:
            client.close()
