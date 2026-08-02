<a name="top"></a>

**English** · [Русский](../ru/reference/compute.md#top) · [Español](../es/reference/compute.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/compute)**

← Previous: [Generators](./generators.md#top) · **[Contents](../README.md#top)** · Next: [Built-ins](./builtins.md#top) →

---

# Compute functions reference

Every tag in the [`<compute>`](../compute/overview.md#top) sub-language, grouped by what it
does. The [Compute Language](../compute/overview.md#top) section covers how they fit
together.

Reading the signature column: `int|str|list` means any of the three, `…` means any
number of children, `?` marks an optional attribute, `1` means exactly one child
expression, and `—` means the tag yields no value of its own. Slot tags — the children
that carry a job title — are shown by name in the signature of the tag that owns them.

## Literals and references

In depth: [The compute sub-language](../compute/overview.md#top)

| Tag | Signature | What it does |
| :--- | :--- | :--- |
| [`<int>`](../compute/overview.md#top) | `v=` → `int` | An integer literal (attribute `v`) |
| [`<str>`](../compute/strings.md#str--a-string-literal) | `v=` → `str` | A string literal (attribute `v`) |
| [`<list>`](../compute/lists.md#list--a-literal-list-of-values) | `v=` or `int…` → `list` | A literal list of ints, or one built from nested expressions |
| [`<field>`](../compute/overview.md#a-value-from-a-field-is-a-string) | `name=` → `str` | The value of a sequence in scope — the same as `${{X}}` |
| [`<var>`](../compute/overview.md#let-and-var-are-not-two-kinds-of-variable) | `name=` → `int\|str\|list` | A value bound by `<let>` |
| [`<let>`](../compute/overview.md#let-and-var-are-not-two-kinds-of-variable) | `name=` + 1 → `—` | Name an intermediate result for sibling tags |
| [`<current>`](../compute/lists.md#each--map-over-a-list) | → `int\|str` | The current iteration item (inside `<do>`) |
| [`<current_index>`](../compute/lists.md#each--map-over-a-list) | → `int` | The current item's index, counting from zero |
| [`<acc>`](../compute/lists.md#reduce--fold-to-one-value) | → `int\|str\|list` | The accumulator (inside `<reduce>`) |

## Lists and iteration

In depth: [Lists & iteration](../compute/lists.md#top)

| Tag | Signature | What it does |
| :--- | :--- | :--- |
| [`<each>`](../compute/lists.md#each--map-over-a-list) | `<over>` `<do>` → `list` | Transform every element → a new list |
| [`<reduce>`](../compute/lists.md#reduce--fold-to-one-value) | `<over>` `<init>` `<do>` → `int\|str\|list` | Fold a list into one value (`<acc>`) |
| [`<join>`](../compute/lists.md#join--a-list-to-a-string) | `list` + `sep=?` → `str` | List → string (attribute `sep`) |
| [`<at>`](../compute/lists.md#at--index-into-a-list) | `<in>` `<index>` + `default=?` → `int\|str` | An element by index (attribute `default`) |
| [`<length>`](../compute/lists.md#length--measure-a-string-or-list) | `str\|list` → `int` | Length of a string or a list |

## Arithmetic

In depth: [Arithmetic](../compute/arithmetic.md#top)

| Tag | Signature | What it does |
| :--- | :--- | :--- |
| [`<add>`](../compute/arithmetic.md#add) | `int…` → `int` | Sum of all children (empty → 0) |
| [`<subtract>`](../compute/arithmetic.md#subtract) | `int…` → `int` | First minus the sum of the rest |
| [`<multiply>`](../compute/arithmetic.md#multiply) | `int…` → `int` | Product (empty → 1) |
| [`<divide>`](../compute/arithmetic.md#divide) | `int` `int` → `int` | Integer division toward −∞ (2 children) |
| [`<mod>`](../compute/arithmetic.md#mod) | `int` `int` → `int` | Euclidean remainder, always ≥ 0 |

## Strings, encoding, formatting

In depth: [Strings & formatting](../compute/strings.md#top)

| Tag | Signature | What it does |
| :--- | :--- | :--- |
| [`<encode>`](../compute/arithmetic.md#encode-as) | `str`(1) + `as=` → `str` | Character → number (`base36`/`ascii`/`hex`/…) |
| [`<to_number>`](../compute/arithmetic.md#to_number) | `str` → `int` | Digit string → integer |
| [`<pad>`](../compute/strings.md#pad--pad-on-the-left-to-a-fixed-width) | `int\|str` + `width=` `fill=?` → `str` | Pad on the left to a given width (`width`, `fill`) |
| [`<concat>`](../compute/strings.md#concat--glue-parts-into-a-string) | `int\|str…` → `str` | Join several parts into one string |
| [`<upper>`](../compute/strings.md#upper--lower--capitalize--title--case) / [`<lower>`](../compute/strings.md#upper--lower--capitalize--title--case) | `str` → `str` | Upper / lower case |
| [`<capitalize>`](../compute/strings.md#upper--lower--capitalize--title--case) | `str` → `str` | Uppercase the first letter |
| [`<title>`](../compute/strings.md#upper--lower--capitalize--title--case) | `str` → `str` | Uppercase the first letter of every word |
| [`<mask>`](../compute/strings.md#mask--split-and-rearrange-by-a-pattern) | `str` + `pattern=` → `str` | Display mask (`pattern`: `x`/`w`/`*`) |
| [`<slice>`](../compute/strings.md#slice--substring-by-index) | `str` + `from=` `to=?` → `str` | Substring `[from, to)` |
| [`<replace>`](../compute/strings.md#replace--replace-every-occurrence) | `str` + `from=` `to=` → `str` | Replace every occurrence (`from`, `to`) |
| [`<trim>`](../compute/strings.md#trim--strip-outer-whitespace) | `str` → `str` | Strip surrounding whitespace |
| [`<group>`](../compute/strings.md#group--group-characters-from-the-right) | `str` + `size=?` `sep=?` → `str` | Group digits from the right (`size`, `sep`) |

## Conditionals

In depth: [Conditionals](../compute/conditionals.md#top)

| Tag | Signature | What it does |
| :--- | :--- | :--- |
| [`<choose>`](../compute/conditionals.md#choose--pick-the-first-matching-branch) | `<when>…` `<otherwise>` → `int\|str\|list` | Choose a branch; requires an `<otherwise>` |
| [`<when>`](../compute/conditionals.md#when--one-branch) | `<test>` `<then>` → `—` | A branch: `<test>` predicate + `<then>` value |
| [`<otherwise>`](../compute/conditionals.md#otherwise-is-required--error-tdc184) | 1 → `int\|str\|list` | The "else" branch (required) |
| [`<test>`](../compute/conditionals.md#test--the-condition-slot) | 1 → `yes\|no` | Holds one predicate, yields yes or no |
| [`<then>`](../compute/conditionals.md#when--one-branch) | 1 → `int\|str\|list` | The value of the matched branch |
| [`<equals>`](../compute/conditionals.md#equals--two-integers-are-equal) | `int\|str` ×2 → `yes\|no` | Predicate: two ints are equal |
| [`<greater_than>`](../compute/conditionals.md#greater_than--strict-a--b) | `int` `int` → `yes\|no` | Predicate: A > B |
| [`<less_than>`](../compute/conditionals.md#less_than--strict-a--b) | `int` `int` → `yes\|no` | Predicate: A < B |
| [`<is_digit>`](../compute/conditionals.md#is_digit--a-character-is-09) | `str`(1) → `yes\|no` | Predicate: a character is a digit 0–9 |

## Wrappers and special

| Tag | Signature | What it does |
| :--- | :--- | :--- |
| [`<over>`](../compute/lists.md#each--map-over-a-list) | 1 → `str\|list` | The input list for `<each>` / `<reduce>` |
| [`<do>`](../compute/lists.md#each--map-over-a-list) | 1 → `int\|str\|list` | The iteration body for `<each>` / `<reduce>` |
| [`<init>`](../compute/lists.md#reduce--fold-to-one-value) | 1 → `int\|str\|list` | The accumulator's starting value for `<reduce>` |
| [`<in>`](../compute/lists.md#at--index-into-a-list) | 1 → `list` | The list for `<at>` |
| [`<index>`](../compute/lists.md#at--index-into-a-list) | 1 → `int` | The item index for `<at>` |
| [`<result>`](../compute/overview.md#top) | 1 → `int\|str\|list` | The final value of a `<compute>` |
| [`<valid>`](../compute/conditionals.md#valid--reject-and-retry) | 1 → `—` | Reject and retry until the value is valid |

See the [Compute Language](../compute/overview.md#top) section for worked examples.

---

← Previous: [Generators](./generators.md#top) · **[Contents](../README.md#top)** · Next: [Built-ins](./builtins.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/compute)**
