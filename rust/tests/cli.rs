//! The command line's contract, as data.
//!
//! Every implementation runs `fixtures/cross-language/cli.json` and must agree —
//! exit code first, then what reached stdout and stderr. A CLI is the surface
//! most users touch, and two implementations that generate identical data while
//! disagreeing about an exit code are still not interchangeable in a script.
//!
//! `init` and `pack` act on a working DIRECTORY rather than on a named file, so
//! they are handed the temp directory instead of the test process changing into
//! it — a process-wide `cd` is a race as soon as two tests run at once.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tdcv2::json::Value;

/// Commands this implementation has not built yet.
///
/// Named here rather than deleted from the fixture: a case that is skipped and
/// counted is a piece of work anyone can see, and one that quietly is not run
/// looks exactly like one that passes.
const NOT_BUILT_YET: &[&str] = &[];

#[test]
fn the_cli_behaves_as_the_shared_contract_says() {
    let fixture = common::read_fixture("cli.json");
    let configs = fixture.get("configs").expect("the named configs");
    let cases = fixture
        .get("cases")
        .and_then(Value::as_array)
        .expect("the cases");

    let mut ran = 0usize;
    let mut skipped: BTreeSet<String> = BTreeSet::new();

    for case in cases {
        let name = case
            .get("name")
            .and_then(Value::as_str)
            .expect("every case is named")
            .to_string();

        match not_built_yet(case) {
            Some(command) => {
                skipped.insert(command);
            }
            None => {
                run_case(case, configs, &name);
                ran += 1;
            }
        }
    }

    println!(
        "cli: {ran} of {} shared cases run here; {} not built yet: {}",
        cases.len(),
        cases.len() - ran,
        skipped.iter().cloned().collect::<Vec<_>>().join(", ")
    );
    assert!(ran > 0, "the fixture produced no runnable cases");
}

/// The command a case needs, when this implementation does not have it.
fn not_built_yet(case: &Value) -> Option<String> {
    let command = case
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("main");
    if NOT_BUILT_YET.contains(&command) {
        return Some(command.to_string());
    }
    // `check` and `format` arrive as the first argument rather than as a named
    // command, so the argv is where they have to be spotted.
    let first = case
        .get("argv")
        .and_then(Value::as_array)
        .and_then(|argv| argv.first())
        .and_then(Value::as_str)
        .unwrap_or_default();
    NOT_BUILT_YET.contains(&first).then(|| first.to_string())
}

fn run_case(case: &Value, configs: &Value, name: &str) {
    let sandbox = Sandbox::new();
    let dir = sandbox.path();

    let registry = case
        .get("registry")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        .then(|| build_registry(&dir.join("registry")));

    write_inputs(case, configs, dir, name);

    let argv: Vec<String> = case
        .get("argv")
        .and_then(Value::as_array)
        .expect("every case has argv")
        .iter()
        .map(|a| resolve_all(a.as_str().unwrap_or_default(), dir, registry.as_deref()))
        .collect();

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let command = case
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("main");
    let exit = match command {
        "init" => tdcv2::cli::init::run(&argv, &dir.to_string_lossy(), &mut stdout, &mut stderr),
        "pack" => tdcv2::cli::pack::run(&argv, &dir.to_string_lossy(), &mut stdout, &mut stderr),
        _ => tdcv2::cli::run(&argv, &mut stdout, &mut stderr),
    }
    .unwrap_or_else(|e| panic!("{name}: the CLI could not write its output: {e}"));

    let stdout = String::from_utf8(stdout).expect("stdout is UTF-8");
    let stderr = String::from_utf8(stderr).expect("stderr is UTF-8");

    let expected_exit = case
        .get("exit")
        .and_then(Value::as_i64)
        .expect("every case pins an exit code");
    assert_eq!(
        i64::from(exit),
        expected_exit,
        "{name}: exit code\n--- stdout ---\n{stdout}--- stderr ---\n{stderr}"
    );

    check(case, "stdout", &stdout, dir, registry.as_deref(), name);
    check(case, "stderr", &stderr, dir, registry.as_deref(), name);
    check_written(case, "wrote", dir, registry.as_deref(), name, true);
    check_written(case, "wroteContains", dir, registry.as_deref(), name, false);
}

/// The named configs live once in the fixture; a case refers to one with `@name`.
fn write_inputs(case: &Value, configs: &Value, dir: &Path, name: &str) {
    let Some(files) = case.get("files").and_then(Value::as_object) else {
        return;
    };
    for (relative, contents) in files {
        let mut text = contents.as_str().unwrap_or_default().to_string();
        if let Some(key) = text.strip_prefix('@') {
            text = configs
                .get(key)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{name}: no config named {key:?}"))
                .to_string();
        }
        let target = dir.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).expect("the temp dir is writable");
        }
        std::fs::write(&target, resolve(&text, dir)).expect("the temp dir is writable");
    }
}

