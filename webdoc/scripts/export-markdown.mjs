/**
 * Export the documentation site as plain Markdown for the repository.
 *
 * GitHub shows a folder's README.md when you open the folder, and renders
 * nothing else — no sidebar, no tabs, no JSX. So the same pages that build the
 * site are rewritten here into what GitHub can actually display, and the
 * navigation the sidebar used to provide is generated as links instead.
 *
 * The site is the single source: nothing under docs/ is written by hand. A
 * drift check re-runs this and fails the build when the committed output
 * differs, which is the only thing that keeps the two from separating again.
 *
 * Structure comes from the English tree only — folder order and labels live in
 * _category_.json, which Docusaurus keeps untranslated, with the translated
 * labels in the locale's current.json. Driving every language off one tree also
 * guarantees the three read in the same order.
 *
 * Run:  node webdoc/scripts/export-markdown.mjs [outDir]
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ISO_UPDATED, TOKENS, spellDate } from "../plugins/remark-version.mjs";

/** The generated pack catalogue — the same file <PackCatalogue> renders from. */
const packCatalogue = JSON.parse(
  readFileSync(
    new URL("../src/data/pack-catalogue.json", import.meta.url),
    "utf8",
  ),
);

const HERE = dirname(fileURLToPath(import.meta.url));
const WEBSITE = join(HERE, "..");
const ROOT = join(WEBSITE, "..");

/** Overridable so the drift check can export to a throwaway directory. */
const OUT = process.argv[2] ? process.argv[2] : join(ROOT, "docs");

const LOCALES = [
  { code: "en", dir: join(WEBSITE, "docs"), out: "", name: "English" },
  {
    code: "ru",
    dir: join(WEBSITE, "i18n/ru/docusaurus-plugin-content-docs/current"),
    out: "ru",
    name: "Русский",
  },
  {
    code: "es",
    dir: join(WEBSITE, "i18n/es/docusaurus-plugin-content-docs/current"),
    out: "es",
    name: "Español",
  },
];

/**
 * The published site. These pages are a convenience copy for reading on GitHub;
 * the site is the same content with search, a sidebar and working anchors, so
 * every page says where its live twin is.
 */
const SITE = "https://nickliapin.github.io/tdcv2";

/** The few words the generated navigation needs in each language. */
const UI = {
  en: {
    title: "TDC Documentation",
    contents: "Contents",
    prev: "Previous",
    next: "Next",
    site: "Read this on the documentation site",
  },
  ru: {
    title: "Документация TDC",
    contents: "Оглавление",
    prev: "Назад",
    next: "Вперёд",
    site: "Открыть на сайте документации",
  },
  es: {
    title: "Documentación de TDC",
    contents: "Contenido",
    prev: "Anterior",
    next: "Siguiente",
    site: "Abrir en el sitio de documentación",
  },
};

/**
 * The address of this page on the published site.
 *
 * `outRel` is the path of the generated file — `ru/generators/running.md`. The
 * site keeps the same shape under a locale prefix, so the two differ only by
 * dropping the extension. An index page has no page of its own on the site, so
 * it points at the introduction, which is where the sidebar opens anyway.
 */
