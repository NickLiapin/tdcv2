using System.Runtime.CompilerServices;

namespace Tdcv2.Generators;

/// <summary>
/// One <c>&lt;gen type="http"&gt;</c> as a column of the run, fetched batch by batch.
/// </summary>
/// <remarks>
/// The rule <c>http</c> runs on: the column is cut into batches of <c>batch=</c> rows, numbered by
/// the ABSOLUTE row of the run — batch k is rows [k·N, (k+1)·N). Wherever the generator sits — a
/// sequence of its own, a <c>parent=</c> child, a <c>&lt;mix&gt;</c> case, a field — row i reads
/// answer i, and the service is asked only for the batches somebody reads.
///
/// The in-memory engine asks for a whole column of rows at once; a reader walking row by row finds
/// the batch already fetched or on the wire. Memory holds a few batches, never the column.
///
/// <c>parallel=</c> is how many batches may be on the wire together. The default, 1, still overlaps
/// the network with the engine's own work: the next batch is requested the moment the current one
/// arrives, while its rows are written.
///
/// Mirrors <c>typescript/src/generators/http-column.ts</c>.
/// </remarks>
public sealed class HttpColumn
{
    /// <summary>Rows per request when <c>batch=</c> is absent — see the TypeScript twin.</summary>
    public const int DefaultBatch = 10_000;

    /// <summary>Everything one http generator needs, resolved once per run.</summary>
    public sealed record Spec(
        string Sequence,
        string Src,
        string? InName,
        string Seed,
        string? Secret,
        HttpGen.OnErrorMode OnError,
        long TimeoutMs,
        int Batch,
        int Parallel);

    /// <summary>A failed batch, worded for the reader — the sequence, the service and the rows.</summary>
    public sealed class ColumnException : Exception
    {
        internal ColumnException(string message, Exception inner) : base(message, inner)
        {
        }
    }

    private sealed record InFlight(Task<IReadOnlyList<string>> Task, int Offset, int Count);

    private readonly Spec _spec;
    private readonly int _total;
    private readonly int _batches;
    private readonly Dictionary<int, InFlight> _inFlight = new();
    private readonly LinkedList<(int K, IReadOnlyList<string> Values)> _answered = new();
    private readonly int _keep;

    public HttpColumn(Spec spec, int total)
    {
        _spec = spec;
        _total = total;
        _batches = spec.Batch <= 0 ? 0 : (total + spec.Batch - 1) / spec.Batch;
        // The batch being read, the one before it (a reader may look one row back across the
        // seam) and everything already on the wire.
        _keep = spec.Parallel + 2;
    }

    /// <summary>The answer for one absolute row.</summary>
    public string ValueAt(int row, Func<int, string> inputAt)
    {
        int size = _spec.Batch;
        int k = row / size;
        var ahead = new List<int>();
        for (int j = k + 1; j < Math.Min(k + _spec.Parallel, _batches); j++)
        {
            ahead.Add(j);
        }

        IReadOnlyList<string> values = Batch(k, k + 1, ahead, inputAt);
        int at = row - k * size;
        return at < values.Count ? values[at] : "";
    }

    /// <summary>
    /// The answers for these absolute rows, in the order given. Only the batches holding them are
    /// requested, in ascending order, each exactly once.
    /// </summary>
    public IReadOnlyList<string> ValuesAt(IReadOnlyList<int> rows, Func<int, string> inputAt)
    {
        int size = _spec.Batch;
        List<int> needed = rows.Select(row => row / size).Distinct().OrderBy(k => k).ToList();
        var byBatch = new Dictionary<int, IReadOnlyList<string>>();
        for (int i = 0; i < needed.Count; i++)
        {
            int k = needed[i];
            int? next = i + 1 < needed.Count ? needed[i + 1] : null;
            int end = Math.Min(i + _spec.Parallel, needed.Count);
            List<int> ahead = needed.GetRange(Math.Min(i + 1, end), end - Math.Min(i + 1, end));
            byBatch[k] = Batch(k, next, ahead, inputAt);
        }

        var output = new string[rows.Count];
        for (int i = 0; i < rows.Count; i++)
        {
            int k = rows[i] / size;
            IReadOnlyList<string> values = byBatch.GetValueOrDefault(k) ?? Array.Empty<string>();
            int at = rows[i] - k * size;
            output[i] = at < values.Count ? values[at] : "";
        }

        return output;
    }

    private IReadOnlyList<string> Batch(
        int k, int? next, IReadOnlyList<int> ahead, Func<int, string> inputAt)
    {
        foreach ((int at, IReadOnlyList<string> values) in _answered)
        {
            if (at == k)
            {
                return values;
            }
        }

        // The batch being read always goes out — the limit governs what is sent AHEAD, not what
        // the reader is waiting for.
        Send(k, true, inputAt);
        foreach (int j in ahead)
        {
            Send(j, false, inputAt);
        }

        if (!_inFlight.Remove(k, out InFlight? flight))
        {
            return Array.Empty<string>();
        }

        IReadOnlyList<string> answer = Answer(flight);
        Remember(k, answer);
        if (next is int n && n < _batches)
        {
            Send(n, false, inputAt);
        }

        return answer;
    }

