<a name="top"></a>

**English** · [Русский](../ru/reference/identifiers.md#top) · [Español](../es/reference/identifiers.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/identifiers)**

← Previous: [Built-ins](./builtins.md#top) · **[Contents](../README.md#top)** · Next: [Error codes](./errors.md#top) →

---

# The identifier catalog

**Use it when** you need a technical identifier that has to _look_ real and **pass a
format check** — a UUID, an email, an IBAN, a payment-card number, a checksummed tax or
document number — without inventing it by hand or copying a real one. Every path on this
page is a value for [`type="template"`](../generators/template.md#top); the
[`value`](./attributes.md#top) attribute is a **dotted path** that picks which identifier you
get.

This page is the full lookup. For a guided tour of the same generator — person data,
dates, localization — see the [`template` generator](../generators/template.md#top). For the
person, name, and date families specifically, that page is the better starting point;
this one is the exhaustive catalog of **technical** identifiers.

> [!NOTE]
> **Outputs are illustrative**
>
> Every value below comes from a fixed [`seed`](../core-concepts/determinism.md#top), so it's
> reproducible, but the exact string can change between core versions. Read them as
> examples of _shape_, not as guarantees.

## How to call

Two naming rules split the catalog:

- **Global** identifiers carry a `common.` prefix — `common.id.uuid`,
  `common.finance.iban`, `common.payment.card.pan`, `common.phone.e164`.
- **Country-specific** ones start with the country name — `usa.docs.ssn`,
  `usa.tax.ein`, `brazil.tax.cpf`, `poland.docs.pesel`.

```xml
<gen type="template" value="common.id.uuid"/>
<gen type="template" value="usa.docs.ssn"/>
```

An unknown path is a hard error, never a silent blank:

`./run bad.tdc`

```
error[TDC071]: unknown template path "usa.docs.nope"
 --> bad.tdc:2:48
  |
2 | <gen type="template" value="usa.docs.nope"/>
  |                             ^^^^^^^^^^^^^
```

## Why these pass validation

Most "number-like" identifiers carry a **check digit** computed from the rest of the
number (Luhn, mod-11, ISO 7064, GS1 mod-10, …). Ten random digits fail the very first
format check, so a test built on them is worthless. These templates emit values that
**pass their checksum** yet are deliberately not real — reserved test ranges, fictional
prefixes, IANA-reserved TLDs — so they're safe to drop into demos, fixtures, and CI. How
each check digit is defined is covered [below](#how-the-check-digits-are-built).

## Parameters

Many identifiers accept **parameters** — pass them as ordinary attributes on
[`<gen>`](./tags.md#top). Any parameter you leave out is drawn at random; the ones you set
are **pinned** across every row, and the check digit is recomputed each time so the value
stays valid.

A parameter name can never be one the engine itself reads off the `<gen>` — `local`,
`order`, `case`, `mask` and the other wrappers. A pack that declares one is refused when it
loads, because the parameter would look real and be unsettable. That is why the email
generator's local part is `user=` and not `local=`: `local=` is the locale override.

A pinned value has to be the **same width** the identifier's own part is. These are fixed
layouts — a check digit is computed over the whole of the value — so a wider or narrower
part does not shift the layout, it breaks it. `usa.finance.aba_routing` used to accept
`prefix="12345"` and then abort mid-run, and `tail="678"` and then write a six-digit
number that is not a routing number. Both are TDC276 now, before a single row is made.

For example, pin the area part of every US Social Security number:

```xml
<gen type="template" value="usa.docs.ssn" area="555"/>
```

`./run ssn.tdc`

```
555772009
555599501
555844442
555579578
555258469
```

Every value starts with `555`, and each one is still a well-formed SSN. **Use a parameter
when** part of the identifier has to stay constant — a fixed issuer, a fixed tax office,
a fixed domain — while the rest varies.

### Discovering a path's parameters

A parameter is just a local [`<sequence name="…">`](../core-concepts/sequences.md#top)
inside the [data pack](../data-packs/overview.md#top) behind the path, and the caller
overrides it with a constant. So the parameters a path accepts are exactly the local
sequence names in its pack. Getting one wrong is a clear error (`TDC072`), never a silent
no-op:

`./run bad-param.tdc`

```
error[TDC072]: "bogus" is not a parameter of "usa.docs.ssn" — it would be ignored
 --> bad-param.tdc:2:47
  |
2 | <gen type="template" value="usa.docs.ssn" bogus="1"/>
  |                                           ^^^^^
```

A few representative paths and the parameters they expose:

| Path                      | Parameters                 |
| :------------------------ | :------------------------- |
| `common.internet.email`   | `user`, `domain`          |
| `common.internet.url`     | `scheme`, `domain`, `slug` |
| `common.internet.domain`  | `word`, `token`, `suffix`  |
| `common.finance.iban`     | `bban`                     |
| `common.payment.card.pan` | `base`                     |
| `usa.docs.ssn`            | `area`, `group`, `serial`  |
| `usa.tax.ein`             | `prefix`, `serial`         |
| `usa.tax.itin`            | `mid`, `group`, `serial`   |
| `usa.finance.aba_routing` | `prefix`, `tail`           |

> [!NOTE]
> **Simplified variants**
>
> When these generators moved into editable packs, a few rarely used parameters and
> "formatted" variants (the ones with brackets or dashes) were reduced to the plain form.
> The checksums and the core format are unchanged; only the cosmetic wrapping is gone.

## IDs and internet

Opaque IDs (UUID, ULID, Nano ID, ObjectId), commit hashes, and safe web values. **Use
them when** a record needs a primary key, a fake email, or a placeholder URL that can't
collide with a real one.

```xml
<gen type="template" value="common.id.uuid"/>
<gen type="template" value="common.id.ulid"/>
<gen type="template" value="common.id.nanoid"/>
<gen type="template" value="common.git.sha"/>
```

`./run ids.tdc`

```
common.id.uuid        63af26a7-9997-4aa8-8883-bec8f2a5c541
common.id.ulid        5GQ9BM9G731XA1KW1KMYM9EGAK
common.id.nanoid      LKCYPokQsGREjVYrZvJjz
common.id.object_id   3ed9c528008a4cc46dbb53b2
common.git.sha        efffc5bd4c321932277f4ff77cc01993344ecd2e
common.system.semver  8.13.7
```

Emails and domains use IANA-reserved TLDs (`.test`, `.invalid`, `.example`), and the IPs
sit in private or documentation ranges, so nothing here can reach a real address:

`./run internet.tdc`

```
common.internet.email     qjoasyc4yx@sandbox-8s2332.test
common.internet.domain    test-26vh9o.test
common.internet.url       https://fixture-vaqpcg.example/atlas-sandbox-sandbox
common.internet.ipv4      10.251.85.160
common.internet.ipv6      2001:db8:c43:28eb:f2c:ee5:e:8d5
common.internet.mac       c5:62:b8:e2:af:d3
common.internet.username  lfmln1e_b
```

| Path                       | Produces                                                            | Example                                                |
| :------------------------- | :------------------------------------------------------------------ | :----------------------------------------------------- |
| `common.git.sha`           | Git commit SHA-1 (40 lowercase hex chars)                           | `efffc5bd4c321932277f4ff77cc01993344ecd2e`             |
| `common.id.nanoid`         | Nano ID (21 chars, URL-safe alphabet `A–Za–z0–9_-`)                 | `LKCYPokQsGREjVYrZvJjz`                                |
| `common.id.object_id`      | MongoDB ObjectId (24 lowercase hex chars)                           | `3ed9c528008a4cc46dbb53b2`                             |
| `common.id.ulid`           | ULID (26 chars, Crockford base32; first char 0–7)                   | `5GQ9BM9G731XA1KW1KMYM9EGAK`                           |
| `common.id.uuid`           | UUID v4 (RFC 4122 — version 4, variant 8/9/a/b)                     | `63af26a7-9997-4aa8-8883-bec8f2a5c541`                 |
| `common.internet.domain`   | Safe fake domain — token.suffix (RFC 2606 reserved TLDs)            | `test-26vh9o.test`                                     |
| `common.internet.email`    | Safe email — a 10-char local part at a safe fake domain             | `qjoasyc4yx@sandbox-8s2332.test`                       |
| `common.internet.ipv4`     | IPv4 in the private ranges (10/8, 172.16/12, 192.168/16)            | `10.251.85.160`                                        |
| `common.internet.ipv6`     | IPv6 in the 2001:db8::/32 documentation range                       | `2001:db8:c43:28eb:f2c:ee5:e:8d5`                      |
| `common.internet.mac`      | MAC address — six colon-separated lowercase hex octets              | `c5:62:b8:e2:af:d3`                                    |
| `common.internet.slug`     | URL slug — 2 to 4 lowercase words joined by hyphens                 | `test-atlas-sandbox`                                   |
| `common.internet.url`      | Safe URL — scheme://safe-domain/slug (the scheme defaults to https) | `https://fixture-vaqpcg.example/atlas-sandbox-sandbox` |
| `common.internet.username` | Username — a leading letter, then 7–13 chars of `a–z0–9_`           | `lfmln1e_b`                                            |
| `common.system.semver`     | Semantic version — major 0–9, minor 0–19, patch 0–99                | `8.13.7`                                               |

## Finance and payments

IBANs, SWIFT/BIC codes, payment-card PANs, and the US ABA routing number — each with a
real check built in. **Use them when** a fixture has to survive a bank-format check or a
Luhn validator.

```xml
<gen type="template" value="common.finance.iban"/>
<gen type="template" value="common.finance.bic"/>
<gen type="template" value="common.payment.card.pan"/>
<gen type="template" value="usa.finance.aba_routing"/>
```

`./run finance.tdc`

```
common.finance.iban       DE60077427668812994595
common.finance.bic        VROLFR00F1Y
common.payment.card.pan   4111111726740445
usa.finance.aba_routing   649946910
```

The IBAN carries a valid ISO 7064 mod-97 check, the PAN carries a valid Luhn check in the
Visa test range (`4111…`), and the routing number carries a valid mod-10 `[3,7,1]` check.

| Path                      | Produces                                                            | Example                  |
| :------------------------ | :------------------------------------------------------------------ | :----------------------- |
| `common.finance.bic`      | SWIFT/BIC-11 (4 letters + country + 2 location + 3 branch)          | `VROLFR00F1Y`            |
| `common.finance.iban`     | IBAN (country defaults to DE, 18-digit BBAN, ISO 7064 mod-97 check) | `DE60077427668812994595` |
| `common.payment.card.pan` | Payment-card PAN (Visa test range, 16 digits + Luhn check)          | `4111111726740445`       |
| `usa.finance.aba_routing` | US ABA routing number (8 digits + mod-10 `[3,7,1]` check)           | `649946910`              |

## Products and devices

Retail and hardware barcodes and identifiers — ISBN, EAN, UPC, GTIN, IMEI, ICCID, ISSN.
**Use them when** a catalog or inventory fixture has to pass a scanner or a format check.

```xml
<gen type="template" value="common.book.isbn13"/>
<gen type="template" value="common.product.ean13"/>
<gen type="template" value="common.device.imei"/>
```

`./run products.tdc`

```
common.book.isbn13     9783635567452
common.product.ean13   9418766812071
common.product.upc_a   277703531852
common.product.gtin14  69243931643417
common.device.imei     263236381039942
common.device.iccid    8910106572426433879
common.periodical.issn 23614552
common.vehicle.vin     XJV8TB3B7W5726830
```

| Path                     | Produces                                                     | Example               |
| :----------------------- | :----------------------------------------------------------- | :-------------------- |
| `common.book.isbn10`     | ISBN-10 (9 digits + mod-11 check, 10 → X)                    | `1684319684`          |
| `common.book.isbn13`     | ISBN-13 (978/979 prefix + 9 digits + GS1 mod-10 check)       | `9783635567452`       |
| `common.periodical.issn` | ISSN (7-digit base + mod-11 check, weights 8..2, 10 → X)     | `23614552`            |
| `common.product.ean13`   | EAN-13 (12-digit base + GS1 mod-10 check)                    | `9418766812071`       |
| `common.product.gtin14`  | GTIN-14 (13-digit base + GS1 mod-10 check)                   | `69243931643417`      |
| `common.product.upc_a`   | UPC-A (11-digit base + GS1 mod-10 check)                     | `277703531852`        |
| `common.device.iccid`    | ICCID (89 + country + issuer prefix, 19 digits + Luhn check) | `8910106572426433879` |
| `common.device.imei`     | IMEI (14-digit base + Luhn check digit, 15 digits in all)    | `263236381039942`     |

## Security and hashes

API keys, one-time codes, TOTP secrets, JWTs, and raw digests. **Use them when** you need
a credential-shaped placeholder for an auth flow or a log line — never a real secret.

```xml
<gen type="template" value="common.security.api_key"/>
<gen type="template" value="common.security.otp"/>
<gen type="template" value="common.security.sha256"/>
```

`./run security.tdc`

```
common.security.api_key      tdc_cxmmn0eD60xEB5CLOilveNjDyxBcYaaM
common.security.otp          874846
common.security.md5          db3d24933e41cbafde844af6dddc769f
common.security.sha1         313f20b6a4fb5eedc53cf02ae32e56c2b7ee0d7b
common.security.sha256       f1be92ba089ddaa35e2273dd6c7d66d712c85e313316a2f006786f383e9f686e
common.security.totp_secret  76F7GJ5PYJXYHYY7E5DMY2L6G6XGVSAL
```

| Path                          | Produces                                                                 | Example                                                            |
| :---------------------------- | :----------------------------------------------------------------------- | :----------------------------------------------------------------- |
| `common.security.api_key`     | API key (`tdc_` prefix by default + 32 alphanumerics)                    | `tdc_cxmmn0eD60xEB5CLOilveNjDyxBcYaaM`                             |
| `common.security.jwt`         | Fake JWT (fixed base64url header per alg + random payload and signature) | `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.6LKo…`                       |
| `common.security.md5`         | MD5 digest (32 lowercase hex chars)                                      | `db3d24933e41cbafde844af6dddc769f`                                 |
| `common.security.otp`         | Numeric one-time passcode (6 digits by default)                          | `874846`                                                           |
| `common.security.sha1`        | SHA-1 digest (40 lowercase hex chars)                                    | `313f20b6a4fb5eedc53cf02ae32e56c2b7ee0d7b`                         |
| `common.security.sha256`      | SHA-256 digest (64 lowercase hex chars)                                  | `f1be92ba089ddaa35e2273dd6c7d66d712c85e313316a2f006786f383e9f686e` |
| `common.security.totp_secret` | TOTP shared secret (32 base32 chars by default, RFC 4648 A–Z2–7)         | `76F7GJ5PYJXYHYY7E5DMY2L6G6XGVSAL`                                 |

## Documents, transport, logistics

Machine-readable travel documents (ICAO 9303 MRZ), vehicle VINs, and ISO 6346 shipping
containers. **Use them when** a fixture gets scanned or OCR'd and has to satisfy the
format's composite check digits.

The two MRZ paths are multi-line — a TD1 identity card is three 30-char lines and a TD3
passport is two 44-char lines, each carrying ICAO composite check digits:

`./run mrz.tdc`

```
common.docs.mrz.id_td1 (identity card, three 30-char lines):
I<UTOV80Y7XXNC58C1E31V2B6IGCXD
8402079F3111275UTOFP4DCM7IPY95
MILLER<<ADAM<<<<<<<<<<<<<<<<<<

common.docs.mrz.passport_td3 (passport, two 44-char lines):
P<UTODOE<<JOHN<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<
22VVYEM7V0UTO9403280<3703276L73REEFL4AFXU642
```

The single-line codes:

`./run transport.tdc`

```
common.vehicle.vin                  XJV8TB3B7W5726830
common.logistics.container_iso6346  PQXU6242844
```

| Path                                 | Produces                                                                          | Example             |
| :----------------------------------- | :-------------------------------------------------------------------------------- | :------------------ |
| `common.docs.mrz.id_td1`             | ICAO 9303 TD1 identity-card MRZ (three 30-char lines) with composite check digits | _(see above)_       |
| `common.docs.mrz.passport_td3`       | ICAO 9303 TD3 passport MRZ (two 44-char lines) with composite check digits        | _(see above)_       |
| `common.logistics.container_iso6346` | ISO 6346 container code (owner + category + 6-digit serial + mod-11 check)        | `PQXU6242844`       |
| `common.vehicle.vin`                 | Vehicle identification number (ISO 3779, 17 chars, weighted mod-11 check; 10 → X) | `XJV8TB3B7W5726830` |

## Phone numbers

`common.phone.e164` picks a random country, and each country also has its own path. They
all emit E.164 format. Where a country reserves a range for drama and testing, the pack
uses it — US area `202` with the `555` exchange, Canada `613 555`, UK Ofcom
`07700 900xxx`. Most countries reserve no such range, so those paths build a structurally
valid number out of real prefixes instead: safe to store and to parse, but not a number
anyone can dial. **Use them when** a contact fixture has to parse as a valid
international number.

```xml
<gen type="template" value="usa.phone"/>
<gen type="template" value="common.phone.e164"/>
```

`./run phones.tdc`

```
usa.phone             +12025550883
canada.phone          +16135558575
united_kingdom.phone  +447700900864
germany.phone         +4917140038023
france.phone          +33618948981
common.phone.e164     +34663489915
```

| Path                   | Produces                                             | Example          |
| :--------------------- | :--------------------------------------------------- | :--------------- |
| `argentina.phone`      | Argentina mobile, E.164 (+54 9 11…)                  | `+5491185268868` |
| `brazil.phone`         | Brazil mobile, E.164 (+55 + DDD + 9…)                | `+5562940038023` |
| `canada.phone`         | Canada, E.164 (area 613, fictional 555 exchange)     | `+16135558575`   |
| `common.phone.e164`    | E.164 phone, with a random country from the set      | `+34663489915`   |
| `france.phone`         | France mobile, E.164 (+33 6…)                        | `+33618948981`   |
| `germany.phone`        | Germany mobile, E.164 (+49 15x/16x/17x…)             | `+4917140038023` |
| `mexico.phone`         | Mexico, E.164 (+52 + LADA, 10-digit national number) | `+527353382246`  |
| `poland.phone`         | Poland mobile, E.164 (+48 5…)                        | `+48587209191`   |
| `russia.phone`         | Russia mobile, E.164 (+7 9…)                         | `+79962527739`   |
| `spain.phone`          | Spain mobile, E.164 (+34 6…)                         | `+34631634932`   |
| `united_kingdom.phone` | UK mobile, E.164 (Ofcom drama range +44 7700 900xxx) | `+447700900864`  |
| `usa.phone`            | US, E.164 (area 202, fictional 555 exchange)         | `+12025550883`   |

## National tax and document numbers

Every country listed here has its own family of checksummed tax, identity, and — for a
few of them — bank numbers. The US set alone covers most common needs:

```xml
<gen type="template" value="usa.docs.ssn"/>
<gen type="template" value="usa.tax.ein"/>
<gen type="template" value="usa.tax.itin"/>
```

`./run us-ids.tdc`

```
usa.docs.ssn             003060008
usa.tax.ein              678895040
usa.tax.itin             975531718
usa.finance.aba_routing  649946910
```

**Use these when** a record has to carry a country-appropriate identifier that survives
that country's validator — a Brazilian CPF, a Polish PESEL, a German VAT number — while
staying provably fake. Here's the full list, by address:

| Path                                | Produces                                                                                      | Example                |
| :---------------------------------- | :-------------------------------------------------------------------------------------------- | :--------------------- |
| `argentina.docs.dni`                | Argentine DNI (8-digit national identity number, no check digit)                              | `43073935`             |
| `argentina.tax.cuil`                | Argentine CUIL (2-digit prefix + 8-digit body + weighted mod-11 check)                        | `27740275106`          |
| `argentina.tax.cuit`                | Argentine CUIT (2-digit prefix + 8-digit body + weighted mod-11 check)                        | `24574791010`          |
| `austria.tax.vat`                   | Austrian VAT / UID (ATU + 7 digits + Luhn-style check digit)                                  | `ATU55031548`          |
| `belgium.tax.vat`                   | Belgian VAT (BE + 8-digit base + mod-97 check)                                                | `BE0507916645`         |
| `bolivia.docs.ci`                   | Bolivian Cedula de Identidad (7-digit number, no check digit)                                 | `3991646`              |
| `bolivia.tax.nit`                   | Bolivian NIT (9-digit tax number, no check digit)                                             | `252014061`            |
| `brazil.tax.cnpj`                   | Brazilian CNPJ (8-digit root + 4-digit branch + two mod-11 check digits)                      | `25232116564552`       |
| `brazil.tax.cpf`                    | Brazilian CPF (9-digit base + two mod-11 check digits)                                        | `14806904651`          |
| `bulgaria.tax.vat`                  | Bulgarian VAT (BG + 9 or 10 digits, no checksum)                                              | `BG380883064`          |
| `canada.docs.sin`                   | Canadian SIN (8 digits + Luhn check)                                                          | `585996796`            |
| `canada.tax.bn`                     | Canadian Business Number (9 digits, no checksum)                                              | `307343577`            |
| `canada.tax.program_account`        | Canadian program account (BN + program code + 4-digit reference)                              | `921050900RP9000`      |
| `chile.docs.run`                    | Chilean RUN (7–8 digit body + cyclic weighted mod-11 check, 10 → K)                           | `271951701`            |
| `chile.tax.rut`                     | Chilean RUT (7–8 digit body + cyclic weighted mod-11 check, 10 → K)                           | `90529471`             |
| `colombia.docs.cc`                  | Colombian Cedula de Ciudadania (8–10 digit number, no check digit)                            | `74407968`             |
| `colombia.tax.nit`                  | Colombian NIT (9-digit body + prime-weighted mod-11 check, right-to-left)                     | `4444807433`           |
| `costa_rica.docs.cpf`               | Costa Rican fisica ID (10 digits starting with 0, no check digit)                             | `0813694243`           |
| `costa_rica.tax.cpj`                | Costa Rican juridica ID (class digit + type + 6-digit serial, no check digit)                 | `4000813072`           |
| `croatia.tax.vat`                   | Croatian VAT / OIB (HR + 10-digit base + ISO 7064 MOD 11,10 check)                            | `HR99570241890`        |
| `cyprus.tax.vat`                    | Cypriot VAT (CY + 8 digits + 1 uppercase letter)                                              | `CY65642357G`          |
| `czechia.tax.vat`                   | Czech VAT / DIC (CZ + 8, 9 or 10 digits, no checksum)                                         | `CZ288311951`          |
| `denmark.tax.vat`                   | Danish VAT / CVR (DK + 8 digits, no checksum)                                                 | `DK42005491`           |
| `dominican_republic.docs.cedula`    | Dominican Cedula (10-digit body + Luhn check digit)                                           | `96179414394`          |
| `dominican_republic.tax.rnc`        | Dominican RNC (8-digit body + weighted mod-11 check)                                          | `970897251`            |
| `ecuador.docs.ci`                   | Ecuadorian Cedula (province + 9-digit payload + mod-10 check)                                 | `2144971195`           |
| `ecuador.tax.ruc`                   | Ecuadorian RUC, private-company form (province + 9 + weighted mod-11 check + 001)             | `0294486720001`        |
| `el_salvador.docs.dui`              | El Salvador DUI (8-digit body + weighted mod-10 check digit)                                  | `332432757`            |
| `el_salvador.tax.nit`               | El Salvador NIT (8-digit body + weighted mod-10 check digit)                                  | `492719607`            |
| `estonia.tax.vat`                   | Estonian VAT / KMKR (EE + 9 digits, no checksum)                                              | `EE949727018`          |
| `europe.tax.vat`                    | EU VAT (delegates to a default member state — Germany)                                        | `DE193530291`          |
| `finland.tax.vat`                   | Finnish VAT / ALV (FI + 7-digit base + weighted mod-11 check)                                 | `FI76372425`           |
| `france.tax.siren`                  | French SIREN (8 digits + Luhn check)                                                          | `033948829`            |
| `france.tax.vat`                    | French VAT (FR + mod-97 key + valid Luhn SIREN)                                               | `FR82250352820`        |
| `germany.tax.vat`                   | German VAT / USt-IdNr (DE + 8 digits, iterative mod-11/10 check)                              | `DE641787309`          |
| `greece.tax.vat`                    | Greek VAT / AFM (EL + 8-digit base + weighted mod-11 then mod-10 check)                       | `EL413288496`          |
| `guatemala.docs.cui`                | Guatemala CUI (9-digit serial + department 01–22 + municipality 01–99, no check digit)        | `2642014611803`        |
| `guatemala.tax.nit`                 | Guatemala NIT (13-digit body, the same shape as the CUI, no check digit)                      | `4436278540509`        |
| `honduras.docs.id`                  | Honduras national ID (department + municipality + year + 5-digit serial, no check digit)      | `1801200568981`        |
| `honduras.tax.rtn`                  | Honduras RTN (the 13-digit Honduras ID shape + 1 trailing digit, no check digit)              | `09281955957643`       |
| `hungary.tax.vat`                   | Hungarian VAT / ANUM (HU + 7-digit base + weighted mod-10 check)                              | `HU27025501`           |
| `ireland.tax.vat`                   | Irish VAT (IE + 7 digits + 1 uppercase letter)                                                | `IE8448267L`           |
| `italy.tax.vat`                     | Italian VAT / Partita IVA (IT + 10 digits + Luhn check)                                       | `IT12124511358`        |
| `latvia.tax.vat`                    | Latvian VAT / PVN (LV + 11 digits, no checksum)                                               | `LV51009639397`        |
| `lithuania.tax.vat`                 | Lithuanian VAT / PVM (LT + 9 or 12 digits, no checksum)                                       | `LT117600379`          |
| `luxembourg.tax.vat`                | Luxembourg VAT / TVA (LU + 8 digits, no checksum)                                             | `LU96561821`           |
| `malta.tax.vat`                     | Maltese VAT (MT + 8 digits, no checksum)                                                      | `MT07558770`           |
| `mexico.tax.rfc`                    | Mexico RFC (person 4-letter or org 3-letter + YYMMDD + 2 homoclave chars + mod-11 check char) | `TLT870426K69`         |
| `mexico.tax.rfc_org`                | Mexico RFC for an organization (3 letters + YYMMDD + 2 homoclave chars + mod-11 check char)   | `ESV970818ZA1`         |
| `mexico.tax.rfc_person`             | Mexico RFC for a person (4 letters + YYMMDD + 2 homoclave chars + mod-11 check char)          | `QEHF820406TE1`        |
| `netherlands.tax.vat`               | Dutch VAT / BTW (NL + 9 digits + B + 2-digit branch 01–99, no checksum)                       | `NL430439452B03`       |
| `nicaragua.docs.cedula`             | Nicaragua cedula (municipality + DDMMYY + 4-digit serial + control letter, no check digit)    | `0051201752201B`       |
| `nicaragua.tax.ruc`                 | Nicaragua RUC (person form — the same shape as the cedula, no check digit)                    | `0041010962608F`       |
| `panama.docs.cedula`                | Panama cedula, citizen form (province 1–13 + two 1–9999 groups, no check digit)               | `13187`                |
| `panama.tax.ruc`                    | Panama RUC, natural-person form — the same shape as the citizen cedula                        | `1221339`              |
| `paraguay.docs.ci`                  | Paraguay Cedula de Identidad (7-digit number, no check digit)                                 | `3254657`              |
| `paraguay.tax.ruc`                  | Paraguay RUC (person 7-digit or org 8-digit body + cycling-weight mod-11 check)               | `919747108`            |
| `peru.docs.dni`                     | Peru DNI (8-digit national identity number, no check digit)                                   | `00124682`             |
| `peru.tax.ruc`                      | Peru RUC (2-digit prefix + 8-digit body + weighted mod-11 check digit)                        | `15278344671`          |
| `poland.docs.pesel`                 | Polish PESEL (century-encoded date + serial + sex digit + weighted mod-10 check)              | `87212812168`          |
| `poland.tax.nip`                    | Polish NIP (9 digits + weighted mod-11 check; rejects check==10)                              | `6047995975`           |
| `poland.tax.vat`                    | Polish VAT (PL + NIP)                                                                         | `PL8126284465`         |
| `portugal.tax.vat`                  | Portuguese VAT / NIF (PT + 8-digit base + weighted mod-11 check)                              | `PT909207518`          |
| `romania.tax.vat`                   | Romanian VAT / CIF (RO + 2 to 10 digits, no checksum)                                         | `RO98311815`           |
| `russia.bank.account`               | Russian 20-digit bank account with cross-field mod-10 control key over the BIK tail           | `40702810299206214921` |
| `russia.bank.bik`                   | Russian BIK (9 digits: 04 + region + RKC + participant; no checksum)                          | `047225281`            |
| `russia.bank.correspondent_account` | Russian correspondent account (20 digits, embeds the BIK tail, cross-field mod-10 key)        | `30101810080720184177` |
| `russia.docs.snils`                 | Russian SNILS (9 digits + mod-101 two-digit check)                                            | `21804781661`          |
| `russia.geo.postal`                 | Russian postal code (6 digits, real range 101000–692999)                                      | `326151`               |
| `russia.tax.inn_org`                | Russian INN for a legal entity (10 digits, weighted mod-11 check)                             | `6840437608`           |
| `russia.tax.inn_person`             | Russian INN for a person (12 digits, two weighted mod-11 checks)                              | `860084325267`         |
| `russia.tax.kpp`                    | Russian KPP (9 digits: tax office + reason + serial; no checksum)                             | `976244677`            |
| `russia.tax.ogrn`                   | Russian OGRN for a legal entity (13 digits, whole-number mod-11 check)                        | `1691669019293`        |
| `russia.tax.ogrnip`                 | Russian OGRNIP for a sole proprietor (15 digits, whole-number mod-13 check)                   | `361197456067674`      |
| `slovakia.tax.vat`                  | Slovak VAT / IC DPH (SK + 10 digits, no checksum)                                             | `SK2872567116`         |
| `slovenia.tax.vat`                  | Slovenian VAT / ID za DDV (SI + 7-digit base + weighted mod-11 check)                         | `SI47349972`           |
| `spain.docs.dni`                    | Spanish DNI (8 digits + mod-23 control letter)                                                | `73742916V`            |
| `spain.docs.nie`                    | Spanish NIE (X/Y/Z + 7 digits + mod-23 control letter)                                        | `X3914405N`            |
| `spain.tax.cif`                     | Spanish CIF (entity-type letter + 7 digits + Luhn-style control digit)                        | `A43753219`            |
| `spain.tax.vat`                     | Spanish VAT (ES + CIF)                                                                        | `ESH50310499`          |
| `sweden.tax.vat`                    | Swedish VAT / Momsnr (SE + 9-digit base + Luhn check + literal "01")                          | `SE977841031701`       |
| `united_kingdom.docs.nino`          | UK National Insurance number (2 letters + 6 digits + suffix A–D; no checksum)                 | `QQ995347B`            |
| `uruguay.docs.ci`                   | Uruguay Cedula de Identidad (up to 7-digit body + weighted mod-10 check digit)                | `01252600`             |
| `uruguay.tax.rut`                   | Uruguay RUT (11-digit body + weighted mod-11 check)                                           | `218883180011`         |
| `usa.docs.ssn`                      | US Social Security number (area 001–899 excl. 666, group 01–99, serial 0001–9999)             | `003060008`            |
| `usa.finance.aba_routing`           | US ABA routing number (8 digits + mod-10 `[3,7,1]` check)                                     | `649946910`            |
| `usa.tax.ein`                       | US Employer Identification Number (valid IRS prefix + 7 digits; no checksum)                  | `678895040`            |
| `usa.tax.itin`                      | US ITIN (9 + 2 digits + valid group + 4 digits; no checksum)                                  | `975531718`            |
| `venezuela.docs.ci`                 | Venezuela Cedula de Identidad (V/E prefix + 7–8 digit body, no check digit)                   | `E7831675`             |
| `venezuela.tax.rif`                 | Venezuela RIF (V/E/J/P/G prefix + 8-digit body + weighted mod-11 check digit)                 | `V919623361`           |

## How the check digits are built

The checksum logic isn't buried in compiled code — each pack computes its check digit
**declaratively** with the [`<compute>`](./compute.md#top) tag, right next to the data. If a
country changes its rules, you edit the pack's text file, not the engine. The bodies of
these identifiers are drawn with the [`regex`](../generators/regex.md#top) and
[`number`](../generators/number.md#top) generators, and then `<compute>` appends the check
digit. See [Data Packs](../data-packs/overview.md#top) for how a pack is structured, and
[Writing your own pack](../data-packs/writing-your-own.md#top) for how to add one.

## See also

- **[`template` generator](../generators/template.md#top)** — the guided tour, plus the person, date, and localization families.
- **[Generators reference](./generators.md#top)** — every `type` for `<gen>`.
- **[`<compute>` reference](./compute.md#top)** — how the check digits are defined.
- **[Data Packs](../data-packs/overview.md#top)** — where identifier data lives, and how to add your own.

---

← Previous: [Built-ins](./builtins.md#top) · **[Contents](../README.md#top)** · Next: [Error codes](./errors.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/identifiers)**
