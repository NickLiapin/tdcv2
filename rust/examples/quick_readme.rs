//! Every value printed in the README's "One value, without a config" block.
//!
//! Kept as an example rather than a test so it can be run by hand while editing
//! the README: `cargo run --example quick_readme`.
use tdcv2::quick::Quick;

fn main() -> Result<(), tdcv2::quick::QuickError> {
    let mut demo = Quick::seeded("demo").locale("en");
    println!(
        "{} | {} | {}",
        demo.get("person.lastName")?,
        demo.get("person.male.firstName")?,
        demo.get("usa.docs.ssn")?
    );
    println!(
        "{:?}",
        Quick::seeded("demo").locale("en").many("person.lastName", 5)?
    );
    println!(
        "{}",
        Quick::seeded("demo").gen("number", &[("value", "18..80")])?
    );
    Ok(())
}
