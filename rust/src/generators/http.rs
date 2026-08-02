//! `<gen type="http" src="https://…">` — values from a service the user runs.
//!
//! The escape hatch. Some values cannot come from a list or a pattern: a real
//! tokeniser, a model, a legacy system that owns the numbering. Rather than grow
//! the DSL until it can express every such thing, a config can point at a
//! service and let it answer.
//!
//! One call carries a whole batch, never one row. That is what keeps a million
//! rows to a handful of requests instead of a million, and it is why the wire
//! format is line-based: the inputs go up one per line and the values come back
//! one per line, in the same order.
//!
//! An http column is **not reproducible** — the service decides the values, and
//! the engine cannot promise what it does not control. What it can do is hand
//! the service what it needs to be reproducible on its own, which is the derived
//! seed below.
//!
//! The call goes out through `curl`, for the same reason `pack` does: the crate
//! takes no dependencies and a TLS stack is not something to hand-write. Unlike
//! `pack` there is no digest to check here, so the service is trusted exactly as
//! far as the config author trusts it — which is the same in every
//! implementation, since all of them simply POST.

use std::collections::BTreeMap;

use crate::engine::{invalid, EngineResult};
use crate::prng;

const DEFAULT_TIMEOUT_MS: i64 = 30_000;

/// What `on_error` may say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnError {
    Fail,
    Empty,
}

/// Run one batch and return exactly `count` values.
///
/// `inputs` is one line per input value in row order, or `None` for a pure
/// source.
pub fn fetch(
    src: &str,
    count: usize,
    inputs: Option<&[String]>,
    seed: Option<&str>,
    on_error: OnError,
    timeout_ms: i64,
) -> EngineResult<Vec<String>> {
    if count == 0 {
        return Ok(Vec::new());
    }

    let body = inputs.map(|lines| lines.join("\n")).unwrap_or_default();
    match post(src, &body, count, seed, timeout_ms) {
        Ok(text) => {
            let lines = split_lines(&text);
            if lines.len() != count {
                return failed(
                    src,
                    &format!("returned {} line(s) for a batch of {count}", lines.len()),
                    count,
                    on_error,
                );
            }
            Ok(lines)
        }
        // "Slow down" and "give me the whole column" cannot both be honoured,
        // and pretending otherwise yields quietly truncated data. This is the
        // one failure `on_error` cannot soften.
        Err(Failure::RateLimited) => invalid(&format!(
            "http service at {src} returned 429 (rate limited)"
        )),
        Err(Failure::Said(why)) => failed(src, &why, count, on_error),
    }
}

/// A failure the caller may or may not be allowed to soften.
enum Failure {
    RateLimited,
    Said(String),
}

fn failed(src: &str, why: &str, count: usize, on_error: OnError) -> EngineResult<Vec<String>> {
    match on_error {
        OnError::Empty => Ok(vec![String::new(); count]),
        OnError::Fail => invalid(&format!("http service at {src} {why}")),
    }
}

/// The reply, tolerating one trailing newline.
fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    text.strip_suffix('\n')
        .unwrap_or(text)
        .split('\n')
        .map(str::to_string)
        .collect()
}

