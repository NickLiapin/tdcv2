# TDC — TypeScript Implementation

## Quick start

**You need:** **Node.js 20 or newer**. Nothing else.

```bash
cd typescript
npm install
npm run build
```

Then write a config and run it:

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
node dist/cli/main.js demo.tdc
```

`npm link` puts it on the PATH as `tdcv2`, after which it is just
`tdcv2 demo.tdc`.

```
1,Williams
2,Johnson
3,Smith
```

The same three names, every time, in every implementation — that is the whole
point of the `seed`.

### Data packs

A pack is the _data_ — the name lists, cities, streets and locale rules that
`type="template"` draws from. A starter set ships with the code: `common`, `en`
and the USA country pack, which is what the example above uses. Everything else
is downloaded on demand:

```bash
tdcv2 init                 # write a tdcv2.config.json, once per project
tdcv2 pack list            # what the registry has
tdcv2 pack add ru france   # download and wire up
```

One registry, one `tdcv2.config.json`, one store, shared by all five
implementations: a pack installed from here is a pack the others find. The full
story is in [the data-packs guide](../docs/data-packs/installing-packs.md).

This is the **reference implementation** of TDC, and the one that also carries
the CLI and the language server. Every design decision is settled here first and
then ported to Python, Java, C# and Rust, which are held to it by the shared
fixtures in [`fixtures/cross-language/`](../fixtures/cross-language/README.md).

## Current capabilities

The parser, sequence engine, text renderer, validator, CLI, and `TDC` facade are
working for the currently documented v0.1.0 feature set. Canonical fixtures in
`/fixtures/*.xml` render byte-identically to their expected outputs.

### Library API

```typescript
import { TDC, tdcv2 } from 'tdcv2';

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

dataset.toString(); // text output from <block>/<line>/<data>
dataset.writeFile('./out.csv');
dataset.toStream().pipe(fs.createWriteStream('./out.csv'));
dataset.preflight({ output: 'streaming' }); // estimate large streaming runs
dataset.toArray(); // object rows from <sequence> declarations

for (const row of dataset.iterate()) {
  console.log(row.Gender);
}

dataset.getAt(0);
```

For direct one-off values without a DSL document:

```typescript
tdc.gen.woman.firstName();
tdc.gen.person.firstName({ sex: 'female', locale: 'ru' });
tdc.gen.num('0-1200');
tdc.gen.internet.email({ mode: 'safe' });

const seeded = tdc.createGen({ seed: 'unit-test' });
seeded.id.uuid();

const rowGen = seeded.forRecord('users', 42);
rowGen.id.uuid();
rowGen.person.firstName({ sex: 'female' });
rowGen.finance.iban({ country: 'DE' });
rowGen.payment.cardPan({ brand: 'visa' });
rowGen.security.otp({ length: 6 });
rowGen.docs.us.ssn({ format: 'formatted' });
rowGen.tax.ru.innPerson({ tax_office: '5001' });
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

## Stack

- **Runtime:** Node.js 20+
- **Language:** TypeScript 5.6 (strict mode)
- **Parser:** ANTLR4 via `antlr-ng` (generator) + `antlr4ng` (runtime). Grammar
  at `../grammar/TDCLexer.g4` and `../grammar/TDCParser.g4`. Generated
  TypeScript lives in `src/generated/` (gitignored, regenerated
  deterministically by `npm run generate`).
- **Test framework:** Vitest 2.1
- **Linter / formatter:** ESLint 9 (flat config, strictTypeChecked) + Prettier 3.3
- **Build:** `tsc` with `tsconfig.build.json`
- **Git hooks:** Husky + lint-staged (configured at repo root)

## Directory structure

```
typescript/
├── src/
│   ├── generated/           ANTLR-generated parser (gitignored)
│   ├── parser/              Parser wrappers, error types, error listener
│   │   ├── parse.ts         Public parse() and parseStrict()
│   │   ├── errors.ts        TdcParseError, ParserDiagnostic
│   │   ├── error-listener.ts  ANTLR BaseErrorListener → diagnostic collector
│   │   └── index.ts         Module public surface
│   └── index.ts             Package entry point
├── test/
│   ├── smoke.test.ts        Package-level smoke
│   └── parser/
│       ├── basic.test.ts    Parser unit tests
│       └── fixtures.test.ts Regression on all /fixtures/*.xml
├── package.json
├── tsconfig.json
├── tsconfig.build.json
├── eslint.config.mjs
├── .prettierrc.json
├── vitest.config.ts
└── README.md (this file)
```

## npm scripts

| Script                  | What it does                                                     |
| ----------------------- | ---------------------------------------------------------------- |
| `npm run generate`      | Generate parser + lexer TypeScript from `../grammar/*.g4`        |
| `npm run build`         | Regenerate + compile to `dist/` via `tsc -p tsconfig.build.json` |
| `npm test`              | Regenerate + run Vitest once                                     |
| `npm run test:watch`    | Vitest watch mode                                                |
| `npm run test:coverage` | Run tests with v8 coverage report                                |
| `npm run typecheck`     | Regenerate + `tsc --noEmit`                                      |
| `npm run lint`          | ESLint over source and tests                                     |
| `npm run lint:fix`      | ESLint with --fix                                                |
| `npm run format`        | Prettier over everything                                         |
| `npm run format:check`  | Prettier check only                                              |
| `npm run check`         | lint + typecheck + test (all of the above)                       |
| `npm run clean`         | Remove dist, coverage, generated                                 |

## Roadmap

- Finish v1.0 DSL gaps that are still intentionally deferred (`uniq`, data packs,
  editor support, release examples).
- Keep regression fixtures byte-identical as the TypeScript reference evolves.
- Port the stabilized runtime to Python and Java in later major phases.

See the project’s internal notes for the
complete plan.

## Principles

This implementation strictly follows the project-wide rules in
the project’s internal notes:

- No source file over 1000 lines (ESLint `max-lines` enforced)
- Every feature has tests; min 80% coverage on core modules
- TypeScript strict mode, no `any` without justification
- Conventional Commits
- Husky pre-commit: Prettier + ESLint + gitleaks secret scan
- CI (GitHub Actions) on every push and PR across Node 20.x and 22.x
- Bit-identical determinism — once Python and Java versions arrive, they must
  produce identical output on all fixtures

## References

- [../docs/reference/tags.md](../docs/reference/tags.md) — every tag the DSL accepts
- [../docs/bindings/](../docs/bindings/) — how one config runs in three languages
- [../docs/bindings/typescript.md](../docs/bindings/typescript.md) — the library API
- [../docs/ru/](../docs/ru/) — the Russian documentation
- [../docs/guides/large-outputs.md](../docs/guides/large-outputs.md) — streaming large outputs
