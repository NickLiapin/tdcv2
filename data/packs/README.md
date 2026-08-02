# Data packs

Self-describing data modules loaded by TDC at startup. See the design spec
at `docs/superpowers/specs/2026-07-14-data-packs-design.md` and the user
docs at `docs/user/ru/data-packs.md`.

## How addressing works

- **By folder path (default):** a file's dotted address is its path
  relative to this folder, without extension.
  `ru/person/male/firstName.txt` → address `ru.person.male.firstName`.
- **By header override:** a file may start with a `---`-fenced header
  declaring `address:` explicitly — used for files that sit loose or need
  an address that doesn't match their folder. The first address segment
  must still be a locale code or `common`.

## Using an address in a `.tdc` config

```xml
<gen type="template" value="person.ru.man.firstName"/>
```

Compose full names in the config (not in the pack):

```xml
<data>${{First}} ${{Patronymic}} ${{LastName}}</data>   <!-- Russian -->
<data>${{First}} ${{LastName}} ${{LastName2}}</data>    <!-- Spanish  -->
```

## Rules

- One file = one homogeneous list = one address.
- Files are plain UTF-8, one value per line.
- Data only — no code (keeps output identical across TS/Python/Java).
- Two files claiming the same address is an error.
- Dotfiles, `README`, `LICENSE`, `CHANGELOG` are ignored by the scanner.

These files are language-agnostic and shared with future Python/Java ports.
