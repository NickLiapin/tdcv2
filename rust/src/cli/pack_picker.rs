//! The interactive picker behind `tdcv2 pack`.
//!
//! The catalogue is 108 bundles and growing. As one flat checkbox list it was
//! unusable: seven rows visible at a time, languages and countries interleaved,
//! and finding Brazil meant paging through the alphabet. So it is browsed the way
//! the catalogue is actually shaped — the locale-agnostic set, then languages,
//! then countries reached through a continent — with search from anywhere and a
//! basket you review before anything is downloaded.
//!
//! The map is not decoration. A continent lights up when you are on it, and every
//! pick burns a spark where that country actually is, so "what have I taken so
//! far" is answerable at a glance. Coordinates come from the registry index, not
//! from a table kept here: the same picker exists in four languages, and four
//! copies of world geography would be four copies that disagree.
//!
//! **Raw input.** The crate takes no dependencies and the standard library has no
//! API for putting a terminal into raw mode, so this shells out to `stty` — the
//! same answer Java reached, and the same reason the picker is Unix-only. The
//! saved settings are handed back verbatim on the way out, so the terminal is as
//! it was even when the picker leaves early. On Windows, and anywhere `stty` is
//! not there, the caller prints the list instead.
//!
//! This module draws and returns a decision. It never touches the network or the
//! disk — the caller installs and removes, which keeps the download progress, the
//! digests and the config writing in one place instead of two.

use std::collections::{BTreeSet, HashMap};
use std::io::{Read, Write};
use std::process::{Command, Stdio};

use crate::packs::registry::Bundle;

/// What the user decided. `None` from [`run`] means they left without confirming.
pub struct Decision {
    pub install: Vec<String>,
    pub remove: Vec<String>,
}

// ── what this terminal can do ────────────────────────────────────────────────

/// Half-blocks and colour are detected, never assumed.
///
/// Modern terminals handle everything here. The old Windows console does not — a
/// raster font has no `▀` — so the drawing falls back to ASCII, and the map to
/// one row per line instead of two rows sharing one.
fn detect_unicode() -> bool {
    if std::env::var_os("TDCV2_ASCII").is_some() {
        return false;
    }
    if cfg!(windows) {
        return ["WT_SESSION", "TERM_PROGRAM", "ConEmuANSI"]
            .iter()
            .any(|key| std::env::var_os(key).is_some());
    }
    let locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok())
        .unwrap_or_default();
    locale.is_empty() || locale.to_lowercase().replace('-', "").contains("utf8")
}

fn detect_colour() -> bool {
    std::env::var_os("NO_COLOR").is_none()
        && std::env::var("TERM").as_deref() != Ok("dumb")
        && std::io::IsTerminal::is_terminal(&std::io::stdout())
}

struct Glyphs {
    cursor: &'static str,
    group: &'static str,
    on: &'static str,
    off: &'static str,
    done: &'static str,
    drop: &'static str,
    chip: &'static str,
    land: &'static str,
}

const RICH: Glyphs = Glyphs {
    cursor: "❯",
    group: "»",
    on: "▣",
    off: "▢",
    done: "✓",
    drop: "✗",
    chip: "■",
    land: "█",
};

const PLAIN: Glyphs = Glyphs {
    cursor: ">",
    group: ">",
    on: "[x]",
    off: "[ ]",
    done: "[+]",
    drop: "[-]",
    chip: "*",
    land: "#",
};

const ESC: &str = "\u{1b}[";

// ── the world ────────────────────────────────────────────────────────────────

struct Continent {
    key: &'static str,
    name: &'static str,
    colour: u8,
    bright: u8,
}

const CONTINENTS: &[Continent] = &[
    Continent {
        key: "europe",
        name: "Europe",
        colour: 34,
        bright: 94,
    },
    Continent {
        key: "asia",
        name: "Asia",
        colour: 35,
        bright: 95,
    },
    Continent {
        key: "africa",
        name: "Africa",
        colour: 33,
        bright: 93,
    },
    Continent {
        key: "north",
        name: "North America",
        colour: 36,
        bright: 96,
    },
    Continent {
        key: "south",
        name: "South America",
        colour: 32,
        bright: 92,
    },
    Continent {
        key: "oceania",
        name: "Oceania",
        colour: 31,
        bright: 91,
    },
];

