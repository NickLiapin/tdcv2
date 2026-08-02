//! Reads a curve out of an SVG file.
//!
//! Somebody draws the shape they want in whatever editor they already have,
//! saves it, and points a config at the file. That is a far shorter path than
//! writing the coordinates out by hand, and it is the reason the pattern
//! generator accepts drawings at all.
//!
//! Not an XML parser: a scan over the tags, tracking the transform stack. Only
//! element names, a handful of attributes and the nesting of `<g>` matter here,
//! and every editor's output differs in ways a strict parser would reject for
//! reasons that have nothing to do with the shape.
//!
//! Every path command is flattened to points, including the arcs and the
//! smooth-curve shorthands. Skipping any of them would silently drop part of a
//! drawing, which is worse than refusing the file: the run would succeed and the
//! data would be the wrong shape.

use crate::engine::{invalid, EngineResult};

/// The top and bottom edges of everything drawn — a band.
pub struct Envelope {
    pub top: Vec<[f64; 2]>,
    pub bottom: Vec<[f64; 2]>,
}

/// A 2×3 affine matrix, in SVG's own order.
type Matrix = [f64; 6];

const IDENTITY: Matrix = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

/// Measure the drawing's highest and lowest point at each position.
///
/// Measured **at the drawn vertices** rather than on a uniform grid. A grid
/// would replace the drawing with a dense straight-line resampling and leave
/// `interp="smooth"` nothing to round off; between two consecutive vertices
/// every shape is a straight segment anyway, so the vertices carry the whole
/// shape.
pub fn envelope(svg: &str, samples: usize) -> EngineResult<Envelope> {
    let curves = collect(svg);
    if curves.is_empty() {
        return invalid(
            "pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from",
        );
    }
    let shapes: Vec<Vec<[f64; 2]>> = curves.iter().map(|c| flip(c)).collect();

    let mut x_min = f64::INFINITY;
    let mut x_max = f64::NEG_INFINITY;
    for shape in &shapes {
        for p in shape {
            x_min = x_min.min(p[0]);
            x_max = x_max.max(p[0]);
        }
    }
    // Written as "not greater" so an empty or NaN extent lands here too, rather
    // than sailing through a comparison that is false either way.
    #[allow(clippy::neg_cmp_op_on_partial_ord)]
    if !(x_max > x_min) {
        return invalid(
            "pattern: the SVG curve has no horizontal extent to stretch over the cards",
        );
    }

    let mut axis: Vec<f64> = shapes.iter().flatten().map(|p| p[0]).collect();
    sort_unique(&mut axis);
    if axis.len() > samples {
        // An absurdly dense input — a huge flattened path — keeps an even subset
        // instead.
        let step = axis.len() as f64 / samples as f64;
        let mut thinned: Vec<f64> = (0..samples)
            .map(|i| axis[(i as f64 * step).floor() as usize])
            .collect();
        thinned.push(x_max);
        sort_unique(&mut thinned);
        axis = thinned;
    }

    let mut top: Vec<[f64; 2]> = Vec::new();
    let mut bottom: Vec<[f64; 2]> = Vec::new();
    for x in axis {
        let mut lo = f64::INFINITY;
        let mut hi = f64::NEG_INFINITY;
        for shape in &shapes {
            for pair in shape.windows(2) {
                let (a, b) = (pair[0], pair[1]);
                if x < a[0].min(b[0]) || x > a[0].max(b[0]) {
                    continue;
                }
                let dx = b[0] - a[0];
                if dx == 0.0 {
                    // A vertical segment covers a whole span of values at this x.
                    lo = lo.min(a[1]).min(b[1]);
                    hi = hi.max(a[1]).max(b[1]);
                } else {
                    let y = a[1] + (x - a[0]) / dx * (b[1] - a[1]);
                    lo = lo.min(y);
                    hi = hi.max(y);
                }
            }
        }
        if lo == f64::INFINITY {
            continue;
        }
        top.push([x, hi]);
        bottom.push([x, lo]);
    }
    if top.len() < 2 {
        return invalid("pattern: the SVG has too little geometry to read a curve from");
    }
    Ok(Envelope { top, bottom })
}

