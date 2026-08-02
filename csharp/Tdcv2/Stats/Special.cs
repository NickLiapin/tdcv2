namespace Tdcv2.Stats;

/// <summary>
/// The special functions gamma and beta sampling need.
/// </summary>
/// <remarks>
/// <para>
/// Neither distribution has a closed-form inverse CDF, but both CDFs can be computed — the
/// regularized lower incomplete gamma and the regularized incomplete beta — and inverting those by
/// bisection gives an exact sampler that spends exactly <b>one</b> uniform draw.
/// </para>
/// <para>
/// That draw count is the whole reason for this file. The obvious way to sample a gamma is
/// rejection sampling, which consumes a variable number of draws, and a variable number of draws
/// makes a row's value depend on every row before it. Fixed draws are what let a row be computed
/// from its index alone, which is what the streaming engines need and what keeps implementations
/// in step.
/// </para>
/// <para>
/// Hand-rolled, in the standard series and continued-fraction forms, because .NET has none of them
/// and a third-party library would be a dependency whose numerical choices this project does not
/// control — and whose last bits would differ from the other three.
/// </para>
/// </remarks>
public static class Special
{
    private const int LanczosG = 7;

    private static readonly double[] LanczosC =
    {
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    };

    private const int MaxIter = 300;
    private const double Eps = 1e-15;
    private const double FpMin = 1e-300;

    /// <summary>2^-100 is far below double precision, so this always converges as far as it can.</summary>
    private const int BisectionIter = 100;

    /// <summary>Natural log of the gamma function, by the Lanczos approximation.</summary>
    public static double LogGamma(double z)
    {
        if (z < 0.5)
        {
            // Reflection, for the left half-plane.
            return Math.Log(Math.PI / Math.Sin(Math.PI * z)) - LogGamma(1 - z);
        }

        double zz = z - 1;
        double x = LanczosC[0];
        for (int i = 1; i < LanczosG + 2; i++)
        {
            x += LanczosC[i] / (zz + i);
        }

        double t = zz + LanczosG + 0.5;
        return (0.5 * Math.Log(2 * Math.PI)) + ((zz + 0.5) * Math.Log(t)) - t + Math.Log(x);
    }

    /// <summary>Regularized lower incomplete gamma <c>P(a,x)</c> — the CDF of gamma(a, 1) at x.</summary>
    public static double GammaP(double a, double x)
    {
        if (x <= 0)
        {
            return 0;
        }

        // The series converges quickly below the mean and the continued fraction above it; each is
        // slow or unstable in the other's territory.
        return x < a + 1 ? GammaSeries(a, x) : 1 - GammaContinuedFraction(a, x);
    }

    private static double GammaSeries(double a, double x)
    {
        double gln = LogGamma(a);
        double ap = a;
        double sum = 1 / a;
        double del = sum;
        for (int n = 0; n < MaxIter; n++)
        {
            ap += 1;
            del *= x / ap;
            sum += del;
            if (Math.Abs(del) < Math.Abs(sum) * Eps)
            {
                break;
            }
        }

        return sum * Math.Exp(-x + (a * Math.Log(x)) - gln);
    }

    /// <summary><c>Q(a,x) = 1 - P(a,x)</c> by continued fraction.</summary>
    private static double GammaContinuedFraction(double a, double x)
    {
        double gln = LogGamma(a);
        double b = x + 1 - a;
        double c = 1 / FpMin;
        double d = 1 / b;
        double h = d;
        for (int i = 1; i < MaxIter; i++)
        {
            double an = -i * (i - a);
            b += 2;
            d = (an * d) + b;
            if (Math.Abs(d) < FpMin)
            {
                d = FpMin;
            }

            c = b + (an / c);
            if (Math.Abs(c) < FpMin)
            {
                c = FpMin;
            }

            d = 1 / d;
            double del = d * c;
            h *= del;
            if (Math.Abs(del - 1) < Eps)
            {
                break;
            }
        }

        return Math.Exp(-x + (a * Math.Log(x)) - gln) * h;
    }

    /// <summary>Regularized incomplete beta <c>I_x(a,b)</c> — the CDF of beta(a,b) at x.</summary>
    public static double BetaI(double x, double a, double b)
    {
        if (x <= 0)
        {
            return 0;
        }

        if (x >= 1)
        {
            return 1;
        }

        double bt = Math.Exp(
            LogGamma(a + b) - LogGamma(a) - LogGamma(b) + (a * Math.Log(x)) + (b * Math.Log(1 - x)));
        if (x < (a + 1) / (a + b + 2))
        {
            return bt * BetaContinuedFraction(a, b, x) / a;
        }

        return 1 - (bt * BetaContinuedFraction(b, a, 1 - x) / b);
    }

    private static double BetaContinuedFraction(double a, double b, double x)
    {
        double qab = a + b;
        double qap = a + 1;
        double qam = a - 1;
        double c = 1;
        double d = 1 - (qab * x / qap);
        if (Math.Abs(d) < FpMin)
        {
            d = FpMin;
        }

        d = 1 / d;
        double h = d;
        for (int m = 1; m < MaxIter; m++)
        {
            int m2 = 2 * m;
            double aa = m * (b - m) * x / ((qam + m2) * (a + m2));
            d = 1 + (aa * d);
            if (Math.Abs(d) < FpMin)
            {
                d = FpMin;
            }

            c = 1 + (aa / c);
            if (Math.Abs(c) < FpMin)
            {
                c = FpMin;
            }

            d = 1 / d;
            h *= d * c;
            aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
            d = 1 + (aa * d);
            if (Math.Abs(d) < FpMin)
            {
                d = FpMin;
            }

            c = 1 + (aa / c);
            if (Math.Abs(c) < FpMin)
            {
                c = FpMin;
            }

            d = 1 / d;
            double del = d * c;
            h *= del;
            if (Math.Abs(del - 1) < Eps)
            {
                break;
            }
        }

        return h;
    }

    /// <summary>The inverse of <see cref="GammaP"/>: the <c>x &gt;= 0</c> where <c>P(a,x) = u</c>.</summary>
    public static double GammaPInv(double a, double u)
    {
        double hi = 1;
        while (GammaP(a, hi) < u && hi < 1e300)
        {
            hi *= 2;
        }

        double lo = 0;
        for (int i = 0; i < BisectionIter; i++)
        {
            double mid = (lo + hi) / 2;
            if (GammaP(a, mid) < u)
            {
                lo = mid;
            }
            else
            {
                hi = mid;
            }
        }

        return (lo + hi) / 2;
    }

    /// <summary>The inverse of <see cref="BetaI"/>: the <c>x</c> in (0,1) where <c>I_x(a,b) = u</c>.</summary>
    public static double BetaIInv(double a, double b, double u)
    {
        double lo = 0;
        double hi = 1;
        for (int i = 0; i < BisectionIter; i++)
        {
            double mid = (lo + hi) / 2;
            if (BetaI(mid, a, b) < u)
            {
                lo = mid;
            }
            else
            {
                hi = mid;
            }
        }

        return (lo + hi) / 2;
    }
}
