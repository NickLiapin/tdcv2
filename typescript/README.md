# TDC — The Data Constructor

> Declarative test-data generator: deterministic, exact proportions, any text
> format you can describe.

You write a short config saying **what** the data is and **how** it should look.
TDC produces it — as CSV, JSON, SQL, YAML, Markdown, or a format nobody has named
yet, because the layout is something you spell out rather than something you pick
off a list.

Three things separate it from a faker.

**It repeats.** The same config and the same seed produce byte-identical output —
today, next year, on your laptop and on CI. A failing test that depends on
generated data can be re-run and will fail the same way.

**The proportions are exact, not approximate.** Ask for 30% cancelled orders over
a thousand rows and you get three hundred, not "about three hundred". The shares
are apportioned over the whole run and then scattered across it, so the count is
right and the arrangement still looks like data.

**Records hold together.** A child sequence can be declared against a slice of its
parent — a distribution that applies only to the rows where the customer is a
company, say — so the record is coherent rather than a row of independently
plausible columns.

One more, for the curious: you can hand it an SVG or PNG curve and TDC will use
the shape as the probability distribution.

## Two ways to use it

They are different tools that happen to share one set of data, and most people
need both at different moments.

**Reach for a value.** Import the library, call an address, get a string — the job
a faker does. Nothing is tied to anything else.

```typescript
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
tdc.common.finance.iban(); // DE62299399441396459682
tdc.country.usa.docs.ssn(); // 699209702
```

**Describe a dataset.** Write a config saying what the records are and how they
should look, then generate as many as you want — as CSV, JSON, SQL, or a format
you spell out yourself. This is where the exact proportions, the parent-child
distributions and the coherent records live.

```xml
<tdc>
  <env count="1000" seed="demo" local="en">
    <sequence name="Status"><gen type="text" value="paid,refunded" percent="97,3"/></sequence>
    <sequence name="Refund" parent="Status.refunded"><gen type="number" value="5..500"/></sequence>
  </env>
  <block><line><data>${{Status}},${{Refund}}</data></line></block>
</tdc>
```

Exactly thirty of those thousand rows are refunds, and only those rows carry an
amount. No sequence of loose calls gives you that.

