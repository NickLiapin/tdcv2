import { useMemo, useState } from "react";

import catalogue from "@site/src/data/pack-catalogue.json";

import styles from "./styles.module.css";

// The catalogue of downloadable packs, rendered from the shipped manifest and
// the pack tree itself.
//
//   <PackCatalogue group="languages" labels={{ …translated strings… }} />
//
// Everything a pack holds is listed — every address, never a count and never
// "and more". The page exists so somebody can find out whether the thing they
// need is inside BEFORE downloading, and a truncated list cannot answer that.
//
// Every word the reader sees that is not an address comes in through `labels`,
// because the page exists in three languages while addresses are addresses.

// The same rule the CLI prints, so a size read here and a size read from
// `tdcv2 pack list` are the same number: a decimal below a hundred, where it
// tells 2.6 kB apart from 3.1 kB, and none above it, where a tenth is noise.
// `unit` is the translated kilobyte word; nothing in this catalogue reaches a
// megabyte, and the branch above is there for the day one does.
function Bytes({ value, unit }) {
  if (value === null || value === undefined) return null;
  const kb = value / 1024;
  const round = (v) => (v < 100 ? v.toFixed(1) : String(Math.round(v)));
  return (
    <span className={styles.size}>
      {value < 1024
        ? `${value} B`
        : kb >= 1024
          ? `${round(kb / 1024)} MB`
          : `${round(kb)} ${unit}`}
    </span>
  );
}

function Pack({ pack, labels, query }) {
  /*
   * The contents are built only once the reader opens the pack.
   *
   * `<details>` renders its children whether it is open or not, and the
   * catalogue holds 29,985 addresses — rendering them all eagerly put about a
   * hundred thousand nodes in the document and hung the page. Nothing is
   * hidden by this: every address is still here, it is built when it is asked
   * for.
   */
  const [open, setOpen] = useState(false);
  const show = open || Boolean(query);
  // With a filter typed, show only the addresses that match — the reader asked
  // a question and the answer is the matching names, not the whole pack.
  const groups = useMemo(() => {
    if (!query) return pack.groups;
    const out = [];
    for (const [name, leaves] of pack.groups) {
      if (name.toLowerCase().includes(query)) {
        out.push([name, leaves]);
        continue;
      }
      const hit = leaves.filter((l) => l.toLowerCase().includes(query));
      if (hit.length > 0) out.push([name, hit]);
    }
    return out;
  }, [pack.groups, query]);

  return (
    <details
      className={styles.pack}
      open={show}
      onToggle={(e) => {
        setOpen(e.currentTarget.open);
      }}
    >
      <summary className={styles.summary}>
        <span className={styles.name}>{pack.name}</span>
        <code className={styles.id}>{pack.id}</code>
        <span className={styles.files}>
          {pack.files} {labels.lists}
        </span>
        {pack.unreleased && (
          <span className={styles.unreleased}>{labels.nextRelease}</span>
        )}
        <Bytes value={pack.bytes} unit={labels.kb} />
      </summary>
      <div className={styles.body}>
        <p className={styles.blurb}>{pack.blurb}.</p>
        {show && (
          <>
            {pack.unreleased && (
              <p className={styles.warning}>{labels.nextReleaseWhy}</p>
            )}
            <p className={styles.label}>{labels.holds}</p>
            {groups.map(([name, leaves]) => (
              <div key={name} className={styles.group}>
                <code className={styles.groupName}>{name}</code>
                <ul className={styles.leaves}>
                  {leaves.map((leaf) => (
                    <li key={leaf}>
                      <code>{leaf}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p className={styles.label}>{labels.install}</p>
            <pre className={styles.install}>
              <code>tdcv2 pack add {pack.id}</code>
            </pre>
          </>
        )}
      </div>
    </details>
  );
}

export default function PackCatalogue({ group, labels }) {
  const packs = catalogue[group] ?? [];
  const [raw, setRaw] = useState("");
  const query = raw.trim().toLowerCase();

  const shown = useMemo(() => {
    if (!query) return packs;
    return packs.filter(
      (p) =>
        p.id.includes(query) ||
        p.name.toLowerCase().includes(query) ||
        p.groups.some(
          ([name, leaves]) =>
            name.toLowerCase().includes(query) ||
            leaves.some((l) => l.toLowerCase().includes(query)),
        ),
    );
  }, [packs, query]);

  return (
    <div className={styles.catalogue}>
      <div className={styles.controls}>
        <input
          className={styles.filter}
          type="search"
          value={raw}
          placeholder={labels.filter}
          onChange={(e) => setRaw(e.target.value)}
          aria-label={labels.filter}
        />
        <span className={styles.count}>
          {shown.length === packs.length
            ? `${packs.length} ${labels.total}`
            : `${shown.length} / ${packs.length}`}
        </span>
      </div>
      {shown.length === 0 ? (
        <p className={styles.empty}>{labels.none}</p>
      ) : (
        shown.map((p) => (
          <Pack key={p.id} pack={p} labels={labels} query={query} />
        ))
      )}
    </div>
  );
}
