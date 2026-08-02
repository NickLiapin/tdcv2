<a name="top"></a>

**English** · [Русский](../ru/bindings/typescript.md#top) · [Español](../es/bindings/typescript.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/typescript)**

← Previous: [Error codes](../reference/errors.md#top) · **[Contents](../README.md#top)** · Next: [One value at a time](./quick-api.md#top) →

---

# TypeScript

The TypeScript package is TDC's reference implementation. The CLI is the right tool
when you want a file; the library is for pulling data **straight into your code** —
as a string or as live JS objects — without spawning a process or reading a file.

```ts
import { TDC } from "tdcv2";
```

## Creating a `TDC`

The constructor takes either a path to a DSL file (`configFile`) or a DSL string
(`configString`). You can override the runtime parameters `seed`, `count`, `locale`,
and `now` from code, and those values win over the ones in `<env>`.

```ts
const tdc = new TDC({
  configString: `<tdc>
    <env count="4" seed="demo" local="en">
      <sequence name="Gender"><gen type="text" value="Male,Female"/></sequence>
      <sequence name="MaleName" parent="Gender.Male"><gen type="template" value="person.male.firstName"/></sequence>
      <sequence name="FemaleName" parent="Gender.Female"><gen type="template" value="person.female.firstName"/></sequence>
      <before><line><data>Gender,Name</data></line></before>
    </env>
    <block><line><data>\${{Gender}},\${{MaleName}}\${{FemaleName}}</data></line></block>
  </tdc>`,
});

console.log(tdc.toString());
```

The name is tied to the gender through `parent` — two sequences, one per branch.
Without that, the name would be drawn independently and a man would end up with a
woman's name. Exactly one of the two is filled on any given row, so the template
can put them back to back and still print a single name.

`node example.js`

```
Gender,Name
Female,Mary
Male,James
Male,John
Female,Elizabeth
```

Overriding from code — these take precedence over `<env>`:

```ts
const tdc = new TDC({
  configFile: "./patients.tdc",
  seed: "test-seed",
  count: 100,
  locale: "ru",
});
```

If the config reads from external files, point the library at the data folders (and
give it a base directory when you're using `configString`):

```ts
const tdc = new TDC({
  configFile: "./configs/users.tdc",
  dataPaths: ["./data", "./private-data"],
});
```

With `configFile`, relative `src` paths inside the `.tdc` are resolved against that
file's folder. With `configString` there's no file to resolve against, so set
`baseDir` yourself.

## Terminal methods

| Method             | Returns                                | For                            |
| :----------------- | :------------------------------------- | :----------------------------- |
| `toString()`       | the whole output as one string         | small / medium results         |
| `writeFile(path)`  | writes the output to a file (chunks)   | a file of any size             |
| `toIterator()`     | a generator of lines (one per record)  | large text, no full string     |
| `toStream()`       | a Node.js `Readable`                   | `pipe` to a file / HTTP / gzip |
| `toArray()`        | an array of row objects                | small object fixtures          |
| `iterate()`        | a generator of row objects             | object output, no array        |
| `getAt(index)`     | one row object by index                | point access                   |
| `preflight(opts?)` | a memory diagnostic, or `undefined`    | a check before a big run       |
| `seedInfo()`       | `{ seed, generated }`                  | read / log the seed            |

`toString`, `writeFile`, `toIterator`, and `toStream` all produce text through the
disk-backed engine, and their memory use is O(number of fields). See **[Large
outputs](../guides/large-outputs.md#top)** for measurements.

## Object output

In tests it's usually easier to work with live objects than to parse CSV or JSON —
you can assert on `row.Gender` directly. `toArray()`, `iterate()`, and `getAt(index)`
give you that. Object output **ignores** `<block>` and the text wrappers; it reads
only the materialized `<sequence>`s:

- a simple sequence becomes a scalar property;
- a compound sequence becomes a **nested** object;
- a parent-filtered sequence is `undefined` on rows where it doesn't apply.

```ts
const tdc = new TDC({
  configString: `<tdc>
    <env count="4" seed="demo" local="en">
      <sequence name="Gender"><gen type="text" value="Male,Female"/></sequence>
      <sequence name="Person">
        <gen name="Code" type="regex" value="[0-9]{4}"/>
      </sequence>
      <sequence name="MaleName" parent="Gender.Male"><gen type="template" value="person.male.firstName"/></sequence>
      <sequence name="FemaleName" parent="Gender.Female"><gen type="template" value="person.female.firstName"/></sequence>
          </env>
    <block><line><data>ignored</data></line></block>
  </tdc>`,
});

console.log(tdc.getAt(0)); // a Female row
console.log(tdc.getAt(1)); // a Male row
```

`node objects.js`

```
{
  Gender: 'Female',
  Person: { Code: '5218' },
  MaleName: undefined,
  FemaleName: 'Mary'
}
{
  Gender: 'Male',
  Person: { Code: '7698' },
  MaleName: 'John',
  FemaleName: undefined
}
```

`Person` is a nested object. `MaleName` and `FemaleName` are both present, but only
one is filled on each row; the other is `undefined`, because its `parent` didn't match
on that row. That's what a parent filter looks like in object output.

> [!NOTE]
> **Same values, one row at a time**
>
> The object methods read from whichever engine the config routes to — the same one
> `toString()` uses — so the values agree, and `getAt(index)` costs one row rather
> than the whole run before it. Asking for row nine million of a ten-million-row
> config is a single row's work.

## See also

- **[CLI](../reference/cli.md#top)** — the same engine from the command line.
- **[Large outputs](../guides/large-outputs.md#top)** — streaming methods and memory.

---

← Previous: [Error codes](../reference/errors.md#top) · **[Contents](../README.md#top)** · Next: [One value at a time](./quick-api.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/typescript)**
