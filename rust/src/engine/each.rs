//! `each="NAME"` on a `<line>` or a `<group>` — its output once per element of a list or record
//! of a pool.
//!
//! Shared by the in-memory and the streaming engine, which used to carry a copy each. Both
//! copies asked a `<data if=…>` once per ROW, so a condition naming the element — `_item`, or
//! the list itself — saw the row instead; the reference asks it once per element, with the
//! element in scope.
//!
//! The walked name is a list (a `repeat=` sequence) or a pool. A list element overlays the name
//! itself; a pool record overlays every field as `Pool.field`, nested records included
//! (`Doctors.dept.name`), since the pool table publishes them under those paths. The `if=` is
//! asked of each element too, and the positions — `Pool._item`, `Pool._first`, `Pool._last` —
//! are counted over the elements it KEEPS: `_last` is the last line printed, which is what a
//! JSON array needs to know before its comma, whatever the filter dropped after it.
//!
//! A `<group>` nests: its element is in scope for every line inside it, an inner group's on top
//! of an outer one's. The views are trait objects for that reason — a generic overlay of an
//! overlay of an overlay would be a new type at every depth, and a group can be nested as deep as
//! the config likes.

use super::EngineResult;
use crate::expr::evaluate;
use crate::format::interpolate::{self, Lookup};
use crate::generators::repeat;
use crate::model::Line;
use crate::sequence::pool::PoolTable;

/// The pool of a name, if the config declares one.
pub(super) type PoolOf<'p> = &'p dyn Fn(&str) -> Option<&'p PoolTable>;

/// The output lines of one `each` line on one row, each with its newline attached.
pub(super) fn render(
    line: &Line,
    name: &str,
    row: usize,
    inject: Option<&str>,
    each_info: &[(String, repeat::Spec)],
    pools: PoolOf<'_>,
    base: &dyn Lookup,
) -> EngineResult<Vec<String>> {
    let mut out = Vec::new();
    for overlay in overlays(name, line.if_expr.as_deref(), row, each_info, pools, base)? {
        let view = Overlay {
            base,
            values: &overlay,
        };
        out.push(text_of(line, inject, &view)?);
    }
    Ok(out)
}

/// `<group>`: its lines and groups, once per element it walks — or once, or not at all.
///
/// With `each=` the items print once per element of a list or record of a pool, with that
/// element in scope for every one of them, so an inner `each` can keep the doctors of the
/// department being printed (`Doctors.dept.id == Depts.id`). Without it, `if=` decides all of
/// them at once, in the scope around the group.
pub(super) fn render_group(
    group: &Line,
    row: usize,
    inject: Option<&str>,
    each_info: &[(String, repeat::Spec)],
    pools: PoolOf<'_>,
    base: &dyn Lookup,
) -> EngineResult<Vec<String>> {
    let name = group.each.as_deref().map(str::trim).unwrap_or("");
    let scopes = if name.is_empty() {
        let keep = holds(group.if_expr.as_deref(), &Overlay { base, values: &[] })?;
        if keep {
            vec![Vec::new()]
        } else {
            Vec::new()
        }
    } else {
        overlays(name, group.if_expr.as_deref(), row, each_info, pools, base)?
    };
    let mut out = Vec::new();
    for overlay in &scopes {
        let view = Overlay {
            base,
            values: overlay,
        };
        for item in group.items.iter().flatten() {
            out.extend(render_item(item, row, inject, each_info, pools, &view)?);
        }
    }
    Ok(out)
}

/// One line or group inside a group, in the scope the groups around it put in place.
fn render_item(
    item: &Line,
    row: usize,
    inject: Option<&str>,
    each_info: &[(String, repeat::Spec)],
    pools: PoolOf<'_>,
    view: &dyn Lookup,
) -> EngineResult<Vec<String>> {
    if item.items.is_some() {
        return render_group(item, row, inject, each_info, pools, view);
    }
    if let Some(name) = item
        .each
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    {
        return render(item, name, row, inject, each_info, pools, view);
    }
    if !holds(
        item.if_expr.as_deref(),
        &Overlay {
            base: view,
            values: &[],
        },
    )? {
        return Ok(Vec::new());
    }
    Ok(vec![text_of(item, inject, view)?])
}

