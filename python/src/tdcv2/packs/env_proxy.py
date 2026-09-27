"""Which proxy a registry request goes through, read from the environment — one rule in all five.

``urllib`` would read these variables on its own. The rule is spelled out here instead so that it is
the SAME rule the other four implementations apply -- the order of the variables, what
``no_proxy`` matches -- and so that the proxy a failure went through can be named in the message.

- An ``https`` address takes the first non-empty of ``https_proxy``, ``HTTPS_PROXY``,
  ``all_proxy``, ``ALL_PROXY``; an ``http`` one ``http_proxy``, ``HTTP_PROXY``, ``all_proxy``,
  ``ALL_PROXY``.
- ``no_proxy`` (or ``NO_PROXY``) is a comma-separated list of hosts that go direct: ``*`` for all,
  otherwise a host matches an entry it equals or ends with after a dot, with a leading dot and a
  port ignored.
- A value with no scheme is an ``http://`` proxy.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from urllib.parse import urlsplit

from .store import PackError


@dataclass(frozen=True, slots=True)
class Choice:
    """The proxy an address goes through, and the variable that named it."""

    url: str
    """The proxy as written, credentials included -- what the request uses."""
    shown: str
    """``scheme://host:port``, port spelled out, credentials left out -- what a message prints."""
    variable: str


def for_url(url: str) -> Choice | None:
    """The proxy for ``url``, or ``None`` to go direct."""
    target = urlsplit(url)
    scheme = target.scheme.lower()
    host = target.hostname or ""
    if scheme not in ("http", "https") or not host or bypassed(host):
        return None
    names = (
        ("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY")
        if scheme == "https"
        else ("http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY")
    )
    for name in names:
        value = _read(name)
        if not value:
            continue
        written = value if "://" in value else "http://" + value
        try:
            proxy = urlsplit(written)
            port = proxy.port
        except ValueError:
            proxy, port = None, None
        if proxy is None or not proxy.hostname:
            raise PackError(
                f'{name}="{value}" is not a proxy address — write it as http://host:port'
            )
        scheme = proxy.scheme.lower()
        effective = port if port is not None else (443 if scheme == "https" else 80)
        shown = f"{scheme}://{proxy.hostname}:{effective}"
        return Choice(written, shown, name)
    return None


def bypassed(host: str) -> bool:
    """Whether ``host`` is listed in ``no_proxy`` / ``NO_PROXY``."""
    listed = _read("no_proxy") or _read("NO_PROXY")
    h = host.lower()
    for raw in listed.split(","):
        entry = raw.strip().lower()
        if entry == "*":
            return True
        entry = entry.removeprefix(".")
        if entry.count(":") == 1:
            entry = entry.split(":", 1)[0]
        if entry and (h == entry or h.endswith("." + entry)):
            return True
    return False


def _read(name: str) -> str:
    return (os.environ.get(name) or "").strip()
