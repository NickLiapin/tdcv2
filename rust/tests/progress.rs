//! The `--progress` channel: what a watcher is promised about the numbers it is
//! given.

use std::cell::RefCell;
use std::rc::Rc;

use tdcv2::tdc::ProgressHook;
use tdcv2::{Options, Tdc};

/// One report, as it reaches a listener.
type Tick = (String, usize, usize);

/// 400 rows drawn from 480 pairs, so the repair is certain to run and to report.
fn uniq_config() -> String {
    let names: Vec<String> = (0..40).map(|i| format!("a{i}")).collect();
    format!(
        concat!(
            "<tdc><env count=\"400\" seed=\"p\" local=\"en\" mode=\"disk\"><uniq>",
            "<sequence name=\"A\"><gen type=\"text\" value=\"{}\"/></sequence>",
            "<sequence name=\"B\"><gen type=\"text\" value=\"m,n,o,p,q,r,s,t,u,v,w,x\"/></sequence>",
            "</uniq></env><block><line><data>${{{{A}}}}-${{{{B}}}}</data></line></block></tdc>"
        ),
        names.join(",")
    )
}

fn ticks() -> Vec<Tick> {
    let seen: Rc<RefCell<Vec<Tick>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = Rc::clone(&seen);
    let tdc = Tdc::new(Options {
        config_string: Some(uniq_config()),
        on_progress: Some(ProgressHook(Rc::new(move |phase: &str, done, total| {
            sink.borrow_mut().push((phase.to_string(), done, total));
        }))),
        ..Options::default()
    })
    .expect("the config parses");
    let _ = tdc.text();
    let out = seen.borrow().clone();
    out
}

#[test]
fn the_repair_reports_and_the_render_follows_it() {
    let mut order: Vec<String> = Vec::new();
    for (phase, _, _) in ticks() {
        if order.last() != Some(&phase) {
            order.push(phase);
        }
    }
    assert_eq!(order, vec!["uniq-repair".to_string(), "render".to_string()]);
}

/// What a progress bar needs. The repair is several steps with different units —
/// pool rows, then a deal per sweep — reported on ONE rising scale for exactly
/// this reason. Reported straight, the counter would restart at every step and
/// the bar would jump backwards, which reads as a bug rather than as progress.
#[test]
fn within_a_phase_neither_the_count_nor_the_scale_goes_backwards() {
    let all = ticks();
    for phase in ["uniq-repair", "render"] {
        let of: Vec<&Tick> = all.iter().filter(|t| t.0 == phase).collect();
        assert!(of.len() > 1, "{phase} reported once or not at all");
        for pair in of.windows(2) {
            assert!(pair[1].1 >= pair[0].1, "{phase} count fell");
            assert!(pair[1].2 >= pair[0].2, "{phase} scale shrank");
            assert!(pair[1].1 <= pair[1].2, "{phase} ran past its scale");
        }
    }
}

#[test]
fn a_phase_ends_at_its_total_so_a_watcher_can_tell_it_from_a_stall() {
    let all = ticks();
    for phase in ["uniq-repair", "render"] {
        let last = all
            .iter()
            .filter(|t| t.0 == phase)
            .next_back()
            .unwrap_or_else(|| panic!("{phase} never reported"));
        assert_eq!(last.1, last.2, "{phase} stopped short of its own total");
    }
}
