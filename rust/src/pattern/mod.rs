//! `<gen type="pattern" .../>` — data shaped like a drawing.
//!
//! Three ways to read one:
//!
//! * `points="0,0 5,9 10,2"` — a single line, read as a trajectory.
//!   Deterministic: no draw is taken at all, so the column is the same under
//!   every seed.
//! * `upper=` with an optional `lower=` — a band. Each row is a random value
//!   between the two lines, one draw apiece.
//! * `mode="density"` — the same drawing read as a distribution instead.
//!
//! `spread="N"` widens a single line into a tunnel of ±N without drawing its
//! edges by hand, which is the usual way to turn a clean trend into something
//! that looks measured.
//!
//! Like the counters, a signal's value comes from the absolute row index rather
//! than from the row before it.

pub mod curve;
pub mod density;
pub mod png;
pub mod svg;

use std::collections::BTreeMap;

use curve::{Curve, Interp};
use density::Density;
use svg::Envelope;

use crate::engine::{invalid, EngineResult};
use crate::numbers;
use crate::prng::{seekable, Sfc32};

#[derive(Clone, Debug)]
enum Kind {
    Signal(Curve),
    Corridor { lower: Curve, upper: Curve },
    Density(Density),
}

#[derive(Clone, Debug)]
pub struct PatternGen {
    kind: Kind,
    spread: f64,
    decimals: usize,
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    prng: &mut Sfc32,
    base_dir: Option<&str>,
    roots: &[String],
) -> EngineResult<Vec<String>> {
    let gen = PatternGen::of(attrs, base_dir, roots)?;
    let draws = gen.draws();
    // The drawing is stretched over the run: row i reads it at i/(count-1), and
    // one row covers 1/(count-1) of its width.
    let denom = if count > 1 { (count - 1) as f64 } else { 1.0 };
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let u = if draws {
            seekable::open_unit(prng.next())
        } else {
            0.0
        };
        result.push(gen.value_at(i as f64 / denom, u));
    }
    Ok(result)
}

impl PatternGen {
    pub fn of(
        attrs: &BTreeMap<String, String>,
        base_dir: Option<&str>,
        roots: &[String],
    ) -> EngineResult<PatternGen> {
        let get = |name: &str| attrs.get(name).map(String::as_str).unwrap_or("");

        let spread = read_spread(get("spread"))?;
        let decimals = read_decimals(get("decimals"))?;
        let y_range = read_y_range(get("y_range"))?;
        let interp = read_interp(get("interp"))?;

        let upper_raw = get("upper");
        let gen = if !upper_raw.trim().is_empty() {
            let upper_pts = points(upper_raw)?;
            let lower_raw = get("lower");
            let lower_pts = if lower_raw.trim().is_empty() {
                None
            } else {
                Some(points(lower_raw)?)
            };
            corridor(
                &upper_pts,
                lower_pts.as_deref(),
                y_range,
                decimals,
                interp,
                spread,
            )?
        } else {
            let points_raw = get("points");
            if points_raw.trim().is_empty() {
                let src = get("src").trim();
                if src.is_empty() {
                    return invalid("pattern: needs \"points\"/\"src\", or \"upper\"[/\"lower\"]");
                }
                from_file(
                    src,
                    base_dir,
                    roots,
                    get("ink_threshold"),
                    y_range,
                    decimals,
                    interp,
                    spread,
                )?
            } else {
                let c = Curve::of(&points(points_raw)?, y_range, decimals, None, interp)?;
                PatternGen {
                    kind: Kind::Signal(c),
                    spread,
                    decimals,
                }
            }
        };

        if read_mode(get("mode"))? != "density" {
            return Ok(gen);
        }

        if spread > 0.0 {
            return invalid(
                "pattern: \"spread\" has no meaning with mode=\"density\" — the drawing itself \
                 sets the scatter",
            );
        }

        // A band contributes its top edge: the outline is the distribution,
        // whatever its floor does.
        let source = match &gen.kind {
            Kind::Corridor { upper, .. } => upper,
            Kind::Signal(c) => c,
            Kind::Density(_) => unreachable!("density is only built here"),
        };
        Ok(PatternGen {
            kind: Kind::Density(Density::of(source)),
            spread: 0.0,
            decimals,
        })
    }

    /// Whether a row costs a draw: a band, a spread, or a density. A bare line
    /// costs none — which is why a `points=` column is identical under every
    /// seed, and why adding one does not move any column after it.
    pub fn draws(&self) -> bool {
        !matches!(self.kind, Kind::Signal(_)) || self.spread > 0.0
    }

    pub fn value_at(&self, t: f64, u: f64) -> String {
        match &self.kind {
            Kind::Density(d) => {
                // Position in the run means nothing here — the drawing is a
                // distribution, so the row's own draw picks the value and the
                // order comes out random.
                numbers::to_fixed(d.value_at(u), d.decimals())
            }
            Kind::Signal(c) => {
                let v = c.value_at(t);
                let v = if self.spread > 0.0 {
                    v + (2.0 * u - 1.0) * self.spread
                } else {
                    v
                };
                numbers::to_fixed(v, self.decimals)
            }
            Kind::Corridor { lower, upper } => {
                let a = lower.value_at(t);
                let b = upper.value_at(t);
                let low = a.min(b) - self.spread;
                let high = a.max(b) + self.spread;
                numbers::to_fixed(low + u * (high - low), self.decimals)
            }
        }
    }
}

