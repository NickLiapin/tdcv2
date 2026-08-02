# Security

## Reporting a vulnerability

Use GitHub's [private vulnerability reporting](https://github.com/NickLiapin/tdcv2/security/advisories/new).
It goes to the maintainer without becoming public first, which is what you want
if the finding is real. Please do not open a public issue for a suspected
vulnerability.

Tell me what you did, what happened, and what you expected. A config that
reproduces it is worth more than a description of one. You will get an
acknowledgement; if the report turns out to be a real issue, you will be told
when the fix lands and credited unless you would rather not be.

This is a solo project, so expect a person rather than a process — days, not
hours.

## What is in scope

The five implementations (`typescript/`, `python/`, `java/`, `csharp/`,
`rust/`), the CLI, and the pack registry client. The data packs themselves are
lists of names, cities and streets; a mistake there is a data bug, not a
security one.

## What TDC is, and what that means for you

TDC runs a configuration you supply. A configuration is not inert data — it is
closer to a script, and it can:

- **read files** — `<gen type="file" src="…">` reads any path the process can
  reach, and `@data/` resolves against the paths you configured;
- **make network calls** — `<gen type="http" url="…">` fetches a URL you name,
  and `tdcv2 pack add` downloads from the registry;
- **write files** — the CLI writes where you point `-o`, and the disk engines
  use temporary files.

So: **do not run a `.tdc` file you would not run as a script.** That is not a
weakness to be fixed — it is what a data generator is for — but it is worth
saying out loud, because a config looks like a document.

The generated data is **fake by design and reproducible from a seed**. It is
not a source of randomness for anything that needs to be secret. `seed`
produces the same values every time, on purpose; never use TDC output as a
key, a token, or a password.

## What runs on every change

- **CodeQL** on JavaScript/TypeScript, Python and the GitHub Actions workflows.
- **Secret scanning** with push protection, so a committed credential is
  blocked before it lands rather than found afterwards.
- **Dependabot** alerts and security updates on every lockfile.

Advisories against build and test tooling (the dev server, the test runner) are
triaged but not treated as urgent: none of it is installed by anyone who
installs TDC, and none of it reaches the published documentation site.