function siteUrl(outRel, code) {
  const prefix = code === "en" ? "" : `${code}/`;
  const rel = outRel.replace(/^(ru|es)\//, "").replace(/\.md$/, "");
  const page = rel === "README" || rel.endsWith("/README") ? "intro" : rel;
  return `${SITE}/${prefix}docs/${page}`;
}

/** The line that sends a reader from this copy to the live one. */
function siteLink(outRel, code) {
  return `📖 **[${UI[code].site} →](${siteUrl(outRel, code)})**`;
}

/** Docusaurus admonitions map onto GitHub's five alert types. */
const ALERTS = {
  note: "NOTE",
  tip: "TIP",
  info: "IMPORTANT",
  warning: "WARNING",
  caution: "CAUTION",
  danger: "CAUTION",
};

/** Matches a tag's attribute list while tolerating `>` inside quoted values. */
const ATTRS = "((?:[^>\"']|\"[^\"]*\"|'[^']*')*)";

/** A token no documentation page contains, so a placeholder cannot collide.
 *  Deliberately printable: a raw control byte would make this file binary to
 *  git, grep and every editor. */
const MARK = "@@TDCBLOCK@@";

/** Images actually referenced, so the export carries no dead weight. */
const used = new Set();

// --------------------------------------------------------------- small parts

function attrs(raw) {
  const out = {};
  for (const m of raw.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

/** The benchmark's own numbers, the same file the <Bars> component reads. */
const PERFORMANCE = JSON.parse(
  readFileSync(join(WEBSITE, "src/data/performance.json"), "utf8"),
);

/** The width of a bar in characters — wide enough to compare, narrow enough that
 *  a row still fits a phone. */
const BAR = 14;

/** Russian and Spanish write 8,97 where English writes 8.97, and the tables these
 *  sit beside already do. */
const DECIMAL = { en: ".", ru: ",", es: "," };

/** One <Bars> figure as a Markdown table GitHub can render. */
function bars(a, code) {
  const [config, tier, field] = a.source.split(".");
  const set = PERFORMANCE[config][tier];
  const rows = set[field];
  const heads = a.columns.split("|");
  const max = Math.max(
    ...rows.flatMap((r) => r.values).filter((v) => v !== null),
  );

  // Precision follows the field, not the translated unit word. See the component.
  const number = (v) => {
    if (v === null) return "—";
    const text =
      field === "seconds"
        ? v.toFixed(2)
        : v >= 100
          ? String(Math.round(v))
          : v.toFixed(1);
    return text.replace(".", DECIMAL[code] ?? ".");
  };
  const bar = (v) => {
    if (v === null) return "";
    const filled = Math.max(1, Math.round((v / max) * BAR));
    return ` ${"█".repeat(filled)}${"░".repeat(BAR - filled)}`;
  };

  const grouped = String(set.rows).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const mb = set.bytes / 1024 / 1024;
  const size = (mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1)).replace(
    ".",
    DECIMAL[code] ?? ".",
  );

  const lines = [
    `| ${grouped} ${a.rowsLabel ?? "rows"} · ${size} ${a.sizeUnit ?? "MB"} | ${heads.join(" | ")} |`,
    `| :--- | ${heads.map(() => ":---").join(" | ")} |`,
    ...rows.map(
      (r) =>
        `| **${r.name}** — ${r.registry} | ` +
        `${r.values.map((v) => `\`${number(v)} ${a.unit}\`${bar(v)}`).join(" | ")} |`,
    ),
  ];
  if (a.caption) lines.push("", `*${a.caption}*`);
  return lines.join("\n");
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].replace(/^['"]|['"]$/g, "");
  }
  return { data, body: text.slice(m[0].length) };
}

/** A relative link from one file in the export to another. */
function link(fromRel, toRel) {
  const r = relative(dirname(join(OUT, fromRel)), join(OUT, toRel))
    .split(sep)
    .join("/");
  return r.startsWith(".") ? r : `./${r}`;
}

// ------------------------------------------------------------- the page tree

/**
 * Rebuild the sidebar order without running Docusaurus: folders are ordered by
 * `position` in _category_.json, pages by `sidebar_position` in front matter —
 * exactly what the autogenerated sidebar does.
 */
function readTree(dir, relPath = "") {
  const items = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("_") || name.startsWith(".")) continue;
    const abs = join(dir, name);
    const childRel = relPath ? `${relPath}/${name}` : name;
    if (statSync(abs).isDirectory()) {
      let meta = {};
      if (existsSync(join(abs, "_category_.json"))) {
        meta = JSON.parse(readFileSync(join(abs, "_category_.json"), "utf8"));
      }
      items.push({
        type: "category",
        label: meta.label ?? name,
        position: meta.position ?? Infinity,
        relPath: childRel,
        children: readTree(abs, childRel),
      });
    } else if (name.endsWith(".mdx") || name.endsWith(".md")) {
      const { data } = frontmatter(readFileSync(abs, "utf8"));
      items.push({
        type: "page",
        label: data.title ?? name.replace(/\.mdx?$/, ""),
        position: data.sidebar_position
          ? Number(data.sidebar_position)
          : Infinity,
        file: name,
        relPath: relPath ? `${relPath}/${name}` : name,
        outRelBase: `${childRel.replace(/\.mdx?$/, "")}.md`,
      });
    }
  }
  items.sort(
    (a, b) => a.position - b.position || a.label.localeCompare(b.label),
  );
  return items;
}

/**
 * Re-point one English tree at a locale's own files: same shape and order,
 * translated category labels and translated page titles.
 */
function localize(items, locale, translations) {
  return items.map((it) => {
    const outRel = locale.out ? `${locale.out}/${it.relPath}` : it.relPath;
    if (it.type === "category") {
      const key = `sidebar.docsSidebar.category.${it.label}`;
      return {
        ...it,
        label: translations[key]?.message ?? it.label,
        outRel,
        children: localize(it.children, locale, translations),
      };
    }
    const source = join(locale.dir, it.relPath);
    if (!existsSync(source))
      throw new Error(`missing ${locale.code} translation: ${it.relPath}`);
    const { data } = frontmatter(readFileSync(source, "utf8"));
    return {
      ...it,
      label: data.title ?? it.label,
      source,
      outRel: locale.out ? `${locale.out}/${it.outRelBase}` : it.outRelBase,
    };
  });
}

/** Depth-first page order — what drives previous/next. */
function flatten(items, acc = []) {
  for (const it of items) {
    if (it.type === "page") acc.push(it);
    else flatten(it.children, acc);
  }
  return acc;
}

// -------------------------------------------------------------- the rewriter

function convert(body, page, code) {
  const blocks = [];
  const hold = (s) => `${MARK}${blocks.push(s) - 1}${MARK}`;

  let t = body;

  // The released version goes in FIRST, above the fence hold — a Maven coordinate
  // and a `curl` for a versioned jar live inside code blocks, and those are the
  // lines a reader copies. Everything below this deliberately leaves fenced code
  // alone; this is the one rewrite that must reach into it. Both this and the
  // site build read VERSION from the same module, so the copy GitHub renders and
  // the copy the site renders cannot name different numbers.
  // The date is the one token whose value depends on the page's language: the
  // month is spelled out so no reader has to guess whether 08-10 is August or
  // October, and it is spelled in THEIR language. Without this the exported
  // Russian mirror said "10 August 2026" while the site said "10 августа".
  const tokens = { ...TOKENS, "%%TDC_UPDATED%%": spellDate(ISO_UPDATED, code) };
  for (const [token, value] of Object.entries(tokens))
    t = t.split(token).join(value);

  // Fenced code next: nothing below may rewrite what a reader will copy.
  t = t.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, (m) => hold(m));

  // MDX imports mean nothing in plain Markdown.
  t = t.replace(/^import\s+[^\n]*\n/gm, "");

  // `export const …` is MDX plumbing that means nothing in plain markdown.
  // Keep the page's own labels before dropping the line: the pack table below is
  // built here, and its warning has to be in the page's language, not English.
  let pageLabels = {};
  t = t.replace(/^export const labels = (\{[\s\S]*?\});\s*$/m, (_m, raw) => {
    try {
      pageLabels = JSON.parse(raw);
    } catch {
      pageLabels = {};
    }
    return "";
  });
  t = t.replace(/^export const [\s\S]*?;\s*$/gm, "");

  // A JSX comment is invisible in MDX and visible in GitHub markdown, so it becomes
  // an HTML comment on the way out — same text, invisible in both places.
  t = t.replace(/\{\/\*([\s\S]*?)\*\/\}/g, (_m, inner) => `<!--${inner}-->`);

  // <Terminal title="…">{`…`}</Terminal> — a titled block of program output.
  t = t.replace(
    new RegExp(
      `<Terminal\\s*${ATTRS}>\\s*\\{\`([\\s\\S]*?)\`\\}\\s*</Terminal>`,
      "g",
    ),
    (_m, raw, content) => {
      const title = attrs(raw).title ?? "";
      // Undo the escaping the JS template literal forced on the author.
      const text = content.replace(/\\([`$\\])/g, "$1");
      return hold(`${title ? `\`${title}\`\n\n` : ""}\`\`\`\n${text}\n\`\`\``);
    },
  );

  // <Figure src alt caption /> — an image with its caption underneath.
  t = t.replace(new RegExp(`<Figure\\s*${ATTRS}/>`, "g"), (_m, raw) => {
    const a = attrs(raw);
    let src = a.src;
    if (src.startsWith("/img/")) {
      const rest = src.slice("/img/".length);
      used.add(rest);
      src = link(page.outRel, `img/${rest}`);
    }
    return hold(
      `![${a.alt ?? ""}](${src})${a.caption ? `\n\n*${a.caption}*` : ""}`,
    );
  });

  // <Legend items={[["A","…"], …]} /> — decodes the letter badges in a figure.
  t = t.replace(/<Legend\s+items=\{(\[[\s\S]*?\])\}\s*\/>/g, (_m, raw) => {
    const items = JSON.parse(raw.replace(/,(\s*[\]}])/g, "$1"));
    return hold(items.map(([k, v]) => `- **${k}** — ${v}`).join("\n"));
  });

  // <PackCatalogue group labels /> — on the site this is a filterable list of
  // collapsible packs. GitHub renders no React, so the page would export as three
  // empty headings: the reader would be told a catalogue exists and shown none of
  // it. Expand it into a real table from the same generated data the component
  // reads, so the offline copy carries the catalogue rather than a promise of one.
  t = t.replace(new RegExp(`<PackCatalogue\\s*${ATTRS}/>`, "g"), (_m, raw) => {
    const packs = packCatalogue[attrs(raw).group] ?? [];
    const rows = packs.map((entry) => {
      // Every list, never a count and never "and more": the offline copy exists
      // so somebody can answer "is the thing I need in there" without a network.
      const held =
        entry.groups.length > 0
          ? entry.groups
              .map(
                ([name, leaves]) =>
                  `**${name}** ${leaves.map((l) => `\`${l}\``).join(" ")}`,
              )
              .join("<br>")
          : "—";
      const mark = entry.unreleased
        ? ` **(${pageLabels.nextRelease ?? "next release"})**`
        : "";
      return `| \`${entry.id}\` | ${entry.name}${mark} | ${String(entry.files)} | ${held} |`;
    });
    return hold(
      [
        "| Pack | Name | Lists | Holds |",
        "| :--- | :--- | ---: | :--- |",
        ...rows,
      ].join("\n") +
        "\n\nInstall any of them with `tdcv2 pack add <pack>`." +
        (packs.some((e) => e.unreleased) && pageLabels.nextReleaseWhy
          ? `\n\n> ${pageLabels.nextReleaseWhy}`
          : ""),
    );
  });

  // <Bars source columns unit rowsLabel caption /> — a measured comparison. On
  // the site every row carries a proportional coloured bar; GitHub renders no CSS,
  // so the proportion is redrawn with block characters and the numbers, which are
  // the part that has to be exact, are printed unchanged.
  t = t.replace(new RegExp(`<Bars\\s*${ATTRS}/>`, "g"), (_m, raw) =>
    hold(bars(attrs(raw), code)),
  );

  // <Tabs>/<TabItem> — one language per tab becomes one heading per language.
  t = t.replace(new RegExp(`</?Tabs\\s*${ATTRS}>`, "g"), "");
  t = t.replace(
    new RegExp(`<TabItem\\s*${ATTRS}>`, "g"),
    (_m, raw) => `#### ${attrs(raw).label ?? ""}`,
  );
  t = t.replace(/<\/TabItem>/g, "");

  // Links between pages: the tree is mirrored, so only the suffix changes.
  // A cross-reference with no fragment means "open that page", so it gets the
  // same #top marker the generated navigation uses — otherwise following one
  // from halfway down an article lands halfway down the next one. Links that
  // already name a section keep it, and images are untouched.
  t = t.replace(/\]\(([^)\s]+)\)/g, (m, href) => {
    if (/^https?:/.test(href)) return m;
    const rewritten = href.replace(/\.mdx?(?=$|#)/, ".md");
    return `](${rewritten.endsWith(".md") ? `${rewritten}#top` : rewritten})`;
  });
  t = t.replace(/\]\(\/img\/([^)]+)\)/g, (_m, rest) => {
    used.add(rest);
    return `](${link(page.outRel, `img/${rest}`)})`;
  });

  // Admonitions become GitHub alerts. Line-based, because a body may hold
  // paragraphs, lists and held-out code that all need the quote marker.
  const lines = t.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^:::(\w+)(?:\[(.*)\])?\s*$/.exec(lines[i]);
    if (!open) {
      out.push(lines[i]);
      continue;
    }
    const inner = [];
    i++;
    while (i < lines.length && !/^:::\s*$/.test(lines[i]))
      inner.push(lines[i++]);
    out.push(`> [!${ALERTS[open[1]] ?? "NOTE"}]`);
    if (open[2]) out.push(`> **${open[2]}**`, ">");
    for (const l of inner) out.push(l.trim() === "" ? ">" : `> ${l}`);
  }
  t = out.join("\n");

  // Tidy the blank lines while the code is still held out, so nothing inside a
  // program's output gets collapsed.
  t = `${t.replace(/\n{3,}/g, "\n\n").trim()}\n`;

  // Put the blocks back, carrying whatever prefix their line picked up — that
  // is what keeps a code block inside an alert quoted on every line.
  return t.replace(
    new RegExp(`^(.*?)${MARK}(\\d+)${MARK}[ \\t]*$`, "gm"),
    (_m, prefix, n) => {
      const block = blocks[Number(n)];
      if (!prefix.trimStart().startsWith(">")) return prefix + block;
      const q = prefix.trimEnd();
      return block
        .split("\n")
        .map((l) => (l === "" ? q : `${q} ${l}`))
        .join("\n");
    },
  );
}

