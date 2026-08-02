import styles from './styles.module.css';

// A dark, terminal-styled output box. Use it to present the result of running a
// TDC config, so example output reads like something printed in a shell.
export default function Terminal({children, title = 'output'}) {
  return (
    <div className={styles.terminal}>
      <div className={styles.bar}>
        <span className={styles.dot} data-color="red" />
        <span className={styles.dot} data-color="yellow" />
        <span className={styles.dot} data-color="green" />
        <span className={styles.title}>{title}</span>
      </div>
      <pre className={styles.body}>{children}</pre>
    </div>
  );
}
