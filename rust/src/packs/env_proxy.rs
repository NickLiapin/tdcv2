//! Which proxy a registry request goes through, read from the environment the
//! way curl and npm read it — the same rule in all five implementations.
//!
//! curl would read these variables on its own. The rule is spelled out here and
//! handed to curl explicitly instead, so that it is the SAME rule the other four
//! apply — the order of the variables, what `no_proxy` matches — and so that the
//! proxy a failure went through can be named in the message.
//!
//! - An `https` address takes the first non-empty of `https_proxy`,
//!   `HTTPS_PROXY`, `all_proxy`, `ALL_PROXY`; an `http` one `http_proxy`,
//!   `HTTP_PROXY`, `all_proxy`, `ALL_PROXY`.
//! - `no_proxy` (or `NO_PROXY`) is a comma-separated list of hosts that go
//!   direct: `*` for all, otherwise a host matches an entry it equals or ends
//!   with after a dot, with a leading dot and a port ignored.
//! - A value with no scheme is an `http://` proxy.

use super::registry::PackError;

/// The proxy an address goes through, and the variable that named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    /// The proxy as written, credentials included — what curl is given.
    pub url: String,
    /// `scheme://host:port`, the port always spelled out and the credentials
    /// left out — what an error message prints.
    pub shown: String,
    pub variable: &'static str,
}

/// The proxy for `url`, or `None` to go direct.
pub fn for_url(url: &str) -> Result<Option<Choice>, PackError> {
    let Some((scheme, rest)) = url.split_once("://") else {
        return Ok(None);
    };
    let scheme = scheme.to_ascii_lowercase();
    let host = host_of(rest);
    if !(scheme == "http" || scheme == "https") || host.is_empty() || bypassed(&host) {
        return Ok(None);
    }
    let names: [&'static str; 4] = if scheme == "https" {
        ["https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"]
    } else {
        ["http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]
    };
    for name in names {
        let value = read(name);
        if value.is_empty() {
            continue;
        }
        let written = if value.contains("://") {
            value.clone()
        } else {
            format!("http://{value}")
        };
        let Some(shown) = shown_of(&written) else {
            return Err(PackError(format!(
                "{name}=\"{value}\" is not a proxy address — write it as http://host:port"
            )));
        };
        return Ok(Some(Choice {
            url: written,
            shown,
            variable: name,
        }));
    }
    Ok(None)
}

/// Whether `host` is listed in `no_proxy` / `NO_PROXY`.
pub fn bypassed(host: &str) -> bool {
    let mut listed = read("no_proxy");
    if listed.is_empty() {
        listed = read("NO_PROXY");
    }
    let h = host.to_ascii_lowercase();
    for raw in listed.split(',') {
        let mut entry = raw.trim().to_ascii_lowercase();
        if entry == "*" {
            return true;
        }
        if let Some(stripped) = entry.strip_prefix('.') {
            entry = stripped.to_string();
        }
        if entry.matches(':').count() == 1 {
            entry = entry.split(':').next().unwrap_or_default().to_string();
        }
        if !entry.is_empty() && (h == entry || h.ends_with(&format!(".{entry}"))) {
            return true;
        }
    }
    false
}

/// The host of `authority/path…` — userinfo and port dropped.
fn host_of(rest: &str) -> String {
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if let Some(bracketed) = authority.strip_prefix('[') {
        return bracketed
            .split(']')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
    }
    authority
        .split(':')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// `scheme://host[:port]` for a proxy address, or `None` when it is not one.
fn shown_of(written: &str) -> Option<String> {
    let (scheme, rest) = written.split_once("://")?;
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    if host_port.contains('@') {
        return None;
    }
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !h.contains(':') || h.ends_with(']') => (h, Some(p)),
        _ => (host_port, None),
    };
    if host.is_empty()
        || port.is_some_and(|p| p.is_empty() || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    let scheme = scheme.to_ascii_lowercase();
    let port = port.map_or_else(
        || if scheme == "https" { "443" } else { "80" }.to_string(),
        str::to_string,
    );
    Some(format!("{scheme}://{host}:{port}"))
}

fn read(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proxy_address_is_shown_without_its_credentials() {
        assert_eq!(
            shown_of("http://user:secret@127.0.0.1:9").as_deref(),
            Some("http://127.0.0.1:9")
        );
        assert_eq!(
            shown_of("http://proxy.corp").as_deref(),
            Some("http://proxy.corp:80")
        );
        assert_eq!(shown_of("http://bad@@value:x"), None);
        assert_eq!(shown_of("http://:8080"), None);
    }

    #[test]
    fn the_host_of_an_address_drops_userinfo_and_port() {
        assert_eq!(host_of("u:p@Registry.Example:443/x"), "registry.example");
        assert_eq!(host_of("[::1]:8080/x"), "::1");
    }
}