/// The continents as rough outlines in real coordinates rather than a fixed grid
/// of characters.
///
/// A hand-drawn grid only looks right at the size it was drawn for. Polygons are
/// rasterised to whatever the window allows, so the shapes survive being made
/// bigger — and each landmass's coastline falls out of the same data, which is
/// what lets the map be drawn as outlines.
///
/// The order is the contract: a pixel takes the FIRST continent whose ring holds
/// it, and Europe before Asia is what puts the line between them where it is.
#[allow(clippy::type_complexity)]
const OUTLINES: &[(&str, &[&[[f64; 2]]])] = &[
    (
        "africa",
        &[
            &[
                [-17.0, 15.0],
                [-16.0, 12.0],
                [-13.0, 8.0],
                [-7.0, 4.0],
                [3.0, 6.0],
                [9.0, 4.0],
                [9.0, -1.0],
                [12.0, -6.0],
                [13.0, -13.0],
                [15.0, -22.0],
                [18.0, -34.0],
                [25.0, -34.0],
                [32.0, -26.0],
                [40.0, -16.0],
                [41.0, -2.0],
                [51.0, 12.0],
                [43.0, 12.0],
                [37.0, 22.0],
                [34.0, 28.0],
                [32.0, 31.0],
                [20.0, 32.0],
                [10.0, 34.0],
                [0.0, 36.0],
                [-6.0, 36.0],
                [-10.0, 30.0],
                [-16.0, 22.0],
            ],
            &[
                [44.0, -12.0],
                [50.0, -15.0],
                [50.0, -25.0],
                [45.0, -25.0],
                [43.0, -16.0],
            ],
        ],
    ),
    (
        "europe",
        &[&[
            [-10.0, 36.0],
            [-9.0, 43.0],
            [-2.0, 48.0],
            [-5.0, 50.0],
            [-6.0, 58.0],
            [5.0, 62.0],
            [12.0, 68.0],
            [28.0, 71.0],
            [40.0, 66.0],
            [60.0, 66.0],
            [60.0, 50.0],
            [50.0, 46.0],
            [40.0, 44.0],
            [28.0, 41.0],
            [24.0, 36.0],
            [15.0, 38.0],
            [12.0, 45.0],
            [3.0, 43.0],
        ]],
    ),
    (
        "asia",
        &[&[
            [60.0, 66.0],
            [70.0, 73.0],
            [100.0, 77.0],
            [140.0, 73.0],
            [170.0, 68.0],
            [180.0, 65.0],
            [180.0, 60.0],
            [160.0, 60.0],
            [155.0, 50.0],
            [142.0, 45.0],
            [130.0, 35.0],
            [122.0, 30.0],
            [110.0, 20.0],
            [105.0, 10.0],
            [100.0, 2.0],
            [95.0, 15.0],
            [88.0, 21.0],
            [80.0, 8.0],
            [72.0, 20.0],
            [62.0, 25.0],
            [56.0, 26.0],
            [52.0, 17.0],
            [43.0, 12.0],
            [35.0, 30.0],
            [36.0, 36.0],
            [28.0, 41.0],
            [40.0, 44.0],
            [50.0, 46.0],
            [60.0, 50.0],
        ]],
    ),
    (
        "north",
        &[
            &[
                [-168.0, 66.0],
                [-165.0, 60.0],
                [-152.0, 58.0],
                [-140.0, 60.0],
                [-130.0, 54.0],
                [-125.0, 48.0],
                [-124.0, 40.0],
                [-117.0, 32.0],
                [-110.0, 23.0],
                [-105.0, 20.0],
                [-97.0, 16.0],
                [-92.0, 15.0],
                [-84.0, 10.0],
                [-78.0, 8.0],
                [-83.0, 15.0],
                [-88.0, 21.0],
                [-97.0, 26.0],
                [-94.0, 29.0],
                [-89.0, 29.0],
                [-82.0, 25.0],
                [-81.0, 32.0],
                [-76.0, 37.0],
                [-70.0, 43.0],
                [-66.0, 45.0],
                [-60.0, 47.0],
                [-55.0, 52.0],
                [-64.0, 60.0],
                [-78.0, 62.0],
                [-95.0, 60.0],
                [-85.0, 68.0],
                [-100.0, 70.0],
                [-125.0, 70.0],
                [-140.0, 70.0],
                [-160.0, 71.0],
            ],
            &[
                [-45.0, 60.0],
                [-20.0, 70.0],
                [-20.0, 82.0],
                [-60.0, 83.0],
                [-70.0, 76.0],
                [-55.0, 64.0],
            ],
        ],
    ),
    (
        "south",
        &[&[
            [-81.0, 8.0],
            [-77.0, 1.0],
            [-80.0, -5.0],
            [-71.0, -18.0],
            [-70.0, -25.0],
            [-72.0, -40.0],
            [-75.0, -52.0],
            [-68.0, -55.0],
            [-65.0, -42.0],
            [-62.0, -38.0],
            [-57.0, -35.0],
            [-48.0, -25.0],
            [-40.0, -20.0],
            [-35.0, -8.0],
            [-44.0, -2.0],
            [-50.0, 0.0],
            [-60.0, 6.0],
            [-70.0, 11.0],
            [-77.0, 8.0],
        ]],
    ),
    (
        "oceania",
        &[
            &[
                [114.0, -22.0],
                [113.0, -26.0],
                [115.0, -34.0],
                [129.0, -32.0],
                [138.0, -35.0],
                [147.0, -38.0],
                [150.0, -37.0],
                [153.0, -28.0],
                [146.0, -19.0],
                [142.0, -11.0],
                [136.0, -12.0],
                [130.0, -11.0],
                [125.0, -14.0],
                [122.0, -18.0],
            ],
            &[
                [172.0, -34.0],
                [174.0, -37.0],
                [178.0, -38.0],
                [174.0, -41.0],
                [171.0, -44.0],
                [167.0, -46.0],
                [166.0, -45.0],
                [170.0, -41.0],
            ],
        ],
    ),
];

const LON_MIN: f64 = -170.0;
const LON_MAX: f64 = 190.0;
const LAT_MAX: f64 = 84.0;
const LAT_MIN: f64 = -56.0;