// ------------------------------------------------------------- the furniture

/**
 * Every generated file opens with this, and every generated link ends in #top.
 *
 * A bare file link says nothing about where to land: GitHub opens it at the top,
 * but a Markdown preview pane may keep the scroll position from the document you
 * came from, dropping you into the middle of the page you just opened. Aiming at
 * the first heading fixed that on GitHub and nowhere else — a heading anchor is
 * whatever the viewer's own slug function makes of it, and our headings are
 * translated, so the target was a different Cyrillic or Spanish slug on every
 * page. An explicit marker is the same six ASCII characters everywhere and does
 * not depend on anyone's slug rules.
 */
const TOP = '<a name="top"></a>';

/** A link to another generated file, aimed at the marker at its very top. */
function to(fromRel, node) {
  return `${link(fromRel, node.rel)}#top`;
}

/** One line of links to the same page in the other two languages. */
function switcher(outRel, code, siblings) {
  return LOCALES.map((l) =>
    l.code === code
      ? `**${l.name}**`
      : `[${l.name}](${to(outRel, siblings[l.code])})`,
  ).join(" · ");
}

/**
 * Previous / contents / next. Placed at the top of a page as well as the
 * bottom: a reader working through the docs wants to go back without first
 * scrolling to the end of whatever they just opened.
 */
