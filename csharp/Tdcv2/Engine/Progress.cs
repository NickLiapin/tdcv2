namespace Tdcv2.Engine;

/// <summary>
/// What a run says about itself while it is still going.
/// </summary>
/// <remarks>
/// A large run is silent for minutes at a time, and silence reads the same as a hang. This is the
/// channel that tells them apart: it is called as the work advances, about two hundred times per
/// phase, so it must be cheap. Whoever wants it durable — the command line writes a small JSON
/// file — throttles it themselves.
/// <para>
/// The phases, in the order a uniq run passes through them: <c>uniq-scan</c> (every row's tuple
/// hashed into its pile), <c>uniq-sort</c> (the piles sorted), <c>render</c> (rows written). A run
/// without uniqueness only ever reports <c>render</c>.
/// </para>
/// </remarks>
/// <param name="phase">Which of the three phases is running.</param>
/// <param name="done">How much of it is finished.</param>
/// <param name="total">How much there is — <paramref name="done"/> counts up to this.</param>
public delegate void Progress(string phase, int done, int total);
