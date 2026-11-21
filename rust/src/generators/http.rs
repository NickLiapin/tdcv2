//! `<gen type="http" src="https://…">` — values from a service the user runs.
//!
//! The escape hatch. Some values cannot come from a list or a pattern: a real
//! tokeniser, a model, a legacy system that owns the numbering. Rather than grow
//! the DSL until it can express every such thing, a config can point at a
//! service and let it answer.
//!
//! One call carries one batch — never one row, and never the whole column: that
//! keeps a billion rows to a hundred thousand requests instead of a billion, and
//! any one reply small enough to hold. `http_column` cuts a column into batches.
//! The wire format is line-based: the inputs go up one per line and the values
//! come back one per line, in the same order.
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

use crate::prng;

use super::http_target::{http_target, HTTP_METHOD};

const DEFAULT_TIMEOUT_MS: i64 = 30_000;

/// What `on_error` may say.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnError {
    Fail,
    Empty,
}

/// One batch of a column, fully described.
pub struct Batch<'a> {
    pub src: &'a str,
    /// How many values are wanted — `X-TDC-Count`.
    pub count: usize,
    /// The row of the column the batch starts at — `X-TDC-Offset`. A service that
    /// invents values from `(seed, row)` needs it, or every batch would repeat the
    /// first.
    pub offset: usize,
    /// Rows in the whole column — `X-TDC-Total`.
    pub total: usize,
    /// One line per input value in row order, or `None` for a pure source.
    pub inputs: Option<&'a [String]>,
    pub seed: Option<&'a str>,
    pub on_error: OnError,
    pub timeout_ms: i64,
    /// The already-resolved `secret=`, if the config carries one. Present means
    /// the request is SIGNED — the secret itself never goes on the wire.
    pub secret: Option<&'a str>,
}

/// Why a batch failed, in the words that follow the service's address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failed {
    pub why: String,
}

/// Run one batch and return exactly `count` values.
///
/// `on_error="empty"` turns a failure into blanks — except 429 and an ignored
/// offset, which fail under both: "slow down" cannot be reconciled with "fill
/// the column", and a source repeating its first batch is a broken contract, not
/// a bad moment.
pub fn fetch(batch: &Batch) -> Result<Vec<String>, Failed> {
    let count = batch.count;
    if count == 0 {
        return Ok(Vec::new());
    }

    let body = batch
        .inputs
        .map(|lines| lines.join("\n"))
        .unwrap_or_default();
    match post(batch, &body) {
        Ok((text, echoed)) => {
            // A source cut into batches: the service has to show it read the
            // offset, or the second batch would be the first one again. A
            // transform needs no echo — each answer comes from its own input.
            if batch.inputs.is_none() && batch.total > count {
                let offset = batch.offset.to_string();
                if echoed.as_deref() != Some(offset.as_str()) {
                    return Err(Failed {
                        why: match echoed {
                            None => format!(
                                "answered the batch at row {offset} without echoing X-TDC-Offset \
                                 — a service with no in= column must read the offset and send it \
                                 back, or every batch would repeat the first"
                            ),
                            Some(other) => format!(
                                "answered the batch at row {offset} with X-TDC-Offset {other}"
                            ),
                        },
                    });
                }
            }
            let lines = split_lines(&text);
            if lines.len() != count {
                return failed(
                    &format!("returned {} line(s) for a batch of {count}", lines.len()),
                    count,
                    batch.on_error,
                );
            }
            Ok(lines)
        }
        // "Slow down" and "give me the whole column" cannot both be honoured,
        // and pretending otherwise yields quietly truncated data. This is the
        // one failure `on_error` cannot soften.
        Err(Failure::RateLimited) => Err(Failed {
            why: "returned 429 (rate limited)".to_string(),
        }),
        Err(Failure::Said(why)) => failed(&why, count, batch.on_error),
    }
}

