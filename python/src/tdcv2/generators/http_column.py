"""One ``<gen type="http">`` as a column of the run, fetched batch by batch.

The rule ``http`` runs on: the column is cut into batches of ``batch=`` rows, numbered by the
ABSOLUTE row of the run — batch k is rows [k·N, (k+1)·N). Wherever the generator sits — a sequence
of its own, a ``parent=`` child, a ``<mix>`` case, a field — row i reads answer i, and the service
is asked only for the batches somebody reads.

The in-memory engine asks for a whole column of rows at once; a reader walking row by row finds
the batch already fetched or on the wire. Memory holds a few batches, never the column.

``parallel=`` is how many batches may be on the wire together. The default, 1, still overlaps the
network with the engine's own work: the next batch is requested the moment the current one
arrives, while its rows are written.

Mirrors ``typescript/src/generators/http-column.ts``.
"""

from __future__ import annotations

import math
import tempfile
from collections import OrderedDict
from collections.abc import Callable, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass

from . import http as http_gen

DEFAULT_BATCH = 10_000
"""Rows per request when ``batch=`` is absent — see the TypeScript twin for why this size."""


@dataclass(frozen=True, slots=True)
class ColumnSpec:
    """Everything one http generator needs, resolved once per run."""

    sequence: str
    """The column as the reader wrote it — ``Hash``, or ``Pay.ref`` for a field. For messages."""
    src: str
    in_name: str | None
    seed: str
    secret: str | None
    on_error: str
    timeout_ms: int
    batch: int
    parallel: int


@dataclass(slots=True)
class _InFlight:
    future: Future[list[str]]
    request: http_gen.Request


