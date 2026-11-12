//! A bounded cache for a parse whose answer depends on its text alone.
//!
//! The streaming engine draws one value at a time, and for every row it asks a
//! generator to read its own attributes again — a regex pattern, a number range.
//! Those are config constants, and nothing changes a parsed tree after it is
//! built, so parsing each text once gives the same values. Measured: the pattern
//! parse was a third of a regex-heavy run.
//!
//! Keyed by a number beside the text (the length limit a pattern is checked
//! against; 0 where there is none), so a lookup borrows the text and allocates
//! nothing. Cleared wholesale when full rather than tracking recency: a run holds
//! a handful of keys, and the limit only stops a long-lived process that builds
//! many configs from growing without bound. A parse that fails is not kept, so a
//! bad pattern reports the same error every time.

use std::collections::HashMap;
use std::rc::Rc;

const LIMIT: usize = 256;

pub struct TextMemo<T> {
    entries: HashMap<i32, HashMap<String, Rc<T>>>,
    size: usize,
}

impl<T> Default for TextMemo<T> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            size: 0,
        }
    }
}

impl<T> TextMemo<T> {
    pub fn get(&self, number: i32, text: &str) -> Option<Rc<T>> {
        self.entries.get(&number)?.get(text).cloned()
    }

    pub fn keep(&mut self, number: i32, text: &str, value: T) -> Rc<T> {
        if self.size >= LIMIT {
            self.entries.clear();
            self.size = 0;
        }
        let value = Rc::new(value);
        self.entries
            .entry(number)
            .or_default()
            .insert(text.to_owned(), Rc::clone(&value));
        self.size += 1;
        value
    }
}
