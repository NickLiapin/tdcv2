import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

const FeatureList = [
  {
    title: 'Deterministic',
    description: (
      <>
        The same seed produces byte-identical output on every run — and across
        the TypeScript, Python, and Java implementations.
      </>
    ),
  },
  {
    title: 'Any text format',
    description: (
      <>
        Build CSV, JSON, SQL, YAML, or your own format with wrapper tags. TDC is
        not limited to a fixed list of exporters.
      </>
    ),
  },
  {
    title: 'Hierarchical & exact',
    description: (
      <>
        Parent/child probabilistic dependencies and exact percentage proportions
        that faker-style tools cannot express.
      </>
    ),
  },
];

function Feature({title, description}) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures() {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
