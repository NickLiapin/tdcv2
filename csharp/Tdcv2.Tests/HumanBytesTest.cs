namespace Tdcv2.Tests;

/// <summary>
/// Sizes people can read.
/// </summary>
/// <remarks>
/// The bug this replaces: <c>pack list</c> divided by 1,048,576 and printed one decimal, so a 3 KB
/// pack and a 9 KB pack both read <c>0.0 MB</c> and the whole catalogue looked like it weighed
/// nothing. These cases pin the boundaries, and the shared CLI fixture pins that all five
/// implementations agree.
/// </remarks>
public class HumanBytesTest
{
    [Fact]
    public void SaysBytesInBytesRatherThanAFractionOfAKilobyte()
    {
        // The case that started this: below a kilobyte there IS no sensible fraction,
        // so the unit has to change instead of the precision.
        Assert.Equal("1 B", HumanBytes.Format(1));
        Assert.Equal("800 B", HumanBytes.Format(800));
        Assert.Equal("1023 B", HumanBytes.Format(1023));
    }

    [Fact]
    public void NeverPrintsZeroPointZeroForAFileThatExists()
    {
        foreach (long n in new long[] { 1, 9, 99, 512, 1024, 2710, 9999 })
        {
            Assert.False(HumanBytes.Format(n).StartsWith("0.0"), n.ToString());
        }
    }

    [Fact]
    public void KeepsADecimalBelowAHundred()
    {
        Assert.Equal("1.0 KB", HumanBytes.Format(1024));
        Assert.Equal("2.6 KB", HumanBytes.Format(2710)); // the smallest shipped pack
        Assert.Equal("10.0 KB", HumanBytes.Format(10_240));
        Assert.Equal("96.7 KB", HumanBytes.Format(99_000));
    }

    [Fact]
    public void DropsTheDecimalAtAHundredWhereItIsNoise()
    {
        Assert.Equal("100 KB", HumanBytes.Format(102_400));
        Assert.Equal("248 KB", HumanBytes.Format(253_515)); // the largest shipped pack
    }

    [Fact]
    public void ClimbsAUnitWhenItShould()
    {
        Assert.Equal("1.0 MB", HumanBytes.Format(1_048_576));
        Assert.Equal("1.5 MB", HumanBytes.Format(1_572_864));
        Assert.Equal("1.0 GB", HumanBytes.Format(1_073_741_824L));
        Assert.Equal("32.0 GB", HumanBytes.Format(34_359_738_368L));
        Assert.Equal("1.0 TB", HumanBytes.Format(1_099_511_627_776L));
    }

    /// <summary>1023.999 KB rounds to a whole 1024 KB, which nobody writes.</summary>
    [Fact]
    public void PromotesRatherThanPrinting1024OfAUnit()
    {
        Assert.Equal("1.0 GB", HumanBytes.Format(1_073_741_823L));
        Assert.Equal("1.0 MB", HumanBytes.Format(1_048_575));
    }

    [Fact]
    public void AnswersANonsenseNumberInsteadOfThrowingAtIt()
    {
        Assert.Equal("0 B", HumanBytes.Format(0));
        Assert.Equal("0 B", HumanBytes.Format(-1));
    }
}