class HttpColumn:
    def __init__(
        self,
        spec: ColumnSpec,
        total: int,
        input_at: Callable[[int], str],
        span: Callable[[], tuple[int, int] | None] = lambda: None,
        kept: AnswerFile | None = None,
    ) -> None:
        self._spec = spec
        # Where answers go when the column is read more than once; None otherwise.
        self._kept = kept
        # The rows this process writes, under parallel shards; None for the whole run.
        self._span = span
        self._total = total
        self._input_at = input_at
        self._batches = math.ceil(total / spec.batch) if spec.batch > 0 else 0
        self._in_flight: dict[int, _InFlight] = {}
        self._answered: OrderedDict[int, list[str]] = OrderedDict()
        # The batch being read, the one before it (a reader may look one row back across the
        # seam) and everything already on the wire.
        self._keep = spec.parallel + 2
        self._pool: ThreadPoolExecutor | None = None

    def value_at(self, row: int) -> str:
        """The answer for one absolute row."""
        k = row // self._spec.batch
        values = self._batch(k, k + 1, self._sequential_ahead(k))
        at = row - k * self._spec.batch
        return values[at] if at < len(values) else ""

    def values_at(self, rows: Sequence[int]) -> list[str]:
        """The answers for these absolute rows, in the order given.

        Only the batches holding them are requested, in ascending order, each exactly once; the
        next one needed goes on the wire before this one is waited for.
        """
        size = self._spec.batch
        needed = sorted({row // size for row in rows})
        by_batch: dict[int, list[str]] = {}
        for i, k in enumerate(needed):
            nxt = needed[i + 1] if i + 1 < len(needed) else None
            ahead = needed[i + 1 : i + self._spec.parallel]
            by_batch[k] = self._batch(k, nxt, ahead)
        out: list[str] = []
        for row in rows:
            k = row // size
            values = by_batch.get(k, [])
            at = row - k * size
            out.append(values[at] if at < len(values) else "")
        return out

    def _batch(self, k: int, nxt: int | None, ahead: Sequence[int]) -> list[str]:
        done = self._answered.get(k)
        if done is not None:
            return done
        # Answered once already and kept on disk: read back, never asked again.
        back = self._kept.read(k) if self._kept is not None else None
        if back is not None:
            self._remember(k, back)
            return back
        # The batch being read always goes out — the limit governs what is sent AHEAD, not what
        # the reader is waiting for.
        self._send(k, needed=True)
        for j in ahead:
            self._send(j)
        flight = self._in_flight.pop(k, None)
        if flight is None:
            return []
        values = self._answer(flight)
        if self._kept is not None:
            self._kept.write(k, values)
        self._remember(k, values)
        if nxt is not None and nxt < self._batches:
            self._send(nxt)
        return values

    def _sequential_ahead(self, k: int) -> list[int]:
        return [j for j in range(k + 1, min(k + self._spec.parallel, self._batches))]

    def _send(self, k: int, needed: bool = False) -> None:
        if k < 0 or k >= self._batches or k in self._in_flight or k in self._answered:
            return
        if self._kept is not None and self._kept.has(k):
            return
        # Read-ahead stops at this shard's last row: the batch past it belongs to the next shard,
        # and asking for it here would send it twice.
        if not needed and not self._in_span(k):
            return
        # Never more than `parallel` out at once: a service that is not safe to call concurrently
        # gets exactly one request at a time under the default.
        if not needed and len(self._in_flight) >= self._spec.parallel:
            return
        offset = k * self._spec.batch
        count = min(self._spec.batch, self._total - offset)
        inputs = (
            None
            if self._spec.in_name is None
            else [self._input_at(offset + i) for i in range(count)]
        )
        request = http_gen.Request(
            src=self._spec.src,
            count=count,
            offset=offset,
            total=self._total,
            inputs=inputs,
            seed=self._spec.seed,
            on_error=self._spec.on_error,
            timeout_ms=self._spec.timeout_ms,
            secret=self._spec.secret,
        )
        if self._pool is None:
            # One more worker than `parallel`: the batch being waited for may go out beside the
            # ones already sent ahead.
            self._pool = ThreadPoolExecutor(max_workers=self._spec.parallel + 1)
        self._in_flight[k] = _InFlight(self._pool.submit(http_gen.fetch, request), request)

    def _in_span(self, k: int) -> bool:
        span = self._span()
        if span is None:
            return True
        first = k * self._spec.batch
        return first < span[1] and first + self._spec.batch > span[0]

    def _answer(self, flight: _InFlight) -> list[str]:
        """Wait for a batch, naming its rows in a failure when the column has several."""
        try:
            return flight.future.result()
        except http_gen.ServiceError as e:
            request = flight.request
            where = (
                f" (rows {request.offset}–{request.offset + request.count - 1})"
                if self._batches > 1
                else ""
            )
            raise ColumnError(
                f'http service for sequence "{self._spec.sequence}" at {e.url}{where} {e}'
            ) from e

    def _remember(self, k: int, values: list[str]) -> None:
        self._answered[k] = values
        while len(self._answered) > self._keep:
            self._answered.popitem(last=False)


class AnswerFile:
    """A column's answers on disk, for a column read twice.

    ``uniq="true"`` on an http column reads every answer to check them, then reads them again to
    write the rows. Memory holds a few batches; the service must be asked once — a second request
    costs its time and, from a service that does not answer alike twice, would write rows other
    than the ones checked. So each batch is appended here as it arrives and read back by position.
    Answers are lines of the reply, so none holds a newline, and one joins them. The file is gone
    when it is closed or the process ends.
    """

    def __init__(self) -> None:
        self._file = None
        self._end = 0
        self._where: dict[int, tuple[int, int]] = {}

    def has(self, k: int) -> bool:
        return k in self._where

    def write(self, k: int, values: list[str]) -> None:
        if k in self._where:
            return
        if self._file is None:
            # Held open for the run and closed with it, so no `with` block can own it.
            self._file = tempfile.TemporaryFile(prefix="tdc-http-")  # noqa: SIM115
        data = "\n".join(values).encode("utf-8")
        self._file.seek(self._end)
        self._file.write(data)
        self._where[k] = (self._end, len(data))
        self._end += len(data)

    def read(self, k: int) -> list[str] | None:
        place = self._where.get(k)
        if place is None or self._file is None:
            return None
        self._file.seek(place[0])
        return self._file.read(place[1]).decode("utf-8").split("\n")


class ColumnError(RuntimeError):
    """A batch that failed, worded for the reader — the sequence, the service and the rows."""


def _parse_count(value: str | None, fallback: int) -> int:
    """A positive whole number from ``batch=``/``parallel=``, or the default."""
    if value is None:
        return fallback
    text = value.strip()
    if not text.isdigit():
        return fallback
    n = int(text)
    return n if n > 0 else fallback


def batch_of(attrs: dict[str, str]) -> int:
    """Rows per request for one ``<gen type="http">``'s attributes."""
    return _parse_count(attrs.get("batch"), DEFAULT_BATCH)


def batches_in(config) -> list[int]:
    """``batch=`` of every ``<gen type="http">`` in the run, wherever it sits — a sequence, a
    field, a part, an ``if=`` branch, a ``<mix>`` or ``<switch>`` case."""
    out: list[int] = []

    def gen(g) -> None:
        if g is not None and g.type == "http":
            out.append(batch_of(g.attrs))

    def case(c) -> None:
        if c is None:
            return
        for part in c.parts:
            gen(part.gen)
            mix(part.mix)
            switch(part.switch)

    def mix(m) -> None:
        if m is not None:
            for c in m.cases:
                case(c)

    def switch(s) -> None:
        if s is not None:
            for entry in s.entries:
                case(entry.value)
            case(s.fallback)

    for spec in config.sequences:
        gen(spec.gen)
        for f in spec.fields or []:
            gen(f.gen)
        for item in spec.items or []:
            gen(item.gen)
            if item.field is not None:
                gen(item.field.gen)
        for branch in spec.branches or []:
            gen(branch.gen)
        mix(spec.mix)
        switch(spec.switch_spec)
    return out


class HttpSession:
    """The http columns of one run.

    One :class:`HttpColumn` per generator and column, made on first use and kept, so a reader
    that builds one row at a time reads the batches the previous row fetched instead of asking
    again.
    """

    def __init__(self, env_seed: str, base_dir: str, keep_answers: bool = False) -> None:
        self._env_seed = env_seed
        self._base_dir = base_dir
        # Keep every answer on disk, because some column of the run is read twice.
        self._keep_answers = keep_answers
        self._span: tuple[int, int] | None = None
        self._columns: dict[tuple[int, str], HttpColumn] = {}
        # Keeps each generator alive while its id() is a key here.
        self._gens: list[object] = []

    def column(
        self,
        attrs: dict[str, str],
        gen: object,
        sequence: str,
        total: int,
        input_at: Callable[[int], str],
    ) -> HttpColumn:
        key = (id(gen), sequence)
        known = self._columns.get(key)
        if known is not None:
            return known
        made = HttpColumn(
            self._spec(attrs, sequence),
            total,
            input_at,
            lambda: self._span,
            AnswerFile() if self._keep_answers else None,
        )
        self._columns[key] = made
        self._gens.append(gen)
        return made

    def restrict(self, start: int, stop: int) -> None:
        """Read ahead no further than rows ``[start, stop)`` — the rows this process writes."""
        self._span = (start, stop)

    def _spec(self, attrs: dict[str, str], sequence: str) -> ColumnSpec:
        # Resolved per column and never cached: two sequences may sign with two different
        # secrets, and a config naming an unset variable should say so in terms of the sequence
        # the reader wrote.
        secret_spec = attrs.get("secret")
        secret = None
        if secret_spec and secret_spec.strip():
            try:
                secret = http_gen.resolve_secret(secret_spec, self._base_dir)
            except http_gen.SecretError as e:
                raise ColumnError(f'http service for sequence "{sequence}": {e}') from e
        in_name = attrs.get("in")
        return ColumnSpec(
            sequence=sequence,
            src=attrs.get("src", ""),
            in_name=in_name if in_name and in_name.strip() else None,
            seed=http_gen.seed_for(self._env_seed, sequence),
            secret=secret,
            on_error=http_gen.parse_on_error(attrs.get("on_error")),
            timeout_ms=http_gen.parse_timeout(attrs.get("timeout")),
            batch=batch_of(attrs),
            parallel=_parse_count(attrs.get("parallel"), 1),
        )
