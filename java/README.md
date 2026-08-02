# TDC — Java Implementation

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

## The command line

Maven has no equivalent of npm's `bin` — adding a library to a project does not put a command on
the PATH — so the CLI ships as one self-contained jar instead. Nothing but a JDK is needed to run
it, and nothing from another language: a Java user should not have to install Node to run a `.tdc`
file.

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
