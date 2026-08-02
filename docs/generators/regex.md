<a name="top"></a>

**English** · [Русский](../ru/generators/regex.md#top) · [Español](../es/generators/regex.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/regex)**

← Previous: [Symbol](./symbol.md#top) · **[Contents](../README.md#top)** · Next: [Advanced Regex](./advanced-regex.md#top) →

---

# The `regex` generator

**Use it when** a value has a **strict shape** — a phone number, a SKU, a license
plate, a token, an order code. There are too many possibilities for a list, and
too much internal structure for [`number`](number.md#top): letters, digits, and
separators in specific places.

A regular expression describes that shape. The generator reads it left to right and
fills each slot with random characters from the matching set, printing literals
(dashes, parentheses, `@`) as-is.

> [!NOTE]
> **A finite, portable subset**
>
> This is **not** the full JavaScript `RegExp`. It's a finite subset that can be
> implemented identically in every language. The one hard rule: the
> result must have a **bounded length**, so `*`, `+`, and `{n,}` are not allowed —
> you always write an explicit upper bound.

## A worked example

A US-format phone number:

```xml
<gen type="regex" value="\+1 \([0-9]{3}\) [0-9]{3}-[0-9]{4}"/>
```

`./run phone.tdc`

```
+1 (701) 632-4696
+1 (892) 687-0522
+1 (609) 136-8927
+1 (428) 096-4165
+1 (957) 201-8377
```

The parentheses, spaces, and dashes are literals (the backslash before `(` and `)`
makes them ordinary characters). The `\+1` is a literal `+1`, and the `[0-9]{…}`
groups are slots that get random digits. The shape is always the same; only the
values differ.

Every example on this page is rendered with `seed="demo"` — the same seed gives you
the same strings. Output values are illustrative; the exact strings can differ by
core version, but the shape never does.

Other everyday shapes:

| Task              | Pattern                                             | Example                            |
| :---------------- | :-------------------------------------------------- | :--------------------------------- |
| SKU               | `[A-Z]{3}-[0-9]{4}`                                 | `SAH-0136`                         |
| Plate (US)        | `[0-9][A-Z]{3}[0-9]{3}`                             | `7KLM042`                          |
| 32-char hex token | `[A-F0-9]{32}`                                      | `5AE5ABF3F7040BEB966D65A23EB7C1EC` |
| Test email        | `user_[a-z0-9]{8}@test\.(com\|org)`                 | `user_zak0bdnw@test.com`           |

That same SKU, rendered in full:

```xml
<gen type="regex" value="[A-Z]{3}-[0-9]{4}"/>
```

`./run sku.tdc`

```
SAH-0136
RVH-2608
GGA-0931
GSU-2840
DQN-5792
```

## When plain `regex` is the right tool

Use `type="regex"` to describe the **shape of one string** when you don't need
exact proportions inside it. An alternation like `(com|org)` is chosen **randomly
and independently** on each row — fine when the exact split of variants doesn't
matter.

Good fits for plain `regex`:

- a technical ID: `[A-Z]{2}[0-9]{6}`
- a safe test email: `user_[a-z0-9]{8}@test\.(com|org)`
- a code with a repeating block: `([0-9]{3})-[A-Z]{2}-\1`
- a fixed-length token: `[A-F0-9]{32}`

If you need **exact shares** of variants inside the string (say, exactly 70% with
one prefix), plain `regex` won't do it — reach for
[`advanced_regex`](advanced-regex.md#top):

```xml
<gen type="advanced_regex" value="(?%{70:US;20:CA;10:UK})-[0-9]{6}"/>
```

## Syntax at a glance

| Construct           | Example                      | Generates                                    |
| :------------------ | :--------------------------- | :------------------------------------------- |
| Literals            | `ABC-42`                     | Exactly those characters                     |
| Escaped characters  | `\.\+\(\)\\`                 | Dot, plus, parens, backslash                 |
| Character class     | `[ABC]`, `[a-z]`, `[A-Z0-9]` | One character from the set                   |
| Unicode BMP range   | `[а-я]`, `[א-ת]`, `[ぁ-ゖ]`  | One character from the range                 |
| Named alphabet      | `\a{kana.hiragana}`          | One character from a built-in alphabet       |
| Negated class       | `[^0-9]`                     | A printable ASCII character, except those    |
| Shorthand class     | `\d`, `\w`, `\s`             | Digit, word char, space/tab                  |
| Inverse shorthand   | `\D`, `\W`, `\S`             | The inverse of the above                     |
| Any character       | `.`                          | One printable ASCII character                |
| Alternation         | `cat\|dog`                   | `cat` or `dog`                               |
| Group               | `(cat\|dog)`                 | Grouping and capture                         |
| Non-capturing group | `(?:cat\|dog)`               | Grouping without capture                     |
| Backreference       | `([0-9]{3})-\1`              | Repeats an already-generated group           |
| Optional            | `AB?C`                       | `AC` or `ABC`                                |
| Exact repeat        | `[A-Z]{4}`                   | Exactly 4                                    |
| Range repeat        | `[A-Z]{2,5}`                 | 2 to 5                                        |
| Anchors             | `^ABC$`                      | Zero-width; the result is `ABC`              |

The rest of this page is the same list, but with **real output** under each one.

## Character classes

`[…]` takes one random character from the set. A range `a-z` is shorthand for "every
letter from `a` to `z`".

```xml
<gen type="regex" value="[ABC]{6}"/>     <!-- only A, B, C -->
<gen type="regex" value="[a-z]{6}"/>     <!-- lowercase latin -->
<gen type="regex" value="[A-Z0-9]{6}"/>  <!-- uppercase and digits -->
```

`./run demo.tdc`

```
[ABC]{6}      [a-z]{6}      [A-Z0-9]{6}
CAACAA        sahtbc        ZAK0BD
CCACAC        rvhyfr        Y3K7HY
AAABAC        ggaqby        IJBWC8
```

Each slot is chosen independently, so letters repeat in `[ABC]{6}` — it's six
separate random characters, not a draw without replacement.

## Shorthand classes — `\d` `\w` `\s`

Ready-made sets: `\d` is a digit `[0-9]`, `\w` is a letter/digit/`_`, `\s` is a space
or tab.

```xml
<gen type="regex" value="\d{6}"/>
<gen type="regex" value="\w{8}"/>
```

`./run demo.tdc`

```
\d{6}      \w{8}
702701     tBSvCGXm
682926     qyR7NqAz
220609     OQBoE7TG
```

`\s` is invisible in the output, so spaces and tabs are shown here as `<SP>` and
`<TAB>` (in real output they're ordinary whitespace):

```xml
<gen type="regex" value="A\sB\sC"/>
```

`./run demo.tdc`

```
A<TAB>B<TAB>C
A<SP>B<TAB>C
A<SP>B<SP>C
```

## Negated classes — `[^…]` `\D` `\W` `\S`

`[^0-9]` and `\D` give **any printable ASCII character except** the listed ones.
They're equivalent and produce the same output on the same seed:

```xml
<gen type="regex" value="[^0-9]{6}"/>
<gen type="regex" value="\D{6}"/>
```

`./run demo.tdc`

```
[^0-9]{6}    \D{6}
f"Bi#)       f"Bi#)
cnAz<b       cnAz<b
@!"%zR       @!"%zR
```

The set is the **whole printable ASCII** range (letters, digits,
punctuation), not just letters. If you want letters only, spell it out: `[A-Za-z]`.

## Any character — `.`

The dot is one printable ASCII character (the same set as `\D`, with no exclusions):

```xml
<gen type="regex" value=".{8}"/>
```

`./run demo.tdc`

```
c";g#*CZ
pl:y4_!m
69#&y=*Q
+ZO|Qdv7
```

## Quantifiers — how many times

`{n}` is exactly `n`; `{n,m}` is `n` to `m` (random); `?` is zero or one (so `AB?C`
is `AC` or `ABC`).

```xml
<gen type="regex" value="[A-Z]{4}"/>    <!-- exactly 4 -->
<gen type="regex" value="[A-Z]{2,5}"/>  <!-- 2 to 5 -->
<gen type="regex" value="AB?C"/>        <!-- B optional -->
```

`./run demo.tdc`

```
[A-Z]{4}    [A-Z]{2,5}    AB?C
SAHT        SAHTB         ABC
RVHY        RVH           AC
GGAQ        GG            AC
```

Change the quantifier and the length changes — same "skeleton" (letters, then
digits), different size:

```xml
<gen type="regex" value="[A-Z]{2}[0-9]{4}"/>   <!-- short -->
<gen type="regex" value="[A-Z]{3}[0-9]{8}"/>   <!-- long -->
```

`./run demo.tdc`

```
[A-Z]{2}[0-9]{4}    [A-Z]{3}[0-9]{8}
SA7013              SAH01363846
RV9260              RVH26087805
GG6093              GGA09313068
```

## Alternation and groups — `|` `(…)` `(?:…)`

`cat|dog` picks one variant **at random** on each row. Parentheses group the
variants so you can attach a suffix or a quantifier.

```xml
<gen type="regex" value="cat|dog"/>            <!-- alternation -->
<gen type="regex" value="(cat|dog)-[0-9]{2}"/> <!-- group + suffix -->
<gen type="regex" value="(?:cat|dog)[0-9]"/>   <!-- no capture -->
```

`./run demo.tdc`

```
cat|dog    (cat|dog)-[0-9]{2}    (?:cat|dog)[0-9]
dog        dog-02               dog7
cat        cat-82               cat6
cat        cat-20               cat2
dog        dog-77               dog2
```

A plain group `(…)` remembers its choice (capture) so you can refer back to it with
`\1`. `(?:…)` groups without remembering — use it when you don't need the capture.

> [!NOTE]
> **Random, not exact**
>
> `cat` and `dog` come out unevenly — this is a **random** choice, not exact
> proportions. For exactly 70/30, use [`advanced_regex`](advanced-regex.md#top).

## Anchors — `^` `$`

`^` (start) and `$` (end) are zero-width: the generator accepts them but they add
nothing to the output. `^[A-Z]{3}$` produces the same three letters as `[A-Z]{3}`:

```xml
<gen type="regex" value="^[A-Z]{3}$"/>
```

`./run demo.tdc`

```
SAH
RVH
GGA
```

## Escaping

Turn a regex metacharacter into an ordinary literal with `\`:

```xml
<gen type="regex" value="\.\+\(\)\[\]\{\}\\"/>
```

The generated string is constant here (there are no random slots):

`./run demo.tdc`

```
.+()[]{}\
```

Inside a character class, a dash is a literal when it's first or last — then it's
just the character `-`, not a range:

```xml
<gen type="regex" value="[-A-C]{8}"/>
<gen type="regex" value="[A-C-]{8}"/>
```

`./run demo.tdc`

```
[-A-C]{8}    [A-C-]{8}
B-AB--AB     CABCAABC
BCAC-B-C     C-B-ACA-
-A-B-CA-     ABACA-BA
```

The set here is four characters: `A`, `B`, `C`, and `-`.

## Unicode alphabets

Character classes aren't limited to ASCII. The same machinery accepts any Unicode
BMP range and any built-in **named alphabet**, so the generator localizes without
special cases. Start with the Latin script most data needs — a plain range covers
Western European accented letters directly:

```xml
<gen type="regex" value="[a-zà-ÿ]{8}"/>  <!-- latin + accents -->
```

`./run demo.tdc`

```
sàhtâbcé
rvïhyfrë
ggaçbÿnu
```

The examples below are a deliberate **Unicode/localization demonstration** —
non-Latin scripts written exactly the same way. Plain BMP ranges work directly
inside a character class:

```xml
<gen type="regex" value="[а-я]{8}"/>   <!-- cyrillic -->
<gen type="regex" value="[א-ת]{6}"/>   <!-- hebrew -->
```

`./run demo.tdc`

```
[а-я]{8}      [א-ת]{6}
цайчбглу      ףאחפבג
хщиюжхаъ      עץחשוע
зибфвюкг      זחאסבש
```

For real configs, named alphabets are clearer — they're documented, validated by
name, and can include characters that are awkward to express as a range (like the
Russian `ё`):

```xml
<gen type="regex" value="\a{cyrillic.ru.letters}{10}"/>
<gen type="regex" value="\a{kana.hiragana}{8}"/>
```

`./run demo.tdc`

```
\a{cyrillic.ru.letters}{10}    \a{kana.hiragana}{8}
нБСпВЖЧжХч                     まぃすめいおちふ
куСьНкАупф                     ほゆすをこぺあょ
```

You can mix alphabets inside one class — the character is then drawn from the union
of them:

```xml
<gen type="regex" value="[\a{arabic.letters}\a{hebrew.letters}]{6}"/>
```

`./run demo.tdc`

```
חآشיؤב
הםشקدה
رسأבإק
```

The escape `\a{name}` is one character from that alphabet, and it behaves like any
other atom — repeat it with `{n}` or `{n,m}`; inside a class it adds the whole
alphabet to the set. The full list of names is on the
[Symbol](symbol.md#named-alphabets-with-alphabet) page.

> [!NOTE]
> Negated classes (`[^...]`), `\D`, `\W`, `\S`, and `.` invert against the printable
> **ASCII** set only. For Unicode, spell out a positive set with `\a{name}`.

## Backreferences

A backreference ties parts of a string together: `\1` repeats what the first group
`(…)` already generated.

```xml
<gen type="regex" value="([0-9]{3})-[A-Z]{2}-\1"/>
```

`./run demo.tdc`

```
702-BC-702
682-FR-682
220-BY-220
277-FW-277
```

The first and last three digits **always match** — that's the captured block. This
is how you build document numbers in which one section repeats.

A reference may only point to a group that was already generated to its left; a
forward reference is an error:

```xml
<gen type="regex" value="\1([0-9]{3})"/>
```

`./run bad.tdc`

```
error: invalid regex generator pattern: backreference "\1" points to
a group that is not generated yet
```

If the capture sits inside a repetition, the backreference uses the **last** value
that group generated:

```xml
<gen type="regex" value="([A-Z]){3}-\1"/>
```

`./run demo.tdc`

```
SAH-H
RVH-H
GGA-A
```

Here `([A-Z]){3}` runs the group three times, and `\1` echoes only the third letter
it produced.

## The length guard — `regex_max_length`

Every result is checked against
[`regex_max_length`](../reference/attributes.md#top) (default **32**). A pattern that
could exceed it is rejected **before** generation:

```xml
<gen type="regex" value="[A-Z0-9]{40}"/>
```

`./run token.tdc`

```
error: invalid regex generator pattern: regex can produce 40 characters,
which exceeds regex_max_length=32
```

Raise the cap for the whole config on `<tdc>`. Use this when a config has several
long patterns and you want one place to set the ceiling:

```xml
<tdc regex_max_length="64">
    <env count="5" seed="demo">
        <sequence name="Token"><gen type="regex" value="[A-Z0-9]{40}"/></sequence>
    </env>
    <block>
        <line><data>${{Token}}</data></line>
    </block>
</tdc>
```

`./run token.tdc`

```
MURI40FXS16A2ABROOBQFGMSDBLWP3TCDTA16VVK
NPJ3PVSU1NGARTRDQHT92IHGWJZVUST4531IOEAW
66WWVKTAA2XWUQJBJA8P0SNZ6W3Q75R3CP12JIXW
```

Or set it **locally**, on just this one generator, when a single field is the
exception and you don't want to loosen the ceiling everywhere else:

```xml
<gen type="regex" value="[A-Z0-9]{40}" regex_max_length="40"/>
```

`./run token.tdc`

```
MURI40FXS16A2ABROOBQFGMSDBLWP3TCDTA16VVK
NPJ3PVSU1NGARTRDQHT92IHGWJZVUST4531IOEAW
66WWVKTAA2XWUQJBJA8P0SNZ6W3Q75R3CP12JIXW
```

`regex_max_length` does **not** make an infinite regex finite — it only allows an
already-finite result to be longer.

## What's not allowed

| Not allowed              | Why                                   | Use instead                     |
| :----------------------- | :------------------------------------ | :------------------------------ |
| `*`                      | No upper bound                        | `{0,n}`                         |
| `+`                      | No upper bound                        | `{1,n}`                         |
| `{n,}`                   | No upper bound                        | `{n,m}`                         |
| Lazy `*?`, `??`          | Matcher semantics, not generation     | Write the range you want        |
| Lookahead / lookbehind   | Inspects existing text, doesn't build | Move the condition into the DSL |
| Named captures           | Not implemented yet                   | Plain groups and `\1`           |
| Conditional groups       | Not implemented yet                   | Use `<mix>` or a sequence       |
| `\p{...}` / `\P{...}`    | Unicode properties aren't portable yet| `\a{name}` or an explicit class |
| `\n` / `\r`              | Multi-line generation lives elsewhere | Use separate `<line>`s          |

For example, `+` is rejected immediately:

```xml
<gen type="regex" value="[a-z]+"/>
```

`./run bad.tdc`

```
error: invalid regex generator pattern: unbounded "+" quantifier is not
allowed; use "{1,n}"
```

## Exact proportions

Plain `regex` doesn't set percentages inside the expression — `(cat|dog)` is random,
not "exactly 70/30". For exact shares, use:

- [`<mix percent="…">`](../reference/tags.md#top) to pick between DSL fragments
- [`<gen type="text" percent="…">`](text.md#top) for a set of values
- [`advanced_regex`](advanced-regex.md#top) for weighted choice right inside the pattern

## See also

- **[Advanced Regex](advanced-regex.md#top)** — the same engine plus weighted choice.
- **[Symbol](symbol.md#top)** — when you only need a character set, not structure.
- [`regex_max_length`](../reference/attributes.md#top) and [`alphabet`](../reference/attributes.md#top).

---

← Previous: [Symbol](./symbol.md#top) · **[Contents](../README.md#top)** · Next: [Advanced Regex](./advanced-regex.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/regex)**
