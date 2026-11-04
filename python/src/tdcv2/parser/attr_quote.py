"""An attribute value as the lexer hands it over — quotes included — and the text between them.

A value is quoted with ``"`` or with ``'`` and closes with the quote it opened with. Nothing
inside is escaped, so the other kind of quote is how a value holds one: ``value='say "hi"'``.
"""

from __future__ import annotations


def is_quoted(text: str) -> bool:
    """Whether ``text`` is a whole quoted value, either kind of quote."""
    return len(text) >= 2 and text[0] in "\"'" and text[-1] == text[0]


def unquote(text: str) -> str:
    """The text between the quotes, or ``text`` itself when it is not quoted."""
    return text[1:-1] if is_quoted(text) else text
