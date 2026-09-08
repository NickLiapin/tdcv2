//! The pack picker's map, against the shared fixture.
//!
//! The picker is about 5,600 lines across the five implementations and had no test at all — the
//! largest untested surface in the project. Most of it is a terminal loop, and a loop that reads
//! keys is not something a fixture can hold. Its geometry is, and geometry is the part five
//! copies of a coordinate table can quietly disagree about: each implementation keeps its own
//! continent outlines, so one hand-edited number would move a coastline in one language and
//! nowhere else.
//!
//! The tables were identical when this was written — measured, all six continents, every number.
//! The point PROJECTION was not: this crate rounded a half AWAY from zero, which parts company
//! with the others below zero, and Python's ties-to-even parted company with everyone above it.

mod common;

use tdcv2::cli::pack_picker::{map_cell, map_rows, map_size};
use tdcv2::json::Value;

fn fixture() -> Value {
    common::read_fixture("pack-picker.json")
}

fn int(v: &Value, key: &str) -> i64 {
    v.get(key)
        .and_then(Value::as_f64)
        .unwrap_or_else(|| panic!("{key} is missing")) as i64
}

#[test]
fn fits_the_map_to_the_terminal() {
    let f = fixture();
    let cases = f
        .get("mapSizes")
        .and_then(Value::as_array)
        .expect("mapSizes");
    for case in cases {
        let columns = int(case, "columns") as usize;
        let rows = int(case, "rows") as usize;
        let reserved = int(case, "reserved") as usize;
        let half = case
            .get("halfBlocks")
            .and_then(Value::as_bool)
            .expect("halfBlocks");
        let want = match case.get("size") {
            Some(Value::Object(_)) => {
                let s = case.get("size").expect("size");
                Some((int(s, "w") as usize, int(s, "h") as usize))
            }
            _ => None,
        };
        assert_eq!(
            map_size(columns, rows, reserved, half),
            want,
            "{columns}x{rows} reserved {reserved} half-blocks {half}"
        );
    }
}

#[test]
fn rasterises_the_continents_to_the_same_pixels() {
    let f = fixture();
    for case in f.get("rasters").and_then(Value::as_array).expect("rasters") {
        let w = int(case, "w") as usize;
        let h = int(case, "h") as usize;
        let want: Vec<String> = case
            .get("rows")
            .and_then(Value::as_array)
            .expect("rows")
            .iter()
            .map(|r| r.as_str().expect("row").to_string())
            .collect();
        assert_eq!(map_rows(w, h), want, "raster {w}x{h}");
    }
}

#[test]
fn puts_a_country_where_the_country_is() {
    let f = fixture();
    for case in f.get("points").and_then(Value::as_array).expect("points") {
        let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
        let lon = case.get("lon").and_then(Value::as_f64).expect("lon");
        let lat = case.get("lat").and_then(Value::as_f64).expect("lat");
        let w = int(case, "w") as usize;
        let h = int(case, "h") as usize;
        let want = match case.get("cell") {
            Some(Value::Object(_)) => {
                let c = case.get("cell").expect("cell");
                Some((int(c, "col") as usize, int(c, "row") as usize))
            }
            _ => None,
        };
        assert_eq!(map_cell(lon, lat, w, h), want, "{name} on {w}x{h}");
    }
}

#[test]
fn the_frame_is_half_open() {
    // Its top-left corner is on the map and its bottom-right is just past it, the way a pixel
    // grid works. All five agree on both.
    assert_eq!(map_cell(-170.0, 84.0, 56, 22), Some((0, 0)));
    assert_eq!(map_cell(190.0, -56.0, 56, 22), None);
    assert_eq!(map_cell(189.0, -55.0, 56, 22), Some((55, 21)));
    assert_eq!(map_cell(0.0, 90.0, 56, 22), None);
    assert_eq!(map_cell(0.0, -90.0, 56, 22), None);
}

#[test]
fn half_blocks_buy_height() {
    let half = map_size(120, 40, 13, true).expect("half-blocks fit");
    let full = map_size(120, 40, 13, false).expect("full blocks fit");
    assert!(half.0 > full.0, "{half:?} against {full:?}");
}

#[test]
fn refuses_to_draw_rather_than_squash() {
    assert_eq!(map_size(59, 200, 0, true), None); // narrower than the smallest map
    assert_eq!(map_size(200, 14, 13, true), None); // no room for the list beside it
}
