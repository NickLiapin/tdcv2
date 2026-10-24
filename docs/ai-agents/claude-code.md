<a name="top"></a>

**English** · [Русский](../ru/ai-agents/claude-code.md#top) · [Español](../es/ai-agents/claude-code.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/ai-agents/claude-code)**

← Previous: [TDC for AI agents](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Other agents](./other-agents.md#top) →

---

# Claude Code

The plugin brings both parts at once: the skill, and the MCP server, which Claude Code starts
on its own whenever a session needs it.

## Install the plugin

```bash
claude plugin marketplace add NickLiapin/tdcv2-agents
claude plugin install tdcv2@tdcv2
```

The first command adds the plugin's marketplace, which is its GitHub repository. The second
installs the plugin for you, in every project. Start a new session afterward.

To confirm it worked, run `claude plugin list`: it shows `tdcv2@tdcv2` with
`Status: ✔ enabled`. Then `claude mcp list` shows the plugin's server, `plugin:tdcv2:tdcv2`,
followed by `✔ Connected`. The first check of the server can take a few seconds, because the
first start downloads it from npm.

## Ask for data

Ask in plain words, in any project:

```text
Generate 200 customers from 10 countries as CSV, with names that match the country.
```

Claude Code reads the skill, writes a `.tdc` config, checks it, generates the file in your
project, and gives you both. [Working with the agent](./working-with-the-agent.md#top) shows
what happens at each step and how to review the result.

## Update and remove

```bash
claude plugin update tdcv2@tdcv2
claude plugin uninstall tdcv2@tdcv2
```

`update` installs the newest release; it says so when you already have it. A new session
picks the update up.

## The skill or the server alone

The plugin is the simple path. If you want one part only:

```bash
npx -y tdcv2-mcp@0.1.5 install-skill            # the skill, for you: ~/.claude/skills/tdcv2
npx -y tdcv2-mcp@0.1.5 install-skill --project  # the skill, this project: ./.claude/skills/tdcv2
claude mcp add tdcv2 -- npx -y tdcv2-mcp@0.1.5  # the server, this project
```

`install-skill` replaces an older copy of the skill in the same folder. `claude mcp add`
registers the server for the project you run it in; add `--scope user` to have it in every
project.

---

← Previous: [TDC for AI agents](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Other agents](./other-agents.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/ai-agents/claude-code)**
