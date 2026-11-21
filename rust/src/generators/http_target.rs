//! The request target of an `http` generator — the path and query of `src=`,
//! written once, the way it goes on the wire.
//!
//! It is signed (`X-TDC-Signature` covers it), so the bytes TDC signs and the
//! bytes the service reads off the request line have to be the same bytes. The
//! five implementations send through five different HTTP clients, and handed the
//! same URL they do NOT send the same request line, measured 2026-11-21:
//!
//! - .NET decodes `%41` to `A` and `%7e` to `~`, and upper-cases `%d0` to `%D0`;
//! - Node's fetch encodes `'` in the query as `%27` and drops an empty `?`;
//!   Python, curl and .NET keep both;
//! - curl and Node resolve `/a/../b` to `/b`; the others send it as written.
//!
//! So the target is not left to the client. It is computed here by one rule, the
//! URL that is actually sent is rebuilt from it, and every client is then handed
//! a target it sends untouched — which is what the same measurement showed for a
//! target already in this form, in all five. This crate's client is `curl`.
//!
//! The rule:
//!
//! 1. everything after the host; `#fragment` dropped (no client sends it);
//! 2. an empty query (`/a?`) is no query;
//! 3. `/` when nothing is left, and a leading `/` before a bare `?query`;
//! 4. a `%XX` escape of an unreserved character (`A-Z a-z 0-9 - . _ ~`) is that
//!    character — RFC 3986 §6.2.2.2, and what .NET does anyway; every other
//!    escape is kept, its hex digits upper-cased (§6.2.2.1);
//! 5. a `%` that does not start an escape is `%25`;
//! 6. any other character outside `A-Z a-z 0-9 - . _ ~ ! $ & ( ) * + , ; = : @ / ?`
//!    is percent-encoded as its UTF-8 bytes — `'` included, because fetch
//!    encodes it in a query and nothing else does.
//!
//! `.` and `..` segments are the one shape no rule can settle — two clients
//! resolve them, three send them — so the validator refuses them (TDC066) and a
//! config never reaches this point with one.
//!
//! The same rule lives in the other four implementations, held to
//! `fixtures/cross-language/http-vectors.json` (`target`).

/// What every TDC request is sent with. Signed, so a service can tell.
pub const HTTP_METHOD: &str = "POST";

/// The URL to send and the target to sign, for one `src=`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpTarget {
    /// The URL handed to the HTTP client: scheme and host as written, then `target`.
    pub url: String,
    /// Path and query as they go on the request line — and into the signature.
    pub target: String,
}

/// Characters a target carries as they are. `'` is deliberately absent.
fn is_kept(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '-' | '.'
                | '_'
                | '~'
                | '!'
                | '$'
                | '&'
                | '('
                | ')'
                | '*'
                | '+'
                | ','
                | ';'
                | '='
                | ':'
                | '@'
                | '/'
                | '?'
        )
}

fn is_unreserved(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | '~')
}

/// `src=` cut into what is sent as written (scheme, host, port) and what is not.
fn split_src(src: &str) -> (&str, &str) {
    let trimmed = src.trim_matches(|c| matches!(c, ' ' | '\t' | '\r' | '\n'));
    let host_start = trimmed.find("://").map_or(0, |scheme| scheme + 3);
    // The three characters that end the host are ASCII, so a byte search finds
    // the same place a character walk would, and slicing there stays on a
    // character boundary.
    match trimmed[host_start..].find(['/', '?', '#']) {
        Some(end) => trimmed.split_at(host_start + end),
        None => (trimmed, ""),
    }
}

/// `%XX` for each UTF-8 byte of one character.
fn percent_encode(c: char, out: &mut String) {
    let mut buf = [0u8; 4];
    for byte in c.encode_utf8(&mut buf).bytes() {
        out.push_str(&format!("%{byte:02X}"));
    }
}

/// The URL to send and the target to sign, for one `src=`.
pub fn http_target(src: &str) -> HttpTarget {
    let (origin, rest) = split_src(src);
    let mut raw = rest;
    if let Some(hash) = raw.find('#') {
        raw = &raw[..hash];
    }
    if let Some(query) = raw.find('?') {
        if query == raw.len() - 1 {
            raw = &raw[..query];
        }
    }

    // By code point: an emoji is one character of four bytes, not two halves.
    let chars: Vec<char> = if raw.starts_with('/') {
        raw.chars().collect()
    } else {
        std::iter::once('/').chain(raw.chars()).collect()
    };
    let mut target = String::with_capacity(chars.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '%' {
            match (chars.get(i + 1), chars.get(i + 2)) {
                (Some(&hi), Some(&lo)) if hi.is_ascii_hexdigit() && lo.is_ascii_hexdigit() => {
                    let value = (hi.to_digit(16).unwrap_or(0) * 16 + lo.to_digit(16).unwrap_or(0))
                        as u8 as char;
                    if is_unreserved(value) {
                        target.push(value);
                    } else {
                        target.push('%');
                        target.push(hi.to_ascii_uppercase());
                        target.push(lo.to_ascii_uppercase());
                    }
                    i += 2;
                }
                _ => target.push_str("%25"),
            }
        } else if is_kept(c) {
            target.push(c);
        } else {
            percent_encode(c, &mut target);
        }
        i += 1;
    }
    HttpTarget {
        url: format!("{origin}{target}"),
        target,
    }
}

/// The first `.` or `..` segment of the target's path, if it has one.
///
/// Read AFTER the rule above, so `%2e%2e` counts — Node's URL parser treats it
/// as `..` too.
pub fn dot_segment_of(src: &str) -> Option<&'static str> {
    let HttpTarget { target, .. } = http_target(src);
    let path = target.split('?').next().unwrap_or("");
    path.split('/').find_map(|segment| match segment {
        "." => Some("."),
        ".." => Some(".."),
        _ => None,
    })
}
