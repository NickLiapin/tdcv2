//! Render a `.tdc` file and print it, for a differential check against the
//! reference.
//!
//! Goes through the public facade rather than the engine directly: the packs a
//! project declares, the locale it defaults to and the folder a relative `src=`
//! resolves against are all decided there, and a comparison that skipped them
//! would be comparing a path no caller takes.
//!
//! The clock is pinned to the epoch so a config reading `today` would still
//! compare — none of the corpus does, but a run whose answer depends on when it
//! ran is not a comparison.
//!
//! Usage: cargo run --example render_file -- config.tdc [1|2|3]

use tdcv2::{Options, Tdc, TdcError};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: render_file <config.tdc> [1|2|3]");
    // The router decides unless an engine is named, exactly as the CLI's
    // --engine does — a comparison has to run the same engine on both sides.
    let engine = std::env::args()
        .nth(2)
        .map(|value| value.parse::<u8>().expect("the engine is 1, 2 or 3"));

    let data = Tdc::new(Options {
        config_file: Some(path),
        engine,
        now_millis: Some(0),
        ..Options::default()
    });

    match data {
        Ok(data) => print!("{data}"),
        Err(TdcError::Refused {
            diagnostics,
            source: _,
        }) => {
            for diagnostic in &diagnostics {
                eprintln!("{diagnostic}");
            }
            std::process::exit(2);
        }
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(3);
        }
    }
}
