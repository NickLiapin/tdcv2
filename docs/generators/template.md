<a name="top"></a>

**English** · [Русский](../ru/generators/template.md#top) · [Español](../es/generators/template.md#top)

← Previous: [Number](./number.md#top) · **[Contents](../README.md#top)** · Next: [File](./file.md#top) →

---

# The `template` generator

**Use it when** you need realistic real-world data (names, birthdays, countries) or
technical identifiers (UUIDs, emails, IBANs, tax numbers) that you don't want to
invent by hand. `type="template"` pulls the value from a built-in source; the
[`value`](../reference/attributes.md#top) attribute is a **dotted path** that selects
which one, and many templates respect the
[locale](../core-concepts/configuration.md#top).

An unknown path is a render error: `unknown template path "..."`.

> [!NOTE]
> **Outputs are illustrative**
>
> The values shown on this page come from a fixed `seed`, so they are reproducible, but
> the exact strings can differ between core versions. Treat them as examples of *shape*,
> not guarantees.

## Why not a plain list

With [`text`](text.md#top) you'd **type** names by hand — a short list that repeats and
isn't localized. `template` reaches into a large built-in pool instead, in the right
language, without a single line of data in your config:

```xml
<sequence name="Manual"><gen type="text" value="John,Mary,Anna"/></sequence>
<sequence name="Tpl"><gen type="template" value="person.male.firstName"/></sequence>
```

`./run demo.tdc`

```
manual=John   template=James
manual=Mary   template=William
manual=Anna   template=Henry
manual=John   template=Oliver
manual=Mary   template=Samuel
```

The manual list cycles the same three values; the template draws from a big built-in
pool.

## A whole person, coherent

Several templates together build a consistent record: gender is drawn first, and the
name is pulled to match it through [`parent`](../core-concepts/sequences.md#top). The
final line is assembled in a [`<data>`](../core-concepts/output-formatting.md#top) block:

```xml
<env count="6" seed="demo" local="en">
  <sequence name="Gender"><gen type="template" value="person.gender"/></sequence>
  <sequence name="Man" parent="Gender.Male">
    <gen name="First" type="template" value="person.male.firstName"/>
    <gen name="Last"  type="template" value="person.lastName"/>
  </sequence>
  <sequence name="Woman" parent="Gender.Female">
    <gen name="First" type="template" value="person.female.firstName"/>
    <gen name="Last"  type="template" value="person.lastName"/>
  </sequence>
  <sequence name="Bday">
    <gen type="template" value="person.b_day" youngest="18" oldest="70" format="DD.MM.YYYY"/>
  </sequence>
</env>
```

`./run person.tdc`

```
Female: Emma Bishop, 28.11.1985
Male: James Cole, 31.08.2001
Female: Olivia Doyle, 25.04.1984
Male: William Ferris, 20.05.1998
Male: Henry Kirby, 28.08.1981
Female: Sophia Ferris, 20.04.1970
```

Male rows get male names, female rows female names — and none of it is written by
hand. The rest of this page walks through each family of templates with real output.

## Person data

| Path                      | Produces                                         | Locale-aware |
| :------------------------ | :----------------------------------------------- | :----------: |
| `person.male.firstName`   | A male first name                                |  `en`, `ru`  |
| `person.female.firstName` | A female first name                              |  `en`, `ru`  |
| `person.lastName`         | A last name (male + locale-common surnames)      |  `en`, `ru`  |
| `person.male.diagnosis`   | A male diagnosis + common ones                   |  `en`, `ru`  |
| `person.female.diagnosis` | A female diagnosis + common ones                 |  `en`, `ru`  |
| `person.gender`           | A random gender; the label comes from the locale |  `en`, `ru`  |
| `person.b_day`            | A birthday in the format you specify             | format only  |

> [!NOTE]
> **Why `lastName` mixes two pools**
>
> `person.lastName` combines male surnames with the locale's **common** surnames (the
> ones shared by both genders). In some locales that distinction matters — inflected
> surnames have separate male and female forms, while indeclinable ones are common — so
> the pool is deliberately built this way rather than being strictly "male only".

### First names — male and female

The same generator, one path per gender:

```xml
<sequence name="M"><gen type="template" value="person.male.firstName"/></sequence>
<sequence name="F"><gen type="template" value="person.female.firstName"/></sequence>
```

`./run names.tdc (local=en)`

```
male=Dominic   female=Emma
male=Brady     female=Ava
male=Cade      female=Mia
male=Patrick   female=Chloe
male=Ryker     female=Grace
male=Everett   female=Amy
```

Use two separate paths when a row's gender is already fixed (as in the coherent-record
example above). Draw [`person.gender`](#persongender--a-locale-aware-label) first
instead when you want the gender itself picked at random.

### Last names and diagnoses

`person.lastName` and the gendered `person.*.diagnosis` paths work the same way — pick
the path, get a value from the pool:

```xml
<sequence name="L"><gen type="template" value="person.lastName"/></sequence>
<sequence name="D"><gen type="template" value="person.male.diagnosis"/></sequence>
```

`./run patient.tdc (local=en)`

```
last=Chisholm    diagnosis=Hypertension
last=Falcone     diagnosis=Type 2 diabetes
last=Puga        diagnosis=Asthma
last=Ruelas      diagnosis=Chronic gastritis
last=Quevedo     diagnosis=Migraine
last=Shapiro     diagnosis=Hypertension
```

The diagnosis pools are gendered for realism — `person.female.diagnosis` draws from a
female-specific list mixed with common conditions — which is why they follow the same
`male` / `female` split as first names. Use them for synthetic medical fixtures where
the label just has to *look* plausible, not be clinically accurate.

### `person.gender` — a locale-aware label

`person.gender` is not a fixed `Male` / `Female` string — it returns the label from the
current locale's list (roughly a 50/50 split). Those exact strings are what you pass as
the key in [`parent`](../core-concepts/sequences.md#top), so a locale switch changes the
key you match on:

```xml
<sequence name="Gender"><gen type="template" value="person.gender"/></sequence>
```

`./run gender.tdc (localization: en vs ru)`

```
local="en"     local="ru"
Male           мужчина
Male           мужчина
Female         женщина
Male           мужчина
Female         женщина
Male           мужчина
```

Under `local="en"` the keys are `Male` / `Female`; under `local="ru"` the same draw
yields `мужчина` / `женщина`. Match `parent="Gender.Male"` in the first case,
`parent="Gender.мужчина"` in the second.

### Localization — one path, two languages

The path doesn't change — only [`local`](../core-concepts/configuration.md#top) on
`<env>` does. Here is `person.male.firstName` + `person.lastName` rendered once in
English and once in Russian, to show the **same config** producing localized output:

`./run names.tdc (localization: en vs ru)`

```
local="en"           local="ru"
Ahmed Spangler       Пётр Строяков
Griffin Richey       Дмитрий Строяков
Zavier Fong          Михаил Строяков
Emilio Halstead      Дмитрий Салогуб
Cullen Bristol       Андрей Долгих
Titan Bryant         Андрей Белкин
```

The Russian column is a localization demo — the point is that a single path maps onto
whichever data pack the locale selects. English is the default under `local="en"`.

## Location

| Path               | Produces       | Locale-aware   |
| :----------------- | :------------- | :------------: |
| `location.country` | A country name | all 9 locales |

```xml
<sequence name="C"><gen type="template" value="location.country"/></sequence>
```

`./run country.tdc (local=en)`

```
Libya
Japan
Wallis and Futuna Islands
Colombia
Lesotho
Iceland
```

The list is localized: `local="ru"` yields `Греция`, `Никарагуа`, `Турция`;
`local="es"` yields `Surinam`, `Burundi`, `Guyana`.

> [!NOTE]
> **Every locale that has a pack**
>
> `location.country` ships in all nine locales that carry a data pack — **en**, **es**,
> **de**, **it**, **pt**, **fr**, **ru**, **ar** and **zh-cn** — each with the same 233
> countries and territories (English carries 237). A locale with no pack has no list
> either: the path raises an error there instead of falling back to English. Cities and
> regions are planned.

## Dates

Both date templates share the format tokens (and locale-aware `L` / `LL`) of the
[`date` generator](date.md#formatting-the-output).

### `person.b_day` — a birthday

| Attribute  | Default      | Description                              |
| :--------- | :----------- | :--------------------------------------- |
| `oldest`   | `80`         | Maximum age, in years                    |
| `youngest` | `10`         | Minimum age, in years                    |
| `format`   | `L`          | Output format (TDC date-format)          |
| `local`    | from `<env>` | Locale for localized formats (`L`, `LL`) |

Use it whenever a record needs an age-bounded date of birth — the `youngest` / `oldest`
window keeps everyone inside a believable age band.

```xml
<gen type="template" value="person.b_day" youngest="18" oldest="65" format="YYYY-MM-DD"/>
```

`./run bday.tdc`

```
1999-11-18
1973-02-22
1999-04-15
1971-04-30
1986-06-17
1988-09-17
```

#### Localized month names with `LL`

The `LL` format writes the month as a word in the locale's language — the underlying
date is identical, only its spelling changes:

`./run bday.tdc (format=LL, localization: en vs ru)`

```
local="en"            local="ru"
November 18, 1999     18 ноября 1999 г.
February 22, 1973     22 февраля 1973 г.
April 15, 1999        15 апреля 1999 г.
April 30, 1971        30 апреля 1971 г.
June 17, 1986         17 июня 1986 г.
September 17, 1988    17 сентября 1988 г.
```

### `date.range` — a date from a range

| Attribute | Default      | Description                               |
| :-------- | :----------- | :---------------------------------------- |
| `range`   | —            | **Required.** `"YYYY.MM.DD - YYYY.MM.DD"` |
| `format`  | `L`          | Output format                             |
| `local`   | from `<env>` | Locale for localized formats              |

Use it for any date that isn't a birthday — an order date, a signup, an event —
anywhere you want a uniform draw between two explicit bounds.

```xml
<gen type="template" value="date.range" range="2020.01.01 - 2025.12.31" format="DD.MM.YYYY"/>
```

`./run event.tdc`

```
08.12.2023
05.11.2020
23.02.2023
30.10.2024
03.08.2024
16.05.2020
```

The same `LL` localization applies here too — swap `format="LL"` and the month prints as
a word in the active locale (`December 8, 2023` under `en`, `8 декабря 2023 г.` under
`ru`).

## Technical identifiers

The same `type="template"` also builds **algorithmic identifiers** — UUIDs, emails,
IBANs, card numbers, checksummed tax and document numbers. Two naming rules:

- **Global** identifiers carry a `common.` prefix — `common.id.uuid`,
  `common.finance.iban`, `common.payment.card.pan`, `common.phone.e164`.
- **Country-specific** ones start with the country name — `usa.docs.ssn`,
  `usa.tax.ein`, `brazil.tax.cpf`, `poland.docs.pesel`.

### Why these aren't just random digits

Most "number-like" identifiers carry a **check digit** computed from the rest of the
number (Luhn, mod-11, ISO 7064, …). Ten random digits fail the very first format check,
so tests built on them are worthless. These templates emit values that **pass their
checksum** yet are deliberately non-real — reserved test ranges, fictional prefixes — so
they are safe to drop into demos, fixtures, and CI.

### IDs and internet

```xml
<gen type="template" value="common.id.uuid"/>
<gen type="template" value="common.id.ulid"/>
<gen type="template" value="common.internet.email"/>
<gen type="template" value="common.internet.ipv4"/>
<gen type="template" value="common.system.semver"/>
```

`./run ids.tdc`

```
common.id.uuid          b04b0159-d6a6-441f-b3cb-8941d2742bd0
common.id.ulid          609Q13BKAVCMD292YSS7RQ1HK9
common.internet.email   uak1benwm6@fixture-odkd82.test
common.internet.ipv4    192.168.102.101
common.system.semver    7.0.7
```

Emails and domains use IANA-reserved TLDs (`.test`, `.invalid`, `.example`) and IPs use
private ranges, so nothing here can collide with a real address. Also available:
`common.id.nanoid`, `common.id.object_id`, `common.internet.url`,
`common.internet.mac`, `common.internet.slug`, `common.internet.username`.

### Finance and payments

```xml
<gen type="template" value="common.finance.iban"/>
<gen type="template" value="common.finance.bic"/>
<gen type="template" value="common.payment.card.pan"/>
<gen type="template" value="usa.finance.aba_routing"/>
```

`./run finance.tdc`

```
common.finance.iban       DE68702701363846402097
common.finance.bic        SAHTDENW5OW
common.payment.card.pan   4242420270136385
usa.finance.aba_routing   650270138
```

The IBAN carries a valid ISO 7064 mod-97 check, the card PAN a valid Luhn check in the
Visa test range (`4242…`), and the ABA routing number a valid mod-10 `[3,7,1]` check —
every one passes format validation while staying non-real.

### Products and devices

```xml
<gen type="template" value="common.book.isbn13"/>
<gen type="template" value="common.product.ean13"/>
<gen type="template" value="common.device.imei"/>
<gen type="template" value="common.vehicle.vin"/>
```

`./run products.tdc`

```
common.book.isbn13     9790270136387
common.product.ean13   7027013638467
common.device.imei     702701363846407
common.vehicle.vin     0AK1BDNX8L5640209
```

Also available: `common.book.isbn10`, `common.product.gtin14`, `common.product.upc_a`,
`common.periodical.issn`, `common.device.iccid`.

### Security and hashes

```xml
<gen type="template" value="common.security.api_key"/>
<gen type="template" value="common.security.otp"/>
<gen type="template" value="common.security.sha256"/>
<gen type="template" value="common.git.sha"/>
```

`./run security.tdc`

```
common.security.api_key   tdc_i1Hk26NbKrPdP5H5xnmFlk3XbH5rBSI9
common.security.otp       702701
common.security.sha256    b04b01595d6a6141fcc3cb08941d2742bd0800d71700...
common.git.sha            b04b01595d6a6141fcc3cb08941d2742bd0800d7
```

Also available: `common.security.jwt`, `common.security.md5`, `common.security.sha1`,
`common.security.totp_secret`.

### Phone numbers

`common.phone.e164` picks a random country; each country also has its own path. They
all emit E.164 form and draw on the fictional ranges reserved for drama and testing
(US area code 202 with the `555` exchange, UK Ofcom `07700 900xxx`, and so on):

```xml
<gen type="template" value="usa.phone"/>
<gen type="template" value="common.phone.e164"/>
```

`./run phones.tdc`

```
usa.phone           +12025557027
usa.phone           +12025556829
common.phone.e164   +447700900829
common.phone.e164   +33670270136
```

### National tax and document numbers

Every country has its own family of checksummed numbers. The US set alone covers most
common needs:

```xml
<gen type="template" value="usa.docs.ssn"/>
<gen type="template" value="usa.tax.ein"/>
<gen type="template" value="usa.tax.itin"/>
<gen type="template" value="usa.geo.zip"/>
```

`./run us-ids.tdc`

```
usa.docs.ssn   690070001
usa.tax.ein    750270136
usa.tax.itin   970620136
usa.geo.zip    77093
```

Dozens of other countries are available on the same pattern —
`brazil.tax.cpf`, `poland.docs.pesel`, `germany.tax.vat`, `spain.docs.dni`,
`france.tax.siren`, and many more. The complete country-by-country catalog lives in the
[Reference](../reference/generators.md#top).

```xml
<gen type="template" value="brazil.tax.cpf"/>
<gen type="template" value="poland.docs.pesel"/>
<gen type="template" value="germany.tax.vat"/>
<gen type="template" value="france.tax.siren"/>
```

`./run world-ids.tdc`

```
brazil.tax.cpf       64173916477
poland.docs.pesel    18302310570
germany.tax.vat      DE153363548
france.tax.siren     860356302
```

Four countries, four schemes, one tag: the CPF carries its mod-11 pair of check digits,
the PESEL its date of birth and mod-10 digit, the VAT number its own mod-11, and the
SIREN a Luhn check. Every one passes validation without belonging to anybody.

### Parameters

Many identifiers accept **parameters** — pass them as ordinary attributes on
[`<gen>`](../reference/tags.md#top). Any parameter you leave out is drawn at random; the
one you set is pinned across every row. For example, fixing the email domain:

```xml
<gen type="template" value="common.internet.email" domain="example.test"/>
```

`./run email.tdc`

```
uak1benwm6@example.test
j3k8iya414@example.test
p7m2nqx8v0@example.test
z0k4hya3c1@example.test
r5t9bd6l2e@example.test
```

Country generators take their own parameters — a tax-office code, a `sex`, a prefix —
and the check digit is always recomputed to stay valid. Which parameters a given path
accepts is defined by the [data pack](../data-packs/overview.md#top) behind it: each local
`<sequence name="…">` in the pack is one parameter. A wrong parameter is a clear error
(`TDC072`), never silent — TDC tells you what a path actually accepts.

> [!NOTE]
> **Simplified variants**
>
> When these generators moved into editable packs, a few rarely used parameters and
> "formatted" variants (the ones with brackets or dashes) were reduced to the plain
> form. The checksums and the core format are unchanged; only the cosmetic wrapping
> was dropped.

### How the check digits are built

The checksum logic isn't hidden in compiled code — each pack computes its check digit
**declaratively** with the [`<compute>`](../reference/compute.md#top) tag, right next to the
data. If a country changes its rules, you edit the pack's text file, not the engine. See
[Data Packs](../data-packs/overview.md#top) for how a pack is structured.

## Where template data lives

Today the template pools ship with the library and are exposed through the built-in
paths listed above. The plan is to let you load *any* data file declaratively — with
metadata describing what it is, how it's delimited, and which class parses it — so you
can register your own pools the same way the built-ins are registered. Until then, the
available templates are exactly the built-in ones documented here.

## See also

- **[Date](date.md#top)** — the format tokens these date templates use.
- **[`<compute>`](../reference/compute.md#top)** — how the checksums are defined.
- **[Reference: generators](../reference/generators.md#top)** — the full identifier catalog.
- **[Data Packs](../data-packs/overview.md#top)** — where template data comes from, and adding your own.

---

← Previous: [Number](./number.md#top) · **[Contents](../README.md#top)** · Next: [File](./file.md#top) →
