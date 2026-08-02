# Weighted source data

Real-world lists **with frequencies**, one value per row as `name,count`. These
are what makes `Smith` appear as often as it does in life instead of as often as
`Zabrowski` — the difference between a bag of strings and a model of a
population.

They live here, outside `data/packs/`, on purpose. The pack format is one value
per line and carries no weight column yet (see the en/US plan, step 1), and the
pack scanner would otherwise read `Smith,2442977` as a literal value. Until packs
learn to carry weights, use these through `weight=`:

```xml
<gen type="file" src="@data/us/person/lastName.csv" column="name" weight="count"/>
```

```
tdc config.tdc --data-path data/sources
```

Verified end to end: 100 000 rows of `lastName` produce **920 Smith** — exactly
the 0.919 % Smith holds in the Census — and the run is byte-identical across
seeds.

---

## What is here

| File                             |    Rows | Source                            |
| -------------------------------- | ------: | --------------------------------- |
| `us/person/lastName.csv`         | 162 253 | 2010 US Census surname file       |
| `us/person/male/firstName.csv`   |  42 567 | SSA baby names, 1880–2020, summed |
| `us/person/female/firstName.csv` |  68 905 | SSA baby names, 1880–2020, summed |
| `us/geo/city.csv`                |  19 484 | Census 2023 place population est. |
| `us/geo/state.csv`               |      57 | Census state reference file       |
| `us/geo/street_suffix.csv`       |     206 | USPS Pub 28 Appendix C1           |

`city.csv` and `state.csv` carry extra columns beyond the weighted one, so an
address stays coherent: draw a city weighted by `population`, and its `state`
sits in the same row (link them with [`row=`](../../docs/user/ru/attr-row.md)).

## Provenance and licence

All three are **US federal public-domain** data — free to redistribute, no
attribution required.

**Surnames** — _Frequently Occurring Surnames from the 2010 Census_, US Census
Bureau. Downloaded from
`https://www2.census.gov/topics/genealogy/2010surnames/names.zip`
(`Names_2010Census.csv`). Every surname occurring **100 times or more** is
listed with its national count; the file's trailing `ALL OTHER NAMES` aggregate
(the ~29 M-person long tail below the threshold) is dropped. The counts of what
remains sum to 265 667 228.

**First names** — _Baby Names from Social Security Card Applications, National
Data_, US Social Security Administration. The SSA host blocks datacentre IPs at
its CDN edge, so the raw per-year `yobYYYY.txt` files were taken from the
`hackerb9/ssa-baby-names` mirror on GitHub and **verified against published SSA
facts** before use: the 2020 top names come out Liam / Olivia, and the all-time
tops come out James, John, Robert (male) and Mary, Elizabeth, Patricia (female)
— all matching the SSA's own published rankings. Counts are summed across every
year 1880–2020 and split by the file's `M`/`F` column.

**Cities** — _Subcounty Resident Population Estimates 2020–2023_ (`sub-est2023`),
US Census Bureau Population Estimates Program. Downloaded from
`https://www2.census.gov/programs-surveys/popest/datasets/2020-2023/cities/totals/sub-est2023.csv`.
Filtered to incorporated places (`SUMLEV == 162`), taking `NAME`, `STNAME` and
`POPESTIMATE2023`. Verified against reality: the top come out New York
(8 258 035), Los Angeles, Chicago, Houston, Phoenix, Philadelphia — the correct
order and magnitudes. A city name repeats across states (there are 12 677
distinct names over 19 484 rows — every Springfield is a separate row with its
own state and population), which is exactly what makes a city→state link work.

**States** — the Census Bureau's state FIPS reference file
`https://www2.census.gov/geo/docs/reference/state.txt`. 51 states + DC, plus 6
territories (PR, VI, GU, AS, MP, UM). Columns: `name`, `abbr`, `fips`.

**Street suffixes** — USPS _Publication 28, Appendix C1_ (`Street Suffix
Abbreviations`), the postal standard, from
`https://pe.usps.com/text/pub28/28apc_002.htm`. 206 distinct primary suffix
names with their standard abbreviation (`Street`/`St`, `Avenue`/`Ave`,
`Boulevard`/`Blvd`), Title-cased. USPS content is public domain.

> This list is **not weighted** — USPS publishes no usage frequency, so `Street`
> and `Skyway` are equally likely here. Real usage is heavily skewed toward a
> dozen common suffixes; deriving weights would mean counting suffixes across
> the Census TIGER/Line road network, which is a separate, larger job.

## Normalisation applied

- **Surnames were Title-cased** from the Census ALL-CAPS (`SMITH` → `Smith`).
  Apostrophes and hyphens are handled (`O'BRIEN` → `O'Brien`, `SMITH-JONES` →
  `Smith-Jones`). Mc/Mac names are **not** perfectly cased — `MCDONALD` becomes
  `Mcdonald`, not `McDonald`. Fixing that needs a name-specific rule and is left
  for when it matters. (The 2010 file, incidentally, carries no apostrophes at
  all — it stores `OBRIEN`, not `O'BRIEN`.)
- **First names** arrive from SSA already in Title case and are left untouched.
- **City names** have their Census type designator stripped (`New York city` →
  `New York`, dropping `city`/`town`/`village`/`CDP`/`borough`/`municipality`
  and a few Puerto-Rico-specific ones) and any trailing `(…)` note removed. Two
  names legitimately contain a comma (`Islamorada, Village of Islands`;
  `Lynchburg, Moore County`) and are RFC 4180-quoted by the CSV writer.

## Decisions worth revisiting

- **First names are weighted by ALL years 1880–2020.** That is the honest "how
  often has this name ever been given" figure, but it over-weights names that
  dominated decades ago — `Mary` lands at #2 female, which reads old for
  present-day test data. A per-decade split (so a 1990s birth date draws 1990s
  names) is the planned refinement; the SSA files carry the year, so the data to
  do it is already downloaded.

## Reproducing

```bash
# surnames
curl -sO https://www2.census.gov/topics/genealogy/2010surnames/names.zip
# first names (from the mirror, since ssa.gov blocks datacentre IPs)
curl -sL https://codeload.github.com/hackerb9/ssa-baby-names/zip/refs/heads/main -o ssa.zip
```

Then title-case + drop the `ALL OTHER NAMES` row (surnames), and sum the yob
files by name and sex (first names).
