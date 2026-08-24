using System;
using System.Collections.Generic;
using System.Linq;
using Tdcv2;
using Tdcv2.Engine;
using Xunit;

namespace Tdcv2.Tests;

/// <summary>
/// The <c>--progress</c> channel: what a watcher is promised about the numbers it is given.
/// </summary>
public class ProgressTest
{
    /// <summary>One report, as it reaches a listener.</summary>
    private readonly record struct Tick(string Phase, int Done, int Total);

    /// <summary>400 rows drawn from 480 pairs, so the repair is certain to run and to report.</summary>
    private static string UniqConfig()
    {
        string names = string.Join(",", Enumerable.Range(0, 40).Select(i => "a" + i));
        return "<tdc><env count=\"400\" seed=\"p\" local=\"en\" mode=\"disk\"><uniq>"
            + "<sequence name=\"A\"><gen type=\"text\" value=\"" + names + "\"/></sequence>"
            + "<sequence name=\"B\"><gen type=\"text\" value=\"m,n,o,p,q,r,s,t,u,v,w,x\"/></sequence>"
            + "</uniq></env><block><line><data>${{A}}-${{B}}</data></line></block></tdc>";
    }

    private static List<Tick> Ticks()
    {
        var seen = new List<Tick>();
        _ = new Tdc(new Tdc.Options
        {
            ConfigString = UniqConfig(),
            OnProgress = (phase, done, total) => seen.Add(new Tick(phase, done, total)),
        }).ToString();
        return seen;
    }

    [Fact]
    public void TheRepairReportsAndTheRenderFollowsIt()
    {
        var order = new List<string>();
        foreach (Tick tick in Ticks())
        {
            if (order.Count == 0 || order[^1] != tick.Phase)
            {
                order.Add(tick.Phase);
            }
        }

        Assert.Equal(new[] { "uniq-repair", "render" }, order);
    }

    /// <summary>
    /// What a progress bar needs. The repair is several steps with different units — pool rows,
    /// then a deal per sweep — reported on ONE rising scale for exactly this reason. Reported
    /// straight, the counter would restart at every step and the bar would jump backwards, which
    /// reads as a bug rather than as progress.
    /// </summary>
    [Fact]
    public void WithinAPhaseNeitherTheCountNorTheScaleGoesBackwards()
    {
        List<Tick> ticks = Ticks();
        foreach (string phase in new[] { "uniq-repair", "render" })
        {
            List<Tick> of = ticks.Where(t => t.Phase == phase).ToList();
            Assert.True(of.Count > 1, phase + " reported once or not at all");
            for (int i = 1; i < of.Count; i++)
            {
                Assert.True(of[i].Done >= of[i - 1].Done, phase + " count fell");
                Assert.True(of[i].Total >= of[i - 1].Total, phase + " scale shrank");
                Assert.True(of[i].Done <= of[i].Total, phase + " ran past its scale");
            }
        }
    }

    [Fact]
    public void APhaseEndsAtItsTotalSoAWatcherCanTellItFromAStall()
    {
        List<Tick> ticks = Ticks();
        foreach (string phase in new[] { "uniq-repair", "render" })
        {
            Tick last = ticks.Where(t => t.Phase == phase).Last();
            Assert.Equal(last.Total, last.Done);
        }
    }

    /// <summary>
    /// The scale itself, tested where it is written: a new step lifts the floor instead of
    /// resetting it, and the phase closes full.
    /// </summary>
    [Fact]
    public void ANewStepLiftsTheFloorInsteadOfResettingIt()
    {
        var seen = new List<Tick>();
        var report = new ExactUniq.RepairReport((phase, done, total) => seen.Add(new Tick(phase, done, total)));

        report.Step(3);
        report.At(1);
        report.At(2);
        report.Step(5);
        report.At(1);
        report.Finish();

        Assert.Equal(
            new[]
            {
                new Tick("uniq-repair", 0, 3), // three units taken on
                new Tick("uniq-repair", 1, 3),
                new Tick("uniq-repair", 2, 3),
                new Tick("uniq-repair", 3, 8), // the first step is behind us, five more taken on
                new Tick("uniq-repair", 4, 8),
                new Tick("uniq-repair", 8, 8), // closed full
            },
            seen);
    }

    [Fact]
    public void NoListenerNoWork()
    {
        var report = new ExactUniq.RepairReport(null);
        report.Step(2);
        report.At(1);
        report.Finish();
    }
}
