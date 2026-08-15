# Shared diagnostic cases

A case is a config plus the diagnostics the reference reports for it. Every
implementation reads these files and must report the same ones.

This exists because "the same config produces the same data everywhere" is only
half a promise if one implementation accepts what another refuses. A config that
runs in Java and fails in TypeScript is a portability bug even when no value was
ever wrong — and it is the kind that surfaces at the worst moment, when someone
moves a config between two systems that were supposed to be interchangeable.

## What is compared

The **severity**, the **stable code**, and **where the diagnostic points** —
never the message text. Wording is edited for clarity over time, and holding
three implementations to a sentence would make every improvement a breaking
change. The code is the contract; that is what it was introduced for.

The position is compared because it is what an editor underlines and what a CLI
prints a caret under. An implementation that reports the right code at the wrong
place has not told anyone what is wrong with their config — only which file to go
looking in. It is recorded as `line:column`, with the column counted from zero
and pointing at the first character inside the attribute's quotes.

## Fields

| field          | meaning                                                            |
| :------------- | :----------------------------------------------------------------- |
| `name`         | unique within the file                                             |
| `demonstrates` | the code this case exists to pin                                   |
| `description`  | what is wrong with the config, in one line                         |
| `config`       | the `.tdc` source                                                  |
| `expected`     | `severity code` per diagnostic, in report order                    |
| `dataPath`     | optional — a folder beside this one holding files the config reads |

`dataPath` exists because some diagnostics cannot be stated without a file. TDC062 is "this
CSV column is not in the header", and there is no header for it to be absent from until one
is on disk. It names a folder relative to this directory (`"data"`), exactly as the rendering
cases spell it, so the two harnesses cannot drift apart on it.

`demonstrates` is a guard, not decoration. A case named after TDC062 whose config
actually produces TDC050 would otherwise be recorded as correct and then held
over every implementation forever; the generator refuses to write it. Three of
the first twenty-two cases here were caught that way.

## Regenerating

```
cd typescript && npm run diagnostics:update
```

`npm run check` runs the same script in verify mode, so a code cannot change in
the reference without the diff being seen.