    private void Send(int k, bool needed, Func<int, string> inputAt)
    {
        if (k < 0 || k >= _batches || _inFlight.ContainsKey(k) || _answered.Any(a => a.K == k))
        {
            return;
        }

        // Never more than `parallel` out at once: a service that is not safe to call concurrently
        // gets exactly one request at a time under the default.
        if (!needed && _inFlight.Count >= _spec.Parallel)
        {
            return;
        }

        int offset = k * _spec.Batch;
        int count = Math.Min(_spec.Batch, _total - offset);
        string[]? inputs = null;
        if (_spec.InName is not null)
        {
            inputs = new string[count];
            for (int i = 0; i < count; i++)
            {
                inputs[i] = inputAt(offset + i);
            }
        }

        Spec spec = _spec;
        int total = _total;
        var task = Task.Run(() => HttpGen.Fetch(
            spec.Src, count, offset, total, inputs, spec.Seed, spec.OnError, spec.TimeoutMs,
            spec.Secret));
        _inFlight[k] = new InFlight(task, offset, count);
    }

    /// <summary>Wait for a batch, naming its rows in a failure when the column has several.</summary>
    private IReadOnlyList<string> Answer(InFlight flight)
    {
        try
        {
            return flight.Task.GetAwaiter().GetResult();
        }
        catch (HttpGen.ServiceException e)
        {
            string where = _batches > 1
                ? $" (rows {flight.Offset}–{flight.Offset + flight.Count - 1})"
                : "";
            throw new ColumnException(
                $"http service for sequence \"{_spec.Sequence}\" at {e.Url}{where} {e.Message}", e);
        }
    }

    private void Remember(int k, IReadOnlyList<string> values)
    {
        _answered.AddLast((k, values));
        while (_answered.Count > _keep)
        {
            _answered.RemoveFirst();
        }
    }

    /// <summary>A positive whole number from <c>batch=</c>/<c>parallel=</c>, or the default.</summary>
    internal static int ParseCount(string? raw, int fallback)
    {
        if (raw is null)
        {
            return fallback;
        }

        string text = raw.Trim();
        if (text.Length == 0 || !text.All(c => c is >= '0' and <= '9'))
        {
            return fallback;
        }

        return int.TryParse(text, System.Globalization.NumberStyles.None,
            System.Globalization.CultureInfo.InvariantCulture, out int n) && n > 0
            ? n
            : fallback;
    }

    /// <summary>
    /// The http columns of one run, one per generator and column, made on first use and kept — so
    /// a reader building one row at a time reads the batches the previous row fetched instead of
    /// asking again.
    /// </summary>
    public sealed class Session
    {
        private readonly string _envSeed;
        private readonly string _baseDir;

        /// <summary>By generator IDENTITY: two generators written alike are still two columns.</summary>
        private readonly ConditionalWeakTable<object, Dictionary<string, HttpColumn>> _columns = new();

        public Session(string envSeed, string baseDir)
        {
            _envSeed = envSeed;
            _baseDir = baseDir;
        }

        /// <summary>The column for this generator, as <paramref name="sequence"/> reads it.</summary>
        public HttpColumn Column(
            object gen, IReadOnlyDictionary<string, string> attrs, string sequence, int total)
        {
            Dictionary<string, HttpColumn> bySequence = _columns.GetOrCreateValue(gen);
            if (bySequence.TryGetValue(sequence, out HttpColumn? known))
            {
                return known;
            }

            // Resolved per column and never cached: two sequences may sign with two different
            // secrets, and a config naming an unset variable should say so in terms of the
            // sequence the reader wrote.
            string? secretSpec = attrs.GetValueOrDefault("secret");
            string? secret = null;
            if (!string.IsNullOrWhiteSpace(secretSpec))
            {
                try
                {
                    secret = HttpGen.ResolveSecret(secretSpec, _baseDir);
                }
                catch (HttpGen.SecretException e)
                {
                    throw new ColumnException(
                        $"http service for sequence \"{sequence}\": {e.Message}", e);
                }
            }

            string? inName = attrs.GetValueOrDefault("in")?.Trim();
            var spec = new Spec(
                sequence,
                attrs.GetValueOrDefault("src") ?? "",
                string.IsNullOrEmpty(inName) ? null : inName,
                HttpGen.SeedFor(_envSeed, sequence),
                secret,
                HttpGen.OnError(attrs),
                HttpGen.TimeoutMs(attrs.GetValueOrDefault("timeout")),
                ParseCount(attrs.GetValueOrDefault("batch"), DefaultBatch),
                ParseCount(attrs.GetValueOrDefault("parallel"), 1));
            var made = new HttpColumn(spec, total);
            bySequence[sequence] = made;
            return made;
        }
    }
}