fn check(case: &Value, stream: &str, actual: &str, dir: &Path, registry: Option<&str>, name: &str) {
    if let Some(exact) = case.get(stream).and_then(Value::as_str) {
        assert_eq!(
            actual,
            resolve_all(exact, dir, registry),
            "{name}: {stream}"
        );
    }
    if let Some(parts) = case
        .get(&format!("{stream}Contains"))
        .and_then(Value::as_array)
    {
        for part in parts {
            let wanted = resolve_all(part.as_str().unwrap_or_default(), dir, registry);
            assert!(
                actual.contains(&wanted),
                "{name}: {stream} should contain {wanted:?}\n--- {stream} ---\n{actual}"
            );
        }
    }
    if let Some(pattern) = case
        .get(&format!("{stream}Matches"))
        .and_then(Value::as_str)
    {
        assert!(
            regex_lite::matches(pattern, actual),
            "{name}: {stream} should match /{pattern}/\n--- {stream} ---\n{actual}"
        );
    }
}

fn check_written(
    case: &Value,
    key: &str,
    dir: &Path,
    registry: Option<&str>,
    name: &str,
    exact: bool,
) {
    let Some(files) = case.get(key).and_then(Value::as_object) else {
        return;
    };
    for (relative, expected) in files {
        let path = dir.join(relative);
        let written = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("{name}: {} was not written: {e}", path.display()));
        if exact {
            assert_eq!(
                written,
                resolve_all(expected.as_str().unwrap_or_default(), dir, registry),
                "{name}: {relative}"
            );
            continue;
        }
        for part in expected.as_array().unwrap_or_default() {
            let wanted = resolve_all(part.as_str().unwrap_or_default(), dir, registry);
            assert!(
                written.contains(&wanted),
                "{name}: {relative} should contain {wanted:?}\n--- written ---\n{written}"
            );
        }
    }
}

fn resolve(text: &str, dir: &Path) -> String {
    text.replace("{dir}", &dir.to_string_lossy())
}

fn resolve_all(text: &str, dir: &Path, registry: Option<&str>) -> String {
    let text = resolve(text, dir);
    match registry {
        Some(url) => text.replace("{registry}", url),
        None => text,
    }
}

/// A throwaway directory, removed when the case ends.
struct Sandbox(PathBuf);

