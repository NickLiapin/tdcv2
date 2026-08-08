<a name="top"></a>

**English** · [Русский](../ru/reference/comparison.md#top) · [Español](../es/reference/comparison.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/comparison)**

← Previous: [Expressions](./expressions.md#top) · **[Contents](../README.md#top)** · Next: [TypeScript](../bindings/typescript.md#top) →

---

# Comparison and truth

Everything a TDC config produces is **text**. A `<gen type="number">` produces the text `42`,
a data pack produces the text `Miller`, and every [built-in](builtins.md#top) is text as well.
Nothing carries a type alongside it, because nothing needs one: text is what lands in the CSV
file at the end.

The only values that are **not** text are the ones you write yourself inside an expression —
the `1` in `if="N == 1"`, the `admin` in `if="Role == admin"`.

That single fact decides every rule on this page.

## Two questions, two operators

Ask whether two things are equal and you are asking one of two different questions:

- Are they the **same number**? `01` and `1` are.
- Are they the **same text**? `01` and `1` are not.

Both questions are worth asking, so each has its own operator.

| Operator     | Asks                    | `"01"` against `1` |
| :----------- | :---------------------- | :----------------- |
| `==`  `!=`   | the same **number**?    | true               |
| `===` `!==`  | the same **text**?      | false              |

This is the shape Perl settled on, and for the same reason: there, too, a value is text that
may or may not read as a number, so one operator asks about the number and another asks about
the characters.

```xml
<tdc>
  <env count="4" seed="cmp" local="en">
    <sequence name="Code"><gen type="text" value="1,01,1.0,+1" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>Code is "${{Code}}":</data><data if="Code == 1"> == 1</data><data if="Code === 1"> === 1</data></line>
  </block>
</tdc>
```

`./run code.tdc`

```
Code is "1": == 1 === 1
Code is "01": == 1
Code is "1.0": == 1
Code is "+1": == 1
```

All four columns **are** the number one, so `== 1` is true on all four. Only the first one
**prints** as `1`, so `=== 1` is true once.

## `==` — the same number

The rule, in order:

1. If both sides are **whole numbers**, compare them as whole numbers. Exactly — a 19-digit
   id keeps every digit, because whole numbers never become doubles here. See
   [Whole numbers](expressions.md#whole-numbers).
2. Otherwise, if one side is a number **you wrote** and the other is text that reads as a
   number, compare them as numbers.
3. Otherwise, compare them as text.

Step 3 is what makes `Role == admin` work: neither side is a number, so both stay text.

Step 2 is what makes a money column work:

```xml
<tdc>
  <env count="3" seed="money" local="en">
    <sequence name="Total"><gen type="text" value="100.00,0.00,99.50" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>${{Total}}:</data><data if="Total == 100"> hundred</data><data if="Total == 0"> zero</data><data if="Total < 100"> under</data></line>
  </block>
</tdc>
```

`./run money.tdc`

```
100.00: hundred
0.00: zero under
99.50: under
```

> [!NOTE]
> **Two texts stay text**
>
> Step 2 needs a number **you wrote**. Two columns compared against each other never get pulled
> into arithmetic by it — but step 1 still applies, so two columns of digits do compare as whole
> numbers. `"01" == "1"` is true; `"" == " "` is false, even though both read as zero.

## `===` — the same text

One rule, no steps: print both sides and compare the characters.

- A column prints as whatever it holds.
- A number you wrote prints the way it would in the output: `1` is `1`, `1.5` is `1.5`.
- `true` and `false` print as those five and four letters.
- Nothing at all — an empty column — prints as the empty text.

```xml
<tdc>
  <env count="5" seed="http" local="en">
    <sequence name="Status"><gen type="text" value="200,404,500,200,301" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>${{Status}}</data><data if="Status === 200"> OK</data><data if="Status >= 400"> failed</data></line>
  </block>
</tdc>
```

`./run status.tdc`

```
200 OK
404 failed
500 failed
200 OK
301
```

## Where the two disagree

Only where the number and the characters genuinely differ. These are the shapes you will
actually meet:

| The column holds | `== 1` | `=== 1` | Why                                     |
| :--------------- | :----- | :------ | :-------------------------------------- |
| `1`              | true   | true    | same number, same characters            |
| `01`             | true   | false   | a leading zero is a character           |
| `1.0`            | true   | false   | a written-out decimal is characters too |
| `+1`             | true   | false   | so is a plus sign                       |
| `1 ` (a space)   | true   | false   | so is a space                           |
| `one`            | false  | false   | not a number and not those characters   |

Between two columns the same split holds, and there is no literal in sight:

```xml
<tdc>
  <env count="4" seed="pair" local="en">
    <sequence name="A"><gen type="text" value="01,7,x,0" order="sequential"/></sequence>
    <sequence name="B"><gen type="text" value="1,7,x,00" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>${{A}} vs ${{B}}:</data><data if="A == B"> same number</data><data if="A === B"> same text</data></line>
  </block>
</tdc>
```

`./run pair.tdc`

```
01 vs 1: same number
7 vs 7: same number same text
x vs x: same number same text
0 vs 00: same number
```

## Reading text as a number is generous

Step 2 of `==` uses the same reading the rest of the language uses, and it accepts more than
you might expect: leading and trailing spaces are ignored, an empty value reads as zero, and
`0x10` reads as sixteen.

```xml
<tdc>
  <env count="4" seed="loose" local="en">
    <sequence name="Field"><gen type="text" value="7,0x10,007,x" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>"${{Field}}":</data><data if="Field == 7"> == 7</data><data if="Field == 16"> == 16</data><data if="Field === '007'"> === '007'</data></line>
  </block>
</tdc>
```

`./run loose.tdc`

```
"7": == 7
"0x10": == 16
"007": == 7 === '007'
"x":
```

None of that happens under `===`, which reads nothing as anything. When the characters are the
question — an id with a fixed width, a code with a leading zero, a hexadecimal field — `===`
is the operator that answers it.

## Ordering

`<`, `>`, `<=` and `>=` always read both sides as numbers. There is no text ordering: two
values that are not numbers are neither less than nor greater than each other, so both
comparisons come out false.

```xml
<tdc>
  <env count="6" seed="ord" local="en">
    <sequence name="Age"><gen type="text" value="15,17,18,25,40,70" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>age ${{Age}}:</data><data if="Age < 18"> minor</data><data if="Age >= 18"> adult</data><data if="Age > 65"> senior</data></line>
  </block>
</tdc>
```

`./run ages.tdc`

```
age 15: minor
age 17: minor
age 18: adult
age 25: adult
age 40: adult
age 70: adult senior
```

Two whole numbers are ordered exactly, past the point where a double would start rounding.

## What counts as true

A bare name is a condition on its own: `if="Flag"`. So is anything `!`, `&&` or `||` is
handed. Two texts are false and **every other text is true**:

| Value            | Truth     | Reason                                  |
| :--------------- | :-------- | :-------------------------------------- |
| `` (empty)       | **false** | the column produced no value            |
| `false`          | **false** | a flag column saying no                 |
| `0`              | true      | zero is a value, not an absence         |
| `00`, `0.0`      | true      | likewise                                |
| ` ` (a space)    | true      | a space is a character                  |
| anything else    | true      |                                         |

```xml
<tdc>
  <env count="6" seed="truth" local="en">
    <sequence name="V"><gen type="text" value="x,0,00,0.0,false,true" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>"${{V}}"</data><data if="V"> is true</data><data if="!V"> is false</data></line>
  </block>
</tdc>
```

`./run truth.tdc`

```
"x" is true
"0" is true
"00" is true
"0.0" is true
"false" is false
"true" is true
```

This is Lua's and Ruby's rule — only "nothing" and "no" are false — in a language whose only
carrier is text. TDC's two falsy texts are exactly those two things:

- **empty** is how a column says it produced nothing: `missing=`, an `if=` that did not fire,
  a branch of `parent=` that is not this row's;
- **`false`** is the boolean written the only way a column can write it.

> [!CAUTION]
> **`0` is true, and that is the one to remember**
>
> `if="Count"` asks whether the column produced a value. A count of zero did. If the question is
> about the number, use the operator that means the number: `if="Count != 0"`.

### Why a flag column works

`_first`, `_last` and every [`anomaly_flag`](../guides/anomalies.md#top) column hold the literal
text `true` or `false`. Because `false` is falsy, the flag reads as a condition directly:

```xml
<tdc>
  <env count="6" seed="flag" local="en">
    <sequence name="Amount"><gen type="number" value="10..99" anomaly="0.4" anomaly_factor="20" anomaly_flag="Spike"/></sequence>
  </env>
  <block>
    <line><data>${{Amount}} Spike=${{Spike}}</data><data if="Spike"> OUTLIER</data><data if="Spike === 'true'"> ===true</data><data if="Spike == true"> ==true</data></line>
  </block>
</tdc>
```

`./run spike.tdc`

```
89 Spike=false
30 Spike=false
76 Spike=false
47 Spike=false
1500 Spike=true OUTLIER ===true
1000 Spike=true OUTLIER ===true
```

Note the third marker: `Spike == true` never appears. `==` compares **numbers**, and neither
the text `true` nor the boolean is one. Write the bare name, or `=== 'true'`.

The same rule is what makes the comma-between-items idiom work:

```xml
<tdc>
  <env count="4" seed="join" local="en">
    <sequence name="Tag"><gen type="text" value="red,green,blue,gray" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>${{Tag}}</data><data if="!_last">, </data></line>
  </block>
</tdc>
```

`./run join.tdc`

```
red, 
green, 
blue, 
gray
```

## Two selectors that are always text

`parent="Code.1"` and `<case is="1">` are not comparisons — they are **value selectors**,
asking which value the column produced on this row. They match the characters exactly, the
way `===` does, and no reading as a number happens:

| The column holds | `parent="Code.1"` | `<case is="1">` | `== 1` |
| :--------------- | :---------------- | :-------------- | :----- |
| `1`              | matches           | matches         | true   |
| `01`             | no                | no              | true   |
| `1.0`            | no                | no              | true   |

If a column of digits has to be matched by its number, do it with `if=` and `==`. A `case`
takes several keys at once — `<case is="1|01|1.0">` — which is the shorter answer when the
column holds a fixed set of spellings.

## `in`

`in` takes a list on its right and asks whether the left value is one of its members. It
compares as loosely as `==`, so a column of digits still matches a list of numbers.

```xml
<gen if="Country in [US, CA, MX]" type="text" value="NAFTA"/>
```

Bare words inside the list stay bare words, exactly as they do beside `==`. A list is allowed
nowhere else — see [TDC259](errors.md#top).

## Which one to reach for

| The question                                     | The operator      |
| :----------------------------------------------- | :---------------- |
| Is this amount / age / count equal to N?          | `==`              |
| Is this category / status word this one?          | `==` or `===`     |
| Is this id exactly these characters?              | `===`             |
| Does this code still have its leading zero?       | `===`             |
| Is this flag set?                                 | the bare name     |
| Did this column produce anything at all?          | the bare name     |
| Is this number greater / smaller?                 | `<` `>` `<=` `>=` |
| Is it one of several?                             | `in`              |

When both would work, `==` reads more naturally and is the everyday choice. Reach for `===`
the moment the exact characters matter.

## Precedence

Highest first:

`binding order`

```
!   →   * / %   →   + -   →   < > <= >=   →   == != === !==   →   &&   →   ||
```

Parentheses override it. `a ? b : c` binds loosest of all.

## The same five answers

All five implementations — TypeScript, Python, Rust, C# and Java — answer every comparison on
this page identically, and shared fixtures hold them to it. See
[Determinism](../core-concepts/determinism.md#top).

---

← Previous: [Expressions](./expressions.md#top) · **[Contents](../README.md#top)** · Next: [TypeScript](../bindings/typescript.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/comparison)**