/// Ray casting: is this coordinate inside the ring?
fn inside(lon: f64, lat: f64, ring: &[[f64; 2]]) -> bool {
    let mut hit = false;
    let mut j = ring.len().wrapping_sub(1);
    for i in 0..ring.len() {
        let [xi, yi] = ring[i];
        let [xj, yj] = ring[j];
        if (yi > lat) != (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi {
            hit = !hit;
        }
        j = i;
    }
    hit
}

/// Which continent owns each pixel, and whether that pixel sits on a coastline.
struct Raster {
    land: Vec<Option<&'static str>>,
    edge: Vec<bool>,
}

fn raster(w: usize, h: usize) -> Raster {
    let mut land: Vec<Option<&'static str>> = vec![None; w * h];
    for row in 0..h {
        let lat = LAT_MAX - ((row as f64 + 0.5) / h as f64) * (LAT_MAX - LAT_MIN);
        for col in 0..w {
            let lon = LON_MIN + ((col as f64 + 0.5) / w as f64) * (LON_MAX - LON_MIN);
            for (name, rings) in OUTLINES {
                if rings
                    .iter()
                    .any(|ring| inside(lon, lat, ring) || inside(lon - 360.0, lat, ring))
                {
                    land[row * w + col] = Some(name);
                    break;
                }
            }
        }
    }

    let mut edge = vec![false; w * h];
    for row in 0..h {
        for col in 0..w {
            let here = land[row * w + col];
            if here.is_none() {
                continue;
            }
            edge[row * w + col] = row == 0
                || row == h - 1
                || col == 0
                || col == w - 1
                || land[(row - 1) * w + col] != here
                || land[(row + 1) * w + col] != here
                || land[row * w + col - 1] != here
                || land[row * w + col + 1] != here;
        }
    }

    Raster { land, edge }
}

// ── the picker ───────────────────────────────────────────────────────────────

#[derive(Clone)]
struct Screen {
    screen: String,
    cursor: usize,
    offset: usize,
}

#[derive(Clone, PartialEq)]
enum Kind {
    Pack,
    Group,
    Action,
}

#[derive(Clone)]
struct Item {
    kind: Kind,
    label: String,
    hint: String,
    id: Option<String>,
    to: Option<String>,
    act: Option<&'static str>,
    region: Option<String>,
}

impl Item {
    fn pack(id: &str, label: String, hint: String) -> Item {
        Item {
            kind: Kind::Pack,
            label,
            hint,
            id: Some(id.to_string()),
            to: None,
            act: None,
            region: None,
        }
    }

    fn group(to: &str, label: &str, hint: String) -> Item {
        Item {
            kind: Kind::Group,
            label: label.to_string(),
            hint,
            id: None,
            to: Some(to.to_string()),
            act: None,
            region: None,
        }
    }

    fn action(act: &'static str, label: String, hint: String) -> Item {
        Item {
            kind: Kind::Action,
            label,
            hint,
            id: None,
            to: None,
            act: Some(act),
            region: None,
        }
    }
}

fn human_size(bytes: i64) -> String {
    if bytes < 102_400 {
        format!("{} KB", (bytes as f64 / 1024.0).round() as i64)
    } else {
        format!("{:.1} MB", bytes as f64 / 1_048_576.0)
    }
}

/// "Argentina (country)" is right in a printed list and noise in a screen that
/// says so already.
fn plain_name(name: &str) -> String {
    for suffix in [" (country)", " (language)", " (locale-agnostic)"] {
        if let Some(head) = name.strip_suffix(suffix) {
            return head.trim_end().to_string();
        }
    }
    name.to_string()
}

/// The picker's whole state: what is on screen, what is in the basket, and what
/// the terminal can draw.
struct Picker<'a> {
    bundles: &'a [Bundle],
    installed: BTreeSet<String>,
    selected: BTreeSet<String>,
    dropping: BTreeSet<String>,
    stack: Vec<Screen>,
    query: String,
    flash: String,
    body_visible: bool,
    unicode: bool,
    colour: bool,
    glyphs: &'static Glyphs,
    rasters: HashMap<(usize, usize), Raster>,
}

