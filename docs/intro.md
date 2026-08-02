<a name="top"></a>

**English** · [Русский](./ru/intro.md#top) · [Español](./es/intro.md#top)

**[Contents](./README.md#top)** · Next: [Installation](./getting-started/installation.md#top) →

---

# TDC — The Data Constructor

TDC generates test data in which the fields of a row agree with each other. The name matches
the gender, the city belongs to the country, the diagnosis is one the patient could have.
Run it again with the same seed and you get the same rows, byte for byte — in every one of
the five languages, on every machine.

That promise has an exact shape: **same config, same seed, same TDC version, same output
mode** gives the same bytes. Change any of the four and the rows may differ —
[Determinism & proportions](core-concepts/determinism.md#top) says which and why.

An ordinary fake-data library fills each field on its own. That is the difference, and
everything below follows from it.

## The problem with independent fields

When each field is drawn separately, every value is valid and the record they form is not.
Three ways that shows up in practice:

- A patient comes out female, 34 years old, with benign prostatic hyperplasia. The bug looks
  like an application bug until someone checks the fixture.
- A million seeded orders pair a random city with a random country. The address validator
  rejects a third of them, so the load test measures the error path instead of the feature.
- A test fails in CI, you rerun it, the generator produces different data, and the test
  passes. Nothing tells you whether the bug is fixed.

The fields have no way to know about each other.

![](./img/intro/flat-vs-linked.svg)

*The same three sources, wired two different ways.*

- **A** — three sources, each holding values from every group
- **B** — the records that result: every field was drawn on its own, so nothing in a row matches
- **C** — one source starts the record
- **D** — every later field is drawn from what the earlier one picked, so the row agrees with itself

## How TDC solves it

A field can name a parent. From then on it draws only from the branch the parent landed in.

Once a row is female, the male-only lists are not filtered out afterwards. They are out of
reach. There is no impossible combination to reject, because there is no way to express one.
Every draw comes from a seeded stream, so one seed rebuilds the whole set.

![](./img/intro/dependency-tree.svg)

*The numbers are the sizes of the English medical lists.*

- **A** — one record being built
- **B** — the branch it lands in
- **C** — the list only that branch reaches: 26 conditions specific to women, 20 to men
- **D** — the list both branches share: 78 conditions anyone can have
- **E** — the edge that cannot exist, because a record never leaves its branch

Everything else in these docs builds on that.

## A first example

Ten people, split 60/40 by gender, with names drawn from gender-specific lists and ages in a
range:

```xml
<tdc>
    <env count="10" seed="demo">
        <sequence name="Gender">
            <gen type="text" value="Male,Female" percent="60,40"/>
        </sequence>

        <sequence name="MaleName" parent="Gender.Male">
            <gen type="template" value="person.male.firstName"/>
        </sequence>
        <sequence name="FemaleName" parent="Gender.Female">
            <gen type="template" value="person.female.firstName"/>
        </sequence>

        <sequence name="Age">
            <gen type="number" value="18..65"/>
        </sequence>
    </env>

    <block>
        <line>
            <data>${{_count}}. ${{Gender}} — ${{MaleName}}${{FemaleName}}, age ${{Age}}</data>
        </line>
    </block>
</tdc>
```

`./run people.tdc`

```
1. Male — Robert, age 59
2. Female — Mary, age 18
3. Male — James, age 53
4. Male — John, age 24
5. Male — Michael, age 28
6. Male — David, age 34
7. Female — Elizabeth, age 57
8. Female — Jennifer, age 58
9. Female — Patricia, age 52
10. Male — William, age 56
```

Three things are true of that output.

[`percent="60,40"`](reference/attributes.md#top) produced 6 men and 4 women. Not approximately
six: the split is computed with the Hamilton method and is exact at any row count.

Every name matches its gender. The two name fields name the split as their
[`parent`](reference/attributes.md#top), so a female row cannot reach the male list.

The run is reproducible. The same [`seed`](core-concepts/determinism.md#top) returns these same
ten people; a different seed returns a different ten, still split 6 to 4.

The second half of the config controls the shape of the output.
[`<block>`](core-concepts/output-formatting.md#top) wraps what repeats,
[`<line>`](core-concepts/output-formatting.md#top) is one line, and
[`<data>`](core-concepts/output-formatting.md#top) is the text on it. Rearranging those three
turns the same ten people into CSV, JSON, or SQL.

### Dependencies nest

Suppose half the men have no car, and a quarter of the women. That is two more sequences,
and nothing else in the config changes:

```xml
<sequence name="MaleCar" parent="Gender.Male">
    <gen type="text" value="has a car,no car" percent="50,50"/>
</sequence>
<sequence name="FemaleCar" parent="Gender.Female">
    <gen type="text" value="has a car,no car" percent="75,25"/>
</sequence>
```

`./run people.tdc`

```
1. Male — Robert — has a car
2. Female — Mary — no car
3. Male — James — no car
4. Male — John — has a car
5. Male — Michael — has a car
6. Male — David — no car
7. Female — Elizabeth — has a car
8. Female — Jennifer — has a car
9. Female — Patricia — has a car
10. Male — William — no car
```

Each rate applies within its own group, and each is exact there: 3 of the 6 men and 1 of the
4 women have no car. Sequences nest as deep as you need.

> [!IMPORTANT]
> **Example outputs are illustrative**
>
> TDC is deterministic for a given seed and a given core version. The engine is still
> changing, so the names and numbers you get today may differ from the ones printed here. The
> behavior is the point — the split is exactly 60/40 — not a byte-for-byte match.

## Where TDC is used

**Test automation.** Fixtures that cannot contradict themselves, and a seed you can paste
into a bug report to reproduce the exact row that failed. TDC is a library as well as a
command-line tool, so rows go into the test directly instead of into a fixture file that has
to be kept in sync:

```typescript
import { test, expect } from '@playwright/test';
import { TDC } from 'tdcv2';

const users = new TDC({ configFile: 'users.tdc' }).toArray();

for (const user of users) {
  test(`sign up ${user.Name}`, async ({ page }) => {
    await page.goto('/signup');
    await page.fill('#name', user.Name);
    await page.fill('#age', String(user.Age));
    await page.click('#submit');
    await expect(page.getByText('Welcome')).toBeVisible();
  });
}
```

**Load and performance testing.** Millions of rows that pass your own foreign keys and
validators. The output is [streamed](guides/large-outputs.md#top) rather than held in memory,
so the limit is disk, not RAM.

**Development.** Demo environments, sandboxes, and seed scripts that hold together under
inspection and rebuild identically next time.

**Research and data work.** Datasets with proportions you set deliberately, containing no
one's personal data.

## When not to use TDC

- **You need one random value in one test.** `faker.name()` is less setup. TDC pays off when
  a whole record has to hold together.
- **You need a synthetic copy of a production database.** TDC invents plausible data. It
  does not learn the joint distribution of your tables, which is a different problem.
- **You need to de-identify production data.** That is masking, and it starts from real
  rows. TDC never sees them.
- **You need a fixed five-row fixture.** Write the JSON by hand.
- **You need to generate load.** TDC produces the data; k6, JMeter, and Locust send it.

## What TDC does

- **Exact proportions.** [`percent="60,40"`](reference/attributes.md#top) is exact at any row count.
- **[Hierarchical dependencies](guides/hierarchical-dependencies.md#top).** A field conditioned on its parent's value, nested as deep as needed.
- **[Coherent related fields](guides/coherent-data.md#top).** Name, price, and category taken from the same source row.
- **[Unique values](constructs/unique-values.md#top).** No duplicates down a column.
- **[Files and CSV](guides/files-and-csv.md#top).** Values, and whole linked rows, read from your own data.
- **[Any output format](guides/output-formats.md#top).** CSV, JSON, SQL, YAML, or one you define.
- **[Large datasets](guides/large-outputs.md#top).** Millions of rows, streamed.
- **Locale and country packs.** People, places, medicine, and documents in ten languages,
  plus national ID formats for more than ninety countries, each with its real check-digit
  rule.

## Availability

Five implementations are complete — **[TypeScript](bindings/typescript.md#top)**,
**[Python](bindings/python.md#top)**, **[Java](bindings/java.md#top)**,
**[C#](bindings/csharp.md#top)** and **[Rust](bindings/rust.md#top)** — and the same config
produces the same bytes in each. None is published to a package registry yet; until then
you install from a checkout, which [Installation](getting-started/installation.md#top)
walks through for every ecosystem.

## Where to start

- **[Installation](getting-started/installation.md#top)** — requirements, and how to run a config.
- **[Your first dataset](getting-started/first-data.md#top)** — a short walkthrough.

> [!NOTE]
> These docs describe what is implemented in the current version. Anything still in
> development is marked where it appears.

---

**[Contents](./README.md#top)** · Next: [Installation](./getting-started/installation.md#top) →
