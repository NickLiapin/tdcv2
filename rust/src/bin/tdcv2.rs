//! The `tdcv2` command line.
//!
//! A thin shell over [`tdcv2::cli`], exactly as in the other four
//! implementations, where every command is a function the tests call directly
//! rather than a process they spawn. All this does is hand over the arguments
//! and turn the returned code into an exit status.

use std::io::Write;

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();

    // Locked once and written through a buffer, rather than `println!` per line:
    // a run of a million rows would otherwise take the stdout lock a million
    // times.
    let stdout = std::io::stdout();
    let stderr = std::io::stderr();
    let mut out = std::io::BufWriter::new(stdout.lock());
    let mut err = stderr.lock();

    let code = match tdcv2::cli::run(&argv, &mut out, &mut err) {
        Ok(code) => code,
        // A closed pipe is the ordinary end of `tdcv2 big.tdc | head`, not a
        // failure worth a message nobody is left to read.
        Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => 0,
        Err(e) => {
            let _ = writeln!(err, "tdcv2: {e}");
            1
        }
    };

    // Flushed before exiting, and its failure reported: `process::exit` with a
    // full buffer drops the data silently, which on a redirected run means a
    // truncated file and an exit code of zero.
    if let Err(e) = out.flush() {
        if e.kind() != std::io::ErrorKind::BrokenPipe {
            let _ = writeln!(err, "tdcv2: {e}");
            std::process::exit(1);
        }
    }
    std::process::exit(code);
}
