import useDocusaurusContext from '@docusaurus/useDocusaurusContext';

import data from '@site/src/data/performance.json';

import styles from './styles.module.css';

/** Russian and Spanish write 8,97 where English writes 8.97 — and the plain
 *  tables these sit beside already do. */
const DECIMAL = { en: '.', ru: ',', es: ',' };

// A measured comparison drawn as a table: one implementation per row, its name
// in the first column, a proportional bar in each of the others.
//
//   <Bars source="customers.large.seconds" columns="engine 1|engine 2"
//         unit="s" rowsLabel="rows"
//         caption="Seconds for two million rows. Lower is better." />
//
// `source` addresses `src/data/performance.json`, which is generated from the
// benchmark's own result files — so nothing on this page is typed by hand, and a
// bar cannot disagree with the number printed next to it.
//
// Two deliberate choices about how it is drawn:
//
// Bars are scaled against ONE maximum taken across the whole table, not one per
// column. That is what makes the memory table tell its story at a glance: the
// streaming column is a row of stubs beside the in-memory column, which is the
// entire point of the streaming engine.
//
// Colour runs from green at the smallest value to red at the largest, on that
// same single scale — so a longer bar is always a redder bar. The colour carries
// no information the length does not, on purpose: a reader who cannot separate
// red from green loses nothing.
export default function Bars({
  source,
  columns,
  unit,
  rowsLabel = 'rows',
  sizeUnit = 'MB',
  caption,
}) {
  const { i18n } = useDocusaurusContext();
  const point = DECIMAL[i18n.currentLocale] ?? '.';

  const [config, tier, field] = source.split('.');
  const set = data[config][tier];
  const rows = set[field];
  const heads = columns.split('|');

  const values = rows.flatMap((r) => r.values).filter((v) => v !== null);
  const max = Math.max(...values);

  // Green (145°) through amber to a red that stops short of pure red, which is
  // loud enough to read as an error rather than as the slowest of five.
  const hue = (v) => Math.round((145 - 155 * (v / max) + 360) % 360);
  // A bar is never allowed to vanish: 3.7 MB against 4140 is a quarter of a pixel,
  // and an empty cell would read as missing data rather than as a small number.
  const width = (v) => `${Math.max(1.2, (v / max) * 100).toFixed(2)}%`;

  // Precision follows the FIELD, never the unit: `unit` is a translated word —
  // "s" in English, "с" in Russian — and branching on it would silently round a
  // translated page differently. Seconds keep two decimals at any size, so 91.30
  // and 112.11 can be read against each other; megabytes go to whole numbers past
  // 100, where a tenth of a megabyte says nothing.
  const number = (v) => {
    if (v === null) return '—';
    const text =
      field === 'seconds' ? v.toFixed(2) : v >= 100 ? String(Math.round(v)) : v.toFixed(1);
    return text.replace('.', point);
  };

  return (
    <figure className={styles.figure}>
      <div className={styles.scroll}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.corner}>
                {group(set.rows)} {rowsLabel}
                <span className={styles.size}>
                  {megabytes(set.bytes).replace('.', point)} {sizeUnit}
                </span>
              </th>
              {heads.map((head) => (
                <th key={head} className={styles.head}>
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.registry}>
                <th className={styles.name} scope="row">
                  {row.name}
                  <span className={styles.registry}>{row.registry}</span>
                </th>
                {row.values.map((value, i) => (
                  <td key={heads[i]} className={styles.cell}>
                    <span className={styles.bar}>
                      <span className={styles.track}>
                        {value === null ? null : (
                          <span
                            className={styles.fill}
                            style={{ width: width(value), '--bar-hue': hue(value) }}
                          />
                        )}
                      </span>
                      <span className={styles.value}>
                        {number(value)}
                        <span className={styles.unit}>{unit}</span>
                      </span>
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {caption ? <figcaption className={styles.caption}>{caption}</figcaption> : null}
    </figure>
  );
}

/** 2000000 as `2 000 000` — a thin space reads the same in all three languages. */
function group(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function megabytes(bytes) {
  const mb = bytes / 1024 / 1024;
  return mb >= 100 ? String(Math.round(mb)) : mb.toFixed(1);
}
