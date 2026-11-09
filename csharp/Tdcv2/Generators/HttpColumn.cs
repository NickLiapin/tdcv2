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
    private readonly Func<(int Start, int End)?> _span;

    /// <summary>Where answers go when the column is read more than once; null otherwise.</summary>
    private readonly AnswerFile? _kept;

    public HttpColumn(Spec spec, int total, Func<(int Start, int End)?>? span = null)
        : this(spec, total, span, null)
    {
    }

    private HttpColumn(Spec spec, int total, Func<(int Start, int End)?>? span, AnswerFile? kept)
    {
        _kept = kept;
        _spec = spec;
        _total = total;
        // The rows this run writes, when a worker writes only some of them; null for the whole run.
        _span = span ?? (() => null);
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

        // Answered once already and kept on disk: read back, never asked again.
        IReadOnlyList<string>? back = _kept?.Read(k);
        if (back is not null)
        {
            Remember(k, back);
            return back;
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
        _kept?.Write(k, answer);
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

        if (_kept is not null && _kept.Has(k))
        {
            return;
        }

        // Read-ahead stops at this worker's last row: the batch past it belongs to the next
        // worker, and asking for it here would send it twice.
        if (!needed && !InSpan(k))
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
    private bool InSpan(int k)
    {
        if (_span() is not (int start, int end))
        {
            return true;
        }

        long first = (long)k * _spec.Batch;
        return first < end && first + _spec.Batch > start;
    }

    /// <summary>A column's answers on disk, for a column read twice.</summary>
    /// <remarks>
    /// <c>uniq="true"</c> on an http column reads every answer to check them, then reads them again
    /// to write the rows. Memory holds a few batches; the service must be asked once — a second
    /// request costs its time and, from a service that does not answer alike twice, would write
    /// rows other than the ones checked. So each batch is appended here as it arrives and read back
    /// by position. Answers are lines of the reply, so none holds a newline, and one joins them.
    /// The file is deleted when it is closed — at the latest, when the process ends.
    /// </remarks>
    private sealed class AnswerFile
    {
        private FileStream? _file;
        private long _end;
        private readonly Dictionary<int, (long At, int Length)> _where = new();

        public bool Has(int k) => _where.ContainsKey(k);

        public void Write(int k, IReadOnlyList<string> values)
        {
            if (_where.ContainsKey(k))
            {
                return;
            }

            _file ??= new FileStream(
                Path.Combine(Path.GetTempPath(), "tdc-http-" + Guid.NewGuid().ToString("N")),
                FileMode.CreateNew,
                FileAccess.ReadWrite,
                FileShare.None,
                4096,
                FileOptions.DeleteOnClose);
            byte[] bytes = System.Text.Encoding.UTF8.GetBytes(string.Join("\n", values));
            _file.Position = _end;
            _file.Write(bytes, 0, bytes.Length);
            _where[k] = (_end, bytes.Length);
            _end += bytes.Length;
        }

        public IReadOnlyList<string>? Read(int k)
        {
            if (_file is null || !_where.TryGetValue(k, out (long At, int Length) place))
            {
                return null;
            }

            var bytes = new byte[place.Length];
            _file.Position = place.At;
            int read = 0;
            while (read < bytes.Length)
            {
                int got = _file.Read(bytes, read, bytes.Length - read);
                if (got <= 0)
                {
                    break;
                }

                read += got;
            }

            return System.Text.Encoding.UTF8.GetString(bytes).Split('\n');
        }
    }

    /// <summary>Rows per request for one <c>&lt;gen type="http"&gt;</c>'s attributes.</summary>
    public static int BatchOf(IReadOnlyDictionary<string, string> attrs) =>
        ParseCount(attrs.GetValueOrDefault("batch"), DefaultBatch);

    /// <summary>
    /// <c>batch=</c> of every <c>&lt;gen type="http"&gt;</c> in the run, wherever it sits — a
    /// sequence, a field, a part, an <c>if=</c> branch, a <c>&lt;mix&gt;</c> or
    /// <c>&lt;switch&gt;</c> case.
    /// </summary>
    public static List<int> BatchesIn(Tdcv2.Model.Config config)
    {
        var sizes = new List<int>();
        foreach (Tdcv2.Model.SequenceSpec spec in config.Sequences)
        {
            CollectGen(spec.Gen, sizes);
            foreach (Tdcv2.Model.Field field in spec.Fields ?? Array.Empty<Tdcv2.Model.Field>())
            {
                CollectGen(field.Gen, sizes);
            }

            foreach (Tdcv2.Model.Item item in spec.Items ?? Array.Empty<Tdcv2.Model.Item>())
            {
                CollectGen(item.Gen, sizes);
                CollectGen(item.Field?.Gen, sizes);
            }

            foreach (Tdcv2.Model.Branch branch in spec.Branches ?? Array.Empty<Tdcv2.Model.Branch>())
            {
                CollectGen(branch.Gen, sizes);
            }

            CollectMix(spec.Mix, sizes);
            CollectSwitch(spec.SwitchSpec, sizes);
        }

        return sizes;
    }

    private static void CollectGen(Tdcv2.Model.Gen? gen, List<int> sizes)
    {
        if (gen is { Type: "http" } http)
        {
            sizes.Add(BatchOf(http.Attrs));
        }
    }

    private static void CollectCase(Tdcv2.Model.Case? c, List<int> sizes)
    {
        foreach (Tdcv2.Model.CasePart part in c?.Parts ?? Array.Empty<Tdcv2.Model.CasePart>())
        {
            CollectGen(part.Gen, sizes);
            CollectMix(part.Mix, sizes);
            CollectSwitch(part.SwitchSpec, sizes);
        }
    }

    private static void CollectMix(Tdcv2.Model.Mix? mix, List<int> sizes)
    {
        foreach (Tdcv2.Model.Case c in mix?.Cases ?? Array.Empty<Tdcv2.Model.Case>())
        {
            CollectCase(c, sizes);
        }
    }

    private static void CollectSwitch(Tdcv2.Model.Switch? sw, List<int> sizes)
    {
        if (sw is null)
        {
            return;
        }

        foreach (Tdcv2.Model.SwitchEntry entry in sw.Entries)
        {
            CollectCase(entry.Value, sizes);
        }

        CollectCase(sw.Fallback, sizes);
    }

    /// <summary>
    /// The row count a parallel split must fall on so no batch of any http column straddles two
    /// workers: the least common multiple of <see cref="BatchesIn"/>, or 1 when nothing calls a
    /// service. Straddling would send the seam's batch twice.
    /// </summary>
    public static int Alignment(Tdcv2.Model.Config config)
    {
        long lcm = 1;
        foreach (int size in BatchesIn(config))
        {
            lcm = lcm / (long)System.Numerics.BigInteger.GreatestCommonDivisor(lcm, size) * size;
            if (lcm > int.MaxValue)
            {
                return int.MaxValue;
            }
        }

        return (int)lcm;
    }

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

        private (int Start, int End)? _span;

        /// <summary>Keep every answer on disk, because some column of the run is read twice.</summary>
        private readonly bool _keepAnswers;

        public Session(string envSeed, string baseDir, bool keepAnswers = false)
        {
            _envSeed = envSeed;
            _baseDir = baseDir;
            _keepAnswers = keepAnswers;
        }

        /// <summary>Read ahead no further than rows <c>[start, end)</c> — the rows this worker writes.</summary>
        public void Restrict(int start, int end) => _span = (start, end);

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
                BatchOf(attrs),
                ParseCount(attrs.GetValueOrDefault("parallel"), 1));
            var made = new HttpColumn(spec, total, () => _span, _keepAnswers ? new AnswerFile() : null);
            bySequence[sequence] = made;
            return made;
        }
    }
}