impl<'a> Picker<'a> {
    fn new(bundles: &'a [Bundle], installed: BTreeSet<String>) -> Picker<'a> {
        let unicode = detect_unicode();
        Picker {
            bundles,
            installed,
            selected: BTreeSet::new(),
            dropping: BTreeSet::new(),
            stack: vec![Screen {
                screen: "start".to_string(),
                cursor: 0,
                offset: 0,
            }],
            query: String::new(),
            flash: String::new(),
            body_visible: false,
            unicode,
            colour: detect_colour(),
            glyphs: if unicode { &RICH } else { &PLAIN },
            rasters: HashMap::new(),
        }
    }

    fn sgr(&self, text: &str, code: &str) -> String {
        if self.colour {
            format!("{ESC}{code}m{text}{ESC}0m")
        } else {
            text.to_string()
        }
    }

    fn dim(&self, text: &str) -> String {
        self.sgr(text, "2")
    }

    fn bold(&self, text: &str) -> String {
        self.sgr(text, "1")
    }

    fn by_id(&self, id: &str) -> Option<&Bundle> {
        self.bundles.iter().find(|b| b.id == id)
    }

    fn size_of(&self, id: &str) -> String {
        human_size(self.by_id(id).map_or(0, |b| b.bytes))
    }

    fn languages(&self) -> Vec<&Bundle> {
        self.bundles.iter().filter(|b| b.locale.is_some()).collect()
    }

    fn countries(&self) -> Vec<&Bundle> {
        self.bundles
            .iter()
            .filter(|b| b.country.is_some())
            .collect()
    }

    fn neither(&self) -> Vec<&Bundle> {
        self.bundles
            .iter()
            .filter(|b| b.locale.is_none() && b.country.is_none())
            .collect()
    }

    fn in_region(&self, key: &str) -> Vec<&Bundle> {
        self.countries()
            .into_iter()
            .filter(|b| b.regions.iter().any(|r| r == key))
            .collect()
    }

    fn not_installed(&self) -> Vec<String> {
        self.bundles
            .iter()
            .map(|b| b.id.clone())
            .filter(|id| !self.installed.contains(id))
            .collect()
    }

    fn picked_in(&self, list: &[&Bundle]) -> usize {
        list.iter()
            .filter(|b| self.selected.contains(&b.id))
            .count()
    }

    /// The largest map that still leaves room for the list, or nothing when
    /// nothing sensible fits.
    fn map_size(&self, columns: usize, rows: usize, reserved: usize) -> Option<(usize, usize)> {
        let mut w = columns.saturating_sub(4).min(132);
        while w >= 56 {
            // 360 degrees of longitude against 140 of latitude: keep the ratio so
            // nothing is squashed.
            let h = (((w as f64 * 0.39) / 2.0).round() as usize * 2).max(2);
            let drawn = if self.unicode && self.colour {
                h / 2
            } else {
                h
            };
            if drawn + reserved <= rows {
                return Some((w, h));
            }
            w -= 4;
        }
        None
    }

    fn items_for(&self, state: &Screen) -> Vec<Item> {
        match state.screen.as_str() {
            "start" => {
                let rest = self.not_installed();
                let total: i64 = rest
                    .iter()
                    .map(|id| self.by_id(id).map_or(0, |b| b.bytes))
                    .sum();
                let mut items = vec![
                    Item::action(
                        "all",
                        "Everything".to_string(),
                        if rest.is_empty() {
                            "already installed".to_string()
                        } else {
                            format!("{} not installed · {}", rest.len(), human_size(total))
                        },
                    ),
                    Item::group(
                        "browse",
                        "Choose what I need",
                        "by language, by country, or search".to_string(),
                    ),
                ];
                if !self.installed.is_empty() {
                    items.push(Item::group(
                        "installed",
                        "Installed packs",
                        format!(
                            "{} here · remove any you no longer want",
                            self.installed.len()
                        ),
                    ));
                }
                items
            }
            "browse" => {
                let languages = self.languages();
                let countries = self.countries();
                let mut items: Vec<Item> = self
                    .neither()
                    .iter()
                    .map(|b| {
                        Item::pack(
                            &b.id,
                            plain_name(&b.name),
                            b.description.chars().take(64).collect(),
                        )
                    })
                    .collect();
                let picked_languages = self.picked_in(&languages);
                let picked_countries = self.picked_in(&countries);
                items.push(Item::group(
                    "languages",
                    "Languages",
                    format!(
                        "{} available{}",
                        languages.len(),
                        if picked_languages > 0 {
                            format!(" · {picked_languages} picked")
                        } else {
                            String::new()
                        }
                    ),
                ));
                items.push(Item::group(
                    "regions",
                    "Countries",
                    format!(
                        "{} available{}",
                        countries.len(),
                        if picked_countries > 0 {
                            format!(" · {picked_countries} picked")
                        } else {
                            String::new()
                        }
                    ),
                ));
                items.push(Item::group(
                    "review",
                    "Review and install",
                    if self.selected.is_empty() {
                        "basket is empty".to_string()
                    } else {
                        format!("{} in the basket", self.selected.len())
                    },
                ));
                items
            }
            "languages" => self
                .languages()
                .iter()
                .map(|b| {
                    Item::pack(
                        &b.id,
                        plain_name(&b.name),
                        format!("{} · {}", b.id, self.size_of(&b.id)),
                    )
                })
                .collect(),
            "regions" => CONTINENTS
                .iter()
                .map(|c| {
                    let here = self.in_region(c.key);
                    let picked = self.picked_in(&here);
                    let mut item = Item::group(
                        &format!("region:{}", c.key),
                        c.name,
                        format!(
                            "{} countries{}",
                            here.len(),
                            if picked > 0 {
                                format!(" · {picked} picked")
                            } else {
                                String::new()
                            }
                        ),
                    );
                    item.region = Some(c.key.to_string());
                    item
                })
                .collect(),
            "installed" => self
                .installed
                .iter()
                .map(|id| {
                    Item::pack(
                        id,
                        plain_name(self.by_id(id).map_or(id.as_str(), |b| b.name.as_str())),
                        if self.dropping.contains(id) {
                            "marked for removal".to_string()
                        } else {
                            format!("{id} · installed")
                        },
                    )
                })
                .collect(),
            "review" => {
                if self.selected.is_empty() && self.dropping.is_empty() {
                    return Vec::new();
                }
                let total: i64 = self
                    .selected
                    .iter()
                    .map(|id| self.by_id(id).map_or(0, |b| b.bytes))
                    .sum();
                let mut items: Vec<Item> = self
                    .selected
                    .iter()
                    .map(|id| {
                        Item::pack(
                            id,
                            plain_name(self.by_id(id).map_or(id.as_str(), |b| b.name.as_str())),
                            format!("{id} · {}", self.size_of(id)),
                        )
                    })
                    .collect();
                for id in &self.dropping {
                    items.push(Item::pack(
                        id,
                        plain_name(self.by_id(id).map_or(id.as_str(), |b| b.name.as_str())),
                        "will be removed".to_string(),
                    ));
                }
                let mut what: Vec<String> = Vec::new();
                if !self.selected.is_empty() {
                    what.push(format!("install {}", self.selected.len()));
                }
                if !self.dropping.is_empty() {
                    what.push(format!("remove {}", self.dropping.len()));
                }
                items.push(Item::action(
                    "confirm",
                    format!("Apply — {}", what.join(", ")),
                    if self.selected.is_empty() {
                        String::new()
                    } else {
                        human_size(total)
                    },
                ));
                items
            }
            "search" => {
                let q = self.query.trim().to_lowercase();
                if q.is_empty() {
                    return Vec::new();
                }
                self.bundles
                    .iter()
                    .filter(|b| {
                        b.id.contains(&q) || plain_name(&b.name).to_lowercase().contains(&q)
                    })
                    .map(|b| {
                        let where_ = if b.locale.is_some() {
                            "language".to_string()
                        } else if b.country.is_some() {
                            CONTINENTS
                                .iter()
                                .filter(|c| b.regions.iter().any(|r| r == c.key))
                                .map(|c| c.name)
                                .collect::<Vec<_>>()
                                .join(" / ")
                        } else {
                            "no language, no country".to_string()
                        };
                        Item::pack(
                            &b.id,
                            plain_name(&b.name),
                            format!("{where_} · {}", self.size_of(&b.id)),
                        )
                    })
                    .collect()
            }
            other => {
                let key = other.trim_start_matches("region:");
                self.in_region(key)
                    .iter()
                    .map(|b| {
                        Item::pack(
                            &b.id,
                            plain_name(&b.name),
                            format!(
                                "{} · {}{}",
                                b.id,
                                self.size_of(&b.id),
                                if b.regions.len() > 1 {
                                    " · spans two continents"
                                } else {
                                    ""
                                }
                            ),
                        )
                    })
                    .collect()
            }
        }
    }

    fn title_for(&self, state: &Screen) -> String {
        match state.screen.as_str() {
            "start" => "Data packs".to_string(),
            "browse" => "Data packs › Choose".to_string(),
            "languages" => "Data packs › Languages".to_string(),
            "regions" => "Data packs › Countries".to_string(),
            "installed" => "Data packs › Installed".to_string(),
            "review" => "Data packs › Review".to_string(),
            "search" => "Data packs › Search".to_string(),
            other => {
                let key = other.trim_start_matches("region:");
                let name = CONTINENTS
                    .iter()
                    .find(|c| c.key == key)
                    .map_or(key, |c| c.name);
                format!("Data packs › Countries › {name}")
            }
        }
    }
}

impl Picker<'_> {
    fn counts_by_region(&self) -> HashMap<&'static str, usize> {
        CONTINENTS
            .iter()
            .map(|c| (c.key, self.picked_in(&self.in_region(c.key))))
            .collect()
    }

    fn render_map(
        &mut self,
        w: usize,
        h: usize,
        focused: Option<&str>,
        columns: usize,
    ) -> Vec<String> {
        // Rasterising a hundred thousand pixels is worth doing once per window
        // size, not once per keystroke.
        self.rasters.entry((w, h)).or_insert_with(|| raster(w, h));
        let counts = self.counts_by_region();
        let mut lit: BTreeSet<usize> = BTreeSet::new();
        for id in &self.selected {
            let Some([lon, lat]) = self.by_id(id).and_then(|b| b.point) else {
                continue;
            };
            let col = (((lon - LON_MIN) / (LON_MAX - LON_MIN)) * w as f64 - 0.5).round();
            let row = (((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * h as f64 - 0.5).round();
            if col >= 0.0 && col < w as f64 && row >= 0.0 && row < h as f64 {
                lit.insert(row as usize * w + col as usize);
            }
        }

        let map = &self.rasters[&(w, h)];
        // Land you have not chosen is a grey body under a coloured coastline: the
        // shape stays readable, but nothing is filled in until you pick it.
        let shade = |index: usize| -> Option<String> {
            if lit.contains(&index) {
                return Some("1;97".to_string());
            }
            let key = map.land[index]?;
            let continent = CONTINENTS.iter().find(|c| c.key == key)?;
            let is_edge = map.edge[index];
            if Some(key) == focused {
                return Some(if is_edge {
                    format!("1;{}", continent.bright)
                } else {
                    continent.colour.to_string()
                });
            }
            if counts.get(key).copied().unwrap_or(0) > 0 {
                return Some(if is_edge {
                    continent.bright.to_string()
                } else {
                    format!("2;{}", continent.colour)
                });
            }
            if is_edge {
                return Some(continent.colour.to_string());
            }
            if self.body_visible {
                Some("90".to_string())
            } else {
                None
            }
        };

        let mut lines: Vec<String> = Vec::new();
        if self.unicode && self.colour {
            for row in (0..h).step_by(2) {
                let mut line = String::from("  ");
                for col in 0..w {
                    let upper = shade(row * w + col);
                    let lower = if row + 1 < h {
                        shade((row + 1) * w + col)
                    } else {
                        None
                    };
                    match (upper, lower) {
                        (None, None) => line.push(' '),
                        // One cell, two pixels: the top is drawn, the bottom
                        // becomes its background.
                        (Some(up), Some(down)) => {
                            let background: u32 = down
                                .rsplit(';')
                                .next()
                                .and_then(|n| n.parse::<u32>().ok())
                                .unwrap_or(0)
                                + 10;
                            line.push_str(&format!("{ESC}{up};{background}m▀{ESC}0m"));
                        }
                        (Some(up), None) => line.push_str(&format!("{ESC}{up}m▀{ESC}0m")),
                        (None, Some(down)) => line.push_str(&format!("{ESC}{down}m▄{ESC}0m")),
                    }
                }
                lines.push(line);
            }
        } else {
            // No half-blocks, or no colour to tell the two pixels apart: one row
            // per line, coastlines only. Still a world, and it still shows where a
            // pick landed.
            for row in 0..h {
                let mut line = String::from("  ");
                for col in 0..w {
                    let index = row * w + col;
                    let code = shade(index);
                    let skip = code.is_none()
                        || (!self.colour && !map.edge[index] && !lit.contains(&index));
                    if skip {
                        line.push(' ');
                        continue;
                    }
                    match code {
                        Some(code) if self.colour => {
                            line.push_str(&format!("{ESC}{code}m{}{ESC}0m", self.glyphs.land));
                        }
                        _ => line.push_str(self.glyphs.land),
                    }
                }
                lines.push(line);
            }
        }

        let chips: Vec<String> = CONTINENTS
            .iter()
            .map(|c| {
                let picked = counts.get(c.key).copied().unwrap_or(0);
                let label = if picked > 0 {
                    format!("{} ({picked})", c.name)
                } else {
                    c.name.to_string()
                };
                self.sgr(
                    &format!("{} {label}", self.glyphs.chip),
                    &if Some(c.key) == focused {
                        format!("1;{}", c.bright)
                    } else {
                        format!("2;{}", c.colour)
                    },
                )
            })
            .collect();
        lines.push(String::new());
        if columns >= 92 {
            lines.push(format!("  {}", chips.join("   ")));
        } else {
            lines.push(format!("  {}", chips[..3].join("   ")));
            lines.push(format!("  {}", chips[3..].join("   ")));
        }
        lines
    }

    fn draw(&mut self, out: &mut dyn Write) {
        let (columns, rows) = Stty::size();
        let state = self.stack.last().expect("the stack never empties").clone();
        let items = self.items_for(&state);

        let on_map = state.screen == "regions" || state.screen.starts_with("region:");
        let size = if on_map {
            self.map_size(columns, rows, 13)
        } else {
            None
        };
        let chrome = match size {
            Some((_, h)) => {
                (if self.unicode && self.colour {
                    h / 2
                } else {
                    h
                }) + 13
            }
            None => 8,
        };
        let viewport = items.len().min(rows.saturating_sub(chrome)).max(4);

        // An empty list still has to draw: clamp the cursor before the row loop
        // reads it.
        let last = items.len().saturating_sub(1);
        let here = self.stack.last_mut().expect("the stack never empties");
        here.cursor = here.cursor.min(last);
        if here.cursor < here.offset {
            here.offset = here.cursor;
        }
        if here.cursor >= here.offset + viewport {
            here.offset = here.cursor - viewport + 1;
        }
        let (cursor, offset) = (here.cursor, here.offset);

        let mut lines: Vec<String> = vec![
            format!("{ESC}2J{ESC}H"),
            String::new(),
            format!("  {}", self.bold(&self.title_for(&state))),
            String::new(),
        ];

        if let Some((w, h)) = size {
            let focused: Option<String> = if state.screen.starts_with("region:") {
                Some(state.screen.trim_start_matches("region:").to_string())
            } else {
                items.get(cursor).and_then(|i| i.region.clone())
            };
            lines.extend(self.render_map(w, h, focused.as_deref(), columns));
            lines.push(String::new());
        }

        if state.screen == "search" {
            let shown = if self.query.is_empty() {
                self.dim("type a name…")
            } else {
                self.bold(&self.query)
            };
            lines.push(format!("  Search: {shown}"));
            lines.push(String::new());
        }

        if items.is_empty() {
            lines.push(self.dim(match state.screen.as_str() {
                "search" => "  nothing matches",
                "review" => "  Nothing picked yet — go back and choose something.",
                _ => "  empty",
            }));
        }

        let visible = items.len().min(offset + viewport);
        for (i, item) in items[offset..visible].iter().enumerate() {
            let i = offset + i;
            let on_this = i == cursor;
            let mark = match (&item.kind, item.id.as_deref()) {
                (Kind::Pack, Some(id)) => {
                    if self.dropping.contains(id) {
                        self.bold(&format!(" {} ", self.glyphs.drop))
                    } else if self.selected.contains(id) {
                        self.bold(&format!(" {} ", self.glyphs.on))
                    } else if self.installed.contains(id) {
                        self.dim(&format!(" {} ", self.glyphs.done))
                    } else {
                        format!(" {} ", self.glyphs.off)
                    }
                }
                (Kind::Group, _) => format!(" {} ", self.glyphs.group),
                _ => "   ".to_string(),
            };
            let label = format!("{:<26}", item.label);
            let cursor_mark = if on_this {
                self.bold(self.glyphs.cursor)
            } else {
                " ".to_string()
            };
            let shown = if on_this { self.bold(&label) } else { label };
            lines.push(format!(
                "  {cursor_mark}{mark}{shown} {}",
                self.dim(&item.hint)
            ));
        }

        if items.len() > viewport {
            lines.push(String::new());
            lines.push(self.dim(&format!(
                "  {}–{} of {}",
                offset + 1,
                items.len().min(offset + viewport),
                items.len()
            )));
        }

        lines.push(String::new());
        lines.push(self.dim(&format!("  {}", match state.screen.as_str() {
            "search" => "↑↓ move · enter pick · esc leave search",
            "review" => "↑↓ move · space drop · enter apply · backspace back · q cancel",
            "installed" => "↑↓ move · space mark for removal · backspace back · q cancel",
            _ => "↑↓ move · enter open · space pick · / search · m map · backspace back · q cancel",
        })));

        if !self.selected.is_empty() || !self.dropping.is_empty() {
            let mut parts: Vec<String> = Vec::new();
            if !self.selected.is_empty() {
                parts.push(format!("{} to install", self.selected.len()));
            }
            if !self.dropping.is_empty() {
                parts.push(format!("{} to remove", self.dropping.len()));
            }
            lines.push(format!(
                "  {}{}",
                self.dim("basket: "),
                self.bold(&parts.join(", "))
            ));
        }
        if !self.flash.is_empty() {
            lines.push(String::new());
            lines.push(format!("  {}", self.flash));
        }

        let _ = writeln!(out, "{}", lines.join("\n"));
        let _ = out.flush();
    }
}

// ── the terminal ─────────────────────────────────────────────────────────────

/// Raw mode, borrowed from `stty`.
///
/// The standard library has no API for this and the crate takes no dependencies,
/// so shelling out is the answer — the same one Java reached, and the reason the
/// picker is Unix-only. The saved settings are handed back verbatim on the way
/// out, so the terminal is exactly as it was even when the picker leaves early.
struct Stty;

impl Stty {
    fn enter_raw() -> Option<String> {
        let saved = Stty::run(&["-g"])?;
        Stty::run(&["raw", "-echo"])?;
        Some(saved)
    }

    fn restore(saved: &str) {
        if !saved.trim().is_empty() {
            Stty::run(&[saved.trim()]);
        }
    }

    /// The window, or a conservative default when `stty` cannot say.
    fn size() -> (usize, usize) {
        let parsed = Stty::run(&["size"]).and_then(|out| {
            let parts: Vec<&str> = out.split_whitespace().collect();
            match (
                parts.first()?.parse::<usize>(),
                parts.get(1)?.parse::<usize>(),
            ) {
                (Ok(rows), Ok(columns)) => Some((columns, rows)),
                _ => None,
            }
        });
        parsed.unwrap_or((80, 24))
    }

    /// Whether this system has `stty` at all — which is what decides between the
    /// picker and the plain list.
    fn available() -> bool {
        Stty::run(&["-g"]).is_some()
    }

    fn run(args: &[&str]) -> Option<String> {
        let output = Command::new("stty")
            .args(args)
            .stdin(Stdio::inherit())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        if output.status.success() {
            Some(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            None
        }
    }
}

/// Escape sequences decoded once, so the loop reads plainly.
fn read_key(input: &mut dyn Read) -> String {
    let next = |input: &mut dyn Read| -> i32 {
        let mut byte = [0u8; 1];
        match input.read(&mut byte) {
            Ok(1) => i32::from(byte[0]),
            _ => -1,
        }
    };

    let first = next(input);
    match first {
        -1 | 3 => return "quit".to_string(),
        13 | 10 => return "enter".to_string(),
        127 | 8 => return "backspace".to_string(),
        32 => return "space".to_string(),
        27 => {}
        other => {
            return char::from_u32(other as u32).map_or_else(String::new, |c| c.to_string());
        }
    }

    let second = next(input);
    if second != i32::from(b'[') && second != i32::from(b'O') {
        return "escape".to_string();
    }
    let third = next(input);
    match u8::try_from(third).unwrap_or(0) {
        b'A' => "up".to_string(),
        b'B' => "down".to_string(),
        b'C' => "right".to_string(),
        b'D' => "left".to_string(),
        b'H' => "home".to_string(),
        b'F' => "end".to_string(),
        digit @ (b'5' | b'6' | b'1' | b'4') => {
            // A numbered sequence runs on to its `~`; swallow it or the tail
            // arrives as separate keystrokes.
            let mut ch = next(input);
            while ch >= 0 && ch != i32::from(b'~') {
                ch = next(input);
            }
            match digit {
                b'5' => "pageup".to_string(),
                b'6' => "pagedown".to_string(),
                b'1' => "home".to_string(),
                _ => "end".to_string(),
            }
        }
        _ => "unknown".to_string(),
    }
}

// ── the loop ─────────────────────────────────────────────────────────────────

/// Whether this terminal can host the picker at all.
///
/// Both ends have to be a terminal — a piped stdin has no keystrokes and a piped
/// stdout has nowhere to draw — and `stty` has to exist to turn off line
/// buffering. Anywhere else the caller prints the list, which answers the same
/// question with less ceremony.
pub fn usable() -> bool {
    std::io::IsTerminal::is_terminal(&std::io::stdin())
        && std::io::IsTerminal::is_terminal(&std::io::stdout())
        && Stty::available()
}

/// Puts the terminal back the way it was found — on drop, so a panic anywhere
/// in the picker cannot leave the shell in `raw -echo` with a hidden cursor.
/// Straight-line restore code is skipped by unwinding; a destructor is not.
struct RawGuard {
    saved: String,
}

impl Drop for RawGuard {
    fn drop(&mut self) {
        let mut stdout = std::io::stdout();
        let _ = write!(stdout, "{ESC}?25h{ESC}2J{ESC}H");
        let _ = stdout.flush();
        Stty::restore(&self.saved);
    }
}

/// Browse the catalogue and come back with what to install and what to remove.
pub fn run(bundles: &[Bundle], installed: BTreeSet<String>) -> Option<Decision> {
    let _guard = RawGuard {
        saved: Stty::enter_raw()?,
    };
    let mut picker = Picker::new(bundles, installed);
    let mut stdout = std::io::stdout();
    let mut stdin = std::io::stdin();

    let _ = write!(stdout, "{ESC}?25l");
    picker.loop_until_done(&mut stdin, &mut stdout)
    // `_guard` drops here — and on any early return or panic above.
}

impl Picker<'_> {
    fn toggle(&mut self, id: &str) {
        let on_installed_screen = self.stack.last().is_some_and(|s| s.screen == "installed");
        if on_installed_screen || self.dropping.contains(id) {
            if !self.dropping.remove(id) {
                self.dropping.insert(id.to_string());
            }
            return;
        }
        if self.installed.contains(id) {
            self.flash = self.dim(&format!("{id} is already installed"));
            return;
        }
        if !self.selected.remove(id) {
            self.selected.insert(id.to_string());
        }
    }

    fn loop_until_done(&mut self, input: &mut dyn Read, out: &mut dyn Write) -> Option<Decision> {
        loop {
            self.draw(out);
            let key = read_key(input);
            let state = self.stack.last().expect("the stack never empties").clone();
            let items = self.items_for(&state);
            self.flash = String::new();

            if key == "quit" || key == "q" && state.screen != "search" {
                return None;
            }

            if state.screen == "search" {
                match key.as_str() {
                    "escape" => {
                        self.stack.pop();
                        self.query.clear();
                        continue;
                    }
                    "backspace" => {
                        self.query.pop();
                        self.set_cursor(0);
                        continue;
                    }
                    "space" => {
                        self.query.push(' ');
                        self.set_cursor(0);
                        continue;
                    }
                    "enter" => {
                        if let Some(id) = items.get(state.cursor).and_then(|i| i.id.clone()) {
                            self.toggle(&id);
                        }
                        continue;
                    }
                    other if other.chars().count() == 1 => {
                        self.query.push_str(other);
                        self.set_cursor(0);
                        continue;
                    }
                    _ => {}
                }
            }

            let last = items.len().saturating_sub(1);
            match key.as_str() {
                "up" => self.move_cursor(-1, last),
                "down" => self.move_cursor(1, last),
                "pageup" => self.move_cursor(-10, last),
                "pagedown" => self.move_cursor(10, last),
                "home" => self.set_cursor(0),
                "end" => self.set_cursor(last),
                "m" => {
                    self.body_visible = !self.body_visible;
                    self.flash = self.dim(if self.body_visible {
                        "land filled"
                    } else {
                        "coastlines only"
                    });
                }
                "space" => match items.get(state.cursor) {
                    Some(item) if item.kind == Kind::Pack => {
                        if let Some(id) = item.id.clone() {
                            self.toggle(&id);
                        }
                    }
                    Some(item) if item.kind == Kind::Group => {
                        if let Some(to) = item.to.clone().filter(|t| t.starts_with("region:")) {
                            self.take_continent(to.trim_start_matches("region:"));
                        }
                    }
                    _ => {}
                },
                "enter" => {
                    let Some(item) = items.get(state.cursor).cloned() else {
                        continue;
                    };
                    match item.kind {
                        Kind::Group => {
                            if let Some(to) = item.to {
                                self.stack.push(Screen {
                                    screen: to,
                                    cursor: 0,
                                    offset: 0,
                                });
                            }
                        }
                        Kind::Action if item.act == Some("all") => {
                            for id in self.not_installed() {
                                self.selected.insert(id);
                            }
                            self.stack.push(Screen {
                                screen: "review".to_string(),
                                cursor: 0,
                                offset: 0,
                            });
                        }
                        Kind::Action if item.act == Some("confirm") => {
                            return Some(Decision {
                                install: self.selected.iter().cloned().collect(),
                                remove: self.dropping.iter().cloned().collect(),
                            });
                        }
                        _ => {}
                    }
                }
                "backspace" | "escape" | "left" => {
                    if self.stack.len() > 1 {
                        self.stack.pop();
                    }
                }
                "/" => {
                    self.stack.push(Screen {
                        screen: "search".to_string(),
                        cursor: 0,
                        offset: 0,
                    });
                    self.query.clear();
                }
                _ => {}
            }
        }
    }

    /// Space on a continent takes the whole continent — the shortcut for "all of
    /// Africa".
    fn take_continent(&mut self, key: &str) {
        let here: Vec<String> = self
            .in_region(key)
            .into_iter()
            .filter(|b| !self.installed.contains(&b.id))
            .map(|b| b.id.clone())
            .collect();
        let all = here.iter().all(|id| self.selected.contains(id));
        for id in here {
            if all {
                self.selected.remove(&id);
            } else {
                self.selected.insert(id);
            }
        }
        self.flash = self.dim(if all {
            "continent cleared"
        } else {
            "whole continent added"
        });
    }

    fn set_cursor(&mut self, to: usize) {
        if let Some(state) = self.stack.last_mut() {
            state.cursor = to;
        }
    }

    fn move_cursor(&mut self, by: isize, last: usize) {
        if let Some(state) = self.stack.last_mut() {
            let next = state.cursor as isize + by;
            state.cursor = next.clamp(0, last as isize) as usize;
        }
    }
}
