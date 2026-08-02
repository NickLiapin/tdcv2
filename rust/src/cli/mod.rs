//! `tdcv2` — the command line.
//!
//! The library is the recommended way to embed TDC; this exists so that a `.tdc`
//! file can be run without writing a program around it, and so that a Rust user
//! never needs another language's toolchain to do it. The surface deliberately
//! matches the TypeScript, C#, Java and Python CLIs flag for flag: the same
//! config run through any of them must behave the same way, including its exit
//! codes. `fixtures/cross-language/cli.json` is where that is written down.
//!
//! Exit codes: 0 fine, 1 the run failed (an invalid config), 2 the command line
//! itself was wrong.
//!
//! Everything is written through the two writers passed in rather than through
//! `println!`, so the whole CLI can be driven by a test without spawning a
//! process.

pub mod args;
pub mod init;
pub mod pack;
pub mod pack_picker;

use std::io::Write;

use crate::errors::{render, Diagnostic};
use crate::tdc::{Options, Tdc, TdcError};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = r#"tdcv2 — The Data Constructor

Usage:
  tdcv2 <input.tdc> [options]       Generate data from a config
  tdcv2 init [--global]             Set up a config (asks where; --yes for defaults)
  tdcv2 pack [list|add|remove <id>] Install / remove data packs (list with no args)
  tdcv2 check <input.tdc>           Validate a config without generating anything
  tdcv2 format [-w] <file.tdc>      Pretty-print a config (-w writes it in place)

Options:
  -o, --output <path>      Write generated content to <path> (default: stdout)
  --seed <seed>            Override the seed declared in <env>
  --count <n>              Override the count declared in <env>
  --locale <loc>           Override the default locale (default: en)
  --data-path <dir>        Add a data folder for @data/... sources (repeatable)
  --jobs <n>               Accepted and ignored here: this build runs on one
                           thread. The flag never changes the output in any
                           implementation, only how long a large run takes
  --mode <memory|disk>     Advanced. disk (default): bounded memory, scales to
                           any size — TDC picks the streaming or exact engine
                           automatically from the config. memory: the small,
                           in-RAM engine (an escape hatch; does not scale)
  --disk                   Shortcut for --mode disk (already the default)
  --engine <1|2|3>         Advanced: force a specific engine
  --stream                 Legacy alias for --engine 2
  -h, --help               Show this message
  -v, --version            Show version and exit

Data paths also come from tdcv2.config.json (nearest one up from the current
directory) and the global config — { "dataPaths": [...], "locale": ".." }.
Order of priority: --data-path > project config > global config > bundled packs.

See https://github.com/NickLiapin/tdcv2 for the DSL reference.

"#;

/// Run the CLI. Returns the exit code rather than exiting, so tests can drive it.
pub fn run(
    argv: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> std::io::Result<i32> {
    let cwd = std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| ".".to_string());

    // init and pack take the working directory as their subject rather than a
    // file, which is why they are dispatched by name here instead of going
    // through the option parser.
    match argv.first().map(String::as_str) {
        Some("init") => return init::run(&argv[1..], &cwd, stdout, stderr),
        Some("pack") => return pack::run(&argv[1..], &cwd, stdout, stderr),
        Some("check") => return check(&argv[1..], stderr),
        Some("format") => return format(&argv[1..], stdout, stderr),
        _ => {}
    }

    let options = match args::parse(argv) {
        Ok(options) => options,
        Err(e) => {
            fail(stderr, &e.0, true)?;
            return Ok(2);
        }
    };

    if options.help {
        write!(stdout, "{HELP}")?;
        return Ok(0);
    }
    if options.version {
        writeln!(stdout, "tdcv2 {VERSION}")?;
        return Ok(0);
    }
    let Some(input) = options.input.clone() else {
        fail(stderr, "input file is required", true)?;
        return Ok(2);
    };

    generate(&options, &input, stdout, stderr)
}