impl Sandbox {
    fn new() -> Sandbox {
        // A counter rather than a random name: the tests run in parallel threads
        // of one process, and `Math.random` has no place in a fixture runner.
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tdcv2-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        Sandbox(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Just enough regular expression to check what the fixture asks.
///
/// Three patterns use this, and a matcher is not what the crate is for. Anything
/// outside the supported subset PANICS rather than returning false: a pattern
/// this cannot read must fail loudly, or the day someone adds one the case would
/// silently start passing on nothing.
mod regex_lite {
    #[derive(Debug)]
    enum Node {
        Literal(char),
        Digit,
        /// `(a|b|c)` — each branch a literal string.
        Choice(Vec<String>),
    }

    struct Term {
        node: Node,
        /// `+` — one or more.
        repeat: bool,
    }

    pub fn matches(pattern: &str, text: &str) -> bool {
        let (terms, anchored_start, anchored_end) = parse(pattern);
        let chars: Vec<char> = text.chars().collect();

        let starts: Vec<usize> = if anchored_start {
            vec![0]
        } else {
            (0..=chars.len()).collect()
        };
        starts
            .into_iter()
            .any(|from| walk(&terms, 0, &chars, from, anchored_end))
    }

    /// Backtracking, because `+` is greedy and the fixture's patterns are short.
    fn walk(terms: &[Term], term: usize, chars: &[char], at: usize, anchored_end: bool) -> bool {
        let Some(current) = terms.get(term) else {
            return !anchored_end || at == chars.len();
        };

        let mut taken = 0usize;
        let mut cursor = at;
        loop {
            // A match of `taken` repetitions is only worth trying once the
            // minimum of one has been met.
            if taken >= 1 && walk(terms, term + 1, chars, cursor, anchored_end) {
                return true;
            }
            if taken >= 1 && !current.repeat {
                return false;
            }
            match step(&current.node, chars, cursor) {
                Some(next) => cursor = next,
                None => return false,
            }
            taken += 1;
        }
    }

    /// Where this node ends if it matches here.
    fn step(node: &Node, chars: &[char], at: usize) -> Option<usize> {
        match node {
            Node::Literal(expected) => (chars.get(at) == Some(expected)).then_some(at + 1),
            Node::Digit => chars.get(at).filter(|c| c.is_ascii_digit()).map(|_| at + 1),
            Node::Choice(branches) => branches.iter().find_map(|branch| {
                let end = at + branch.chars().count();
                (chars.len() >= end && chars[at..end].iter().collect::<String>() == *branch)
                    .then_some(end)
            }),
        }
    }

    fn parse(pattern: &str) -> (Vec<Term>, bool, bool) {
        let chars: Vec<char> = pattern.chars().collect();
        let anchored_start = chars.first() == Some(&'^');
        let anchored_end = chars.last() == Some(&'$');
        let body = &chars[usize::from(anchored_start)..chars.len() - usize::from(anchored_end)];

        let mut terms: Vec<Term> = Vec::new();
        let mut i = 0;
        while i < body.len() {
            let node = match body[i] {
                '\\' => {
                    i += 1;
                    match body.get(i) {
                        Some('d') => Node::Digit,
                        Some('n') => Node::Literal('\n'),
                        Some(escaped) => Node::Literal(*escaped),
                        None => panic!("regex_lite: pattern ends in a backslash: /{pattern}/"),
                    }
                }
                '(' => {
                    let close = body[i..]
                        .iter()
                        .position(|c| *c == ')')
                        .unwrap_or_else(|| panic!("regex_lite: unclosed group in /{pattern}/"))
                        + i;
                    let inner: String = body[i + 1..close].iter().collect();
                    assert!(
                        !inner.contains(['(', '\\', '+', '*', '?', '[']),
                        "regex_lite: only literal alternations are supported, got /{pattern}/"
                    );
                    i = close;
                    Node::Choice(inner.split('|').map(str::to_string).collect())
                }
                c => {
                    assert!(
                        !"*?[]{}".contains(c),
                        "regex_lite: unsupported metacharacter {c:?} in /{pattern}/"
                    );
                    Node::Literal(c)
                }
            };
            let repeat = body.get(i + 1) == Some(&'+');
            if repeat {
                i += 1;
            }
            terms.push(Term { node, repeat });
            i += 1;
        }
        (terms, anchored_start, anchored_end)
    }
}

/// The demo registry every implementation's runner builds.
///
/// Served over `file:` rather than a local HTTP server: the layout is what is
/// under test, not the transport, and a socket in a unit test is a flake waiting
/// for a busy machine.
///
/// The archive is STORED rather than deflated. Nothing here compares zip bytes
/// across implementations — each runner builds its own and hashes what it built
/// — and the deflate path is proven in `tests/archive.rs` against archives
/// another tool wrote, which is the only way that proves anything.
fn build_registry(root: &Path) -> String {
    // The zip nests everything under the bundle's own id, so it unpacks into the
    // STORE and lands at <store>/<id>/packs. That layout is the registry's,
    // shared by every implementation, so building it differently here would test
    // the wrong thing.
    let archive = zip_of("demo/packs/demo/person/lastName.txt", b"Ivanov\nPetrov\n");
    let digest = tdcv2::archive::sha256::hex(&archive);

    std::fs::create_dir_all(root.join("bundles")).expect("writable");
    std::fs::write(root.join("bundles/demo.zip"), &archive).expect("writable");
    std::fs::write(root.join("index.json"), index_json(archive.len(), &digest)).expect("writable");

    // A second, deliberately broken registry beside the honest one: the same
    // archive, advertised at a size it does not have. It lives under its own
    // path so the honest catalogue — which cases assert byte for byte — keeps
    // listing exactly one bundle.
    std::fs::create_dir_all(root.join("broken/bundles")).expect("writable");
    std::fs::write(root.join("broken/bundles/demo.zip"), &archive).expect("writable");
    std::fs::write(
        root.join("broken/index.json"),
        index_json(archive.len() + 999, &digest),
    )
    .expect("writable");

    format!("file://{}", root.to_string_lossy())
}

fn index_json(bytes: usize, digest: &str) -> String {
    format!(
        "{{\"schemaVersion\": 1, \"bundles\": [{{\"id\": \"demo\", \"name\": \"Demo pack\", \
         \"description\": \"two surnames\", \"file\": \"bundles/demo.zip\", \"bytes\": {bytes}, \
         \"sha256\": \"{digest}\", \"locale\": \"demo\"}}]}}"
    )
}

/// A one-entry zip, stored. Written out because the crate reads archives and
/// does not write them — this is the only place one is needed.
fn zip_of(name: &str, data: &[u8]) -> Vec<u8> {
    let crc = crc32(data);
    let name_bytes = name.as_bytes();
    let mut out: Vec<u8> = Vec::new();

    // Local header, then the data.
    out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
    out.extend_from_slice(&[20, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // version, flags, method 0, time, date
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(name_bytes);
    out.extend_from_slice(data);

    // The central directory, and the record that says where it starts.
    let directory_at = out.len();
    out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
    out.extend_from_slice(&[20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    out.extend_from_slice(&crc.to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&(name_bytes.len() as u16).to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // extra, comment, disk, attrs
    out.extend_from_slice(&0u32.to_le_bytes()); // offset of the local header
    out.extend_from_slice(name_bytes);
    let directory_size = out.len() - directory_at;

    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]); // this disk, the disk the directory starts on
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&(directory_size as u32).to_le_bytes());
    out.extend_from_slice(&(directory_at as u32).to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes()); // no comment
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xedb8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}