fn sort_unique(values: &mut Vec<f64>) {
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values.dedup();
}

/// SVG grows downward and a graph grows upward, so the vertical axis flips once.
fn flip(points: &[[f64; 2]]) -> Vec<[f64; 2]> {
    points
        .iter()
        .map(|p| [p[0], if p[1] == 0.0 { 0.0 } else { -p[1] }])
        .collect()
}

// ── scanning ─────────────────────────────────────────────────────────────────

fn collect(svg: &str) -> Vec<Vec<[f64; 2]>> {
    let mut found = Vec::new();
    let mut stack: Vec<Matrix> = vec![IDENTITY];

    for tag in scan_tags(svg) {
        let closing = tag.whole.starts_with("</");
        let self_closing = tag.whole.ends_with("/>");
        let top = *stack.last().unwrap_or(&IDENTITY);

        if closing {
            if (tag.name == "g" || tag.name == "svg") && stack.len() > 1 {
                stack.pop();
            }
            continue;
        }

        let local = match attribute(&tag.whole, "transform") {
            None => top,
            Some(raw) => multiply(top, parse_transform(&raw)),
        };

        if tag.name == "g" || tag.name == "svg" {
            if !self_closing {
                stack.push(local);
            }
            continue;
        }

        let raw = match tag.name.as_str() {
            "path" => attribute(&tag.whole, "d").map(|d| flatten_path(&d)),
            "polyline" | "polygon" => attribute(&tag.whole, "points").map(|p| read_points(&p)),
            "line" => match (
                number(attribute(&tag.whole, "x1")),
                number(attribute(&tag.whole, "y1")),
                number(attribute(&tag.whole, "x2")),
                number(attribute(&tag.whole, "y2")),
            ) {
                (Some(x1), Some(y1), Some(x2), Some(y2)) => Some(vec![[x1, y1], [x2, y2]]),
                _ => None,
            },
            _ => None,
        };
        let Some(raw) = raw.filter(|points| points.len() >= 2) else {
            continue;
        };

        found.push(raw.iter().map(|p| apply(local, *p)).collect());
    }
    found
}

struct Tag {
    whole: String,
    name: String,
}

