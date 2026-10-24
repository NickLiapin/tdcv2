<a name="top"></a>

**English** · [Русский](../ru/ai-agents/working-with-the-agent.md#top) · [Español](../es/ai-agents/working-with-the-agent.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/ai-agents/working-with-the-agent)**

← Previous: [Other agents](./other-agents.md#top) · **[Contents](../README.md#top)** · Next: [Configuration structure](../core-concepts/configuration.md#top) →

---

# Working with the agent

## Ask in plain words

Describe the data the way you would to a colleague:

```text
500 customers from 20 countries as CSV.
A pytest test for validate_user on 50 different users.
SQL inserts for a clinic: departments, doctors in each department, and their appointments.
The same orders file, but 10,000 rows and 30% of them canceled.
```

Say what matters to you: the format, how many rows, which fields must agree with each other,
the shares you need, the language or country. Anything you leave out, the agent decides and
writes into the config, where you can see it.

## What the agent does

1. Reads the TDC guide, once per session.
2. Looks up real-world values in the [data packs](../data-packs/overview.md#top) — names,
   cities, IBANs. When a language or country is missing, it installs the pack; with the MCP
   server, your client asks you to allow that first.
3. Writes the `.tdc` config and checks it with the engine until no error is left.
4. Generates a preview of the first rows, or the whole file.
5. Summarizes the file — row count, the split of each column, the ranges — to show it holds
   what you asked for.
6. Hands you the file and the config.

With the skill alone, the agent does all of this with the `tdcv2` command in its terminal.
With the MCP server, it calls the server's tools instead.

## The server's tools

| Tool             | What it does                                                                            |
| :--------------- | :-------------------------------------------------------------------------------------- |
| `tdc_read_docs`  | the guide, the traps `check` does not catch, test code in five languages, any page here |
| `tdc_find_packs` | finds installed data packs by words ("last name", "iban") and gives their addresses     |
| `tdc_pack_add`   | installs packs for another language or country — `tdcv2 pack add`                       |
| `tdc_check`      | every diagnostic, with code, line, column, hint and a "did you mean"                    |
| `tdc_generate`   | a preview of up to 50 lines, or the whole file                                          |
| `tdc_peek`       | a short summary of a CSV, JSON or SQL file in the project                               |
| `tdc_format`     | formats a config the way `tdcv2 format` does                                            |

The server also offers the guide as a prompt, `tdcv2_guide`, and four pages as resources:
`tdcv2://guide`, `tdcv2://traps`, `tdcv2://from-code` and `tdcv2://linked-tables`.

## Review what you get

The config is what you keep. It is a short file that states every rule the data follows, and
reading it is quicker than reading the data — [Your first dataset](../getting-started/first-data.md#top)
explains what you will see in one. Keep it in the project beside the file it made.

The same config with the same `seed` gives the same file, byte for byte. Rerun it yourself
without the agent:

```bash
npx -y tdcv2@0.3.5 customers.tdc -o customers.csv
```

To change the data, change the config: ask the agent ("make it 10,000 rows, a third from
Germany"), or edit the file and rerun it. `tdcv2 check customers.tdc` tells you whether an
edit is valid before you generate.

---

← Previous: [Other agents](./other-agents.md#top) · **[Contents](../README.md#top)** · Next: [Configuration structure](../core-concepts/configuration.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/ai-agents/working-with-the-agent)**
