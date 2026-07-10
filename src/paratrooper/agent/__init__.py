"""Agent worker: Claude Agent SDK + tools + main-boundary hook + memory.

SDK-independent internals (``config``, ``pins``, ``images``, ``spotify``,
``siterepo``, ``screenshot``, ``memory``) are importable without the Agent SDK.
The SDK wiring (``auth``, ``hooks``, ``prompt``, ``tools``, ``worker``) imports
``claude_agent_sdk``.
"""

from .config import Config, ConfigError, load_config
from .hooks import git_violation
from .memory import Changelog, ChangelogEntry, format_digest
from .pins import slugify

__all__ = [
    "Config",
    "ConfigError",
    "load_config",
    "git_violation",
    "Changelog",
    "ChangelogEntry",
    "format_digest",
    "slugify",
]
