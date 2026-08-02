# TDC — Java Implementation

## Quick start

**You need:** **A JDK, 17 or newer**. Nothing else — the Gradle wrapper fetches what it uses.

```bash
cd java
./gradlew cliJar
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
java -jar build/libs/tdcv2-*-cli.jar demo.tdc
```

```
1,Williams
2,Johnson
3,Smith
```

The same three names, every time, in every implementation — that is the whole
point of the `seed`.

Worth an alias — `alias tdcv2='java -jar /absolute/path/tdcv2-0.1.0-SNAPSHOT-cli.jar'` —
after which the commands below read the same as in every other implementation.

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

Complete. Every cross-language fixture passes: the 104 shared cases through the router and on
all three engines, the 108 diagnostic cases by code and position, the PRNG and apportionment
vectors, and the six Parquet files byte for byte.

Run the checks with `./gradlew test` from this folder — 709 tests. No global install is needed;
the Gradle wrapper fetches what it uses.

```java
var data = new TDC("users.tdc");
System.out.println(data);

for (TDC.Row row : data.iterate()) {
    System.out.println(row.get("Gender"));
}

data.writeFile(Path.of("users.parquet"));  // the extension picks the format
```

The jar ships a starter pack set only — `common`, `en`, and the USA country pack. Everything
else comes from the shared registry on demand, the same one the command-line tool and the
Python library read: `DataPacks.install(projectDir, "ru", "france")`.

## One value, without a config

Sometimes a test wants a name, not a dataset. The quick API answers from the same
data packs a config draws on, so the name in a unit test and the name in a
million-row fixture come from one list.

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");             // Jones
tdc.get("person.male.firstName");       // Robert
tdc.get("usa.docs.ssn");                // 699209702 — with its real check digits
tdc.many("person.lastName", 5);         // five of them
tdc.gen("number", Map.of("value", "18..80"));
```

Values are random per process. Pin a seed when the value should be part of the
test rather than a variable in it — and `seed()` returns a NEW object, so two
tests can hold two seeds at once:

```java
Quick demo = Quick.tdc().seed("demo").locale("en");
demo.get("person.lastName");            // Jones, today and next year
```

The address is spelled the way the pack spells it: `person.male.firstName` here is
`person.male.firstName` in a config and in the reference. A bare address is read
against the active locale; write `ru.person.lastName` to name a pack outright.

**Why a string and not `tdc.person().lastName()`.** That shape needs a generated
method per address, and a generated surface can only ever cover the packs inside
the jar. Most packs are downloaded at runtime — ten languages, ninety-odd
countries — so `tdc.lang().ru()` would not exist for the pack a user had just
installed, while `get("ru.person.lastName")` works the moment the download
finishes.

Every call is independent: nothing here ties one value to another. The moment two
values have to agree, you want a config.

## The command line

Maven has no equivalent of npm's `bin` — adding a library to a project does not put a command on
the PATH — so the CLI ships as one self-contained jar instead. Nothing but a JDK is needed to run
it, and nothing from another language: a Java user should not have to install Node to run a `.tdc`
file.

It travels with the library, under the same Maven coordinates — one address, two files, told
apart by a classifier. Download `tdcv2-<version>-cli.jar` from
`https://repo1.maven.org/maven2/io/github/nickliapin/tdcv2/<version>/`, or build it here:

```bash
./gradlew cliJar
java -jar build/libs/tdcv2-*-cli.jar users.tdc -o users.csv
```

Worth an alias — `alias tdcv2='java -jar /path/to/tdcv2-cli.jar'` — after which it is the same
four commands as the TypeScript and Python CLIs, flag for flag:

|                                              |                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `tdcv2 <file.tdc>`                           | Generate. `-o`, `--seed`, `--count`, `--locale`, `--data-path`, `--engine`  |
| `tdcv2 init`                                 | Write a `tdcv2.config.json` — asks at a terminal, takes `--yes` in a script |
| `tdcv2 pack list \| add <id> \| remove <id>` | Data packs, from the shared registry                                        |
| `tdcv2 check <file.tdc>`                     | Validate and say nothing when it is fine — for a pre-commit hook            |
| `tdcv2 format [-w] <file.tdc>`               | Pretty-print a config; `-w` rewrites it in place                            |

A pack installed here is a pack the TypeScript and Python implementations find: one registry, one
`tdcv2.config.json`, one store. `--registry` accepts an `http`, `https` or `file` address, so an
offline mirror or a folder on a share works the same way as the public one.

The one deliberate difference: `--jobs` is accepted and does nothing. Splitting a run across
processes is implemented in the TypeScript and Python CLIs; here the flag exists so a script
written for one of those does not fail, and the run stays single-threaded.

## Why Java

The **enterprise backend market** remains predominantly on the JVM. For
organizations running large-scale test environments, generation pipelines
with strong typing and performance, or integration with Java-based tooling
(Spring, Micronaut, Quarkus, etc.), a Java-native implementation of TDC
lowers the integration barrier significantly.

Java on the JVM may also become the **fastest** TDC implementation thanks to
JIT compilation — a useful property when generating very large datasets
(tens of millions of records).

## Stack

- **Runtime:** Java 17+, compiled with `--release 17` so the bytecode is checked against
  the 17 API rather than whichever JDK happens to be installed
- **Parser:** ANTLR4 Java runtime (generated from `../grammar/TDC.g4`)
- **Test framework:** JUnit 5 + AssertJ for readable assertions
- **Linter / style:** Checkstyle + Spotless (Google Java Format)
- **Static analysis:** SpotBugs + ErrorProne
- **Build:** Gradle (Kotlin DSL). Maven Central is the _repository_ the artifact is
  published to; the build tool is a separate choice. Gradle wins here because the parser is
  generated from the shared `../grammar/*.g4` and the tests read fixtures and data packs
  from outside this folder — both are a few lines of Gradle and a plugin binding in Maven.
- **Package:** published to Maven Central as `io.github.nickliapin:tdcv2`
- **Git hooks:** pre-commit framework (cross-language)

## Principles

**Bit-identical output** to the TypeScript reference for the same config and seed. That is what
the fixtures under `../fixtures/cross-language/` check, and it is why the PRNG, the Snappy
encoder, the Parquet writer and the date arithmetic are all written here rather than depended on
— a library's choice of rounding or compression would change the bytes.

Java-specific note, now settled: the JVM's signed 32-bit `int` turned out to be an
advantage rather than a hazard. JavaScript has to force 32-bit arithmetic out of doubles
with `Math.imul`, `| 0` and `>>> 0`; Java's `int` already wraps that way, so the port is
almost line for line. The single place a mask is required is the final division, where
`t >>> 0` becomes `t & 0xFFFFFFFFL` because Java has no unsigned int.

The other trap is the seed string: JavaScript's `charCodeAt` yields a UTF-16 code unit and
so does Java's `charAt`. A port that iterates code points instead would diverge on any seed
outside the Basic Multilingual Plane.

## References

- [../docs/bindings/](../docs/bindings/) — how one config runs in three languages
