//! `each="NAME"` on a `<line>` — one output line per element of a list or record of a pool.
//!
//! Shared by the in-memory and the streaming engine, which used to carry a copy each. Both
//! copies asked a `<data if=…>` once per ROW, so a condition naming the element — `_item`, or
//! the list itself — saw the row instead; the reference asks it once per element, with the
//! element in scope.
//!
//! The walked name is a list (a `repeat=` sequence) or a pool. A list element overlays the name
//! itself; a pool record overlays every field as `Pool.field`, nested records included
//! (`Doctors.dept.name`), since the pool table publishes them under those paths. The line's own
//! `if=` is asked of each element too, and the positions — `Pool._item`, `Pool._first`,
//! `Pool._last` — are counted over the elements it KEEPS: `_last` is the last line printed,
//! which is what a JSON array needs to know before its comma, whatever the filter dropped
//! after it.

use super::EngineResult;
use crate::expr::evaluate;
use crate::format::interpolate::{self, Lookup};
use crate::generators::repeat;
use crate::model::Line;
use crate::sequence::pool::PoolTable;

/// The output lines of one `each` line on one row, each with its newline attached.
///
/// `table` is the pool of that name, if there is one; a sequence of the same name wins, as
/// it does everywhere a name is read.
#[allow(clippy::too_many_arguments)]
pub(super) fn render<B: Lookup + ?Sized>(
    line: &Line,
    name: &str,
    row: usize,
    inject: Option<&str>,
    each_info: &[(String, repeat::Spec)],
    table: Option<&PoolTable>,
    base: &B,
) -> EngineResult<Vec<String>> {
    let mut candidates: Vec<Vec<(String, String)>> = Vec::new();
    match table.filter(|_| !base.has(name)) {
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
        if holds(
            line.if_expr.as_deref(),
            &Overlay {
                base,
                values: &overlay,
            },
        )? {
            kept.push(overlay);
        }
    }
    let total = kept.len();
    let mut out = Vec::with_capacity(total);
    for (k, mut overlay) in kept.into_iter().enumerate() {
        overlay.push((format!("{name}._item"), (k + 1).to_string()));
        overlay.push((format!("{name}._first"), (k == 0).to_string()));
        overlay.push((format!("{name}._last"), (k + 1 == total).to_string()));
        let view = Overlay {
            base,
            values: &overlay,
        };
        let mut template = String::new();
        for part in &line.parts {
            if holds(part.if_expr.as_deref(), &view)? {
                template.push_str(&part.text);
            }
        }
        let mut text = interpolate::apply(&template, inject, &view)?;
        text.push('\n');
        out.push(text);
    }
    Ok(out)
}

fn holds<B: Lookup + ?Sized>(
    expression: Option<&str>,
    view: &Overlay<'_, B>,
) -> EngineResult<bool> {
    match expression {
        None => Ok(true),
        Some(expr) => evaluate::as_condition(expr, view),
    }
}

/// The row's view with one element's names laid over it.
///
/// Shallow on purpose: every other column still resolves per record, which is exactly what
/// makes a foreign key on the repeated line point at the right parent on every emitted row.
struct Overlay<'a, B: ?Sized> {
    base: &'a B,
    values: &'a [(String, String)],
}

impl<B: Lookup + ?Sized> Lookup for Overlay<'_, B> {
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
impl<B: Lookup + ?Sized> evaluate::Scope for Overlay<'_, B> {
    fn has(&self, name: &str) -> bool {
        Lookup::has(self, name)
    }

    fn value(&self, name: &str) -> String {
        Lookup::value(self, name)
    }
}
