//! `tdcv2 pack` — the data packs, from the shared registry.
//!
//! The library ships with English and the USA and nothing else, because the
//! packs are meant to grow to a size no library should carry. Everything else
//! comes from one registry that every implementation reads, so a pack fetched by
//! any of them works in the others.
//!
//! A bundle is axis-pure — one language (`en`), or one country (`usa`), or
//! `common` — because language and country are independent and compose: US
//! English is common + en + usa. Installing extracts to `<store>/<id>/` and
//! registers only that bundle's own `packs` folder in the config, so addresses
//! stay `en.person.lastName` and never `en.packs.en.person.lastName`.
//!
//! Where things go is decided by the config cascade, not guessed: `packStore`
//! from the nearest `tdcv2.config.json`, else the global one. With neither,
//! `init` has not been run and this says so rather than inventing a folder.

use crate::cli::pack_picker;
use std::io::Write;
use std::path::PathBuf;

use crate::packs::project;
use crate::packs::registry::{self, Bundle, PackError, Registry};

const USAGE: &str = "Usage: tdcv2 pack [command]

  list                  Show what can be installed, and what already is
  add <id>...           Download and install one or more bundles
  remove <id>...        Uninstall, and drop them from the config

  --registry <url>      Use another registry (default: the public one)
";

/// The narrowest the id column ever gets: two spaces, twelve, a space.
///
/// The column grows to fit the widest id in the catalogue — `sao_tome_and_principe`
/// is twenty-one characters, and a fixed twelve pushed every column after it out
/// of line on that row alone. It never SHRINKS below this, so a short catalogue
/// keeps the shape the shared CLI fixture pins.
const MIN_ID_WIDTH: usize = 12;

/// How wide to fold a description when there is no terminal to ask.
///
/// The same answer every implementation gives, which keeps their output
/// identical when it is piped.
const PIPED_WIDTH: usize = 80;

/// Where downloads go, and which config file records them.
struct Store {
    path: PathBuf,
    config_path: PathBuf,
}

/// The pack folder and the config that owns it, from the cascade.
///
/// A project config wins over the global one — packs belong to the project that
/// uses them. Neither means `init` has not run, and guessing a folder here would
/// put data somewhere the next command would not look.
fn resolve_store(cwd: &str) -> Result<Store, PackError> {
    let resolved = project::load(Some(cwd)).map_err(|e| PackError(e.message().to_string()))?;

    let config_path = project::find_project_config(Some(cwd))
        .or_else(project::global_config_path)
        .filter(|path| path.is_file());
    let Some(config_path) = config_path else {
        return Err(PackError(
            "no tdcv2.config.json found — run `tdcv2 init` first".to_string(),
        ));
    };

    match resolved.pack_store {
        Some(store) => Ok(Store {
            path: PathBuf::from(store),
            config_path,
        }),
        None => Err(PackError(format!(
            "config \"{}\" does not name a \"packStore\" — add one, or re-run \
             `tdcv2 init --force`",
            config_path.display()
        ))),
    }
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

    let mut registry_url: Option<String> = None;
    let mut rest: Vec<String> = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = argv[i].as_str();
        if arg == "--registry" {
            i += 1;
            let Some(value) = argv.get(i) else {
                writeln!(stderr, "tdcv2: missing value for --registry")?;
                return Ok(2);
            };
            registry_url = Some(value.clone());
        } else if let Some(value) = arg.strip_prefix("--registry=") {
            registry_url = Some(value.to_string());
        } else {
            rest.push(arg.to_string());
        }
        i += 1;
    }

    // No subcommand on a terminal opens the picker; anywhere else — a pipe, a
    // script, a system without stty — it lists, which answers the same question
    // without needing a keyboard.
    let bare = rest.is_empty();
    let command = rest.first().cloned().unwrap_or_else(|| "list".to_string());
    let ids: Vec<String> = rest.into_iter().skip(1).collect();

    let store = match resolve_store(cwd) {
        Ok(store) => store,
        Err(e) => {
            writeln!(stderr, "tdcv2: {e}")?;
            return Ok(2);
        }
    };
    let registry = match &registry_url {
        Some(url) => Registry::new(url),
        None => Registry::default(),
    };

    if bare && pack_picker::usable() {
        return match browse(&registry, &store, stdout, stderr) {
            Ok(code) => Ok(code),
            Err(e) => {
                writeln!(stderr, "tdcv2: {e}")?;
                Ok(1)
            }
        };
    }

    let outcome = match command.as_str() {
        "list" => list(&registry, &store, stdout),
        "add" if ids.is_empty() => {
            writeln!(stderr, "tdcv2: `pack add` needs at least one bundle id")?;
            return Ok(2);
        }
        "add" => add(&registry, &store, &ids, stdout, stderr),
        "remove" if ids.is_empty() => {
            writeln!(stderr, "tdcv2: `pack remove` needs at least one bundle id")?;
            return Ok(2);
        }
        "remove" => remove(&store, &ids, stdout, stderr),
        other => {
            writeln!(
                stderr,
                "tdcv2: unknown pack command \"{other}\" (use list | add | remove)"
            )?;
            return Ok(2);
        }
    };

    match outcome {
        Ok(code) => Ok(code),
        Err(e) => {
            writeln!(stderr, "tdcv2: {e}")?;
            Ok(2)
        }
    }
}

