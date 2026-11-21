//! A signed request against a service that checks the signature the way a real
//! one would: over the method and the request target it actually received off
//! the request line, not over what the config said.
//!
//! The vectors pin the formula; this pins the other half — that the target
//! signed is the target curl sends. The service is a few dozen lines of
//! `std::net`: this crate takes no dependencies, its tests included.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use tdcv2::archive::sha256::hmac_hex;
use tdcv2::generators::http::{self, Batch, OnError};

const SECRET: &str = "k7Fm2p-test-secret";

struct Service {
    base: String,
    port: u16,
    /// Every request target received, in arrival order.
    targets: Arc<Mutex<Vec<String>>>,
}

/// Answer `ok-<line>` for each input line when the signature matches, 401 when
/// it does not.
fn handle(mut stream: TcpStream, targets: &Arc<Mutex<Vec<String>>>) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut line = String::new();
    reader.read_line(&mut line).expect("request line");
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let target = parts.next().unwrap_or("").to_string();
    targets.lock().expect("lock").push(target.clone());

    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        line.clear();
        reader.read_line(&mut line).expect("header");
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone())
            .unwrap_or_default()
    };
    if header("expect").eq_ignore_ascii_case("100-continue") {
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .expect("continue");
    }
    let length: usize = header("content-length").parse().unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).expect("body");
    let body = String::from_utf8(body).expect("utf-8");

    // The formula written out here rather than borrowed from the crate, the way
    // a service author would write it from the documentation.
    let message = format!(
        "{method}\n{target}\n{}\n{}\n{}\n{}\n{}\n{body}",
        header("x-tdc-timestamp"),
        header("x-tdc-seed"),
        header("x-tdc-count"),
        header("x-tdc-offset"),
        header("x-tdc-total"),
    );
    let signature = header("x-tdc-signature");
    let (status, payload) =
        if !signature.is_empty() && signature == hmac_hex(SECRET.as_bytes(), message.as_bytes()) {
            let lines: Vec<String> = body.split('\n').map(|l| format!("ok-{l}")).collect();
            (200, lines.join("\n"))
        } else {
            (401, String::new())
        };
    let reply = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\n\
         X-TDC-Offset: {}\r\nConnection: close\r\n\r\n{payload}",
        if status == 200 { "OK" } else { "Unauthorized" },
        payload.len(),
        header("x-tdc-offset"),
    );
    let _ = stream.write_all(reply.as_bytes());
}

fn start() -> Service {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let targets = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::clone(&targets);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let targets = Arc::clone(&shared);
            std::thread::spawn(move || handle(stream, &targets));
        }
    });
    Service {
        base: format!("http://127.0.0.1:{port}"),
        port,
        targets,
    }
}

fn batch<'a>(src: &'a str, inputs: &'a [String]) -> Batch<'a> {
    Batch {
        src,
        count: inputs.len(),
        offset: 0,
        total: inputs.len(),
        inputs: Some(inputs),
        seed: Some("abc123"),
        on_error: OnError::Fail,
        timeout_ms: 2000,
        secret: Some(SECRET),
    }
}

/// POST the given headers and body to `target` as they are; the status that comes back.
fn replay(service: &Service, target: &str, headers: &[(&str, String)], body: &str) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", service.port)).expect("connect");
    let mut request = format!(
        "POST {target} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n",
        service.port,
        body.len()
    );
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    request.push_str(body);
    stream.write_all(request.as_bytes()).expect("send");
    let mut reply = String::new();
    stream.read_to_string(&mut reply).expect("reply");
    reply
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .expect("status")
}

#[test]
fn a_signed_request_is_accepted_at_an_address_the_clients_would_each_send_differently() {
    // An escape of a plain letter, an escape in lower case, a space, a quote in
    // the query: the shapes the five HTTP clients do not send alike. They only
    // pass if what was signed is what went on the wire.
    let service = start();
    let src = format!("{}/%7eme/%d0%bf a?k=it's&v=%41", service.base);
    let inputs = vec!["x".to_string()];
    let values = http::fetch(&batch(&src, &inputs)).expect("accepted");
    assert_eq!(values, ["ok-x"]);
    assert_eq!(
        *service.targets.lock().expect("lock"),
        ["/~me/%D0%BF%20a?k=it%27s&v=A"],
        "the request line curl sent"
    );
}

#[test]
fn a_signed_request_is_refused_at_another_address_of_the_same_service() {
    // One service, two addresses, one secret. A request signed for the first
    // one, sent unchanged to the second, must not be answered.
    let service = start();
    let src = format!("{}/hash", service.base);
    let inputs = vec!["qwerty".to_string()];
    let signed_for = batch(&src, &inputs);
    let body = inputs.join("\n");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let headers = http::contract_headers(&signed_for, &body, now);

    assert_eq!(replay(&service, "/hash", &headers, &body), 200);
    assert_eq!(replay(&service, "/invite", &headers, &body), 401);
}

#[test]
fn the_signature_covers_the_target_on_the_wire_not_the_src_as_written() {
    // `/gen?` goes on the wire as `/gen` — an empty query is no query — so that
    // is what is signed.
    let inputs = vec!["body".to_string()];
    let mut written = batch("http://127.0.0.1:1/gen?", &inputs);
    written.count = 4;
    written.total = 4;
    written.seed = Some("seed1");
    let headers = http::contract_headers(&written, "body", 1_786_000_000);
    let signature = headers
        .iter()
        .find(|(name, _)| *name == "X-TDC-Signature")
        .map(|(_, value)| value.as_str());
    assert_eq!(
        headers
            .iter()
            .filter(|(n, _)| *n == "X-TDC-Timestamp")
            .count(),
        1
    );
    assert_eq!(
        signature,
        Some(
            http::sign_request(
                SECRET,
                "POST",
                "/gen",
                "1786000000",
                "seed1",
                4,
                0,
                4,
                "body"
            )
            .as_str()
        )
    );
}