The rest of this page walks both: [one value](#just-one-value-like-a-faker) first,
then [a first config](#a-first-config).

## Documentation

📖 **[nickliapin.github.io/tdcv2](https://nickliapin.github.io/tdcv2/docs/intro)**
— every implemented feature, with search and working examples, in
[English](https://nickliapin.github.io/tdcv2/docs/intro),
[Русский](https://nickliapin.github.io/tdcv2/ru/docs/intro) and
[Español](https://nickliapin.github.io/tdcv2/es/docs/intro).

Source, issues and the other four implementations:
**[github.com/NickLiapin/tdcv2](https://github.com/NickLiapin/tdcv2)**.

## One config, five implementations

This package is the TypeScript **reference implementation**, and the one that also
carries the CLI and the language server. The same config runs in Python, Java, C#
and Rust and produces the same bytes — not "the same kind of data", the same
bytes. A shared fixture suite holds all five to it on every change: 130 configs
rendered byte for byte, plus the diagnostics each one reports, the command-line
contract, and the Parquet output down to the file header. A config written
against one implementation is a config that runs on any of them.

Use it when the data has to be reproducible across a team, a language boundary, or
a year.

## Install

```bash
npm install -D tdcv2
```

The `tdcv2` command comes with it, and so does a starter set of data — the
`common`, `en` and USA packs — which is enough for names, addresses, companies and
identifiers out of the box.

## Just one value, like a faker

The values come from the same data packs a config draws on, so the name in your
unit test and the name in your million-row fixture come from one list.

```typescript
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.company.industry(); // Pharmaceuticals

tdc.common.id.uuid(); // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.finance.iban(); // DE62299399441396459682
tdc.country.usa.docs.ssn(); // 699209702 — with its real check digits

tdc.lang.ru.person.lastName(); // after `npx tdcv2 pack add ru`

tdc.person.lastName.many(5); // [ 'Bush', 'Armstrong', 'Andrews', … ]
tdc.gen.number('18..80'); // 66
```

A dot in the code is a dot in the address: `person.male.firstName` here is
`person.male.firstName` in a config and in the reference — one vocabulary, not two.
A bare address reads against the active locale; `common.`, `country.<code>.` and
`lang.<code>.` name a pack outright. Pin a seed when the value should be part of the
test rather than a variable in it:

```typescript
const t = tdc.seed('demo');
t.person.lastName(); // Jones, today and next year
```

Every call is independent — nothing here ties one value to another. The moment two
values have to agree, you want a config, which is the rest of this page.
[Full reference](https://nickliapin.github.io/tdcv2/docs/core-concepts/quick-api).

## A first config

```xml title="demo.tdc"
<tdc>
  <env count="3" seed="demo" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Name"><gen type="template" value="person.lastName"/></sequence>
  </env>
  <block><line><data>${{Id}},${{Name}}</data></line></block>
</tdc>
```

```bash
npx tdcv2 demo.tdc
```

```
1,Williams
2,Johnson
3,Smith
```

The same three names, every time, in every implementation — that is what the
`seed` buys.

### Data packs

A pack is the _data_: the name lists, cities, streets and locale rules that
`type="template"` draws from. The starter set ships with the package; everything
else is downloaded when you ask for it.

```bash
npx tdcv2 init                 # write a tdcv2.config.json, once per project
npx tdcv2 pack list            # what the registry has
npx tdcv2 pack add ru france   # download and wire up
```

One registry, one `tdcv2.config.json`, one store, shared by all five
implementations: a pack installed from here is a pack the others find. The full
story is in
[the data-packs guide](https://nickliapin.github.io/tdcv2/docs/data-packs/installing-packs).

## Using it from code

### Library API

```typescript
import { TDC } from 'tdcv2';

const config = `
<tdc version="0.1">
  <env count="3" seed="demo">
    <sequence name="Gender">
      <gen type="text" value="Male,Female" percent="50,50"/>
    </sequence>
    <sequence name="Code">
      <gen type="number" value="0000..9999"/>
    </sequence>
  </env>
  <block>
    <line><data>\${{_count}},\${{Gender}},\${{Code}}</data></line>
  </block>
</tdc>`;

const dataset = new TDC({ configString: config });

dataset.toString(); // "1,Female,1116\n2,Male,2111\n3,Male,1968\n"
dataset.writeFile('./out.csv');
dataset.toStream().pipe(fs.createWriteStream('./out.csv'));

// The rows as objects, ignoring the <block>/<line> layout.
dataset.toArray(); // [{ Gender: 'Female', Code: '1116' }, …]
for (const row of dataset.iterate()) {
  console.log(row['Gender']);
}
dataset.getAt(0); // { Gender: 'Female', Code: '1116' }
```

`getAt` reads a single record without building the ones before it, so asking for
row nine million of a ten-million-row run costs one row's work.

`preflight()` returns a diagnostic when a run looks too large for the way you are
about to produce it, and `undefined` when it does not — worth checking before a
big one:

```typescript
const warning = dataset.preflight({ output: 'streaming' });
if (warning) console.warn(warning.message);
```

### CLI

After package installation:

```bash
npm install -D tdcv2
npx tdcv2 demo.tdc -o out.csv
```

From this repository during development:

```bash
npm --workspace typescript run build
node typescript/dist/cli/main.js fixtures/tdc_csv.xml --count 10 --seed demo
```

Use `--data-path <dir>` for configs that reference `@data/...` sources:

```bash
npx tdcv2 demo.tdc --data-path ./data -o out.csv
```

### Parser API

```typescript
import { parse, parseStrict, TdcParseError } from 'tdcv2';

// Non-throwing variant — inspect diagnostics
const { tree, diagnostics } = parse('<tdc version="0.01"><data>hi</data></tdc>');
if (diagnostics.length === 0) {
  // tree is a DocumentContext (ANTLR parse tree root)
}

// Strict variant — throws with all diagnostics on any error
try {
  const tree = parseStrict(source);
} catch (err) {
  if (err instanceof TdcParseError) {
    for (const d of err.diagnostics) {
      console.error(`${d.source} ${d.line}:${d.column}: ${d.message}`);
    }
  }
}
```

## Working on the repository

Everything above is what the package gives you. This part is for a checkout of
[the repository](https://github.com/NickLiapin/tdcv2).

```bash
git clone https://github.com/NickLiapin/tdcv2.git
cd tdcv2/typescript
npm ci
npm test
```

The parser is generated from the grammar the five implementations share, so
`npm test` and `npm run build` regenerate it first — there is no separate step to
remember. `npm run check` is the gate CI uses: lint, types, the whole suite, the
shared fixtures, the documented examples, and a coverage floor.

| Script                  | What it does                                        |
| ----------------------- | --------------------------------------------------- |
| `npm run build`         | Regenerate the parser, compile to `dist/`           |
| `npm test`              | Regenerate, then run the suite once                 |
| `npm run test:watch`    | The suite, in watch mode                            |
| `npm run test:coverage` | The suite with a coverage report                    |
| `npm run typecheck`     | Types only, no emit                                 |
| `npm run lint`          | ESLint over source and tests (`lint:fix` to repair) |
| `npm run format`        | Prettier (`format:check` to check only)             |
| `npm run check`         | All of the above, plus the fixtures — what CI runs  |
| `npm run clean`         | Remove `dist`, coverage and the generated parser    |

`node ../scripts/five-ways.mjs` runs all five implementations against the shared
fixtures at once, which is the check that matters when the engine changes.

**Built on:** Node.js 20+, TypeScript 5.6 in strict mode, ANTLR4 (`antlr-ng` to
generate, `antlr4ng` at runtime) over
[`grammar/`](https://github.com/NickLiapin/tdcv2/tree/main/grammar), Vitest,
ESLint 9 and Prettier. The PRNG, the Parquet writer, the Snappy encoder and the
date arithmetic are written here rather than pulled in, because no dependency's
choice of rounding or compression is allowed to change the bytes.

## Links

- [Documentation](https://nickliapin.github.io/tdcv2/docs/intro) — every
  implemented feature ([ru](https://nickliapin.github.io/tdcv2/ru/docs/intro) ·
  [es](https://nickliapin.github.io/tdcv2/es/docs/intro))
- [Every tag the DSL accepts](https://nickliapin.github.io/tdcv2/docs/reference/tags)
- [The library API](https://nickliapin.github.io/tdcv2/docs/bindings/typescript)
- [Streaming large outputs](https://nickliapin.github.io/tdcv2/docs/guides/large-outputs)
- [Repository and issues](https://github.com/NickLiapin/tdcv2)
- [Security policy](https://github.com/NickLiapin/tdcv2/blob/main/SECURITY.md)

## License

MIT © Nick Liapin