/// A `PackError` or an IO failure; both end the same way, one line on stderr.
type Outcome = Result<i32, PackError>;

/// The picker, and then whatever it decided.
///
/// The picker draws and returns; installing and removing stay here, so the
/// download progress, the digests and the config writing live in one place
/// rather than two.
fn browse(
    registry: &Registry,
    store: &Store,
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> Outcome {
    let index = registry.read_index()?;
    if index.bundles.is_empty() {
        let _ = writeln!(stdout, "No bundles in the registry.");
        return Ok(0);
    }

    let here: std::collections::BTreeSet<String> =
        registry::installed(&store.path).into_iter().collect();
    let Some(decision) = pack_picker::run(&index.bundles, here) else {
        let _ = writeln!(stdout, "Nothing changed.");
        return Ok(0);
    };
    if decision.install.is_empty() && decision.remove.is_empty() {
        let _ = writeln!(stdout, "Nothing changed.");
        return Ok(0);
    }

    if !decision.remove.is_empty() {
        remove(store, &decision.remove, stdout, stderr)?;
    }
    if !decision.install.is_empty() {
        return add(registry, store, &decision.install, stdout, stderr);
    }
    Ok(0)
}

fn list(registry: &Registry, store: &Store, stdout: &mut dyn Write) -> Outcome {
    let index = registry.read_index()?;
    let here = registry::installed(&store.path);

    if index.bundles.is_empty() {
        let _ = writeln!(stdout, "No bundles in the registry.");
        return Ok(0);
    }

    let id_width = index
        .bundles
        .iter()
        .map(|b| b.id.chars().count())
        .max()
        .unwrap_or(0)
        .max(MIN_ID_WIDTH);
    // Two spaces of margin, the id column, one space — where a description and
    // the "installed" mark both start.
    let indent = 2 + id_width + 1;

    let _ = writeln!(stdout, "Available data packs:");
    let _ = writeln!(stdout);
    for bundle in &index.bundles {
        let mark = if here.contains(&bundle.id) {
            "✓ installed"
        } else {
            " "
        };
        let _ = writeln!(
            stdout,
            "  {:<id_width$} {:<12} {} ({})",
            bundle.id,
            mark,
            bundle.name,
            megabytes(bundle.bytes)
        );
        for line in wrap(&bundle.description, indent) {
            let _ = writeln!(stdout, "{line}");
        }
        let _ = writeln!(stdout);
    }

    // An id in the store that the registry no longer lists still works; saying
    // so beats a silent omission that reads like the pack is gone.
    let orphans: Vec<String> = here
        .iter()
        .filter(|id| !index.bundles.iter().any(|b| &b.id == *id))
        .cloned()
        .collect();
    if !orphans.is_empty() {
        let _ = writeln!(
            stdout,
            "Installed but not in this registry: {}",
            orphans.join(", ")
        );
        let _ = writeln!(stdout);
    }

    let _ = writeln!(stdout, "Install with: tdcv2 pack add <id>");
    Ok(0)
}

fn add(
    registry: &Registry,
    store: &Store,
    ids: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> Outcome {
    let index = registry.read_index()?;
    // Every id is looked up before anything is downloaded, so a typo in the
    // third one does not leave the first two half-installed.
    let bundles: Vec<Bundle> = ids
        .iter()
        .map(|id| index.find(id).cloned())
        .collect::<Result<_, _>>()?;

    for bundle in &bundles {
        let _ = writeln!(
            stderr,
            "tdcv2: downloading {} ({})…",
            bundle.id,
            megabytes(bundle.bytes)
        );
        let root = registry.install(bundle, &store.path)?;
        let directory = store.path.join(&bundle.id);
        let root_text = root.to_string_lossy().into_owned();
        let stored = project::stored_path(&store.config_path, &root_text);
        let added = project::register(&store.config_path, std::slice::from_ref(&root_text))
            .map_err(|e| PackError(e.message().to_string()))?;

        let _ = writeln!(
            stdout,
            "Installed {}: {} files → {}",
            bundle.id,
            registry::count_files(&directory),
            directory.display()
        );
        let _ = if added {
            writeln!(
                stdout,
                "  registered {stored} in {}",
                store.config_path.display()
            )
        } else {
            writeln!(
                stdout,
                "  already registered in {}",
                store.config_path.display()
            )
        };
    }
    Ok(0)
}

fn remove(
    store: &Store,
    ids: &[String],
    stdout: &mut dyn Write,
    stderr: &mut dyn Write,
) -> Outcome {
    for id in ids {
        let directory = store.path.join(id);
        let packs = directory.join(registry::BUNDLE_PACKS_DIR);
        if !packs.is_dir() && !directory.is_dir() {
            // Not an error. `remove` is asked for to reach a state, and that
            // state already holds; exiting non-zero would make an idempotent
            // script fail on its second run.
            let _ = writeln!(
                stderr,
                "tdcv2: \"{id}\" is not installed — nothing to remove"
            );
            continue;
        }

        let removed =
            project::unregister(&store.config_path, &[packs.to_string_lossy().into_owned()])
                .map_err(|e| PackError(e.message().to_string()))?;
        std::fs::remove_dir_all(&directory)
            .map_err(|e| PackError(format!("cannot remove \"{}\": {e}", directory.display())))?;

        let _ = writeln!(stdout, "Removed {id} ({})", directory.display());
        let _ = if removed {
            writeln!(
                stdout,
                "  unregistered from {}",
                store.config_path.display()
            )
        } else {
            writeln!(
                stdout,
                "  was not registered in {}",
                store.config_path.display()
            )
        };
    }
    Ok(0)
}

/// Text folded to the terminal, with every line under the same indent.
///
/// Descriptions run to two hundred characters. Printed as one line each they
/// wrap wherever the window happens to end and the remainder lands hard against
/// the left margin, which turns a list of a hundred packs into a wall nobody can
/// read down.
fn wrap(text: &str, indent: usize) -> Vec<String> {
    let width = terminal_columns().max(40) - indent;
    let pad = " ".repeat(indent);
    let mut lines: Vec<String> = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        if line.is_empty() {
            line.push_str(word);
        } else if line.chars().count() + 1 + word.chars().count() <= width {
            line.push(' ');
            line.push_str(word);
        } else {
            lines.push(format!("{pad}{line}"));
            line = word.to_string();
        }
    }
    if !line.is_empty() {
        lines.push(format!("{pad}{line}"));
    }
    lines
}

/// How wide to fold to: always 80 here.
///
/// The other four ask the terminal and fall back to 80 when there is none, so a
/// piped run matches them exactly and an interactive one in a wide window folds
/// narrower than theirs would. Asking needs an `ioctl`, and that needs a
/// dependency the crate does not take for a cosmetic difference.
///
/// Never `COLUMNS`: an environment variable only one implementation honours is a
/// way for the same command to print differently in the same shell.
fn terminal_columns() -> usize {
    PIPED_WIDTH
}

fn megabytes(bytes: i64) -> String {
    format!("{:.1} MB", bytes as f64 / 1024.0 / 1024.0)
}
