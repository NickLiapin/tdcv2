//! `tdcv2 init` — create a config file by asking, rather than by making anyone
//! hand-write JSON.
//!
//! People want to generate data, not learn a config format. At a real terminal
//! this asks three questions — where the config should live, where downloaded
//! packs go, which locale — and writes the file. With no terminal, in a script
//! or in CI, it takes the answers from flags instead, so it stays scriptable and
//! testable.
//!
//! The decisions are pure functions; the questions are a thin shell over them.
//! That is what the tests exercise, because a prompt is hard to test and a
//! decision is not.

use std::io::Write;
use std::path::{Path, PathBuf};

use crate::packs::project;

const USAGE: &str = "Usage: tdcv2 init [options]

  -g, --global          Write the per-user config instead of a project one
  -y, --yes             Take the defaults, ask nothing
  -f, --force           Overwrite an existing config
  --locale <loc>        Default locale for the config (default: en)
  --data-path <dir>     Folder for downloaded packs
";

/// A command line `init` cannot obey, or a file it cannot write.
#[derive(Clone, Debug)]
pub struct InitError(pub String);

fn fail<T>(message: impl Into<String>) -> Result<T, InitError> {
    Err(InitError(message.into()))
}

/// Everything decided, nothing written yet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub path: String,
    pub pack_store: String,
    pub locale: String,
    pub is_global: bool,
}

/// What the flags said.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Flags {
    pub is_global: bool,
    pub force: bool,
    pub yes: bool,
    pub locale: Option<String>,
    pub pack_store: Option<String>,
}

/// Where the config goes: the project's own folder, or the per-user location.
pub fn config_target(is_global: bool, cwd: &str) -> Result<String, InitError> {
    if !is_global {
        return Ok(project::absolute(
            Path::new(cwd),
            project::PROJECT_CONFIG_NAME,
        ));
    }
    match project::global_config_path() {
        Some(path) => Ok(path.to_string_lossy().into_owned()),
        None => fail("no global config location on this platform — use a project config"),
    }
}

/// A project keeps packs beside its config; the global config keeps them next to
/// itself.
pub fn default_pack_store(is_global: bool, config_path: &str, cwd: &str) -> String {
    if is_global {
        let dir = Path::new(config_path).parent().unwrap_or(Path::new("."));
        project::absolute(dir, "packs")
    } else {
        project::absolute(Path::new(cwd), "tdcv2-packs")
    }
}

/// The file's JSON.
///
/// The store is written as `packStore`, not as a `dataPaths` entry: it is where
/// `pack add` downloads bundles, and it is deliberately not a scan root on its
/// own — each installed bundle registers its own `packs` folder, so that
/// addresses stay `en.person.lastName` rather than `en.packs.en.person.lastName`.
/// A project config stores the path relative, so the file can be checked into git
/// and still work on another machine; a global config is machine-specific by
/// nature and stores it absolute.
pub fn config_content(plan: &Plan) -> String {
    let store = if plan.is_global {
        plan.pack_store.clone()
    } else {
        let dir = Path::new(&plan.path).parent().unwrap_or(Path::new("."));
        relative_to(dir, &plan.pack_store)
    };
    format!(
        "{{\n  \"packStore\": \"{}\",\n  \"locale\": \"{}\"\n}}\n",
        escape(&store),
        escape(&plan.locale)
    )
}

fn relative_to(base: &Path, target: &str) -> String {
    let absolute = project::normalize(Path::new(target));
    let root = project::normalize(base);
    if absolute == root {
        return ".".to_string();
    }
    let prefix = if root.ends_with(std::path::MAIN_SEPARATOR) {
        root
    } else {
        format!("{root}{}", std::path::MAIN_SEPARATOR)
    };
    match absolute.strip_prefix(&prefix) {
        Some(rest) => format!("./{}", rest.replace('\\', "/")),
        None => absolute,
    }
}

fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Write it, and create the pack folder so `pack add` has somewhere to go.
pub fn write_config(plan: &Plan, force: bool) -> Result<(), InitError> {
    let path = Path::new(&plan.path);
    if path.is_file() && !force {
        return fail(format!(
            "config already exists at \"{}\" — pass --force to overwrite, or edit it directly",
            plan.path
        ));
    }

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| InitError(format!("cannot create \"{}\": {e}", parent.display())))?;
    }
    std::fs::write(path, config_content(plan))
        .map_err(|e| InitError(format!("cannot write \"{}\": {e}", plan.path)))?;
    std::fs::create_dir_all(&plan.pack_store)
        .map_err(|e| InitError(format!("cannot create \"{}\": {e}", plan.pack_store)))?;
    Ok(())
}