/// `hex(HMAC-SHA256(secret, method \n target \n timestamp \n seed \n count \n offset \n total \n body))`.
///
/// Everything that decides what comes back is inside: change the address, the
/// body, the count, the place in the column, the seed or the minute, and the
/// signature no longer matches — so a captured batch cannot be replayed as
/// another one, nor sent to another address of the same service. `target` is the
/// path and query exactly as they went on the request line (see
/// `http_target.rs`); the host and port are not in it, because proxies and port
/// forwarding change them on the way. The secret is the key, so it is never sent
/// — which is what makes this safe over plain http on a trusted network, and what
/// makes a captured request useless tomorrow once the service checks the
/// timestamp.
#[allow(clippy::too_many_arguments)]
pub fn sign_request(
    secret: &str,
    method: &str,
    target: &str,
    timestamp: &str,
    seed: &str,
    count: usize,
    offset: usize,
    total: usize,
    body: &str,
) -> String {
    let message =
        format!("{method}\n{target}\n{timestamp}\n{seed}\n{count}\n{offset}\n{total}\n{body}");
    crate::archive::sha256::hmac_hex(secret.as_bytes(), message.as_bytes())
}

/// The headers that say what this request IS, beyond its body, in the order
/// they go out.
///
/// `X-TDC-Input` closes an ambiguity the body alone cannot: `in=` naming a
/// column of one empty value sends an empty body, byte for byte what a pure
/// source sends, and the service invented a value where it had been asked to
/// process one. Absent keeps the old reading, so a service written before this
/// header is unaffected.
///
/// `now_seconds` is stamped into the signature; [`fetch`] passes the real clock,
/// and a test can pin it.
pub fn contract_headers(
    batch: &Batch,
    body: &str,
    now_seconds: u64,
) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        // Bare, without a charset: the four other implementations send exactly this, and a
        // service matching the header would have rejected the longer form.
        ("Content-Type", "text/plain".to_string()),
        ("X-TDC-Count", batch.count.to_string()),
        ("X-TDC-Offset", batch.offset.to_string()),
        ("X-TDC-Total", batch.total.to_string()),
    ];
    if let Some(seed) = batch.seed {
        headers.push(("X-TDC-Seed", seed.to_string()));
    }
    if let Some(lines) = batch.inputs {
        headers.push(("X-TDC-Input", lines.len().to_string()));
    }
    if let Some(secret) = batch.secret.filter(|s| !s.is_empty()) {
        let timestamp = now_seconds.to_string();
        let signature = sign_request(
            secret,
            HTTP_METHOD,
            &http_target(batch.src).target,
            &timestamp,
            batch.seed.unwrap_or(""),
            batch.count,
            batch.offset,
            batch.total,
            body,
        );
        headers.push(("X-TDC-Timestamp", timestamp));
        headers.push(("X-TDC-Signature", signature));
    }
    headers
}

/// The REAL clock, not the run's pinned `now`: the timestamp exists so a service
/// can refuse a request replayed tomorrow, and a config pinned to last year
/// would otherwise be refused by every service that checks.
fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// A failure the caller may or may not be allowed to soften.
enum Failure {
    RateLimited,
    Said(String),
}

