<a name="top"></a>

**English** · [Русский](../ru/bindings/quick-api.md#top) · [Español](../es/bindings/quick-api.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/quick-api)**

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Python](./python.md#top) →

---

# One value at a time

Sometimes you don't want a dataset. You want a surname, here, on this line of a
test — the job a faker library does. TDC answers that from the same data packs
its configs draw on, so the name in your unit test and the name in your million-row
fixture come from one list.

```ts
import { tdc } from 'tdcv2';

tdc.person.lastName(); // Jones
```

That is the whole API. Everything below is that one call with something in front
of it.

> [!NOTE]
> **This is the loose-values drawer**
>
> Every call is independent. Nothing here ties one value to another — no `parent=`,
> no `<switch>` on a drawn column, no `uniq`, no `<compute>`. A **coherent record**
> is a config; see [Your first dataset](../getting-started/first-data.md#top). Use
> this when the values genuinely don't need to agree with each other.

## One rule: a dot is a dot

`person.male.firstName` in your code is `person.male.firstName` in a config and in
the reference. There is no second vocabulary to learn.

```ts
tdc.person.lastName(); // Jones
tdc.person.male.firstName(); // Robert
tdc.person.female.firstName(); // Linda
tdc.company.industry(); // Pharmaceuticals
tdc.color.name(); // Emerald
tdc.food.dish(); // Chicken Tikka Masala
```

A bare address is read against the **active locale**, exactly as in a config. In
`en` you get `Jones`; switch the locale and the same line gives you a Russian
surname.

## Naming a pack outright

Three prefixes reach past the active locale. They are the same words a config
uses, and they carry no meaning of their own — they are there so that the
autocomplete list at `tdc.` stays a list of categories rather than a wall of 122
locale codes.

| Prefix | Reaches | Example |
| :-- | :-- | :-- |
| _(none)_ | the active locale | `tdc.person.lastName()` |
| `common.` | the shared pack — the same in every language | `tdc.common.id.uuid()` |
| `country.<code>.` | one country's pack | `tdc.country.usa.docs.ssn()` |
| `lang.<code>.` | one language's pack | `tdc.lang.ru.person.lastName()` |

```ts
tdc.common.id.uuid(); // 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.internet.email(); // u99o89qpeo@test-qu8y3h.invalid
tdc.common.finance.iban(); // DE62299399441396459682
tdc.common.finance.currency(); // Swedish Krona

tdc.country.usa.docs.ssn(); // 699209702
tdc.country.usa.finance.aba_routing(); // 659939946
```

Those two identifiers are not shaped like one — they carry real check digits, the
same ones a config would produce.

> [!TIP]
> **An address that isn't installed says so**
>
> `common`, `en` and the USA pack ship with the package. Anything else is a download
> away, and asking for it before it is there gets you a named error rather than a
> blank:
>
> ```ts
> tdc.lang.ru.person.lastName();
> // TdcQuickError: unknown address "ru.person.lastName" (locale "en")
> ```
>
> ```bash
> npx tdcv2 init
> npx tdcv2 pack add ru
> ```
>
> See [Installing packs](../data-packs/installing-packs.md#top).

## Many at once

Append `.many(n)` instead of calling in a loop — it is one draw of `n` values, not
`n` draws of one.

```ts
tdc.person.lastName.many(5);
// [ 'Bush', 'Armstrong', 'Andrews', 'Jimenez', 'Long' ]
```

## Making it repeat

By default every call is fresh — that is what you want in a scratch script. Pin a
seed and the values become part of the test rather than a variable in it:

```ts
const t = tdc.seed('demo');
t.person.lastName(); // Jones, today and next year
```

`seed()` and `locale()` return a **new** object rather than changing the one you
called them on, so two tests can hold different seeds at the same time:

```ts
const ru = tdc.seed('fixtures').locale('ru');
const en = tdc.seed('fixtures').locale('en');
```

## Generators without a pack

`tdc.gen.<type>` reaches the generators directly, for the values that come from a
rule rather than from a list.

```ts
tdc.gen.number('18..80'); // 66
tdc.gen.regex('[A-Z]{2}-[0-9]{4}'); // FZ-3994
```

Every generator and its attributes are in [the generators
reference](../generators/number.md#top).

## Values are always strings

Including numbers and dates. The engine's world is text — that is what lets one
config produce CSV, SQL and JSON without changing — and a return type that varied
with the address would break both autocomplete and the four other implementations.
Convert at the call site when you need a number:

```ts
const age = Number(tdc.gen.number('18..80'));
```

## When to use a config instead

Reach for a config the moment two values have to agree: a city that belongs to its
country, an order total that matches its lines, a 30% share that has to be exactly
30%. That is what the rest of this documentation is about, and it starts at [Your
first dataset](../getting-started/first-data.md#top).

## See also

- **[TypeScript](./typescript.md#top)** — the `TDC` class, for whole datasets.
- **[Data packs](../data-packs/overview.md#top)** — what a pack is and how addresses are organised.
- **[Installing packs](../data-packs/installing-packs.md#top)** — adding the other 120.

---

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Python](./python.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/quick-api)**
