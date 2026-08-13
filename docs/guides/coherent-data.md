<a name="top"></a>

**English** · [Русский](../ru/guides/coherent-data.md#top) · [Español](../es/guides/coherent-data.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/coherent-data)**

← Previous: [Hierarchical dependencies](./hierarchical-dependencies.md#top) · **[Contents](../README.md#top)** · Next: [No repeats within a row](./distinct.md#top) →

---

# Coherent & relational data

Ordinary fake-data generators fill fields independently, so you get impossible pairs: a
`Fiat` with the model `Altima` (that's a Nissan), a city from one state with a ZIP code
from another. TDC does it differently.

The mechanism is one rule: **a template address can interpolate another field's value**. The
parent picks the file the child is drawn from:

```text
value="common.vehicle.model.${{Brand}}"
```

If the brand comes out as `Fiat`, the address becomes `common.vehicle.model.Fiat` and
the model is drawn **from the Fiat file** — never "Fiat Altima".

> [!NOTE]
> **Outputs are illustrative**
>
> The values below come from a fixed `seed`, so they're reproducible, but exact strings
> and proportions can differ between core versions. Treat them as examples of _shape_,
> not guarantees.

## How it looks

Two [sequences](../core-concepts/sequences.md#top): a brand and a model. The model
declares [`parent="Brand"`](../core-concepts/sequences.md#top) (so it sees the chosen
brand) and interpolates it into the [`template`](../generators/template.md#top) address
with `${{Brand}}`:

```xml
<tdc>
  <env count="5" seed="showroom" local="en">
    <sequence name="Brand"><gen type="template" value="common.vehicle.brand"/></sequence>
    <sequence name="Model" parent="Brand"><gen type="template" value="common.vehicle.model.${{Brand}}"/></sequence>
  </env>
  <block><line><data>${{Brand}} ${{Model}}</data></line></block>
</tdc>
```

`./run showroom.tdc`

```
Honda CR-V
Toyota Corolla
Ford Maverick
Chevrolet Bolt EV
Nissan Kicks
```

Every model belongs to its brand. And `common.vehicle.brand` is a **weighted** pack
(Toyotas are common, Maybachs are rare), so the makes themselves show up in realistic
proportions too — you get coherent pairs _and_ a believable market mix from one config.

## One child per parent — a cuisine and its dish

The same shape works for any parent/child pair. A cuisine pulls its own dish
(`food.cuisine` → `food.dishByCuisine.<cuisine>`). **Use it when** the two fields would
look absurd drawn independently — nobody believes in "Korean Falafel":

```xml
<sequence name="Cuisine"><gen type="template" value="food.cuisine"/></sequence>
<sequence name="Dish" parent="Cuisine"><gen type="template" value="food.dishByCuisine.${{Cuisine}}"/></sequence>
```

`./run menu.tdc`

```
Lebanese: Falafel
Korean: Bulgogi
Indian: Rogan Josh
Chinese: Peking Duck
Greek: Souvlaki
```

## One parent, several linked children

A single parent can feed **more than one** child. Each child interpolates the same
parent value into its own address, so every field on the row stays consistent with the
others. Here a country (weighted by population) pulls both a capital and a currency:

```xml
<sequence name="Country"><gen type="template" value="geo.country"/></sequence>
<sequence name="Capital" parent="Country"><gen type="template" value="geo.capitalByCountry.${{Country}}"/></sequence>
<sequence name="Currency" parent="Country"><gen type="template" value="geo.currencyByCountry.${{Country}}"/></sequence>
```

`./run atlas.tdc`

```
China — Beijing — Renminbi
United States — Washington — US Dollar
India — New Delhi — Indian Rupee
Indonesia — Jakarta — Rupiah
China — Beijing — Renminbi
```

**Use it when** several fields all depend on the same key: address parts hanging off a
state, product details hanging off a category, org data hanging off a department.
Declare each child with the same `parent` and they all read the same chosen value.

## How the data is laid out

The parent is an ordinary list, and each of its values gets its **own child file**,
named after the value itself:

```text
data/packs/common/vehicle/
  brand.txt                 # the brands (parent)
  model/
    Toyota.txt              # Toyota models
    Fiat.txt                # Fiat models
    Mercedes-Benz.txt       # names with a hyphen or space work too
```

The file address is the dotted path: `model/Fiat.txt` → `common.vehicle.model.Fiat`. In
the template, `${{Brand}}` fills in the file name and TDC finds the right list. To add a
brand, drop in `model/NewBrand.txt` and add a line to `brand.txt`. Ready-made coherent
sets ship for car makes, `food.cuisine`, `medical.specialtyCoherent`,
`work.industryCoherent`, `common.dev.languageCoherent`, `sport.sportCoherent`, and
`geo.country`.

## Things to remember

- **Declare the parent before the child** — TDC materializes
  [sequences](../core-concepts/sequences.md#top) top to bottom, so `${{Brand}}` reads a
  value that has already been computed. A child that interpolates a field defined
  _below_ it has nothing to read.
- **`parent="Brand"`** links the child to the parent and fixes the order. For a plain
  lookup that's enough; stricter filtering on a _specific_ value (`parent="Brand.Fiat"`)
  is covered in [Hierarchical dependencies](hierarchical-dependencies.md#top).
- **Every parent value needs a matching child file**, or the address won't resolve and
  you get an error. That's why the parent list usually holds exactly the values that
  have files (like `common.vehicle.brand`).
- **Engine.** A config like this always runs on the in-memory engine — it's the only one
  that resolves an address per row, so memory grows with `count`. This feature is about
  realistic coherence, not streaming gigabytes; [Which engine runs your
  config](large-outputs.md#which-engine-runs-your-config) lists this and the five other
  shapes that route the same way.

## The CSV cousin — `row` + `weight`

When your related fields live in one **CSV** rather than in per-value files, link them
with [`row`](../generators/file.md#top) instead: several [`file`](../generators/file.md#top)
generators that share the same `row` read the **same line** on each record, so the
fields stay together on one row of real data. Add `weight` to one of them to draw that
line by its real frequency:

```xml
<sequence name="Place">
  <gen name="City"  type="file" src="cities.csv" column="city"  row="loc" weight="population"/>
  <gen name="State" type="file" src="cities.csv" column="state" row="loc"/>
</sequence>
```

`./run cities.tdc`

```
Seattle, WA
Austin, TX
Chicago, IL
Seattle, WA
Denver, CO
```

Because both generators share `row="loc"`, the city and its state always come from the
same line; `weight="population"` on the city makes bigger places show up more often.
Full details are on the [File generator](../generators/file.md#top) page.

## The numeric cousin — a column computed from another

The two mechanisms above keep **drawn** values together: one file decides another
file, or one CSV line feeds several fields. A number often has to hold together
differently — not drawn at all, but **computed** from the column beside it. A weight
follows a height; an area follows a price; a total follows a quantity and a rate.

That is [`formula`](../generators/formula.md#top):

```xml
<sequence name="Height"><gen type="number" distribution="normal" mean="170" sd="10" decimals="1"/></sequence>
<sequence name="Noise"> <gen type="number" distribution="normal" mean="0" sd="1" decimals="4"/></sequence>
<sequence name="Weight"><gen type="formula" expr="0.75 * Height - 58 + 6 * Noise" decimals="1"/></sequence>
```

`./run clinic.tdc`

```
171.2, 77.5
177.6, 83.4
164.6, 76.9
164.4, 68.4
175.8, 74.8
```

`Noise` is what keeps the pair from being a straight line, and it never has to be
printed — a sequence left out of `<block>` still takes part in the calculation. Two
columns that move together like this are what a model can actually learn from;
independent draws of the same two ranges are not.

A third way in is a **distribution parameter**: `lambda="Traffic * 0.1"` shapes the
draw itself by another column rather than computing a value after the fact. See
[A parameter can follow another column](statistical-distributions.md#a-parameter-can-follow-another-column).

## See also

- **[Hierarchical dependencies](hierarchical-dependencies.md#top)** — filtering a child on a specific parent value.
- **[Sequences](../core-concepts/sequences.md#top)** — declaring fields and the `parent` link.
- **[Template](../generators/template.md#top)** and **[File](../generators/file.md#top)** generators.

---

← Previous: [Hierarchical dependencies](./hierarchical-dependencies.md#top) · **[Contents](../README.md#top)** · Next: [No repeats within a row](./distinct.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/coherent-data)**
