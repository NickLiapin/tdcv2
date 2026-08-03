using System.Globalization;
using Tdcv2.Date;

namespace Tdcv2.Cli;

/// <summary>
/// The command line, parsed by hand.
/// </summary>
/// <remarks>
/// <para>
/// No argument library. The TypeScript CLI is the interface users already know, and matching it
/// exactly matters more than the lines saved: <c>--engine 2</c> and <c>--engine=2</c> both work
/// there, an unknown flag exits 2 with a specific message, and a positional argument may follow
/// flags. Making a general parser agree on all of that costs more than writing the loop, and leaves
/// the agreement undocumented.
/// </para>
/// <para>
/// Kept apart from <see cref="Main"/> so the parsing can be tested without a filesystem or a run.
/// </para>
/// </remarks>
public static class Args
{
    /// <summary>A command line that cannot be obeyed. Reported, then exit code 2.</summary>
    public sealed class UsageException : Exception
    {
        public UsageException(string message)
            : base(message)
        {
        }
    }

    /// <summary>What the command line asked for, before anything has been read or run.</summary>
    public sealed record Options(
        string? Input, string? Output, string? Seed, int? Count, string? Locale, long? Now,
        IReadOnlyList<string> DataPaths, int? Jobs, string? Mode, int? Engine, bool Help,
        bool Version);

    /// <summary>Mutable while parsing; a record once it is done.</summary>
    private sealed class Builder
    {
        internal string? Input;
        internal string? Output;
        internal string? Seed;
        internal int? Count;
        internal string? Locale;
        internal long? Now;
        internal readonly List<string> DataPaths = new();
        internal int? Jobs;
        internal string? Mode;
        internal int? Engine;
        internal bool Help;
        internal bool Version;

        internal Options Build() => new(
            Input, Output, Seed, Count, Locale, Now, DataPaths, Jobs, Mode, Engine, Help, Version);
    }

    /// <summary>The generate command's arguments. Throws <see cref="UsageException"/> with the message to print.</summary>
    public static Options Parse(IReadOnlyList<string> argv)
    {
        var result = new Builder();

        for (int i = 0; i < argv.Count; i++)
        {
            string arg = argv[i];

            int equals = arg.StartsWith("--", StringComparison.Ordinal) ? arg.IndexOf('=') : -1;
            if (equals > 0)
            {
                string name = arg[..equals];
                string value = arg[(equals + 1)..];
                if (value.Length == 0)
                {
                    throw new UsageException("missing value for " + name);
                }

                if (IsValued(name))
                {
                    Store(result, name, value);
                    continue;
                }
            }

            if (IsValued(arg) || arg == "-o")
            {
                string name = arg == "-o" ? "--output" : arg;
                i++;
                if (i >= argv.Count || argv[i].Length == 0)
                {
                    throw new UsageException("missing value for " + name);
                }

                Store(result, name, argv[i]);
            }
            else if (arg is "-h" or "--help")
            {
                result.Help = true;
            }
            else if (arg is "-v" or "--version")
            {
                result.Version = true;
            }
            else if (arg == "--stream")
            {
                // The legacy spelling of --engine 2, kept because configs and scripts still say it.
                result.Engine = 2;
            }
            else if (arg == "--disk")
            {
                result.Mode = "disk";
            }
            else if (arg.StartsWith('-'))
            {
                throw new UsageException("unknown option: " + arg);
            }
            else if (result.Input is null)
            {
                result.Input = arg;
            }
            else
            {
                throw new UsageException("unexpected positional argument: " + arg);
            }
        }

        return result.Build();
    }

    private static bool IsValued(string name) => name is
        "--output" or "--seed" or "--count" or "--locale" or "--now" or "--data-path" or "--jobs"
        or "--mode" or "--engine";

    private static void Store(Builder result, string name, string value)
    {
        switch (name)
        {
            case "--output":
                result.Output = value;
                return;
            case "--seed":
                result.Seed = value;
                return;
            case "--locale":
                result.Locale = value;
                return;
            case "--now":
                result.Now = NowMillis(value);
                return;
            case "--data-path":
                result.DataPaths.Add(value);
                return;
            case "--count":
                result.Count = NonNegative(value, "--count");
                return;
            case "--jobs":
                result.Jobs = Positive(value, "--jobs");
                return;
            case "--engine":
                if (value is not ("1" or "2" or "3"))
                {
                    throw new UsageException(
                        $"invalid --engine \"{value}\" — expected 1 (in-memory), 2 (streaming), "
                        + "or 3 (exact-on-disk)");
                }

                result.Engine = int.Parse(value, CultureInfo.InvariantCulture);
                return;
            case "--mode":
                if (value is not ("memory" or "disk"))
                {
                    throw new UsageException(
                        $"invalid --mode \"{value}\" — expected \"memory\" or \"disk\"");
                }

                result.Mode = value;
                return;
            default:
                throw new UsageException("unknown option: " + name);
        }
    }

    /// <summary>The clock <c>--now</c> pins, in milliseconds since the epoch.</summary>
    /// <remarks>
    /// The syntax is the date generator's own — whatever <c>&lt;gen type="date" value="…"&gt;</c>
    /// accepts is what this accepts, down to the same parser — so the project has one date syntax
    /// rather than two. It carries no zone, so like every date in the engine it is read as UTC. A
    /// value that does not parse is refused rather than falling back to the real clock, which would
    /// hand back the very irreproducibility the flag exists to remove.
    /// </remarks>
    private static long NowMillis(string value)
    {
        try
        {
            // Fully qualified: System.Globalization is in scope here and also has a Calendar.
            return Tdcv2.Date.Calendar.ToEpochMillis(DateParse.DateTime(value).Value);
        }
        catch (ArgumentException)
        {
            throw new UsageException(
                $"invalid --now \"{value}\" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)");
        }
    }

    private static int NonNegative(string value, string flag)
    {
        int parsed = Integer(value, flag, "a non-negative integer");
        return parsed >= 0
            ? parsed
            : throw new UsageException(
                $"invalid {flag} \"{value}\" — expected a non-negative integer");
    }

    private static int Positive(string value, string flag)
    {
        int parsed = Integer(value, flag, "a positive integer");
        return parsed >= 1
            ? parsed
            : throw new UsageException($"invalid {flag} \"{value}\" — expected a positive integer");
    }

    private static int Integer(string value, string flag, string expected) =>
        int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out int parsed)
            ? parsed
            : throw new UsageException($"invalid {flag} \"{value}\" — expected {expected}");
}