function nav(outRel, code, home, prev, next) {
  const ui = UI[code];
  const parts = [];
  if (prev) parts.push(`← ${ui.prev}: [${prev.label}](${to(outRel, prev)})`);
  parts.push(`**[${ui.contents}](${to(outRel, home)})**`);
  if (next) parts.push(`${ui.next}: [${next.label}](${to(outRel, next)}) →`);
  return parts.join(" · ");
}

/** The table of contents a reader lands on when opening the folder. */
function contents(items, code, outRel, siblings) {
  const lines = [
    TOP,
    "",
    `# ${UI[code].title}`,
    "",
    switcher(outRel, code, siblings),
    "",
    siteLink(outRel, code),
    "",
    "---",
    "",
  ];
  const walk = (list, depth) => {
    for (const it of list) {
      if (it.type === "page") lines.push(`- [${it.label}](${to(outRel, it)})`);
      else {
        lines.push("", `${"#".repeat(Math.min(6, depth + 1))} ${it.label}`, "");
        walk(it.children, depth + 1);
      }
    }
  };
  walk(items, 1);
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

/** A folder gets a README so its link resolves and it lists what is inside. */
function folderIndex(cat, code, outRel, siblings, home) {
  const back = `**[${UI[code].contents}](${to(outRel, home)})**`;
  const lines = [
    TOP,
    "",
    `# ${cat.label}`,
    "",
    switcher(outRel, code, siblings),
    "",
    siteLink(outRel, code),
    "",
    back,
    "",
    "---",
    "",
  ];
  for (const it of cat.children) {
    lines.push(
      it.type === "page"
        ? `- [${it.label}](${to(outRel, it)})`
        : `- [${it.label}/](${to(outRel, it.index)})`,
    );
  }
  lines.push("", "---", "", back);
  return `${lines.join("\n")}\n`;
}

// --------------------------------------------------------------------- build

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const english = readTree(join(WEBSITE, "docs"));

/**
 * Everything is built before anything is written, because a link now needs the
 * target's own heading anchor — including the language switcher, which points
 * at a page whose heading is in another language.
 */
const built = LOCALES.map((locale) => {
  let translations = {};
  const file = join(
    WEBSITE,
    `i18n/${locale.code}/docusaurus-plugin-content-docs/current.json`,
  );
  if (existsSync(file)) translations = JSON.parse(readFileSync(file, "utf8"));

  const tree = localize(english, locale, translations);
  const home = {
    rel: locale.out ? `${locale.out}/README.md` : "README.md",
    label: UI[locale.code].title,
  };

  // Give every node the address other pages will link to.
  const pageBy = new Map();
  const catBy = new Map();
  const annotate = (items) => {
    for (const it of items) {
      if (it.type === "page") {
        it.rel = it.outRel;
        pageBy.set(it.relPath, it);
      } else {
        it.index = { rel: `${it.outRel}/README.md`, label: it.label };
        catBy.set(it.relPath, it.index);
        annotate(it.children);
      }
    }
  };
  annotate(tree);

  return { locale, tree, home, pages: flatten(tree), pageBy, catBy };
});

const siblings = (pick) =>
  Object.fromEntries(built.map((b) => [b.locale.code, pick(b)]));
const homeSiblings = siblings((b) => b.home);

let written = 0;

for (const { locale, tree, home, pages, pageBy } of built) {
  const code = locale.code;

  pages.forEach((page, i) => {
    const { body } = frontmatter(readFileSync(page.source, "utf8"));
    const sw = switcher(
      page.outRel,
      code,
      siblings((b) => b.pageBy.get(page.relPath)),
    );
    const bar = nav(page.outRel, code, home, pages[i - 1], pages[i + 1]);
    const live = siteLink(page.outRel, code);
    const dest = join(OUT, page.outRel);
    mkdirSync(dirname(dest), { recursive: true });
    // The live link goes at the top AND the bottom: at the top for the reader
    // who wants search and a sidebar before reading, at the bottom for the one
    // who finished the page and now wants the rest of the documentation.
    writeFileSync(
      dest,
      `${TOP}\n\n${sw}\n\n${live}\n\n${bar}\n\n---\n\n${convert(body, page, code)}\n---\n\n${bar}\n\n${live}\n`,
    );
    written++;
  });

  mkdirSync(dirname(join(OUT, home.rel)), { recursive: true });
  writeFileSync(
    join(OUT, home.rel),
    contents(tree, code, home.rel, homeSiblings),
  );
  written++;

  const indexes = (items) => {
    for (const it of items) {
      if (it.type !== "category") continue;
      const sw = siblings((b) => b.catBy.get(it.relPath));
      writeFileSync(
        join(OUT, it.index.rel),
        folderIndex(it, code, it.index.rel, sw, home),
      );
      written++;
      indexes(it.children);
    }
  };
  indexes(tree);
}

// Figures are shared by all three languages — the whole point of keeping words
// out of them. Only the ones a page actually references are carried over.
for (const rest of used) {
  const dest = join(OUT, "img", rest);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(join(WEBSITE, "static/img", rest), dest);
}

console.log(
  `wrote ${String(written)} markdown files to ${relative(ROOT, OUT) || OUT}`,
);