pub fn parse_flags(argv: &[String]) -> Result<Flags, InitError> {
    let mut flags = Flags::default();

    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        match arg {
            "-g" | "--global" => flags.is_global = true,
            "-f" | "--force" => flags.force = true,
            "-y" | "--yes" => flags.yes = true,
            "--locale" | "--data-path" => {
                i += 1;
                let Some(value) = argv.get(i) else {
                    return fail(format!("missing value for {arg}"));
                };
                if arg == "--locale" {
                    flags.locale = Some(value.clone());
                } else {
                    flags.pack_store = Some(value.clone());
                }
            }
            _ => {
                if let Some(value) = arg.strip_prefix("--locale=") {
                    flags.locale = Some(value.to_string());
                } else if let Some(value) = arg.strip_prefix("--data-path=") {
                    flags.pack_store = Some(value.to_string());
                } else {
                    return fail(format!("unknown option for init: {arg}"));
                }
            }
        }
        i += 1;
    }

    Ok(flags)
}

pub fn plan_from_flags(flags: &Flags, cwd: &str) -> Result<Plan, InitError> {
    let path = config_target(flags.is_global, cwd)?;
    let store = match &flags.pack_store {
        Some(dir) => project::absolute(Path::new(cwd), dir),
        None => default_pack_store(flags.is_global, &path, cwd),
    };
    Ok(Plan {
        path,
        pack_store: store,
        locale: flags.locale.clone().unwrap_or_else(|| "en".to_string()),
        is_global: flags.is_global,
    })
}

pub fn run(
    argv: &[String],
    cwd: &str,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> std::io::Result<i32> {
    if argv.iter().any(|a| a == "-h" || a == "--help") {
        write!(stdout, "{USAGE}")?;
        return Ok(0);
    }

    let flags = match parse_flags(argv) {
        Ok(flags) => flags,
        Err(e) => {
            writeln!(stderr, "tdcv2: {}", e.0)?;
            writeln!(stderr, "Run `tdcv2 init --help` for usage.")?;
            return Ok(2);
        }
    };

    // No terminal means nothing to ask at — a pipe, a script, a CI job.
    let interactive = !flags.yes && std::io::IsTerminal::is_terminal(&std::io::stdin());

    let plan = if interactive {
        ask(&flags, cwd, stdout)
    } else {
        plan_from_flags(&flags, cwd)
    };
    let plan = match plan {
        Ok(plan) => plan,
        Err(e) => {
            writeln!(stderr, "tdcv2: {}", e.0)?;
            return Ok(2);
        }
    };

    if let Err(e) = write_config(&plan, flags.force) {
        writeln!(stderr, "tdcv2: {}", e.0)?;
        return Ok(2);
    }

    let which = if plan.is_global { "global" } else { "project" };
    writeln!(stdout, "Wrote {which} config: {}", plan.path)?;
    writeln!(stdout, "  data packs → {}", plan.pack_store)?;
    writeln!(stdout, "  locale     → {}", plan.locale)?;
    writeln!(stdout)?;
    writeln!(
        stdout,
        "Next: run `tdcv2 pack` to download data packs into that folder."
    )?;
    Ok(0)
}

fn ask(flags: &Flags, cwd: &str, stdout: &mut dyn Write) -> Result<Plan, InitError> {
    let mut is_global = flags.is_global;
    if flags.pack_store.is_none() && !flags.is_global {
        let _ = writeln!(stdout, "Where should this config live?");
        let _ = writeln!(
            stdout,
            "  1) This project — a tdcv2.config.json here, check it into git"
        );
        let _ = writeln!(
            stdout,
            "  2) Global — all your projects, in your home folder"
        );
        is_global = read(stdout, "Choice [1]: ") == "2";
    }

    let path = config_target(is_global, cwd)?;
    let suggested = match &flags.pack_store {
        Some(dir) => project::absolute(Path::new(cwd), dir),
        None => default_pack_store(is_global, &path, cwd),
    };

    let typed = read(
        stdout,
        &format!("Folder for downloaded data packs [{suggested}]: "),
    );
    let store = if typed.is_empty() {
        suggested
    } else {
        project::absolute(Path::new(cwd), &typed)
    };

    let fallback = flags.locale.clone().unwrap_or_else(|| "en".to_string());
    let typed = read(stdout, &format!("Default locale [{fallback}]: "));
    Ok(Plan {
        path,
        pack_store: store,
        locale: if typed.is_empty() { fallback } else { typed },
        is_global,
    })
}

fn read(stdout: &mut dyn Write, prompt: &str) -> String {
    let _ = write!(stdout, "{prompt}");
    let _ = stdout.flush();
    let mut line = String::new();
    match std::io::stdin().read_line(&mut line) {
        Ok(_) => line.trim().to_string(),
        Err(_) => String::new(),
    }
}

/// Where a pack store would be written down in this config — the shape `pack`
/// registers, and the one `init` writes.
pub fn stored_path(config_path: &str, target: &str) -> String {
    let dir = Path::new(config_path).parent().unwrap_or(Path::new("."));
    relative_to(dir, target)
}

/// The config a `--global` run would write to, as a path.
pub fn global_target() -> Option<PathBuf> {
    project::global_config_path()
}
