using System.IO;
using System.Text;
using Tdcv2.Output;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>A run's output reaches its destination whole, or not at all.</summary>
/// <remarks>
/// The shared CLI fixture pins what matters most — a failed run leaves the previous file byte for
/// byte, for text, Parquet and a parallel run. These pin the edges a config cannot reach: a link
/// stays a link, a device is written in place, and disposing without a commit takes the partial
/// file with it.
/// </remarks>
public class AtomicFileTest
{
    private static string Scratch()
    {
        string dir = Path.Combine(Path.GetTempPath(), "tdc-atomic-" + Path.GetRandomFileName());
        Directory.CreateDirectory(dir);
        return dir;
    }

    [Fact]
    public void ReplacesTheDestinationOnlyOnCommit()
    {
        string output = Path.Combine(Scratch(), "out.csv");
        File.WriteAllText(output, "old\n");
        using (AtomicFile file = AtomicFile.Open(output))
        {
            file.Stream.Write(Encoding.UTF8.GetBytes("new\n"));
            Assert.Equal("old\n", File.ReadAllText(output));
            Assert.True(File.Exists(AtomicFile.PartialPath(output)));
            file.Commit();
        }

        Assert.Equal("new\n", File.ReadAllText(output));
        Assert.False(File.Exists(AtomicFile.PartialPath(output)));
    }

    [Fact]
    public void DisposedWithoutACommitLeavesTheDestinationAndNoPartialFile()
    {
        string output = Path.Combine(Scratch(), "out.csv");
        File.WriteAllText(output, "old\n");
        using (AtomicFile file = AtomicFile.Open(output))
        {
            file.Stream.Write(Encoding.UTF8.GetBytes("half of a "));
        }

        Assert.Equal("old\n", File.ReadAllText(output));
        Assert.False(File.Exists(AtomicFile.PartialPath(output)));
    }

    [Fact]
    public void WritesThroughASymbolicLinkWhichStaysALink()
    {
        string dir = Scratch();
        string real = Path.Combine(dir, "real.csv");
        string link = Path.Combine(dir, "link.csv");
        File.WriteAllText(real, "old\n");
        File.CreateSymbolicLink(link, real);
        using (AtomicFile file = AtomicFile.Open(link))
        {
            file.Stream.Write(Encoding.UTF8.GetBytes("new\n"));
            file.Commit();
        }

        Assert.NotNull(new FileInfo(link).LinkTarget);
        Assert.Equal("new\n", File.ReadAllText(real));
    }

    [Fact]
    public void WritesADeviceInPlace()
    {
        using AtomicFile file = AtomicFile.Open("/dev/null");
        file.Stream.WriteByte((byte)'x');
        file.Commit();
    }
}