/// One POST, through curl.
///
/// The body goes on stdin rather than as an argument: an input column is the
/// whole run, and a command line has a length limit that a million names would
/// pass long before anything else went wrong.
fn post(
    src: &str,
    body: &str,
    count: usize,
    seed: Option<&str>,
    timeout_ms: i64,
) -> Result<String, Failure> {
    use std::io::Write;

    let seconds = format!("{:.3}", timeout_ms as f64 / 1000.0);
    let mut command = std::process::Command::new("curl");
    command
        .arg("--silent")
        .arg("--show-error")
        // The status is wanted even when it is a failure, so `--fail` is out:
        // 429 has to be told apart from 500, and `--fail` collapses both.
        .arg("--write-out")
        .arg("\n%{http_code}")
        .arg("--max-time")
        .arg(&seconds)
        .arg("--request")
        .arg("POST")
        .arg("--header")
        .arg("Content-Type: text/plain; charset=utf-8")
        .arg("--header")
        .arg(format!("X-TDC-Count: {count}"));
    if let Some(seed) = seed {
        command.arg("--header").arg(format!("X-TDC-Seed: {seed}"));
    }
    command
        .arg("--data-binary")
        .arg("@-")
        .arg("--")
        .arg(src)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            Failure::Said(
                "could not be reached: this build calls a service with `curl`, and there is none \
                 on the PATH"
                    .to_string(),
            )
        } else {
            Failure::Said(format!("could not be reached ({e})"))
        }
    })?;

    if let Some(stdin) = child.stdin.as_mut() {
        // A service that answers before reading the body closes the pipe, which
        // is not an error — it is the reply arriving early.
        let _ = stdin.write_all(body.as_bytes());
    }
    drop(child.stdin.take());

    // The reply is read through a hard cap rather than to the end: the wire
    // contract is one value per line for `count` rows — a bounded, known-small
    // answer — so a body past the cap is a misbehaving service, and reading it
    // out would trade an error message for exhausted memory. The same limit
    // lives in the other four implementations.
    const MAX_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;
    let mut reply = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        use std::io::Read;
        let mut limited = stdout.take(MAX_RESPONSE_BYTES + 1);
        if let Err(e) = limited.read_to_end(&mut reply) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::Said(format!("could not be read ({e})")));
        }
        if reply.len() as u64 > MAX_RESPONSE_BYTES {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Failure::Said(format!(
                "answered with more than {MAX_RESPONSE_BYTES} bytes — not a per-line reply"
            )));
        }
    }

    let done = child
        .wait_with_output()
        .map_err(|e| Failure::Said(format!("could not be reached ({e})")))?;

    if !done.status.success() {
        let said = String::from_utf8_lossy(&done.stderr).trim().to_string();
        // 28 is curl's own code for a timeout, and it is worth naming: a service
        // that is merely slow reads very differently from one that is down.
        if done.status.code() == Some(28) {
            return Err(Failure::Said(format!(
                "did not answer within {timeout_ms}ms"
            )));
        }
        return Err(Failure::Said(if said.is_empty() {
            format!("could not be reached (curl {})", done.status)
        } else {
            format!("could not be reached ({said})")
        }));
    }

    // The status was appended after a newline by `--write-out`.
    let whole = String::from_utf8_lossy(&reply).into_owned();
    let Some(split) = whole.rfind('\n') else {
        return Err(Failure::Said("returned nothing".to_string()));
    };
    let status: i32 = whole[split + 1..].trim().parse().unwrap_or(0);
    let text = whole[..split].to_string();

    if status == 429 {
        return Err(Failure::RateLimited);
    }
    if !(200..300).contains(&status) {
        return Err(Failure::Said(format!("returned {status}")));
    }
    Ok(text)
}

/// The value sent as `X-TDC-Seed`: eight hex digits from the run's seed and the
/// sequence name, through the same hash the engine keys its own streams with.
///
/// Derived per sequence rather than passed through. Two http sequences pointed
/// at one service would otherwise receive the same seed, and a service that
/// generates from it would answer both with an identical column.
pub fn seed_for(env_seed: &str, sequence_name: &str) -> String {
    let a = prng::cyrb128(&format!("{env_seed}|http|{sequence_name}"))[0];
    format!("{:08x}", a as u32)
}

/// `timeout="30"` is thirty seconds. Anything unusable falls back to the default.
pub fn timeout_ms(raw: Option<&str>) -> i64 {
    let Some(raw) = raw else {
        return DEFAULT_TIMEOUT_MS;
    };
    match raw.trim().parse::<f64>() {
        Ok(seconds) if seconds.is_finite() && seconds > 0.0 => (seconds * 1000.0) as i64,
        _ => DEFAULT_TIMEOUT_MS,
    }
}

pub fn on_error(attrs: &BTreeMap<String, String>) -> OnError {
    if attrs.get("on_error").map(String::as_str) == Some("empty") {
        OnError::Empty
    } else {
        OnError::Fail
    }
}
