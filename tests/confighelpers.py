"""Configurations for the tests, built from the committed example.

Every test config comes from ``config/paratrooper.example.toml`` through the
real validator. Two reasons, and they are the whole point of this module rather
than a literal in each test file:

* the committed example is placeholders only, so no test carries a person's
  name, a real site or a real repository; and
* a test config that was hand-built would not be a config the loader had ever
  accepted, so the example stays honest by being the thing the suite runs on.

The private source is never read here. Nothing in this file touches ``config/
paratrooper.toml``.
"""

from __future__ import annotations

import base64
import dataclasses
import tomllib
from pathlib import Path
from typing import Any

from paratrooper.agent.config import Config, PinboardConfig, validate_config

REPO_ROOT = Path(__file__).resolve().parents[1]
EXAMPLE_SOURCE = REPO_ROOT / "config" / "paratrooper.example.toml"


def example_text() -> str:
    """The committed example, verbatim."""
    return EXAMPLE_SOURCE.read_text(encoding="utf-8")


def example_table() -> dict[str, Any]:
    """The committed example, parsed, ready to be mutated by a test that wants
    to prove one particular rejection."""
    return tomllib.loads(example_text())


def encoded(text: str) -> str:
    """What ``PARATROOPER_CONFIG_B64`` carries for this text."""
    return base64.b64encode(text.encode("utf-8")).decode("ascii")


def example_config(**overrides: Any) -> Config:
    """A validated pinboard config, with no machine paths bound.

    This is what a local ``check`` produces: no inbox, no site root, no
    credential involved."""
    config = validate_config(example_table(), source="the example")
    return dataclasses.replace(config, **overrides) if overrides else config


def pinboard_config(
    tmp_path: Path | None = None,
    *,
    screenshot: bool = True,
    remote: str | None = None,
    **overrides: Any,
) -> Config:
    """A pinboard config with its two machine paths bound under ``tmp_path``.

    The stage folders keep the example's own relative layout, so ``cfg.pinboard
    .pins_dir`` resolves under the site root exactly as it does on the worker.
    """
    config = example_config()
    pinboard: PinboardConfig = config.pinboard
    if not screenshot:
        pinboard = dataclasses.replace(pinboard, screenshot=None)
    if remote is not None:
        pinboard = dataclasses.replace(pinboard, remote=remote)
    if tmp_path is not None:
        pinboard = dataclasses.replace(pinboard, site_root=tmp_path / "site")
        overrides.setdefault("inbox", tmp_path / "inbox")
    return dataclasses.replace(config, pinboard=pinboard, **overrides)


def plain_table() -> dict[str, Any]:
    """The shared half of the example and nothing else: what a plain source
    looks like. No profile table, and no key from the other profile."""
    table = example_table()
    table.pop("pinboard", None)
    table["profile"] = "plain"
    return table


def plain_config(tmp_path: Path | None = None, **overrides: Any) -> Config:
    """A validated plain config, optionally with its one machine path bound.

    A plain deployment has exactly one machine path, its own inbox: there is no
    checkout to stand in and no site root to bind. Built through the real
    validator from the example's shared half, like every other config here."""
    config = validate_config(plain_table(), source="the plain example")
    if tmp_path is not None:
        overrides.setdefault("inbox", tmp_path / "inbox")
    return dataclasses.replace(config, **overrides) if overrides else config