fn generate(
    options: &args::Options,
    input: &str,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> std::io::Result<i32> {
    let built = Options {
        config_file: Some(input.to_string()),
        count: options.count,
        seed: options.seed.clone(),
        locale: options.locale.clone(),
        data_paths: options.data_paths.clone(),
        engine: options.engine,
        ..Options::default()
    };

    let data = match Tdc::new(built) {
        Ok(data) => data,
        Err(e) => {
            report_error(stderr, &e, input)?;
            return Ok(1);
        }
    };

    report(stderr, data.diagnostics(), input, Some(data.source()))?;

    // A run with no seed anywhere gets a random one. Print it, or the output
    // cannot be reproduced — which is the one promise the whole library is built
    // to keep.
    let seed = data.seed();
    if seed.generated {
        note(
            stderr,
            &format!(
                "no seed specified — using random seed \"{}\". Re-run with --seed \"{}\" to \
                 reproduce this exact output.",
                seed.value, seed.value
            ),
        )?;
    }

    let written = match &options.output {
        Some(path) => data.write_file(path),
        None => {
            write!(stdout, "{}", data.text())?;
            Ok(())
        }
    };
    if let Err(e) = written {
        fail(stderr, &e.to_string(), false)?;
        return Ok(1);
    }

    Ok(0)
}

/// `tdcv2 check <file>` — the validator alone, for an editor or a pre-commit hook.
fn check(argv: &[String], stderr: &mut dyn Write) -> std::io::Result<i32> {
    let files: Vec<&String> = argv.iter().filter(|a| !a.starts_with('-')).collect();
    if files.len() != argv.len() || files.len() != 1 {
        fail(stderr, "usage: tdcv2 check <input.tdc>", false)?;
        return Ok(2);
    }
    let file = files[0];

    let data = match Tdc::from_file(file) {
        Ok(data) => data,
        Err(e) => {
            report_error(stderr, &e, file)?;
            return Ok(1);
        }
    };

    let problems = data.diagnostics();
    report(stderr, problems, file, Some(data.source()))?;
    if problems.is_empty() {
        writeln!(stderr, "tdcv2: {file} is valid")?;
    }
    Ok(0)
}

/// `tdcv2 format [-w] <file.tdc>` — pretty-print a config.
///
/// Prints to stdout by default; `-w` overwrites the file. A file with a syntax
/// error is reported and left alone: reformatting something that cannot be
/// parsed would be a guess about what the author meant.
fn format(argv: &[String], stdout: &mut dyn Write, stderr: &mut dyn Write) -> std::io::Result<i32> {
    let mut write = false;
    let mut files: Vec<&String> = Vec::new();
    for arg in argv {
        match arg.as_str() {
            "-w" | "--write" => write = true,
            "-h" | "--help" => {
                writeln!(stdout, "Usage: tdcv2 format [-w|--write] <file.tdc>")?;
                return Ok(0);
            }
            other if other.starts_with('-') => {
                fail(stderr, &format!("format: unknown option: {other}"), false)?;
                return Ok(2);
            }
            _ => files.push(arg),
        }
    }

    if files.len() != 1 {
        fail(stderr, "format: a .tdc file is required", false)?;
        return Ok(2);
    }
    let file = files[0];

    let source = match std::fs::read_to_string(file) {
        Ok(source) => source,
        Err(e) => {
            fail(stderr, &format!("format: cannot read {file}: {e}"), false)?;
            return Ok(1);
        }
    };

    // Never format a file we cannot fully parse — report the syntax error
    // instead.
    let parsed = crate::parser::parse(&source);
    if !parsed.ok() {
        let syntax: Vec<Diagnostic> = parsed
            .problems
            .iter()
            .map(|p| {
                Diagnostic::error(
                    "TDC001",
                    p.message.clone(),
                    "",
                    crate::parser::lexer::Pos {
                        line: p.line,
                        column: p.column,
                    },
                )
            })
            .collect();
        report(stderr, &syntax, file, Some(&source))?;
        return Ok(1);
    }

    let formatted = crate::pretty::print(&parsed.tree);
    if !write {
        write!(stdout, "{formatted}")?;
        return Ok(0);
    }

    if formatted == source {
        note(stderr, &format!("{file} is already formatted"))?;
        return Ok(0);
    }
    // Write beside the file and rename over it: a crash mid-write must not
    // leave the user's config truncated.
    let tmp = format!("{file}.tmp");
    let landed = std::fs::write(&tmp, &formatted).and_then(|()| std::fs::rename(&tmp, file));
    if let Err(e) = landed {
        let _ = std::fs::remove_file(&tmp);
        fail(stderr, &format!("format: cannot write {file}: {e}"), false)?;
        return Ok(1);
    }
    note(stderr, &format!("formatted {file}"))?;
    Ok(0)
}

/// A refusal, in the same block a warning would get. Anything else is one line —
/// there is no config position to point at.
fn report_error(stderr: &mut dyn Write, error: &TdcError, filename: &str) -> std::io::Result<()> {
    match error {
        TdcError::Refused {
            diagnostics,
            source,
        } => report(stderr, diagnostics, filename, Some(source)),
        other => fail(stderr, &other.to_string(), false),
    }
}

/// Diagnostics to stderr, so they stay out of a piped or redirected run's data.
fn report(
    stderr: &mut dyn Write,
    problems: &[Diagnostic],
    filename: &str,
    source: Option<&str>,
) -> std::io::Result<()> {
    if problems.is_empty() {
        return Ok(());
    }
    writeln!(stderr, "{}", render::all(problems, source, filename, false))
}

fn fail(stderr: &mut dyn Write, message: &str, usage: bool) -> std::io::Result<()> {
    writeln!(stderr, "tdcv2: {message}")?;
    if usage {
        writeln!(stderr, "Run `tdcv2 --help` for usage.")?;
    }
    Ok(())
}

fn note(stderr: &mut dyn Write, message: &str) -> std::io::Result<()> {
    writeln!(stderr, "tdcv2: {message}")
}
