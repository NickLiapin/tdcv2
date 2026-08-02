import styles from './styles.module.css';

// The key to a figure, rendered as page text so it gets translated with the
// page. Figures themselves carry no words: they mark things with latin letter
// badges (A, B, C) and colours, and this component spells out what each means.
//
//   <Legend items={[
//     ['drawn', 'the band you drew'],
//     ['made', 'the generated values'],
//     ['A', 'the column the value is taken from'],
//   ]}/>
//
// A single uppercase latin letter renders as a badge matching the one in the
// drawing; anything else is a colour key from the figure palette.
export default function Legend({ items }) {
  return (
    <ul className={styles.legend}>
      {items.map(([key, label], i) => (
        <li key={i} className={styles.item}>
          {/^[A-Z]$/.test(key) ? (
            <span className={styles.badge}>{key}</span>
          ) : (
            <span className={styles.swatch} data-kind={key} />
          )}
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}