/// Every `<tag …>` in the document, quotes respected.
///
/// A `>` inside an attribute value does not end the tag, which is the one thing
/// a naive split on `<` and `>` gets wrong — and it gets it wrong on exactly the
/// files editors produce.
fn scan_tags(svg: &str) -> Vec<Tag> {
    let ch: Vec<char> = svg.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < ch.len() {
        if ch[i] != '<' {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i + 1;
        if j < ch.len() && ch[j] == '/' {
            j += 1;
        }
        if j >= ch.len() || !ch[j].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        let name_start = j;
        j += 1;
        while j < ch.len()
            && (ch[j].is_ascii_alphanumeric() || ch[j] == '_' || ch[j] == ':' || ch[j] == '-')
        {
            j += 1;
        }
        let name: String = ch[name_start..j].iter().collect();

        let mut closed = false;
        while j < ch.len() {
            match ch[j] {
                '>' => {
                    j += 1;
                    closed = true;
                    break;
                }
                quote @ ('"' | '\'') => {
                    j += 1;
                    while j < ch.len() && ch[j] != quote {
                        j += 1;
                    }
                    if j >= ch.len() {
                        break;
                    }
                    j += 1;
                }
                _ => j += 1,
            }
        }
        if !closed {
            i = start + 1;
            continue;
        }

        out.push(Tag {
            whole: ch[start..j].iter().collect(),
            name: name.to_lowercase(),
        });
        i = j;
    }
    out
}

/// One attribute's value, double quotes first and single quotes after.
fn attribute(tag: &str, name: &str) -> Option<String> {
    quoted(tag, name, '"').or_else(|| quoted(tag, name, '\''))
}

fn quoted(tag: &str, name: &str, quote: char) -> Option<String> {
    let ch: Vec<char> = tag.chars().collect();
    let want: Vec<char> = name.chars().collect();
    let mut i = 0usize;
    while i + want.len() <= ch.len() {
        // A word boundary before the name, so the "d" of "id=" is not the path
        // data.
        let boundary = i == 0 || !(ch[i - 1].is_ascii_alphanumeric() || ch[i - 1] == '_');
        let named = boundary
            && ch[i..i + want.len()]
                .iter()
                .zip(&want)
                .all(|(a, b)| a.eq_ignore_ascii_case(b));
        if named {
            let mut j = i + want.len();
            while j < ch.len() && ch[j].is_whitespace() {
                j += 1;
            }
            if j < ch.len() && ch[j] == '=' {
                j += 1;
                while j < ch.len() && ch[j].is_whitespace() {
                    j += 1;
                }
                if j < ch.len() && ch[j] == quote {
                    let value_start = j + 1;
                    let mut k = value_start;
                    while k < ch.len() && ch[k] != quote {
                        k += 1;
                    }
                    if k < ch.len() {
                        return Some(ch[value_start..k].iter().collect());
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn number(raw: Option<String>) -> Option<f64> {
    raw.and_then(|text| text.trim().parse::<f64>().ok())
        .filter(|v| v.is_finite())
}

fn read_points(raw: &str) -> Vec<[f64; 2]> {
    let nums = numbers_in(raw);
    nums.chunks_exact(2)
        .map(|pair| [pair[0], pair[1]])
        .collect()
}

/// Every number in the text: `-?\d*\.?\d+([eE][+-]?\d+)?`, read by hand.
///
/// Wider than the one the `points=` attribute uses, because a drawing's own
/// coordinates come out of editors as `.5` and `1e3` as readily as `0.5` and
/// `1000`.
fn numbers_in(raw: &str) -> Vec<f64> {
    let ch: Vec<char> = raw.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < ch.len() {
        match number_at(&ch, i) {
            None => i += 1,
            Some((text, next)) => {
                if let Ok(v) = text.parse::<f64>() {
                    out.push(v);
                }
                i = next;
            }
        }
    }
    out
}

/// The number starting at `i`, and where it ends.
fn number_at(ch: &[char], i: usize) -> Option<(String, usize)> {
    let mut j = i;
    if ch.get(j) == Some(&'-') {
        j += 1;
    }
    let digits_start = j;
    while j < ch.len() && ch[j].is_ascii_digit() {
        j += 1;
    }
    let leading = j - digits_start;

    // A dot only belongs to the number when a digit follows it, so "5." reads as
    // 5 and leaves the dot behind — which is what the reference's regex does when
    // it backtracks.
    let mut end = if j < ch.len() && ch[j] == '.' && ch.get(j + 1).is_some_and(char::is_ascii_digit)
    {
        j += 1;
        while j < ch.len() && ch[j].is_ascii_digit() {
            j += 1;
        }
        j
    } else if leading >= 1 {
        j
    } else {
        return None;
    };

    // An exponent only counts when digits actually follow it.
    if end < ch.len() && (ch[end] == 'e' || ch[end] == 'E') {
        let mut k = end + 1;
        if k < ch.len() && (ch[k] == '+' || ch[k] == '-') {
            k += 1;
        }
        if ch.get(k).is_some_and(char::is_ascii_digit) {
            while k < ch.len() && ch[k].is_ascii_digit() {
                k += 1;
            }
            end = k;
        }
    }

    Some((ch[i..end].iter().collect(), end))
}

// ── transforms ───────────────────────────────────────────────────────────────

fn multiply(m: Matrix, n: Matrix) -> Matrix {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

fn apply(m: Matrix, p: [f64; 2]) -> [f64; 2] {
    [
        m[0] * p[0] + m[2] * p[1] + m[4],
        m[1] * p[0] + m[3] * p[1] + m[5],
    ]
}

const TRANSFORMS: [&str; 6] = ["matrix", "translate", "scale", "rotate", "skewX", "skewY"];

fn parse_transform(raw: &str) -> Matrix {
    let ch: Vec<char> = raw.chars().collect();
    let mut m = IDENTITY;
    let mut i = 0usize;
    while i < ch.len() {
        match transform_at(&ch, i) {
            None => i += 1,
            Some((name, args, next)) => {
                m = multiply(m, primitive(name, &args));
                i = next;
            }
        }
    }
    m
}

/// One `name(args)` at this position, if there is one.
fn transform_at(ch: &[char], i: usize) -> Option<(&'static str, Vec<f64>, usize)> {
    for name in TRANSFORMS {
        let letters: Vec<char> = name.chars().collect();
        if i + letters.len() > ch.len() || ch[i..i + letters.len()] != letters[..] {
            continue;
        }
        let mut j = i + letters.len();
        while j < ch.len() && ch[j].is_whitespace() {
            j += 1;
        }
        if ch.get(j) != Some(&'(') {
            continue;
        }
        let body_start = j + 1;
        let mut k = body_start;
        while k < ch.len() && ch[k] != ')' {
            k += 1;
        }
        if k >= ch.len() {
            continue;
        }
        let body: String = ch[body_start..k].iter().collect();
        let args = body
            .split([' ', '\t', '\n', '\r', ','])
            .filter(|piece| !piece.is_empty())
            // A transform nobody can read contributes nothing rather than failing
            // the file.
            .filter_map(|piece| piece.parse::<f64>().ok())
            .collect();
        return Some((name, args, k + 1));
    }
    None
}

fn primitive(name: &str, a: &[f64]) -> Matrix {
    match name {
        "matrix" => [
            arg(a, 0, 1.0),
            arg(a, 1, 0.0),
            arg(a, 2, 0.0),
            arg(a, 3, 1.0),
            arg(a, 4, 0.0),
            arg(a, 5, 0.0),
        ],
        "translate" => [1.0, 0.0, 0.0, 1.0, arg(a, 0, 0.0), arg(a, 1, 0.0)],
        "scale" => {
            let sx = arg(a, 0, 1.0);
            [sx, 0.0, 0.0, arg(a, 1, sx), 0.0, 0.0]
        }
        "rotate" => {
            let rad = arg(a, 0, 0.0).to_radians();
            let rot = [rad.cos(), rad.sin(), -rad.sin(), rad.cos(), 0.0, 0.0];
            if a.len() < 3 {
                return rot;
            }
            let (cx, cy) = (arg(a, 1, 0.0), arg(a, 2, 0.0));
            multiply(
                multiply([1.0, 0.0, 0.0, 1.0, cx, cy], rot),
                [1.0, 0.0, 0.0, 1.0, -cx, -cy],
            )
        }
        "skewX" => [1.0, 0.0, arg(a, 0, 0.0).to_radians().tan(), 1.0, 0.0, 0.0],
        "skewY" => [1.0, arg(a, 0, 0.0).to_radians().tan(), 0.0, 1.0, 0.0, 0.0],
        _ => IDENTITY,
    }
}

fn arg(a: &[f64], i: usize, fallback: f64) -> f64 {
    a.get(i).copied().unwrap_or(fallback)
}

// ── path data ────────────────────────────────────────────────────────────────

const COMMANDS: &str = "MmLlHhVvCcSsQqTtAaZz";

/// Every command of a `d=` attribute, flattened to points.
pub fn flatten_path(d: &str) -> Vec<[f64; 2]> {
    let tk = tokenize(d);

    let mut pts: Vec<[f64; 2]> = Vec::new();
    let mut i = 0usize;
    let mut cur = [0.0, 0.0];
    let mut start = [0.0, 0.0];
    let mut prev_cubic: Option<[f64; 2]> = None;
    let mut prev_quad: Option<[f64; 2]> = None;
    let mut cmd = String::new();

    while i < tk.len() {
        if !tk[i].chars().any(|c| c.is_ascii_alphabetic()) {
            // A bare number repeats the previous command; after an M that means
            // L, per the spec.
            if cmd == "M" {
                cmd = "L".to_string();
            } else if cmd == "m" {
                cmd = "l".to_string();
            }
        } else {
            cmd = tk[i].clone();
            i += 1;
        }
        let rel = cmd == cmd.to_lowercase();
        let bx = if rel { cur[0] } else { 0.0 };
        let by = if rel { cur[1] } else { 0.0 };

        match cmd.to_uppercase().as_str() {
            "M" => {
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                start = p;
                cur = p;
                pts.push(p);
                prev_cubic = None;
                prev_quad = None;
            }
            "L" => {
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                cur = p;
                pts.push(p);
                prev_cubic = None;
                prev_quad = None;
            }
            "H" => {
                let p = [bx + num(&tk, &mut i), cur[1]];
                cur = p;
                pts.push(p);
                prev_cubic = None;
                prev_quad = None;
            }
            "V" => {
                let p = [cur[0], by + num(&tk, &mut i)];
                cur = p;
                pts.push(p);
                prev_cubic = None;
                prev_quad = None;
            }
            "C" => {
                let c1 = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                let c2 = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                pts.extend(cubic(cur, c1, c2, p));
                cur = p;
                prev_cubic = Some(c2);
                prev_quad = None;
            }
            "S" => {
                let c1 = reflect(cur, prev_cubic);
                let c2 = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                pts.extend(cubic(cur, c1, c2, p));
                cur = p;
                prev_cubic = Some(c2);
                prev_quad = None;
            }
            "Q" => {
                let c = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                pts.extend(quad(cur, c, p));
                cur = p;
                prev_quad = Some(c);
                prev_cubic = None;
            }
            "T" => {
                let c = reflect(cur, prev_quad);
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                pts.extend(quad(cur, c, p));
                cur = p;
                prev_quad = Some(c);
                prev_cubic = None;
            }
            "A" => {
                let rx = num(&tk, &mut i);
                let ry = num(&tk, &mut i);
                let rot = num(&tk, &mut i);
                let large = num(&tk, &mut i) != 0.0;
                let sweep = num(&tk, &mut i) != 0.0;
                let p = [bx + num(&tk, &mut i), by + num(&tk, &mut i)];
                pts.extend(arc(cur, rx, ry, rot, large, sweep, p));
                cur = p;
                prev_cubic = None;
                prev_quad = None;
            }
            "Z" => {
                cur = start;
                pts.push(start);
                prev_cubic = None;
                prev_quad = None;
            }
            // An unknown token — skip it rather than spin.
            _ => i += 1,
        }
    }
    pts
}

/// The control point mirrored through the current point, or the current point
/// itself when the previous command was not of the same family.
fn reflect(cur: [f64; 2], prev: Option<[f64; 2]>) -> [f64; 2] {
    match prev {
        None => cur,
        Some(p) => [2.0 * cur[0] - p[0], 2.0 * cur[1] - p[1]],
    }
}

fn tokenize(d: &str) -> Vec<String> {
    let ch: Vec<char> = d.chars().collect();
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < ch.len() {
        if COMMANDS.contains(ch[i]) {
            out.push(ch[i].to_string());
            i += 1;
            continue;
        }
        match number_at(&ch, i) {
            None => i += 1,
            Some((text, next)) => {
                out.push(text);
                i = next;
            }
        }
    }
    out
}

fn num(tk: &[String], i: &mut usize) -> f64 {
    let value = tk
        .get(*i)
        .and_then(|t| t.parse::<f64>().ok())
        .unwrap_or(0.0);
    if *i < tk.len() {
        *i += 1;
    }
    value
}

/// Enough segments to look smooth without turning a short curve into a thousand
/// points.
fn segments_for(pts: &[[f64; 2]]) -> usize {
    let mut len = 0.0;
    for pair in pts.windows(2) {
        len += (pair[1][0] - pair[0][0]).hypot(pair[1][1] - pair[0][1]);
    }
    (len / 3.0).ceil().clamp(4.0, 64.0) as usize
}

fn cubic(p0: [f64; 2], p1: [f64; 2], p2: [f64; 2], p3: [f64; 2]) -> Vec<[f64; 2]> {
    let n = segments_for(&[p0, p1, p2, p3]);
    (1..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            let s = 1.0 - t;
            [
                s * s * s * p0[0]
                    + 3.0 * s * s * t * p1[0]
                    + 3.0 * s * t * t * p2[0]
                    + t * t * t * p3[0],
                s * s * s * p0[1]
                    + 3.0 * s * s * t * p1[1]
                    + 3.0 * s * t * t * p2[1]
                    + t * t * t * p3[1],
            ]
        })
        .collect()
}

/// A quadratic is a cubic with lifted control points.
fn quad(p0: [f64; 2], p1: [f64; 2], p2: [f64; 2]) -> Vec<[f64; 2]> {
    let c1 = [
        p0[0] + 2.0 / 3.0 * (p1[0] - p0[0]),
        p0[1] + 2.0 / 3.0 * (p1[1] - p0[1]),
    ];
    let c2 = [
        p2[0] + 2.0 / 3.0 * (p1[0] - p2[0]),
        p2[1] + 2.0 / 3.0 * (p1[1] - p2[1]),
    ];
    cubic(p0, c1, c2, p2)
}

fn arc(
    p0: [f64; 2],
    rx0: f64,
    ry0: f64,
    rot_deg: f64,
    large_arc: bool,
    sweep: bool,
    p1: [f64; 2],
) -> Vec<[f64; 2]> {
    let mut rx = rx0.abs();
    let mut ry = ry0.abs();
    if rx == 0.0 || ry == 0.0 {
        // Degenerate: the spec says treat it as a straight line.
        return vec![p1];
    }
    let phi = rot_deg.to_radians();
    let (cos_p, sin_p) = (phi.cos(), phi.sin());
    let dx = (p0[0] - p1[0]) / 2.0;
    let dy = (p0[1] - p1[1]) / 2.0;
    let x1 = cos_p * dx + sin_p * dy;
    let y1 = -sin_p * dx + cos_p * dy;

    let lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
    if lam > 1.0 {
        let k = lam.sqrt();
        rx *= k;
        ry *= k;
    }

    let denom = rx * rx * y1 * y1 + ry * ry * x1 * x1;
    let numer = (rx * rx * ry * ry - denom).max(0.0);
    let coef = if large_arc == sweep { -1.0 } else { 1.0 }
        * (if denom == 0.0 { 0.0 } else { numer / denom }).sqrt();
    let cx1 = coef * rx * y1 / ry;
    let cy1 = -coef * ry * x1 / rx;
    let cx = cos_p * cx1 - sin_p * cy1 + (p0[0] + p1[0]) / 2.0;
    let cy = sin_p * cx1 + cos_p * cy1 + (p0[1] + p1[1]) / 2.0;

    let theta = angle(1.0, 0.0, (x1 - cx1) / rx, (y1 - cy1) / ry);
    let mut delta = angle(
        (x1 - cx1) / rx,
        (y1 - cy1) / ry,
        (-x1 - cx1) / rx,
        (-y1 - cy1) / ry,
    );
    if !sweep && delta > 0.0 {
        delta -= 2.0 * std::f64::consts::PI;
    }
    if sweep && delta < 0.0 {
        delta += 2.0 * std::f64::consts::PI;
    }

    let n = (delta.abs() / std::f64::consts::PI * 24.0)
        .ceil()
        .clamp(6.0, 64.0) as usize;
    (1..=n)
        .map(|i| {
            let t = theta + delta * i as f64 / n as f64;
            let ex = rx * t.cos();
            let ey = ry * t.sin();
            [cos_p * ex - sin_p * ey + cx, sin_p * ex + cos_p * ey + cy]
        })
        .collect()
}

fn angle(ux: f64, uy: f64, vx: f64, vy: f64) -> f64 {
    let dot = ux * vx + uy * vy;
    let len = ux.hypot(uy) * vx.hypot(vy);
    let a = (if len == 0.0 { 1.0 } else { dot / len })
        .clamp(-1.0, 1.0)
        .acos();
    if ux * vy - uy * vx < 0.0 {
        -a
    } else {
        a
    }
}
