<a name="top"></a>

**English** · [Русский](../ru/ai-agents/overview.md#top) · [Español](../es/ai-agents/overview.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/ai-agents/overview)**

← Previous: [Editor support](../getting-started/editor-support.md#top) · **[Contents](../README.md#top)** · Next: [Claude Code](./claude-code.md#top) →

---

# TDC for AI agents

A coding agent can write TDC configs for you. You ask in plain words — "500 customers from 20
countries as CSV", "a pytest test for `validate_user` on 50 different users" — and the agent
writes the `.tdc` config, checks it with the engine, generates the file on your machine, and
hands you the data together with the config that reproduces it.

An agent needs two things for that, and the
[`tdcv2-agents`](https://github.com/NickLiapin/tdcv2-agents) project supplies both:

- **A skill** — instructions the agent reads before it starts. It teaches the TDC language,
  the workflow, and the traps the engine's `check` cannot catch. The agent then runs the
  engine in its own terminal.
- **An MCP server**, `tdcv2-mcp` — the same knowledge as tools the agent calls: check a
  config, generate, find and install data packs, summarize a file, read these docs. MCP (the
  Model Context Protocol) is the standard way an agent calls tools that another program
  provides.

Both ship together, under one version: 0.1.6.

## Which one to use

| Your agent                                      | Install                                    | Page                                                               |
| :---------------------------------------------- | :----------------------------------------- | :----------------------------------------------------------------- |
| Claude Code                                     | the plugin, which brings both              | [Claude Code](./claude-code.md#top)                                   |
| Codex, Cursor, VS Code with Copilot, Gemini CLI | the skill; add the server if you want both | [Other agents](./other-agents.md#top)                                 |
| any other MCP client                            | the server                                 | [Other agents](./other-agents.md#the-mcp-server-in-other-clients) |

The skill is enough for an agent that has a terminal. The server suits a client without
one, or an agent that works better with tools than with instructions. Installing both does
no harm: they teach the same thing.

## Where it is published

| Where                    | Name                                                                    |
| :----------------------- | :---------------------------------------------------------------------- |
| Anthropic's plugin directory | **TDCv2 — Fake & Test Data Generator**, in claude.ai and the Claude app under **Customize → Plugins → Discover** |
| Source code (MIT)        | [NickLiapin/tdcv2-agents](https://github.com/NickLiapin/tdcv2-agents)   |
| Claude Code marketplace  | `NickLiapin/tdcv2-agents`, plugin `tdcv2@tdcv2`                         |
| Official MCP Registry    | `io.github.NickLiapin/tdcv2`                                            |
| npm                      | [`tdcv2-mcp`](https://www.npmjs.com/package/tdcv2-mcp) — the server and the skill |

Everything needs Node.js 20 or newer.

## Versions

Release 0.1.6 is checked against TDC 0.3.6. The skill's
reference is built from that engine's documentation, and the agent runs that engine:
`npx -y tdcv2@0.3.6`. The server prefers your project's own `tdcv2` when the
project has one, and otherwise uses the engine it ships with. With another engine version,
the agent reads that version's pages, and the engine's `check` has the last word.

## Privacy

The engine runs on your machine. Neither the skill nor the server sends your data or your
configs anywhere. The server reads `.tdc` files and writes generated files only inside the
folder it is started in.

The network is used for four things only:

- the first start downloads `tdcv2-mcp` and the engine from npm;
- with an engine version other than 0.3.6, the agent may read that version's
  documentation page from GitHub;
- data packs download when you or the agent run `tdcv2 pack add` — through the server, that is
  `tdc_pack_add`, which your client asks you to allow;
- a config with `<gen type="http" src="…">` sends the named values to that address, and only
  if someone writes such a config.

The full policy is in [PRIVACY.md](https://github.com/NickLiapin/tdcv2-agents/blob/main/PRIVACY.md).

---

← Previous: [Editor support](../getting-started/editor-support.md#top) · **[Contents](../README.md#top)** · Next: [Claude Code](./claude-code.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/ai-agents/overview)**
