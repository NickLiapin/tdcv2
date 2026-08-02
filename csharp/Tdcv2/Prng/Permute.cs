namespace Tdcv2.Prng;

/// <summary>
/// A shuffle you can evaluate at one position without performing it.
/// </summary>
/// <remarks>
/// <para>
/// This is what lets an exact quota be resolved row by row. Laying out a <c>percent="20,80"</c> split
/// is easy — twenty per cent of the slots, then eighty — but the result would come out sorted, every
/// <c>A</c> before every <c>B</c>. Shuffling fixes that and normally requires the whole column in
/// memory.
/// </para>
/// <para>
/// A format-preserving permutation removes the requirement: a small Feistel network over the index
/// space is a bijection, so row <c>i</c> can ask which slot it owns and get an answer that is
/// consistent with every other row's answer, without any of them existing.
/// </para>
/// <para>
/// The cycle-walking loop is what keeps it exact for a size that is not a power of two: the network
/// works over a padded domain, and any result past the end is fed back through until it lands
/// inside. It terminates because the network is a bijection on the padded space.
/// </para>
/// </remarks>
public static class Permute
{
    private const int Rounds = 4;

    /// <summary>A key private to one stream, so two columns shuffle independently.</summary>
    public static int Key(string seed, string streamId) =>
        Prng.Cyrb128(seed + "|perm|" + streamId)[0];

    /// <summary>The slot row <paramref name="index"/> owns, among <paramref name="n"/>.</summary>
    public static int Apply(int index, int n, int key)
    {
        if (n <= 1)
        {
            return 0;
        }

        int halfSize = HalfSizeFor(n);
        int x = index;
        do
        {
            x = Forward(x, halfSize, key);
        }
        while (x >= n);

        return x;
    }

    /// <summary>The inverse: which row owns <paramref name="slot"/>.</summary>
    public static int Unapply(int slot, int n, int key)
    {
        if (n <= 1)
        {
            return 0;
        }

        int halfSize = HalfSizeFor(n);
        int x = slot;
        do
        {
            x = Inverse(x, halfSize, key);
        }
        while (x >= n);

        return x;
    }

    /// <summary>The padded domain: two equal halves whose product covers <paramref name="n"/>.</summary>
    private static int HalfSizeFor(int n)
    {
        int bits = Math.Max(2, (int)Math.Ceiling(Math.Log(n) / Math.Log(2)));
        int half = (int)Math.Ceiling(bits / 2.0);
        return 1 << half;
    }

    /// <summary>
    /// The round function.
    /// </summary>
    /// <remarks>
    /// Written with <c>unchecked</c> and <c>uint</c> shifts throughout: the mixing constants
    /// deliberately overflow, and the shift has to be logical, as Java's <c>&gt;&gt;&gt;</c> is. A
    /// signed shift here would give a different permutation and the same seed would land on
    /// different rows.
    /// </remarks>
    private static int RoundFn(int r, int round, int key)
    {
        // Every constant is written as a signed 32-bit pattern rather than left to widen: in C#
        // a literal above int.MaxValue is a uint, and the multiply would silently become 64-bit
        // arithmetic. Java's int math wraps, and this has to wrap identically or the same seed
        // lands on different rows.
        unchecked
        {
            int h = r ^ ((round + 1) * (int)0x9e3779b1);
            h = (h ^ (int)((uint)h >> 16)) * (int)0x85ebca6b;
            h = (h ^ (int)((uint)h >> 13)) * (int)0xc2b2ae35;
            h = (h ^ key) * 0x27d4eb2f;
            return h ^ (int)((uint)h >> 16);
        }
    }

    private static int Forward(int x, int halfSize, int key)
    {
        int left = x / halfSize;
        int right = x % halfSize;
        for (int round = 0; round < Rounds; round++)
        {
            int mixed = (int)((uint)RoundFn(right, round, key) % (uint)halfSize);
            int nextRight = left ^ mixed;
            left = right;
            right = nextRight;
        }

        return (left * halfSize) + right;
    }

    private static int Inverse(int y, int halfSize, int key)
    {
        int left = y / halfSize;
        int right = y % halfSize;
        for (int round = Rounds - 1; round >= 0; round--)
        {
            int prevRight = left;
            int mixed = (int)((uint)RoundFn(prevRight, round, key) % (uint)halfSize);
            int prevLeft = right ^ mixed;
            left = prevLeft;
            right = prevRight;
        }

        return (left * halfSize) + right;
    }
}