fn failed(why: &str, count: usize, on_error: OnError) -> Result<Vec<String>, Failed> {
    match on_error {
        OnError::Empty => Ok(vec![String::new(); count]),
        OnError::Fail => Err(Failed {
            why: why.to_string(),
        }),
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

/// The curl invocation for one batch, everything but the body.
///
/// The URL is the one rebuilt around the signed target, never `src` as written:
/// curl sends a target already in that form untouched, while `src` itself could
/// reach the service as another path — and then fail a signature the service
/// checks against the path it actually received.
fn curl_command(batch: &Batch, body: &str, now_seconds: u64) -> std::process::Command {
    let seconds = format!("{:.3}", batch.timeout_ms as f64 / 1000.0);
    let mut command = std::process::Command::new("curl");
    command
        .arg("--silent")
        .arg("--show-error")
        // The status is wanted even when it is a failure, so `--fail` is out:
        // 429 has to be told apart from 500, and `--fail` collapses both. The
        // echoed offset rides on the same last line, empty when not sent.
        .arg("--write-out")
        .arg("\n%{http_code} %header{x-tdc-offset}")
        .arg("--max-time")
        .arg(&seconds)
        .arg("--request")
        .arg(HTTP_METHOD);
    for (name, value) in contract_headers(batch, body, now_seconds) {
        command.arg("--header").arg(format!("{name}: {value}"));
    }
    command
        .arg("--data-binary")
        .arg("@-")
        .arg("--")
        .arg(http_target(batch.src).url);
    command
}

/// One POST, through curl.
///
/// The body goes on stdin rather than as an argument: an input column is the
/// whole run, and a command line has a length limit that a million names would
/// pass long before anything else went wrong.
fn post(batch: &Batch, body: &str) -> Result<(String, Option<String>), Failure> {
    use std::io::Write;

    let timeout_ms = batch.timeout_ms;
    let mut command = curl_command(batch, body, now_seconds());
    command
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

    // The status and the echoed offset were appended after a newline by `--write-out`.
    let whole = String::from_utf8_lossy(&reply).into_owned();
    let Some(split) = whole.rfind('\n') else {
        return Err(Failure::Said("returned nothing".to_string()));
    };
    let mut tail = whole[split + 1..].split_whitespace();
    let status: i32 = tail.next().and_then(|s| s.parse().ok()).unwrap_or(0);
    let echoed = tail.next().map(str::to_string);
    let text = whole[..split].to_string();

    if status == 429 {
        return Err(Failure::RateLimited);
    }
    if !(200..300).contains(&status) {
        return Err(Failure::Said(format!("returned {status}")));
    }
    Ok((text, echoed))
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

/// `secret="…"` → the bytes to sign with.
///
/// The secret is the one thing in a run that must not travel: it never goes on
/// the wire (only a signature derived from it does) and it should not travel
/// into version control either, which is what a config does. So the two
/// spellings that keep it out of the file come first, and the literal is
/// accepted — with TDC284 saying why it is a poor idea — rather than refused,
/// because a service on 127.0.0.1 for an afternoon is a real use.
///
/// An empty secret is refused wherever it came from: signing with nothing
/// produces a signature every caller could forge, which is worse than not
/// signing at all.
pub fn resolve_secret(spec: &str, base_dir: &std::path::Path) -> Result<String, String> {
    let trimmed = spec.trim();
    if let Some(name) = trimmed.strip_prefix("env:") {
        let name = name.trim();
        if name.is_empty() {
            return Err("secret=\"env:\" names no variable".to_string());
        }
        return match std::env::var(name) {
            Ok(value) if !value.trim().is_empty() => Ok(value.trim().to_string()),
            _ => Err(format!(
                "secret=\"env:{name}\" — the environment variable is not set, or is empty"
            )),
        };
    }
    if let Some(raw) = trimmed.strip_prefix("file:") {
        let raw = raw.trim();
        if raw.is_empty() {
            return Err("secret=\"file:\" names no file".to_string());
        }
        let expanded = expand_home(raw);
        let path = if expanded.is_absolute() {
            expanded
        } else {
            base_dir.join(expanded)
        };
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("secret=\"file:{raw}\" could not be read ({e})"))?;
        // Trimmed because a key file written by a person almost always ends in a
        // newline, and a signature that silently includes it agrees with nothing.
        let value = text.trim();
        if value.is_empty() {
            return Err(format!("secret=\"file:{raw}\" is empty"));
        }
        return Ok(value.to_string());
    }
    if trimmed.is_empty() {
        return Err("secret=\"\" is empty".to_string());
    }
    Ok(trimmed.to_string())
}

fn expand_home(path: &str) -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if path == "~" {
        return std::path::PathBuf::from(home);
    }
    match path.strip_prefix("~/") {
        Some(rest) if !home.is_empty() => std::path::PathBuf::from(home).join(rest),
        _ => std::path::PathBuf::from(path),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curl_is_handed_the_rebuilt_url_not_the_src() {
        // The signed target is computed from `src`; curl must be handed the URL
        // rebuilt around it, or it sends a request line the signature does not
        // cover. Checked on the arguments, so it holds without a socket.
        let batch = Batch {
            src: " http://127.0.0.1:1/%7eme/%d0%bf a?k=it's#top ",
            count: 1,
            offset: 0,
            total: 1,
            inputs: None,
            seed: None,
            on_error: OnError::Fail,
            timeout_ms: 1000,
            secret: None,
        };
        let command = curl_command(&batch, "", 0);
        let args: Vec<String> = command
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args.last().map(String::as_str),
            Some("http://127.0.0.1:1/~me/%D0%BF%20a?k=it%27s")
        );
        // The method the signature names is the one curl sends.
        let method = args
            .iter()
            .position(|a| a == "--request")
            .and_then(|i| args.get(i + 1));
        assert_eq!(method.map(String::as_str), Some(HTTP_METHOD));
    }
}
