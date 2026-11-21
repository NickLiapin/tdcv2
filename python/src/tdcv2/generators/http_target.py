"""The request target of an ``http`` generator — the path and query of ``src=``, written once,
the way it goes on the wire.

It is signed (``X-TDC-Signature`` covers it), so the bytes TDC signs and the bytes the service
reads off the request line have to be the same bytes. The five implementations send through five
different HTTP clients, and handed the same URL they do NOT send the same request line, measured
2026-11-21:

- .NET decodes ``%41`` to ``A`` and ``%7e`` to ``~``, and upper-cases ``%d0`` to ``%D0``;
- Node's fetch encodes ``'`` in the query as ``%27`` and drops an empty ``?``; Python, curl and
  .NET keep both;
- curl and Node resolve ``/a/../b`` to ``/b``; the others send it as written.

So the target is not left to the client. It is computed here by one rule, the URL that is
actually sent is rebuilt from it, and every client is then handed a target it sends untouched —
which is what the same measurement showed for a target already in this form, in all five.

The rule:

1. everything after the host; ``#fragment`` dropped (no client sends it);
2. an empty query (``/a?``) is no query;
3. ``/`` when nothing is left, and a leading ``/`` before a bare ``?query``;
4. a ``%XX`` escape of an unreserved character (``A-Z a-z 0-9 - . _ ~``) is that character —
   RFC 3986 §6.2.2.2, and what .NET does anyway; every other escape is kept, its hex digits
   upper-cased (§6.2.2.1);
5. a ``%`` that does not start an escape is ``%25``;
6. any other character outside ``A-Z a-z 0-9 - . _ ~ ! $ & ( ) * + , ; = : @ / ?`` is
   percent-encoded as its UTF-8 bytes — ``'`` included, because fetch encodes it in a query and
   nothing else does.

``.`` and ``..`` segments are the one shape no rule can settle — two clients resolve them, three
send them — so the validator refuses them (TDC066) and a config never reaches this point with
one.

Mirrors ``typescript/src/generators/http-target.ts``; all five are held to
``fixtures/cross-language/http-vectors.json`` (``target``).
"""

from __future__ import annotations

from dataclasses import dataclass

HTTP_METHOD = "POST"
"""What every TDC request is sent with. Signed, so a service can tell."""

_UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

# Characters a target carries as they are. `'` is deliberately absent.
_KEPT = _UNRESERVED | frozenset("!$&()*+,;=:@/?")

_HEX = frozenset("0123456789ABCDEFabcdef")

# The whitespace trimmed off `src=` — ASCII only, as in the other four.
_TRIMMED = " \t\r\n"


@dataclass(frozen=True, slots=True)
class HttpTarget:
    url: str
    """The URL handed to the HTTP client: scheme and host as written, then ``target``."""

    target: str
    """Path and query as they go on the request line — and into the signature."""


def _split_src(src: str) -> tuple[str, str]:
    """``src=`` cut into what is sent as written (scheme, host, port) and what is not."""
    trimmed = src.strip(_TRIMMED)
    scheme = trimmed.find("://")
    host_start = 0 if scheme < 0 else scheme + 3
    for i in range(host_start, len(trimmed)):
        if trimmed[i] in "/?#":
            return trimmed[:i], trimmed[i:]
    return trimmed, ""


def _percent_encode(char: str) -> str:
    """``%XX`` for each UTF-8 byte of one character."""
    # A lone surrogate has no UTF-8 form; the reference's TextEncoder writes U+FFFD for it.
    if 0xD800 <= ord(char) <= 0xDFFF:
        char = "�"
    return "".join(f"%{byte:02X}" for byte in char.encode("utf-8"))


def http_target(src: str) -> HttpTarget:
    """The URL to send and the target to sign, for one ``src=``.

    A Python ``str`` is a sequence of code points, so a character outside the BMP is one
    character here, as the rule wants — not the two UTF-16 halves a JavaScript string holds.
    """
    origin, raw = _split_src(src)
    hash_at = raw.find("#")
    if hash_at >= 0:
        raw = raw[:hash_at]
    query = raw.find("?")
    if query >= 0 and query == len(raw) - 1:
        raw = raw[:query]
    if not raw.startswith("/"):
        raw = "/" + raw

    out: list[str] = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "%":
            pair = raw[i + 1 : i + 3]
            if len(pair) == 2 and pair[0] in _HEX and pair[1] in _HEX:
                decoded = chr(int(pair, 16))
                out.append(decoded if decoded in _UNRESERVED else "%" + pair.upper())
                i += 2
            else:
                out.append("%25")
        elif c in _KEPT:
            out.append(c)
        else:
            out.append(_percent_encode(c))
        i += 1
    target = "".join(out)
    return HttpTarget(url=origin + target, target=target)


def dot_segment_of(src: str) -> str | None:
    """The first ``.`` or ``..`` segment of the target's path, if it has one.

    Read AFTER the rule above, so ``%2e%2e`` counts — Node's URL parser treats it as ``..`` too.
    """
    target = http_target(src).target
    query = target.find("?")
    path = target if query < 0 else target[:query]
    for segment in path.split("/"):
        if segment in (".", ".."):
            return segment
    return None