/// A drawing on disk: a picture, or a vector file.
///
/// Both are measured the same way — highest and lowest ink at each position — so
/// one stroke gives an exact curve and two strokes, or a closed outline, give a
/// band. A file may switch between the two along its own length, and a sketch
/// usually does.
#[allow(clippy::too_many_arguments)]
fn from_file(
    src: &str,
    base_dir: Option<&str>,
    roots: &[String],
    ink_threshold: &str,
    y_range: Option<[f64; 2]>,
    decimals: usize,
    interp: Interp,
    spread: f64,
) -> EngineResult<PatternGen> {
    // The same resolution a file source gets, so a drawing may live in a data
    // folder too.
    let path = crate::generators::file::resolve(src, base_dir, roots)?;
    let Ok(bytes) = std::fs::read(&path) else {
        return invalid(&format!("pattern: cannot read \"{src}\""));
    };

    if png::is_png(&bytes) {
        let image = png::decode(&bytes)?;
        let traced = png::trace(&image, read_ink_threshold(ink_threshold)?)?;
        // The frame is the value scale: the picture's own height is what 0..max
        // means.
        let extent = [0.0, (image.height as f64) - 1.0];
        return from_envelope(&traced, y_range, decimals, interp, spread, Some(extent));
    }

    let text = String::from_utf8_lossy(&bytes);
    let envelope = svg::envelope(&text, 600)?;
    from_envelope(&envelope, y_range, decimals, interp, spread, None)
}

/// A traced envelope becomes a plain line when its two edges coincide, and a band
/// otherwise.
fn from_envelope(
    envelope: &Envelope,
    y_range: Option<[f64; 2]>,
    decimals: usize,
    interp: Interp,
    spread: f64,
    norm_extent: Option<[f64; 2]>,
) -> EngineResult<PatternGen> {
    let top = &envelope.top;
    let bottom = &envelope.bottom;

    let banded = top
        .iter()
        .zip(bottom)
        .any(|(a, b)| (a[1] - b[1]).abs() > 1e-9);
    if !banded {
        return Ok(PatternGen {
            kind: Kind::Signal(Curve::of(top, y_range, decimals, norm_extent, interp)?),
            spread,
            decimals,
        });
    }

    let heights = top.iter().chain(bottom).map(|p| p[1]);
    // ONE canvas for both curves. Measuring them separately would let each fill
    // the range on its own, so a narrow band and a wide one would come out the
    // same width and the corridor would stop meaning anything.
    let extent = norm_extent.unwrap_or_else(|| {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for y in heights {
            lo = lo.min(y);
            hi = hi.max(y);
        }
        [lo, hi]
    });

    Ok(PatternGen {
        kind: Kind::Corridor {
            lower: Curve::of(bottom, y_range, decimals, Some(extent), interp)?,
            upper: Curve::of(top, y_range, decimals, Some(extent), interp)?,
        },
        spread,
        decimals,
    })
}

/// `ink_threshold` — how dark counts as a line, on an opaque background.
fn read_ink_threshold(raw: &str) -> EngineResult<f64> {
    if raw.trim().is_empty() {
        return Ok(0.5);
    }
    match raw.trim().parse::<f64>() {
        Ok(t) if t.is_finite() && t > 0.0 && t < 1.0 => Ok(t),
        _ => invalid("pattern: \"ink_threshold\" must be a number strictly between 0 and 1"),
    }
}

/// A corridor: two lines in one value space.
///
/// Both are normalized against their *shared* height extent, so the band between
/// them means something. Normalizing each against its own extent would stretch
/// them to the same height and collapse the corridor.
fn corridor(
    upper_pts: &[[f64; 2]],
    lower_pts: Option<&[[f64; 2]]>,
    y_range: Option<[f64; 2]>,
    decimals: usize,
    interp: Interp,
    spread: f64,
) -> EngineResult<PatternGen> {
    let mut heights: Vec<f64> = upper_pts.iter().map(|p| p[1]).collect();
    match lower_pts {
        Some(pts) => heights.extend(pts.iter().map(|p| p[1])),
        // No lower line means a flat floor at zero, which belongs in the shared
        // extent.
        None => heights.push(0.0),
    }

    let lo = heights.iter().copied().fold(f64::INFINITY, f64::min);
    let hi = heights.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let extent = [lo, hi];

    let upper = Curve::of(upper_pts, y_range, decimals, Some(extent), interp)?;
    let lower = match lower_pts {
        Some(pts) => Curve::of(pts, y_range, decimals, Some(extent), interp)?,
        None => {
            let x0 = upper_pts[0][0];
            let xn = upper_pts[upper_pts.len() - 1][0];
            Curve::of(
                &[[x0, lo], [xn, lo]],
                y_range,
                decimals,
                Some(extent),
                interp,
            )?
        }
    };

    Ok(PatternGen {
        kind: Kind::Corridor { lower, upper },
        spread,
        decimals,
    })
}

