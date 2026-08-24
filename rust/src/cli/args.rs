//! The command line, parsed by hand.
//!
//! No argument crate. The TypeScript CLI is the interface users already know,
//! and matching it exactly matters more than the lines saved: `--engine 2` and
//! `--engine=2` both work there, an unknown flag exits 2 with a specific
//! message, and a positional argument may follow flags. Making a general parser
//! agree on all of that costs more than writing the loop, and leaves the
//! agreement undocumented.
//!
//! Kept apart from [`super::run`] so the parsing can be tested without a
//! filesystem or a run.

/// A command line that cannot be obeyed. Reported, then exit code 2.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageError(pub String);

impl std::fmt::Display for UsageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn usage<T>(message: impl Into<String>) -> Result<T, UsageError> {
    Err(UsageError(message.into()))
}

/// What the command line asked for, before anything has been read or run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Options {
    pub input: Option<String>,
    pub output: Option<String>,
    pub seed: Option<String>,
    pub count: Option<i32>,
    pub locale: Option<String>,
    pub now: Option<i64>,
    pub data_paths: Vec<String>,
    pub jobs: Option<i32>,
    pub mode: Option<String>,
    pub engine: Option<u8>,
    pub progress: bool,
    pub help: bool,
    pub version: bool,
}

/// Flags that take a value, in either spelling.
const VALUED: &[&str] = &[
    "--output",
    "--seed",
    "--count",
    "--locale",
    "--now",
    "--data-path",
    "--jobs",
    "--mode",
    "--engine",
];

fn is_valued(name: &str) -> bool {
    VALUED.contains(&name)
}

/// The generate command's arguments.
pub fn parse(argv: &[String]) -> Result<Options, UsageError> {
    let mut result = Options::default();

    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();

        // `--name=value` first, so `--engine=2` is not mistaken for a flag whose
        // value is the next argument.
        if let Some(equals) = arg.strip_prefix("--").and_then(|_| arg.find('=')) {
            if equals > 0 {
                let (name, value) = (&arg[..equals], &arg[equals + 1..]);
                if value.is_empty() {
                    return usage(format!("missing value for {name}"));
                }
                if is_valued(name) {
                    store(&mut result, name, value)?;
                    i += 1;
                    continue;
                }
            }
        }

        if is_valued(arg) || arg == "-o" {
            let name = if arg == "-o" { "--output" } else { arg };
            i += 1;
            match argv.get(i) {
                Some(value) if !value.is_empty() => store(&mut result, name, value)?,
                _ => return usage(format!("missing value for {name}")),
            }
        } else if arg == "-h" || arg == "--help" {
            result.help = true;
        } else if arg == "-v" || arg == "--version" {
            result.version = true;
        } else if arg == "--stream" {
            // The legacy spelling of --engine 2, kept because configs and
            // scripts still say it.
            result.engine = Some(2);
        } else if arg == "--disk" {
            result.mode = Some("disk".to_string());
        } else if arg == "--progress" {
            result.progress = true;
        } else if arg.starts_with('-') {
            return usage(format!("unknown option: {arg}"));
        } else if result.input.is_none() {
            result.input = Some(arg.to_string());
        } else {
            return usage(format!("unexpected positional argument: {arg}"));
        }

        i += 1;
    }

    Ok(result)
}

fn store(result: &mut Options, name: &str, value: &str) -> Result<(), UsageError> {
    match name {
        "--output" => result.output = Some(value.to_string()),
        "--seed" => result.seed = Some(value.to_string()),
        "--locale" => result.locale = Some(value.to_string()),
        "--now" => result.now = Some(now_millis(value)?),
        "--data-path" => result.data_paths.push(value.to_string()),
        "--count" => result.count = Some(non_negative(value, "--count")?),
        "--jobs" => result.jobs = Some(positive(value, "--jobs")?),
        "--engine" => {
            result.engine = match value {
                "1" => Some(1),
                "2" => Some(2),
                "3" => Some(3),
                _ => {
                    return usage(format!(
                        "invalid --engine \"{value}\" — expected 1 (in-memory), 2 (streaming), \
                         or 3 (exact-on-disk)"
                    ))
                }
            }
        }
        "--mode" => {
            if value != "memory" && value != "disk" {
                return usage(format!(
                    "invalid --mode \"{value}\" — expected \"memory\" or \"disk\""
                ));
            }
            result.mode = Some(value.to_string());
        }
        _ => return usage(format!("unknown option: {name}")),
    }
    Ok(())
}

/// The clock `--now` pins, in milliseconds since the epoch.
///
/// The syntax is the date generator's own — whatever `<gen type="date" value="…">`
/// accepts is what this accepts, down to the same parser — so the project has one
/// date syntax rather than two. It carries no zone, so like every date in the
/// engine it is read as UTC. A value that does not parse is refused rather than
/// falling back to the real clock, which would hand back the very
/// irreproducibility the flag exists to remove.
fn now_millis(value: &str) -> Result<i64, UsageError> {
    match crate::date::parse::date_time(value) {
        Ok(parsed) => Ok(crate::date::to_epoch_millis(parsed.value)),
        Err(_) => usage(format!(
            "invalid --now \"{value}\" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)"
        )),
    }
}

fn non_negative(value: &str, flag: &str) -> Result<i32, UsageError> {
    match integer(value, flag, "a non-negative integer")? {
        parsed if parsed >= 0 => Ok(parsed),
        _ => usage(format!(
            "invalid {flag} \"{value}\" — expected a non-negative integer"
        )),
    }
}

fn positive(value: &str, flag: &str) -> Result<i32, UsageError> {
    match integer(value, flag, "a positive integer")? {
        parsed if parsed >= 1 => Ok(parsed),
        _ => usage(format!(
            "invalid {flag} \"{value}\" — expected a positive integer"
        )),
    }
}

fn integer(value: &str, flag: &str, expected: &str) -> Result<i32, UsageError> {
    value
        .parse::<i32>()
        .map_err(|_| UsageError(format!("invalid {flag} \"{value}\" — expected {expected}")))
}
