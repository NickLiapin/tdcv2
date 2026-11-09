//! `fixtures/cross-language/http-batches.json`, against a real local service.
//!
//! The other four implementations run the same file; between them they hold the
//! batch contract — what each request carries, where each answer lands, and what
//! a column reading an answer sees — to one behaviour.
//!
//! The service is a few dozen lines of `std::net`: this crate takes no
//! dependencies, its tests included.

mod common;

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

use tdcv2::json::Value;
use tdcv2::parser::{self, config_builder};
use tdcv2::Severity;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    count: i64,
    offset: i64,
    total: Option<i64>,
    input: Option<i64>,
}

struct Service {
    url: String,
    seen: Arc<Mutex<Vec<Seen>>>,
    seeds: Arc<Mutex<Vec<String>>>,
}

/// What the fixture's service answers: (status, lines, echo the offset?).
fn answer(
    service: &str,
    served: usize,
    offset: i64,
    inputs: &[String],
    count: i64,
) -> (u16, Vec<String>, bool) {
    if service == "fail-second" && served > 1 {
        return (500, Vec::new(), true);
    }
    match service {
        "upper" | "upper-no-echo" => (
            200,
            inputs.iter().map(|line| format!("H{line}")).collect(),
            service == "upper",
        ),
        "row-no-echo" => (200, (0..count).map(|i| format!("r{i}")).collect(), false),
        "row-repeat" => (
            200,
            (0..count)
                .map(|i| format!("r{}", if offset + i == 3 { 1 } else { offset + i }))
                .collect(),
            true,
        ),
        _ => (
            200,
            (0..count).map(|i| format!("r{}", offset + i)).collect(),
            true,
        ),
    }
}

fn handle(
    mut stream: TcpStream,
    name: &str,
    seen: &Arc<Mutex<Vec<Seen>>>,
    seeds: &Arc<Mutex<Vec<String>>>,
) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone"));
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut line = String::new();
    reader.read_line(&mut line).expect("request line");
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
    };
    if header("expect").is_some_and(|v| v.eq_ignore_ascii_case("100-continue")) {
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .expect("continue");
    }
    let length: usize = header("content-length")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).expect("body");
    let body = String::from_utf8(body).expect("utf-8");

    let count: i64 = header("x-tdc-count")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let offset: i64 = header("x-tdc-offset")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let total: Option<i64> = header("x-tdc-total").and_then(|v| v.parse().ok());
    let declared: Option<i64> = header("x-tdc-input").and_then(|v| v.parse().ok());
    let inputs: Vec<String> = match declared {
        None | Some(0) => Vec::new(),
        Some(_) if body.is_empty() => vec![String::new()],
        Some(_) => body.split('\n').map(str::to_string).collect(),
    };
    seeds
        .lock()
        .expect("lock")
        .push(header("x-tdc-seed").unwrap_or_default());
    let served = {
        let mut seen = seen.lock().expect("lock");
        seen.push(Seen {
            count,
            offset,
            total,
            input: declared,
        });
        seen.len()
    };
    let (status, lines, echo) = answer(name, served, offset, &inputs, count);
    let payload = lines.join("\n");
    let mut reply = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n",
        if status == 200 { "OK" } else { "Error" },
        payload.len()
    );
    if echo {
        reply.push_str(&format!("X-TDC-Offset: {offset}\r\n"));
    }
    reply.push_str("\r\n");
    reply.push_str(&payload);
    let _ = stream.write_all(reply.as_bytes());
}

fn start(name: &str) -> Service {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let seeds = Arc::new(Mutex::new(Vec::new()));
    let shared = Arc::clone(&seen);
    let shared_seeds = Arc::clone(&seeds);
    let name = name.to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let seen = Arc::clone(&shared);
            let seeds = Arc::clone(&shared_seeds);
            let name = name.clone();
            std::thread::spawn(move || handle(stream, &name, &seen, &seeds));
        }
    });
    Service {
        url: format!("http://127.0.0.1:{port}/gen"),
        seen,
        seeds,
    }
}

fn int_or_null(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

#[test]
fn every_shared_http_case() {
    let fixture = common::read_fixture("http-batches.json");
    let services = fixture
        .get("services")
        .and_then(Value::as_object)
        .expect("services");
    let mut names: Vec<&str> = services.iter().map(|(k, _)| k.as_str()).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "fail-second",
            "row",
            "row-no-echo",
            "row-repeat",
            "upper",
            "upper-no-echo"
        ],
        "a service this suite does not run"
    );

    let cases = fixture
        .get("cases")
        .and_then(Value::as_array)
        .expect("cases");
    assert!(!cases.is_empty());
    // Every engine reads the same batches: the in-memory one a column at a time,
    // the two streaming ones a row at a time. `None` is the router's choice.
    for (case, engine) in cases
        .iter()
        .flat_map(|c| [None, Some("1"), Some("2"), Some("3")].map(move |e| (c, e)))
    {
        let label = format!(
            "{} (engine {})",
            case.get("name").and_then(Value::as_str).expect("name"),
            engine.unwrap_or("auto")
        );
        let name = label.as_str();
        let service = start(
            case.get("service")
                .and_then(Value::as_str)
                .expect("service"),
        );
        let text = case
            .get("config")
            .and_then(Value::as_str)
            .expect("config")
            .replace("{{SRC}}", &service.url);

        let parsed = parser::parse(&text);
        assert!(parsed.ok(), "{name}: does not parse");
        let refusals: Vec<String> = tdcv2::validator::validate_in(
            &parsed.tree,
            tdcv2::packs::DataPacks::discover().ok(),
            None,
        )
        .into_iter()
        .filter(|d| d.severity == Severity::Error)
        .map(|d| format!("{} {}", d.code, d.message))
        .collect();
        assert!(refusals.is_empty(), "{name}: {refusals:?}");
        let built = config_builder::build(&parsed.tree, None).expect("config");
        let config = match engine {
            Some(id) => built.with_engine(id),
            None => built,
        };
        let result = tdcv2::engine::render_in(&config, 0, None);

        match case.get("error").and_then(Value::as_str) {
            Some(error) => {
                let message = result.expect_err(name).to_string();
                let want = error.replace("{{SRC}}", &service.url);
                assert!(
                    message.contains(&want),
                    "{name}:\n got {message}\nwant {want}"
                );
            }
            None => {
                let want = case.get("output").and_then(Value::as_str).expect("output");
                assert_eq!(result.expect(name), want, "{name}");
            }
        }

        if let Some(requests) = case.get("requests").and_then(Value::as_array) {
            let mut seen = service.seen.lock().expect("lock").clone();
            seen.sort_by_key(|s| s.offset);
            let want: Vec<Seen> = requests
                .iter()
                .map(|r| Seen {
                    count: int_or_null(r.get("count")).expect("count"),
                    offset: int_or_null(r.get("offset")).expect("offset"),
                    total: int_or_null(r.get("total")),
                    input: int_or_null(r.get("input")),
                })
                .collect();
            assert_eq!(seen, want, "{name}: requests");
        }

        if let Some(seeds) = case.get("seeds").and_then(Value::as_array) {
            let want: Vec<String> = seeds
                .iter()
                .map(|v| v.as_str().expect("seed").to_string())
                .collect();
            let mut got = service.seeds.lock().expect("lock").clone();
            got.sort();
            assert_eq!(got, want, "{name}: seeds");
        }
    }
}
