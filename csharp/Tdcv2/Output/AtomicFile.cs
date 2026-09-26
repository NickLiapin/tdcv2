using System;
using System.IO;

namespace Tdcv2.Output;

/// <summary>Writing a run's output so a failed run leaves the destination as it found it.</summary>
/// <remarks>
/// The output is written to <c>&lt;path&gt;.partial</c> beside the destination and moved over it
/// only on <see cref="Commit"/>; disposed without a commit, the partial file is removed and the
/// destination is untouched. The move is within one directory, so within one filesystem, and
/// therefore atomic: a reader sees the old file or the new one, never half of either.
/// <para>
/// Measured before this class, on all five implementations: a run that failed with
/// <c>-o out.csv</c> destroyed an existing <c>out.csv</c> — four truncated it to nothing, one
/// deleted it.
/// </para>
/// <para>
/// A symbolic link is resolved first and its TARGET written, so the link stays a link. A device
/// (<c>-o /dev/stdout</c>) cannot be replaced by a move, so it is written directly, by the name it
/// was given — and so is any destination whose directory refuses a file beside it. .NET 6 cannot
/// ask Unix for a file's type, so a device is recognised by living under <c>/dev/</c>; a named pipe
/// elsewhere would be replaced by a regular file, where the reference writes into it.
/// </para>
/// </remarks>
internal sealed class AtomicFile : IDisposable
{
    private readonly string? _temp;
    private readonly string _target;
    private bool _done;

    private AtomicFile(FileStream stream, string? temp, string target)
    {
        Stream = stream;
        _temp = temp;
        _target = target;
    }

    /// <summary>Where the output goes until it is committed.</summary>
    internal FileStream Stream { get; }

    /// <summary>The partial file beside a destination.</summary>
    internal static string PartialPath(string path) => path + ".partial";

    /// <summary>Open <paramref name="path"/> for a run's output.</summary>
    internal static AtomicFile Open(string path)
    {
        string target = Path.GetFullPath(path);
        if (File.Exists(target)
            && new FileInfo(target).ResolveLinkTarget(returnFinalTarget: true) is { } real)
        {
            target = real.FullName;
        }

        bool device = target.StartsWith("/dev/", StringComparison.Ordinal);
        if (!device)
        {
            string temp = PartialPath(target);
            try
            {
                return new AtomicFile(Create(temp), temp, target);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // No file can be made beside it: written in place, below.
            }
        }

        return new AtomicFile(Create(path), null, target);
    }

    /// <summary>The finished output takes the destination's place.</summary>
    internal void Commit()
    {
        Stream.Dispose();
        _done = true;
        if (_temp is not null)
        {
            File.Move(_temp, _target, overwrite: true);
        }
    }

    /// <summary>Without a commit: the partial file goes, and the destination stays as it was.</summary>
    public void Dispose()
    {
        if (_done)
        {
            return;
        }

        _done = true;
        Stream.Dispose();
        if (_temp is not null)
        {
            File.Delete(_temp);
        }
    }

    private static FileStream Create(string path) =>
        new(path, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16);
}
