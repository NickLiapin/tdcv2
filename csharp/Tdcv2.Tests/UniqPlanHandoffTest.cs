using Tdcv2.Engine;
using Tdcv2.Model;
using Tdcv2.Packs;
using Tdcv2.Parser;

namespace Tdcv2.Tests;

/// <summary>
/// An env-level <c>&lt;uniq&gt;</c> group splits across workers, and the workers OBEY the
/// arrangement they are handed.
/// </summary>
/// <remarks>
/// Such a config runs on engine 3, which this used to refuse to split at all — so every uniq run
/// was single-threaded here while the reference spread it over the cores. It splits now, and the
/// only thing that makes that safe is that the arrangement is decided ONCE and handed down:
/// deciding which rows a group moves where is a pass over every row, and a worker repeating it
/// would be correct and slow, which is the failure that hides.
/// <para>
/// Hence two directions. With the right arrangement the split run must be byte-identical to the
/// single one. With a deliberately wrong one it must NOT be — a worker that quietly worked the
/// answer out for itself would pass the first check and fail this one.
/// </para>
/// </remarks>
public class UniqPlanHandoffTest
{
    private const string Config =
        "<tdc><env count=\"400\" seed=\"pu\" local=\"en\"><uniq>"
        + "<sequence name=\"A\"><gen type=\"text\" value=\"a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t\"/></sequence>"
        + "<sequence name=\"B\"><gen type=\"number\" value=\"1..40\"/></sequence>"
        + "</uniq></env><block><line><data>${{A}}-${{B}}</data></line></block></tdc>";

    private const long Now = 1_776_945_600_000L;
    private const int Workers = 4;

    [Fact]
    public void FourWorkersWriteWhatOneWritesAndOnlyWhileToldTheTruth()
    {
        string dir = Directory.CreateDirectory(
            Path.Combine(Path.GetTempPath(), "tdc-uniq-plan-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            Config config = ConfigBuilder.Build(TdcParserFacade.Parse(Config).Tree);
            string single = Path.Combine(dir, "one.txt");
            using (var writer = new StreamWriter(single, append: false))
            {
                StreamEngine.RenderRows(
                    config, DataPacks.Discover(), Now, null, writer, 0, 400, null, true);
            }

            var plan = new Dictionary<string, Dictionary<int, List<string>>>(StringComparer.Ordinal);
            StreamEngine.PlanUniq(
                config, DataPacks.Discover(), Now, null, true, null,
                (label, moved) => plan[label] = moved);
            Assert.NotEmpty(plan);

            string many = Path.Combine(dir, "many.txt");
            ParallelWrite.WriteFile(
                config, DataPacks.Discover, Now, null, many, Workers, 400, null, true, given: plan);
            Assert.Equal(File.ReadAllBytes(single), File.ReadAllBytes(many));

            // The same run told something false: every moved row sent to one tuple, which cannot
            // be what the honest analysis produced.
            var forged = new Dictionary<string, Dictionary<int, List<string>>>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, Dictionary<int, List<string>>> entry in plan)
            {
                var moved = new Dictionary<int, List<string>>();
                foreach (int row in entry.Value.Keys)
                {
                    moved[row] = new List<string> { "zzz", "1" };
                }

                forged[entry.Key] = moved;
            }

            string wrong = Path.Combine(dir, "wrong.txt");
            ParallelWrite.WriteFile(
                config, DataPacks.Discover, Now, null, wrong, Workers, 400, null, true, given: forged);
            Assert.NotEqual(File.ReadAllBytes(single), File.ReadAllBytes(wrong));
        }
        finally
        {
            Directory.Delete(dir, recursive: true);
        }
    }
}
