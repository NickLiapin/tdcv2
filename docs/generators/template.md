<a name="top"></a>

**English** · [Русский](../ru/generators/template.md#top) · [Español](../es/generators/template.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/template)**

← Previous: [Number](./number.md#top) · **[Contents](../README.md#top)** · Next: [File](./file.md#top) →

---

# The `template` generator

**Use it when** you need realistic real-world data (names, birthdays, countries) or
technical identifiers (UUIDs, emails, IBANs, tax numbers) that you don't want to
invent by hand. `type="template"` pulls the value from a built-in source; the
[`value`](../reference/attributes.md#top) attribute is a **dotted path** that selects
which one, and many templates respect the
[locale](../core-concepts/configuration.md#top).

An unknown path is `TDC071`, reported by `tdcv2 check` before a single row is generated —
with the offending value underlined and the nearest real path suggested.

> [!NOTE]
> **Outputs are illustrative**
>
> The values shown on this page come from a fixed `seed`, so they are reproducible, but
> the exact strings can differ between core versions. Treat them as examples of _shape_,
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
| `person.male.firstName`   | A male first name                                | 10 + `zh-cn` |
| `person.female.firstName` | A female first name                              | 10 + `zh-cn` |
| `person.lastName`         | A last name (male + locale-common surnames)      | 10 + `zh-cn` |
| `person.male.diagnosis`   | A male diagnosis + common ones                   |      10      |
| `person.female.diagnosis` | A female diagnosis + common ones                 |      10      |
| `person.gender`           | A random gender; the label comes from the locale |      10      |
| `person.b_day`            | A birthday in the format you specify             | format only  |

The ten are `ar`, `de`, `el`, `en`, `es`, `fr`, `it`, `pl`, `pt` and `ru` — the language
packs that are filled rather than stubs. `zh-cn` carries names but not yet the rest. Any
other locale gets [TDC217](../reference/errors.md#top), which names the locales that do ship
the path rather than letting the run guess.

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
the label just has to _look_ plausible, not be clinically accurate.

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

| Path               | Produces       | Locale-aware |
| :----------------- | :------------- | :----------: |
| `location.country` | A country name | all 10 packs |

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
> `location.country` ships in all eleven language packs the registry carries — **ar**,
> **de**, **el**, **en**, **es**, **fr**, **it**, **pl**, **pt**, **ru** and **zh-cn** —
> each with the same 233 countries and territories (English carries 237). A locale with no pack has
> no list either: the path raises an error there instead of falling back to English.

There is no `location.city`. Cities, regions and postcodes live under
[`geo.*`](#geo--geography-from-the-country-packs), which is the next section, because
they come from a **country** pack rather than a language one.

### Eight of those countries contain a comma

`Congo, Republic of (Brazzaville)`, `Korea, Republic of (South Korea)`,
`Micronesia, Federal States of` — eight of the 237 English entries are written the way
the ISO list writes them, with the qualifier after a comma. Dropped straight into a CSV
line, they split the row:

```xml
<line><data>${{Id}},${{Country}}</data></line>
```

`./run csv.tdc — row 2 now has three fields, not two`

```
1,Mongolia
2,Korea, Republic of (South Korea)
3,India
```

The engine already answers this. The
[`csv` filter](../core-concepts/output-formatting.md#top) quotes the value, and quoting is
unconditional rather than clever — a reader of the output can see one rule applied to
every row instead of guessing which values were special:

```xml
<line><data>${{Id}},${{Country|csv}}</data></line>
```

`./run csv.tdc — the same three rows, and row 2 is one field again`

```
1,"Mongolia"
2,"Korea, Republic of (South Korea)"
3,"India"
```

Any pack value can hold a comma — a company name, a street, a job title. `csv` is the
answer for all of them, and a column of country names is simply where you meet it first.

## `geo.*` — geography from the country packs

`location.*` is the **language** pack talking: country names in the reader's language — the
same 233 in every locale but English, which carries 237. `geo.*` is a **country** pack talking: the places inside one country,
and a country list weighted by how many people live there.

| Path                          | Comes from     | Produces                                     |
| :---------------------------- | :------------- | :------------------------------------------- |
| `geo.country`                 | language pack  | A country name, **weighted by population**   |
| `geo.capitalByCountry`        | language pack  | A capital, keyed by country                  |
| `geo.currencyByCountry`       | language pack  | A currency name, keyed by country            |
| `geo.currencyCodeByCountry`   | language pack  | An ISO currency code, keyed by country       |
| `geo.direction`               | language pack  | `north`, `south-east`, …                     |
| `<country>.geo.city`          | country pack   | A city in that country                       |
| `<country>.geo.<division>`    | country pack   | A subdivision, under **that country's** word |
| `<country>.geo.<postcode>`    | country pack   | A postcode, under that country's word too    |
| `<country>.geo.streetName`    | country pack   | A street name                                |

The five language-pack rows ship in **`en` and `ru`** today; ask for `geo.country` under
`local="es"` and the run stops with TDC217, naming the locales that do have it. The
country-pack rows are where the table has to stay vague, and the reason is the subject
itself: **a country pack names its subdivisions the way that country names them.**

| Leaf              | Country packs that ship it |
| :---------------- | :------------------------- |
| `geo.city`        | 93 of 111                  |
| `geo.region`      | 52                         |
| `geo.streetName`  | 36 (plus 37 with `geo.streetNamed`) |
| `geo.postalCode`  | 24                         |
| `geo.province`    | 19                         |
| `geo.zip`         | 16                         |
| `geo.municipality`| 13                         |

Some subdivision exists in 95 of the 111 country packs and a postal code in 46 — under
names that include `department`, `canton`, `governorate`, `voivodeship`, `prefecture`,
`zip`, `postalCode`, `eircode`, `cep`, `cap` and `cpa`. So `usa.geo.province` is not a path: the United States has
`usa.geo.state` and `usa.geo.zip`.

**Guessing is the intended way to find out.** Write the leaf you expect and run `check` —
the diagnostic lists what is actually there:

`tdcv2 check geo.tdc`

```
error[TDC071]: unknown template path "usa.geo.province"
 --> geo.tdc:4:35
  |
4 |       <gen type="template" value="usa.geo.province"/>
  |                                   ^^^^^^^^^^^^^^^^
  |
note: Beside it: usa.geo.city, usa.geo.county, usa.geo.state, usa.geo.stateAbbr, usa.geo.streetName, usa.geo.streetNamed, … (1 more).

aborted: 1 error
```

[Data packs](../data-packs/overview.md#top) covers what a given country carries.

### `location.country` and `geo.country` are different lists

Both are real, and they answer different questions:

```xml
<sequence name="Flat"><gen type="template" value="location.country"/></sequence>
<sequence name="Weighted"><gen type="template" value="geo.country"/></sequence>
<sequence name="City"><gen type="template" value="usa.geo.city"/></sequence>
```

`./run geo.tdc (count=5, local=en)`

```
Burundi | Indonesia | Los Angeles
Singapore | China | New York
Congo, Republic of (Brazzaville) | India | Phoenix
Estonia | China | Chicago
Cyprus | United States | Houston
```

`location.country` draws **uniformly from 237** names, so Burundi is as likely as China.
That is what you want when the column is "any country" — a test that must not care which.

`geo.country` draws from **36 countries weighted by population**, so China and India come
up often and the tail rarely. That is what you want when the column is meant to look like
a customer base. Uniform countries in a customer table are the giveaway that data is
generated.

Neither is more correct. Pick the one whose question matches the column.

## Dates

Both date templates share the format tokens (and locale-aware `L` / `LL`) of the
[`date` generator](date.md#formatting-the-output).

### `person.b_day` — a birthday

| Attribute   | Default       | Description                              |
| :---------- | :------------ | :--------------------------------------- |
| `oldest`    | `80`          | Maximum age, in years                    |
| `youngest`  | `10`          | Minimum age, in years                    |
| `format`    | `L`           | Output format (TDC date-format)          |
| `local`     | from `<env>`  | Locale for localized formats (`L`, `LL`) |
| `precision` | `millisecond` | `day`, `second` or `millisecond`         |

Use it whenever a record needs an age-bounded date of birth — the `youngest` / `oldest`
window keeps everyone inside a believable age band.

> [!NOTE]
> **The same birthday, two defaults**
>
> `person.b_day` and [`<gen type="date" value="birth">`](date.md#a-birthday-with-valuebirth)
> compute the same thing from the same age window, and they default to different
> precision: the template draws a **millisecond**, the date generator a **day**. Under a
> date-only format nothing shows. Ask for a time and the difference is the whole value:
>
> ```
> person.b_day                  1976-07-06 11:28:39.539
> <gen type="date" value="birth">  1999-01-21 00:00:00.000
> ```
>
> Write `precision="day"` on the template when a birthday should be a date and nothing
> more. It is not only cosmetic — snapping to the day can move the value into the
> neighbouring date, so the two precisions do not always render the same day.

```xml
<gen type="template" value="person.b_day" youngest="18" oldest="65" format="YYYY-MM-DD"/>
```

`./run bday.tdc`

```
1997-07-03
1988-10-22
2000-09-12
1987-08-06
1972-10-18
1984-06-09
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

| Attribute   | Default      | Description                               |
| :---------- | :----------- | :---------------------------------------- |
| `range`     | —            | **Required.** `"YYYY.MM.DD - YYYY.MM.DD"` |
| `format`    | `L`          | Output format                             |
| `local`     | from `<env>` | Locale for localized formats              |
| `precision` | `day`        | `day`, `second` or `millisecond`          |

`range` takes that spelling and no other: two dates with **dots**, separated by a
hyphen. `"2020-01-01..2020-12-31"` — the spelling `<gen type="date">` uses — is
refused with [TDC073](../reference/errors.md#top) rather than silently misread.

Use it for any date that isn't a birthday — an order date, a signup, an event —
anywhere you want a uniform draw between two explicit bounds.

```xml
<gen type="template" value="date.range" range="2020.01.01 - 2025.12.31" format="DD.MM.YYYY"/>
```

`./run event.tdc`

```
29.08.2024
20.07.2023
25.01.2025
25.05.2023
04.07.2021
29.12.2022
```

The same `LL` localization applies here too — swap `format="LL"` and the month prints as
a word in the active locale (`December 8, 2023` under `en`, `8 декабря 2023 г.` under
`ru`).

#### A timestamp instead of a date

By default the draw snaps to the **day**, so a format asking for a time prints
midnight every row. `precision="second"` draws the time of day as well:

```xml
<gen type="template" value="date.range" range="2020.01.01 - 2025.12.31"
     precision="second" format="YYYY-MM-DD HH:mm:ss"/>
```

`./run event.tdc (precision=second)`

```
2024-08-10 07:59:57
2021-01-22 23:48:52
2021-06-06 17:44:00
2025-12-17 04:31:37
```

This is the mirror of the `person.b_day` note above: the birthday defaults to
**millisecond** and a range defaults to **day**, so each one needs the opposite
correction when you want the other behaviour.

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
u99o89qpeo@example.test
pk9p3g482c@example.test
vyjs5yc5n2@example.test
oau8cd92kv@example.test
g2z4nh4999@example.test
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
paths listed above. The plan is to let you load _any_ data file declaratively — with
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

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/template)**
