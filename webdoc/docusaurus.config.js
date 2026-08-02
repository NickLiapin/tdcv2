// @ts-check
// See: https://docusaurus.io/docs/api/docusaurus-config

import {themes as prismThemes} from 'prism-react-renderer';

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'TDC — The Data Constructor',
  tagline: 'Deterministic test-data generator — exact proportions, any text format',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
  },

  // Share one localStorage namespace across all locales, so the light/dark theme
  // choice (and other UI state) carries over when switching languages. Without
  // this, v4 hashes the storage key per-locale (theme-a6c vs theme-cd3), so a
  // preference set on /docs never reaches /ru/docs and the page falls back to the
  // OS theme.
  storage: {
    namespace: false,
  },

  // Production URL (GitHub Pages project site: https://<org>.github.io/<project>/)
  url: 'https://nickliapin.github.io',
  // Served from a subpath on GitHub Pages, but from the root when someone runs
  // the reviewer bundle on their own machine — see scripts/make-review-bundle.mjs.
  baseUrl: process.env.TDC_BASE_URL ?? '/tdcv2/',

  organizationName: 'NickLiapin',
  projectName: 'tdcv2',
  deploymentBranch: 'gh-pages',
  trailingSlash: false,

  // The tree is complete: a broken link is a defect, not a work-in-progress.
  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ru', 'es'],
    localeConfigs: {
      en: {label: 'English'},
      ru: {label: 'Русский'},
      es: {label: 'Español'},
    },
  },

  plugins: [
    [
      '@docusaurus/plugin-client-redirects',
      {
        // The six construct pages moved out of Guides into their own section.
        // Keep the old addresses working — they are in the published site's history.
        redirects: [
          { from: '/docs/guides/mix', to: '/docs/constructs/mix' },
          { from: '/docs/guides/switch', to: '/docs/constructs/switch' },
          { from: '/docs/guides/conditional-output', to: '/docs/constructs/conditional-output' },
          { from: '/docs/guides/multiple-values', to: '/docs/constructs/multiple-values' },
          { from: '/docs/guides/relational-tables', to: '/docs/constructs/relational-tables' },
          { from: '/docs/guides/unique-values', to: '/docs/constructs/unique-values' },
        ],
      },
    ],
  ],

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          sidebarPath: './sidebars.js',
          // No "Edit this page" link — the site is edited locally, not via GitHub.
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/docusaurus-social-card.jpg',
      colorMode: {
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'TDC',
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: 'Docs',
          },
          {
            type: 'localeDropdown',
            position: 'right',
          },
          {
            href: 'https://github.com/NickLiapin/tdcv2',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              {label: 'Introduction', to: '/docs/intro'},
              {label: 'Installation', to: '/docs/getting-started/installation'},
            ],
          },
          {
            title: 'More',
            items: [
              {label: 'GitHub', href: 'https://github.com/NickLiapin/tdcv2'},
            ],
          },
        ],
        copyright: 'Copyright © 2026 Nick Liapin. Built with Docusaurus.',
      },
      prism: {
        theme: prismThemes.github,
        darkTheme: prismThemes.dracula,
        additionalLanguages: ['bash', 'json', 'sql', 'python', 'java'],
      },
    }),
};

export default config;
