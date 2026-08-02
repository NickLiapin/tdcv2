<a name="top"></a>

**English** · [Русский](../ru/pools/linking.md#top) · [Español](../es/pools/linking.md#top)

← Previous: [Narrowing with filter](./filter.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../constructs/overview.md#top) →

---

# Linking pools together

One pool gives a row a coherent record. Several pools give a row a coherent **world**:
clinics that exist, doctors who work at one of them, nurses who work alongside those
doctors. This page is about how the pieces connect.

There are exactly two ways to link, and they answer different questions:

| The link | Where it is fixed | Write it as |
| :------- | :---------------- | :---------- |
| **A pool draws from a pool** | per member — this doctor works at that clinic, always | `<gen type="pool">` inside a `<pool>` |
| **A row's references agree** | per row — this patient's nurse is at this patient's doctor's clinic | `filter=` naming another reference's field |

The first builds the world. The second holds one row together.

## A pool that draws from a pool

A member of one pool can hold a whole member of another. Doctors belong to clinics:

```xml
<tdc>
  <env count="8" seed="probe" local="en">
    <pool name="Clinics" count="3">
      <sequence name="city" uniq="true"><gen type="text" value="North,South,East"/></sequence>
      <sequence name="phone"><gen type="number" value="100..999"/></sequence>
    </pool>

    <pool name="Doctors" count="5">
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
      <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
    </pool>

    <sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>
  </env>
  <block>
    <line><data>Dr. ${{Seen.name}} @ ${{Seen.at.city}} (tel ${{Seen.at.phone}})</data></line>
  </block>
</tdc>
```

`./run clinics.tdc`

```
Dr. Brown @ North (tel 695)
Dr. Brown @ North (tel 695)
Dr. Jones @ East (tel 300)
Dr. Smith @ South (tel 428)
Dr. Smith @ South (tel 428)
Dr. Jones @ East (tel 300)
Dr. Johnson @ East (tel 300)
Dr. Jones @ East (tel 300)
```

> [!NOTE]
> **Outputs are illustrative**
>
> The values come from a fixed `seed`, so they're reproducible, but exact strings can
> differ between core versions. Treat them as examples of *shape*, not guarantees.

Three facts to read off that output:

- **The dot goes one level deeper.** `at` names a whole clinic, so it has no value of
  its own; its fields are `${{Seen.at.city}}` and `${{Seen.at.phone}}`. Writing
  `${{Seen.at}}` is refused for the same reason `${{Seen}}` is.
- **The link is fixed per member, not per row.** Dr. Jones is at the East clinic on
  every row where he appears, because the clinic was decided when the *doctor* was
  built.
- **The clinic's own fields travel together.** East is always 300 — the phone belongs to
  the clinic record, not to the row.

### The order rule

A pool may only draw from a pool **declared above it**. Pools are built in the order
they are written, so a pool named below has no table yet when this one is computed:

`./run clinics.tdc`

```
error[TDC236]: pool "Doctors" draws from "Clinics", which is not declared above it
 --> clinics.tdc:5:7
  |
5 |       <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
  |       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
  |
note: Pools are built in declaration order, so a pool can only read the pools above it. Move "Clinics" above "Doctors". That order is also why a cycle between pools cannot be written down.
```

That rule does a second job for free: **a cycle between pools cannot be written down.**
There is no cycle detection anywhere in TDC, because there is nothing to detect —
`Doctors` reaching `Clinics` is a table lookup, and `Clinics` reaching `Doctors` is a
name that does not exist yet. A pool naming itself gets the same code, for the same
reason.

### How deep can it go

As deep as you write it. Each level is an ordinary pool that happens to hold a reference,
so `${{Seen.at.region.name}}` is not a special case — it is three tables and two links.

The cost stays where you would want it: every pool is built once, before the run, so a
chain three deep is three small tables and no per-row work beyond the picks.

## Two references that agree

The second kind of link is between two references **in the same row**. A `filter` reads
the current row's columns, and a reference's fields are columns like any other — so a
nurse can be filtered to the clinic the row's doctor works at:

```xml
<tdc>
  <env count="8" seed="clinic" local="en">
    <pool name="Clinics" count="3">
      <sequence name="city" uniq="true"><gen type="text" value="North,South,East"/></sequence>
    </pool>
    <pool name="Doctors" count="6">
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
      <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
    </pool>
    <pool name="Nurses" count="9">
      <sequence name="name"><gen type="template" value="person.female.firstName"/></sequence>
      <sequence name="city"><gen type="text" value="North,South,East"/></sequence>
    </pool>

    <sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>
    <sequence name="Assisted"><gen type="pool" value="Nurses" filter="city == Seen.at.city"/></sequence>
  </env>
  <block>
    <line><data>Dr. ${{Seen.name}} (${{Seen.at.city}}) + nurse ${{Assisted.name}} (${{Assisted.city}})</data></line>
  </block>
</tdc>
```

`./run team.tdc`

```
Dr. Williams (South) + nurse Susan (South)
Dr. Jones (East) + nurse Mary (East)
Dr. Johnson (South) + nurse Patricia (South)
Dr. Garcia (North) + nurse Dorothy (North)
Dr. Jones (East) + nurse Mary (East)
Dr. Jones (East) + nurse Mary (East)
Dr. Brown (East) + nurse Mary (East)
Dr. Williams (South) + nurse Linda (South)
```

The filter reaches through two links in one expression: `Seen.at.city` is the row's
doctor's clinic's city. Nothing special makes that work — `Seen.at.city` is a column of
the row by the time `Assisted` is built, because references resolve in **declaration
order**, exactly as sequences do.

Which means the same rule applies here as everywhere else in `<env>`: **the reference you
filter on must be declared above the one that filters.** Swap `Seen` and `Assisted` and
the filter reads a name nothing has produced yet.

## A worked example

Three layers, four kinds of link, one config. Clinics exist; doctors belong to a clinic
and have a specialty in a fixed proportion; a patient needs a specialty and is seen by a
doctor who has it.

```xml
<tdc>
  <env count="10" seed="clinic" local="en">
    <pool name="Clinics" count="3">
      <sequence name="city" uniq="true"><gen type="text" value="North,South,East"/></sequence>
      <sequence name="phone"><gen type="number" value="200..299"/></sequence>
    </pool>

    <pool name="Doctors" count="8">
      <sequence name="name"><gen type="template" value="person.lastName"/></sequence>
      <mix name="role" percent="25,75">
        <case><gen type="text" value="surgeon"/></case>
        <case><gen type="text" value="therapist"/></case>
      </mix>
      <sequence name="at"><gen type="pool" value="Clinics"/></sequence>
    </pool>

    <sequence name="Patient"><gen type="template" value="person.female.firstName"/></sequence>
    <sequence name="Needs"><gen type="text" value="surgeon,therapist" percent="30,70"/></sequence>
    <sequence name="Seen"><gen type="pool" value="Doctors" filter="role == Needs"/></sequence>
  </env>
  <block>
    <line><data>${{Patient}} needs a ${{Needs}} -> Dr. ${{Seen.name}}, ${{Seen.at.city}} clinic, tel ${{Seen.at.phone}}</data></line>
  </block>
</tdc>
```

`./run clinic.tdc`

```
Barbara needs a therapist -> Dr. Johnson, South clinic, tel 284
Mary needs a therapist -> Dr. Jones, North clinic, tel 278
Dorothy needs a therapist -> Dr. Davis, South clinic, tel 284
Jennifer needs a therapist -> Dr. Smith, East clinic, tel 239
Elizabeth needs a surgeon -> Dr. Williams, South clinic, tel 284
Patricia needs a surgeon -> Dr. Williams, South clinic, tel 284
Susan needs a therapist -> Dr. Garcia, North clinic, tel 278
Sarah needs a surgeon -> Dr. Williams, South clinic, tel 284
Margaret needs a therapist -> Dr. Davis, South clinic, tel 284
Linda needs a therapist -> Dr. Smith, East clinic, tel 239
```

Every constraint in that config holds in every row, and none of them was written twice:

- Two of the eight doctors are surgeons, because `percent="25,75"` applies to the
  **members**.
- Thirty percent of the patients need a surgeon, because `percent="30,70"` applies to
  the **rows**. Those are different populations and both are exact.
- A patient who needs a surgeon gets one, because `filter="role == Needs"` narrows the
  candidates.
- The phone number always belongs to the named city, because the clinic is a record the
  doctor holds.

Add a fourth layer — a region each clinic belongs to — and nothing about the config's
shape changes. That is the point of the construct.

## What is not supported

- **A `<pool>` inside a `<pool>`.** Refused (`TDC230`). A pool stays a flat table you
  could print; nesting would make it a tree, and every later question — uniqueness,
  filtering, the memory ceiling — would have to ask "at which depth?". Point one pool at
  another instead, which is what this page is about.
- **A pool drawing from a pool below it, or from itself.** Refused (`TDC236`), as above.
- **Weights on members.** A pool has no per-member weight. Use a
  [`<mix>`](../constructs/mix.md#top) inside the pool — that is the same thing said in the
  language the pool already speaks, and it is exact rather than approximate.
- **A reference with `parent=` on a streaming engine.** Not refused: the config is
  routed to the in-memory engine, which needs the whole parent column to know which rows
  exist at all.

## Related

- [Overview](overview.md#top) — what a pool is, and the size ceiling
- [Narrowing with `filter`](filter.md#top) — the expression language a link is written in
- [Hierarchical dependencies](../guides/hierarchical-dependencies.md#top) — `parent`, the
  other way rows relate to one another

---

← Previous: [Narrowing with filter](./filter.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../constructs/overview.md#top) →
