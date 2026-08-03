# Documentation voice

One voice across every English page. A native reviewer found the docs read like a
translation from Russian, and found the register swinging between ad copy and reference
material inside a single page. This is the spec that fixes both. It applies to hand-written
pages as much as to anything else.

## Voice

**Address the reader as "you", in the present tense.** TDC does something; you get something
back. Never "we". Never "one".

**State situations, do not tell stories.** No invented characters, no scenes, no dramatic
build-up. "A generated patient can come out female with a prostate diagnosis" — not "A
tester opens a record and spends twenty minutes digging through the app."

**One idea per sentence.** If a sentence needs a dash and two commas to hold itself
together, it is two sentences.

**Say the thing, then stop.** No summing up what you just said, no "as we have seen", no
closing flourish.

**Confident, not promotional.** Facts sell the tool. Superlatives, "powerful", "simply",
"easily", and exclamation marks do not.

## Grammar traps that produced the complaints

- **Every pronoun must have exactly one possible referent, and it must be the nearest noun.**
  "A tester opens a patient record: female, 34. She spends twenty minutes…" — "she" attaches
  to the patient. Repeat the noun rather than risk it.
- **Do not assign a gender to a hypothetical person.** Use "they", or rewrite so no pronoun
  is needed.
- **Articles.** A missing "the" is the loudest sign of a Russian author. Read every noun and
  ask whether English wants an article there.
- **Subject-verb agreement across a long subject.** "Three equal grades over 100 rows **is**
  33.33% each" — the verb has drifted away from its subject.
- **No sentence fragment whose subject is a bare "that" pointing at the previous sentence.**
  "Three ways that costs you a day:" is not a sentence an American writes.
- **No dangling modifiers.** "Left unset, TDC splits on commas" — TDC is not what was left
  unset.

## Words

American spelling and punctuation: color, behavior, analyze, center, license, gray,
recognize. Serial comma. `March 5, 2026`, never `5 March 2026`. `20,000`, never `20 000`.

| Use                                     | Not                     | Why                                                                                    |
| --------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| record                                  | card                    | «карточка». A record can span several lines, so "row" does not always fit either.      |
| parentheses `()`                        | brackets                | English needs three words where Russian has one: parentheses, square brackets, braces. |
| draw without replacement                | pick-without-repetition | The real term.                                                                         |
| sequence, generator, config, seed, pack | —                       | Fixed vocabulary. Never vary these for elegance.                                       |

**"Address" stays** for a dotted pack key such as `person.male.firstName`, even though an
American first reads it as a street. The pack file format has a field literally named
`address:`, so renaming the idea in prose would put the docs at odds with the format.
Where both senses meet on one page, say **street address** for the other one.

## The translations

The Russian and Spanish trees hold the same standard, in their own voice. Two rulings are
fixed, because both had drifted page by page:

**Address the reader formally and never switch.** Russian uses «вы». Spanish uses **usted**
— `use`, `pase`, `vea`, `escriba`, and `su` for the possessive. A `tú` imperative (`usa`,
`escribe`, `renombra`, `decláralo`) or a `tú` verb (`tienes`, `quieres`, `obtienes`) is a
bug, including inside an admonition title or a reference-table cell.

**One word per language for `seed`:**

| English | Russian                           | Spanish                   |
| ------- | --------------------------------- | ------------------------- |
| seed    | **сид** (declined: сида, сиде, …) | **la semilla** (feminine) |

Bare `seed` never appears in translated prose. It stays untranslated only where it is
**code**: the attribute `seed="demo"`, the CLI flag `--seed`, an API member (`seed()`,
`seedInfo`, `X-TDC-Seed`), anything inside backticks, a fenced block or a `<Terminal>`
body, and a heading that names the flags rather than the idea — «Переопределение count и
seed из командной строки», "Sobrescribir count y seed desde la línea de comandos". If a
sentence would still read correctly with the word in backticks, it is code; if it takes an
article or an adjective, it is prose.

## What must not change when editing prose

Fenced code blocks, `<Terminal>` bodies, `<Figure>` `src`, link targets, front matter,
imports, and **headings** — other pages link to headings by anchor. `alt` text **is** prose:
screen readers read it aloud, so it follows every rule above.

## Claims about behavior

If a page says the engine does something, run the config and confirm it. A description that
was true two versions ago is a bug, and it is the one kind of error no reader can catch.
