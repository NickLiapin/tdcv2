package io.github.nickliapin.tdc.stats;

/**
 * The special functions gamma and beta sampling need.
 *
 * <p>Neither distribution has a closed-form inverse CDF, but both CDFs can be computed — the
 * regularized lower incomplete gamma and the regularized incomplete beta — and inverting those by
 * bisection gives an exact sampler that spends exactly <b>one</b> uniform draw.
 *
 * <p>That draw count is the whole reason for this file. The obvious way to sample a gamma is
 * rejection sampling, which consumes a variable number of draws, and a variable number of draws
 * makes a row's value depend on every row before it. Fixed draws are what let a row be computed
 * from its index alone, which is what the streaming engines need and what keeps two
 * implementations in step.
 *
 * <p>Hand-rolled, in the standard series and continued-fraction forms, because the JDK has none
 * of them and a third-party library would be a dependency whose numerical choices this project
 * does not control.
 */
public final class Special {

  private static final int LANCZOS_G = 7;
  private static final double[] LANCZOS_C = {
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

  private static final int MAX_ITER = 300;
  private static final double EPS = 1e-15;
  private static final double FPMIN = 1e-300;
  /** 2^-100 is far below double precision, so this always converges as far as it can. */
  private static final int BISECTION_ITER = 100;

  private Special() {}

  /** Natural log of the gamma function, by the Lanczos approximation. */
  public static double lgamma(double z) {
    if (z < 0.5) {
      // Reflection, for the left half-plane.
      return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    }
    double zz = z - 1;
    double x = LANCZOS_C[0];
    for (int i = 1; i < LANCZOS_G + 2; i++) {
      x += LANCZOS_C[i] / (zz + i);
    }
    double t = zz + LANCZOS_G + 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
  }

  /** Regularized lower incomplete gamma {@code P(a,x)} — the CDF of gamma(a, 1) at x. */
  public static double gammaP(double a, double x) {
    if (x <= 0) {
      return 0;
    }
    // The series converges quickly below the mean and the continued fraction above it; each is
    // slow or unstable in the other's territory.
    return x < a + 1 ? gammaSeries(a, x) : 1 - gammaContinuedFraction(a, x);
  }

  private static double gammaSeries(double a, double x) {
    double gln = lgamma(a);
    double ap = a;
    double sum = 1 / a;
    double del = sum;
    for (int n = 0; n < MAX_ITER; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * EPS) {
        break;
      }
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }

  /** {@code Q(a,x) = 1 - P(a,x)} by continued fraction. */
  private static double gammaContinuedFraction(double a, double x) {
    double gln = lgamma(a);
    double b = x + 1 - a;
    double c = 1 / FPMIN;
    double d = 1 / b;
    double h = d;
    for (int i = 1; i < MAX_ITER; i++) {
      double an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < FPMIN) {
        d = FPMIN;
      }
      c = b + an / c;
      if (Math.abs(c) < FPMIN) {
        c = FPMIN;
      }
      d = 1 / d;
      double del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) {
        break;
      }
    }
    return Math.exp(-x + a * Math.log(x) - gln) * h;
  }

  /** Regularized incomplete beta {@code I_x(a,b)} — the CDF of beta(a,b) at x. */
  public static double betaI(double x, double a, double b) {
    if (x <= 0) {
      return 0;
    }
    if (x >= 1) {
      return 1;
    }
    double bt =
        Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    if (x < (a + 1) / (a + b + 2)) {
      return bt * betaContinuedFraction(a, b, x) / a;
    }
    return 1 - bt * betaContinuedFraction(b, a, 1 - x) / b;
  }

  private static double betaContinuedFraction(double a, double b, double x) {
    double qab = a + b;
    double qap = a + 1;
    double qam = a - 1;
    double c = 1;
    double d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) {
      d = FPMIN;
    }
    d = 1 / d;
    double h = d;
    for (int m = 1; m < MAX_ITER; m++) {
      int m2 = 2 * m;
      double aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) {
        d = FPMIN;
      }
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) {
        c = FPMIN;
      }
      d = 1 / d;
      h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d;
      if (Math.abs(d) < FPMIN) {
        d = FPMIN;
      }
      c = 1 + aa / c;
      if (Math.abs(c) < FPMIN) {
        c = FPMIN;
      }
      d = 1 / d;
      double del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) {
        break;
      }
    }
    return h;
  }

  /** The inverse of {@link #gammaP}: the {@code x >= 0} where {@code P(a,x) = u}. */
  public static double gammaPInv(double a, double u) {
    double hi = 1;
    while (gammaP(a, hi) < u && hi < 1e300) {
      hi *= 2;
    }
    double lo = 0;
    for (int i = 0; i < BISECTION_ITER; i++) {
      double mid = (lo + hi) / 2;
      if (gammaP(a, mid) < u) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  }

  /** The inverse of {@link #betaI}: the {@code x} in (0,1) where {@code I_x(a,b) = u}. */
  public static double betaIInv(double a, double b, double u) {
    double lo = 0;
    double hi = 1;
    for (int i = 0; i < BISECTION_ITER; i++) {
      double mid = (lo + hi) / 2;
      if (betaI(mid, a, b) < u) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return (lo + hi) / 2;
  }
}