// ── attributes ───────────────────────────────────────────────────────────────

/// Every number in the text, in pairs. Whatever separates them is decoration.
///
/// The reference finds them with `-?\d+(\.\d+)?([eE][+-]?\d+)?`; this scans for
/// the same shape, so `0,0 5,9` and `0 0 5 9` and `[[0,0],[5,9]]` all read the
/// same — which is what lets a config paste coordinates from wherever it has
/// them.
pub fn points(raw: &str) -> EngineResult<Vec<[f64; 2]>> {
    let nums = numbers_in(raw);
    if nums.is_empty() || nums.len() % 2 != 0 {
        return invalid(&format!(
            "pattern: points must be an even list of \"x,y\" coordinates (got {} numbers)",
            nums.len()
        ));
    }
    Ok(nums.chunks(2).map(|pair| [pair[0], pair[1]]).collect())
}

fn numbers_in(raw: &str) -> Vec<f64> {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        let start = i;
        if chars[i] == '-' {
            i += 1;
        }
        let digits_start = i;
        while i < chars.len() && chars[i].is_ascii_digit() {
            i += 1;
        }
        if i == digits_start {
            // No digits after an optional sign: not a number, step over one
            // character and carry on.
            i = start + 1;
            continue;
        }
        if i < chars.len() && chars[i] == '.' && chars.get(i + 1).is_some_and(char::is_ascii_digit)
        {
            i += 1;
            while i < chars.len() && chars[i].is_ascii_digit() {
                i += 1;
            }
        }
        // An exponent only counts when digits actually follow it, so the `e` in
        // a stray word is not swallowed into the number before it.
        if i < chars.len() && (chars[i] == 'e' || chars[i] == 'E') {
            let mut j = i + 1;
            if j < chars.len() && (chars[j] == '+' || chars[j] == '-') {
                j += 1;
            }
            if chars.get(j).is_some_and(char::is_ascii_digit) {
                while j < chars.len() && chars[j].is_ascii_digit() {
                    j += 1;
                }
                i = j;
            }
        }
        let text: String = chars[start..i].iter().collect();
        if let Ok(n) = text.parse::<f64>() {
            out.push(n);
        }
    }
    out
}

/// `y_range="min..max"` — the value axis, and REQUIRED.
///
/// A drawing carries no units of its own: a curve exported from one tool runs
/// 0..100, from another 0..480, from a third 0..10002345345. `y_range` is what
/// those coordinates mean, so without it there is nothing to bring the picture
/// into and every answer would be a guess about somebody's export settings.
pub fn read_y_range(raw: &str) -> EngineResult<Option<[f64; 2]>> {
    if raw.trim().is_empty() {
        return invalid(
            "pattern: y_range is required — it is the value axis a drawing is brought into, \
             and a drawing has no scale of its own. Write y_range=\"0..100\".",
        );
    }
    let parts: Vec<&str> = raw.split("..").collect();
    if parts.len() != 2 {
        return invalid(&format!(
            "pattern: y_range \"{raw}\" must be \"min..max\" with two numbers"
        ));
    }
    match (
        parts[0].trim().parse::<f64>(),
        parts[1].trim().parse::<f64>(),
    ) {
        (Ok(a), Ok(b)) if a.is_finite() && b.is_finite() => Ok(Some([a, b])),
        _ => invalid(&format!(
            "pattern: y_range \"{raw}\" must be \"min..max\" with two numbers"
        )),
    }
}

pub fn read_interp(raw: &str) -> EngineResult<Interp> {
    if raw.trim().is_empty() {
        return Ok(Interp::Linear);
    }
    match raw.trim().to_lowercase().as_str() {
        "linear" => Ok(Interp::Linear),
        "smooth" => Ok(Interp::Smooth),
        "step" => Ok(Interp::Step),
        _ => invalid("pattern: \"interp\" must be \"linear\", \"smooth\" or \"step\""),
    }
}

pub fn read_mode(raw: &str) -> EngineResult<String> {
    if raw.trim().is_empty() {
        return Ok("signal".to_string());
    }
    let v = raw.trim().to_lowercase();
    if v != "signal" && v != "density" {
        return invalid(
            "pattern: \"mode\" must be \"signal\" (a trajectory) or \"density\" (a distribution)",
        );
    }
    Ok(v)
}

pub fn read_spread(raw: &str) -> EngineResult<f64> {
    if raw.trim().is_empty() {
        return Ok(0.0);
    }
    match raw.trim().parse::<f64>() {
        Ok(s) if s.is_finite() && s >= 0.0 => Ok(s),
        _ => invalid("pattern: \"spread\" must be a non-negative number"),
    }
}

pub fn read_decimals(raw: &str) -> EngineResult<usize> {
    if raw.trim().is_empty() {
        return Ok(0);
    }
    match raw.trim().parse::<i32>() {
        Ok(d) if d >= 0 => Ok(d as usize),
        _ => invalid("pattern: \"decimals\" must be a non-negative integer"),
    }
}