/// One printed line: the `<data>` parts whose condition holds, interpolated, newline attached.
fn text_of(line: &Line, inject: Option<&str>, view: &dyn Lookup) -> EngineResult<String> {
    let scope = Overlay {
        base: view,
        values: &[],
    };
    let mut template = String::new();
    for part in &line.parts {
        if holds(part.if_expr.as_deref(), &scope)? {
            template.push_str(&part.text);
        }
    }
    let mut text = interpolate::apply(&template, inject, &scope)?;
    text.push('\n');
    Ok(text)
}

/// One overlay per element printed, positions included, after `keep` has dropped some.
fn overlays(
    name: &str,
    keep: Option<&str>,
    row: usize,
    each_info: &[(String, repeat::Spec)],
    pools: PoolOf<'_>,
    base: &dyn Lookup,
) -> EngineResult<Vec<Vec<(String, String)>>> {
    let mut candidates: Vec<Vec<(String, String)>> = Vec::new();
    // A sequence of the same name wins over a pool, as it does everywhere a name is read.
    match pools(name).filter(|_| !base.has(name)) {
        Some(table) => {
            for m in 0..table.count {
                let mut overlay = vec![
                    ("_item".to_string(), (m + 1).to_string()),
                    ("_item_id".to_string(), (m + 1).to_string()),
                ];
                for field in &table.fields {
                    let value = table
                        .columns
                        .get(field)
                        .and_then(|c| c.get(m))
                        .cloned()
                        .unwrap_or_default();
                    overlay.push((format!("{name}.{field}"), value));
                }
                candidates.push(overlay);
            }
        }
        None => {
            let spec = each_info.iter().find(|(n, _)| n == name).map(|(_, s)| s);
            let cell = base.value(name);
            let elements = repeat::split(
                Some(cell.as_str()),
                spec.map_or(repeat::DEFAULT_SEPARATOR, |s| s.separator.as_str()),
            );
            // Lanes: two repeating sequences write into the same child table, so each gets its
            // own slice of every card's key block rather than sharing one counter.
            let (mut lane, mut stride) = (0i64, 0i64);
            for (other, info) in each_info {
                if other == name {
                    lane = stride;
                }
                stride += i64::from(info.max);
            }
            if stride == 0 {
                stride = elements.len() as i64;
            }
            for (k, element) in elements.into_iter().enumerate() {
                let key = repeat::item_key(row as i64 + 1, (k + 1) as i64, lane, stride);
                candidates.push(vec![
                    (name.to_string(), element),
                    ("_item".to_string(), (k + 1).to_string()),
                    ("_item_id".to_string(), key.to_string()),
                ]);
            }
        }
    }

    let mut kept = Vec::new();
    for overlay in candidates {
        let view = Overlay {
            base,
            values: &overlay,
        };
        if holds(keep, &view)? {
            kept.push(overlay);
        }
    }
    let total = kept.len();
    for (k, overlay) in kept.iter_mut().enumerate() {
        overlay.push((format!("{name}._item"), (k + 1).to_string()));
        overlay.push((format!("{name}._first"), (k == 0).to_string()));
        overlay.push((format!("{name}._last"), (k + 1 == total).to_string()));
    }
    Ok(kept)
}

fn holds(expression: Option<&str>, view: &Overlay<'_>) -> EngineResult<bool> {
    match expression {
        None => Ok(true),
        Some(expr) => evaluate::as_condition(expr, view),
    }
}

/// The scope around, with one element's names laid over it.
///
/// Shallow on purpose: every other column still resolves per record, which is exactly what
/// makes a foreign key on the repeated line point at the right parent on every emitted row.
struct Overlay<'a> {
    base: &'a dyn Lookup,
    values: &'a [(String, String)],
}

impl Lookup for Overlay<'_> {
    fn has(&self, name: &str) -> bool {
        self.values.iter().any(|(n, _)| n == name) || self.base.has(name)
    }

    fn value(&self, name: &str) -> String {
        match self.values.iter().find(|(n, _)| n == name) {
            Some((_, v)) => v.clone(),
            None => self.base.value(name),
        }
    }
}

/// The same view serves the expression layer, so `${{X}}` and `if="X"` can never disagree
/// about what a name means on a line.
impl evaluate::Scope for Overlay<'_> {
    fn has(&self, name: &str) -> bool {
        Lookup::has(self, name)
    }

    fn value(&self, name: &str) -> String {
        Lookup::value(self, name)
    }
}
