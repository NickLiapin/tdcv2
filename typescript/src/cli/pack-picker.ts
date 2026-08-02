/**
 * The interactive picker behind `tdcv2 pack`.
 *
 * The catalogue is 108 bundles and growing. As one flat checkbox it was unusable: seven rows
 * visible at a time, languages and countries interleaved, and finding Brazil meant paging through
 * the alphabet. So it is browsed the way the catalogue is actually shaped — the locale-agnostic
 * set, then languages, then countries reached through a continent — with search from anywhere and
 * a basket you review before anything is downloaded.
 *
 * The map is not decoration. A continent lights up when you are on it, and every pick burns a
 * spark where that country actually is, so "what have I taken so far" is answerable at a glance.
 * Coordinates come from the registry index, not from a table kept here: the same picker exists in
 * three languages, and three copies of world geography would be three copies that disagree.
 *
 * This module draws and returns a decision. It never touches the network or the disk — the caller
 * installs and removes, which keeps the download progress, the digests and the config writing in
 * one place instead of two.
 */

import { emitKeypressEvents, type Key } from 'node:readline';

/** A catalogue entry, as much of it as the picker cares about. */
export interface PickerBundle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly bytes: number;
  readonly locale: string | undefined;
  readonly country: string | undefined;
  /** Continent keys. A list because Russia is honestly in two of them. */
  readonly regions: readonly string[] | undefined;
  /** [longitude, latitude], roughly the middle of the country. */
  readonly point: readonly [number, number] | undefined;
}

/** What the user decided. `null` means they left without confirming. */
export interface PickerResult {
  readonly install: readonly string[];
  readonly remove: readonly string[];
}

// ── what this terminal can do ─────────────────────────────────────────────────

/**
 * Half-blocks and colour are detected, never assumed.
 *
 * Windows Terminal, iTerm2, the macOS Terminal, VS Code and the rest of the modern crop handle
 * everything here. The old Windows console does not — a raster font has no "▀", and before
 * Windows 10 there is no ANSI at all — so the drawing falls back to ASCII, and the map to one row
 * per line instead of two rows sharing one.
 */
function detectUnicode(): boolean {
  if (process.env['TDCV2_ASCII']) return false;
  if (process.platform !== 'win32') {
    const locale = process.env['LC_ALL'] ?? process.env['LC_CTYPE'] ?? process.env['LANG'] ?? '';
    return locale === '' || /utf-?8/i.test(locale);
  }
  return (
    (process.env['WT_SESSION'] ?? process.env['TERM_PROGRAM'] ?? process.env['ConEmuANSI']) !==
    undefined
  );
}

function detectColour(): boolean {
  return !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb' && process.stdout.isTTY;
}

const UNICODE = detectUnicode();
const COLOUR = detectColour();

const GLYPHS = UNICODE
  ? { cursor: '❯', group: '»', on: '▣', off: '▢', done: '✓', drop: '✗', chip: '■', land: '█' }
  : {
      cursor: '>',
      group: '>',
      on: '[x]',
      off: '[ ]',
      done: '[+]',
      drop: '[-]',
      chip: '*',
      land: '#',
    };

const ESC = '\x1b[';
const sgr = (text: string, code: string): string =>
  COLOUR ? `${ESC}${code}m${text}${ESC}0m` : text;
const dim = (text: string): string => sgr(text, '2');
const bold = (text: string): string => sgr(text, '1');

// ── the world ─────────────────────────────────────────────────────────────────

interface Continent {
  readonly key: string;
  readonly name: string;
  readonly colour: number;
  readonly bright: number;
}

const CONTINENTS: readonly Continent[] = [
  { key: 'europe', name: 'Europe', colour: 34, bright: 94 },
  { key: 'asia', name: 'Asia', colour: 35, bright: 95 },
  { key: 'africa', name: 'Africa', colour: 33, bright: 93 },
  { key: 'north', name: 'North America', colour: 36, bright: 96 },
  { key: 'south', name: 'South America', colour: 32, bright: 92 },
  { key: 'oceania', name: 'Oceania', colour: 31, bright: 91 },
];

/**
 * The continents as rough outlines in real coordinates rather than a fixed grid of characters.
 *
 * A hand-drawn grid only looks right at the size it was drawn for. Polygons are rasterised to
 * whatever the window allows, so the shapes survive being made bigger — and each landmass's
 * coastline falls out of the same data, which is what lets the map be drawn as outlines.
 */
const OUTLINES: Readonly<Record<string, readonly (readonly (readonly [number, number])[])[]>> = {
  africa: [
    [
      [-17, 15],
      [-16, 12],
      [-13, 8],
      [-7, 4],
      [3, 6],
      [9, 4],
      [9, -1],
      [12, -6],
      [13, -13],
      [15, -22],
      [18, -34],
      [25, -34],
      [32, -26],
      [40, -16],
      [41, -2],
      [51, 12],
      [43, 12],
      [37, 22],
      [34, 28],
      [32, 31],
      [20, 32],
      [10, 34],
      [0, 36],
      [-6, 36],
      [-10, 30],
      [-16, 22],
    ],
    [
      [44, -12],
      [50, -15],
      [50, -25],
      [45, -25],
      [43, -16],
    ],
  ],
  europe: [
    [
      [-10, 36],
      [-9, 43],
      [-2, 48],
      [-5, 50],
      [-6, 58],
      [5, 62],
      [12, 68],
      [28, 71],
      [40, 66],
      [60, 66],
      [60, 50],
      [50, 46],
      [40, 44],
      [28, 41],
      [24, 36],
      [15, 38],
      [12, 45],
      [3, 43],
    ],
  ],
  asia: [
    [
      [60, 66],
      [70, 73],
      [100, 77],
      [140, 73],
      [170, 68],
      [180, 65],
      [180, 60],
      [160, 60],
      [155, 50],
      [142, 45],
      [130, 35],
      [122, 30],
      [110, 20],
      [105, 10],
      [100, 2],
      [95, 15],
      [88, 21],
      [80, 8],
      [72, 20],
      [62, 25],
      [56, 26],
      [52, 17],
      [43, 12],
      [35, 30],
      [36, 36],
      [28, 41],
      [40, 44],
      [50, 46],
      [60, 50],
    ],
  ],
  north: [
    [
      [-168, 66],
      [-165, 60],
      [-152, 58],
      [-140, 60],
      [-130, 54],
      [-125, 48],
      [-124, 40],
      [-117, 32],
      [-110, 23],
      [-105, 20],
      [-97, 16],
      [-92, 15],
      [-84, 10],
      [-78, 8],
      [-83, 15],
      [-88, 21],
      [-97, 26],
      [-94, 29],
      [-89, 29],
      [-82, 25],
      [-81, 32],
      [-76, 37],
      [-70, 43],
      [-66, 45],
      [-60, 47],
      [-55, 52],
      [-64, 60],
      [-78, 62],
      [-95, 60],
      [-85, 68],
      [-100, 70],
      [-125, 70],
      [-140, 70],
      [-160, 71],
    ],
    [
      [-45, 60],
      [-20, 70],
      [-20, 82],
      [-60, 83],
      [-70, 76],
      [-55, 64],
    ],
  ],
  south: [
    [
      [-81, 8],
      [-77, 1],
      [-80, -5],
      [-71, -18],
      [-70, -25],
      [-72, -40],
      [-75, -52],
      [-68, -55],
      [-65, -42],
      [-62, -38],
      [-57, -35],
      [-48, -25],
      [-40, -20],
      [-35, -8],
      [-44, -2],
      [-50, 0],
      [-60, 6],
      [-70, 11],
      [-77, 8],
    ],
  ],
  oceania: [
    [
      [114, -22],
      [113, -26],
      [115, -34],
      [129, -32],
      [138, -35],
      [147, -38],
      [150, -37],
      [153, -28],
      [146, -19],
      [142, -11],
      [136, -12],
      [130, -11],
      [125, -14],
      [122, -18],
    ],
    [
      [172, -34],
      [174, -37],
      [178, -38],
      [174, -41],
      [171, -44],
      [167, -46],
      [166, -45],
      [170, -41],
    ],
  ],
};

const LON_MIN = -170;
const LON_MAX = 190;
const LAT_MAX = 84;
const LAT_MIN = -56;

function inside(lon: number, lat: number, ring: readonly (readonly [number, number])[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const here = ring[i];
    const previous = ring[j];
    if (here === undefined || previous === undefined) continue;
    const [xi, yi] = here;
    const [xj, yj] = previous;
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

interface Raster {
  readonly w: number;
  readonly h: number;
  readonly land: readonly (string | null)[];
  readonly edge: readonly boolean[];
}

const rasters = new Map<string, Raster>();

/** Which continent owns each pixel, and whether that pixel sits on a coastline. */
function raster(w: number, h: number): Raster {
  const key = `${String(w)}x${String(h)}`;
  const cached = rasters.get(key);
  if (cached) return cached;

  const land: (string | null)[] = new Array<string | null>(w * h).fill(null);
  for (let row = 0; row < h; row++) {
    const lat = LAT_MAX - ((row + 0.5) / h) * (LAT_MAX - LAT_MIN);
    for (let col = 0; col < w; col++) {
      const lon = LON_MIN + ((col + 0.5) / w) * (LON_MAX - LON_MIN);
      for (const [name, rings] of Object.entries(OUTLINES)) {
        if (rings.some((ring) => inside(lon, lat, ring) || inside(lon - 360, lat, ring))) {
          land[row * w + col] = name;
          break;
        }
      }
    }
  }

  const edge: boolean[] = new Array<boolean>(w * h).fill(false);
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const here = land[row * w + col];
      if (here === null) continue;
      edge[row * w + col] =
        row === 0 ||
        row === h - 1 ||
        col === 0 ||
        col === w - 1 ||
        land[(row - 1) * w + col] !== here ||
        land[(row + 1) * w + col] !== here ||
        land[row * w + col - 1] !== here ||
        land[row * w + col + 1] !== here;
    }
  }

  const built: Raster = { w, h, land, edge };
  rasters.set(key, built);
  return built;
}

/** The largest map that still leaves room for the list, or null when nothing sensible fits. */
function mapSize(columns: number, rows: number, reserved: number): { w: number; h: number } | null {
  for (let w = Math.min(columns - 4, 132); w >= 56; w -= 4) {
    // 360 degrees of longitude against 140 of latitude: keep the ratio so nothing is squashed.
    const h = Math.max(2, Math.round((w * 0.39) / 2) * 2);
    if ((UNICODE && COLOUR ? h / 2 : h) + reserved <= rows) return { w, h };
  }
  return null;
}

// ── the picker ────────────────────────────────────────────────────────────────

interface Screen {
  screen: string;
  cursor: number;
  offset: number;
}

interface Item {
  readonly kind: 'pack' | 'group' | 'action';
  readonly label: string;
  readonly hint: string;
  readonly id?: string;
  readonly to?: string;
  readonly act?: 'all' | 'confirm';
  readonly region?: string;
}

const humanSize = (bytes: number): string =>
  bytes < 102_400
    ? `${String(Math.round(bytes / 1024))} KB`
    : `${(bytes / 1_048_576).toFixed(1)} MB`;

/** "Argentina (country)" is right in a printed list and noise in a screen that says so already. */
const plainName = (name: string): string =>
  name.replace(/\s*\((country|language|locale-agnostic)\)$/, '');

export function runPicker(
  bundles: readonly PickerBundle[],
  installedNow: ReadonlySet<string>,
): Promise<PickerResult | null> {
  const byId = new Map(bundles.map((b) => [b.id, b]));
  const languages = bundles.filter((b) => b.locale !== undefined);
  const countries = bundles.filter((b) => b.country !== undefined);
  const neither = bundles.filter((b) => b.locale === undefined && b.country === undefined);

  const inRegion = (key: string): readonly PickerBundle[] =>
    countries.filter((b) => (b.regions ?? []).includes(key));

  const selected = new Set<string>();
  const dropping = new Set<string>();
  const first: Screen = { screen: 'start', cursor: 0, offset: 0 };
  const stack: Screen[] = [first];
  let query = '';
  let flash = '';
  let bodyVisible = false;

  // The stack is never emptied — `backspace` stops at one — so the fallback never fires.
  const top = (): Screen => stack[stack.length - 1] ?? first;
  const sizeOf = (id: string): string => humanSize(byId.get(id)?.bytes ?? 0);
  const notInstalled = (): readonly string[] =>
    bundles.map((b) => b.id).filter((id) => !installedNow.has(id));

  const countsByRegion = (): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const c of CONTINENTS) {
      counts.set(c.key, inRegion(c.key).filter((b) => selected.has(b.id)).length);
    }
    return counts;
  };

  function itemsFor(state: Screen): readonly Item[] {
    switch (state.screen) {
      case 'start': {
        const rest = notInstalled();
        const total = rest.reduce((n, id) => n + (byId.get(id)?.bytes ?? 0), 0);
        const items: Item[] = [
          {
            kind: 'action',
            act: 'all',
            label: 'Everything',
            hint:
              rest.length === 0
                ? 'already installed'
                : `${String(rest.length)} not installed · ${humanSize(total)}`,
          },
          {
            kind: 'group',
            to: 'browse',
            label: 'Choose what I need',
            hint: 'by language, by country, or search',
          },
        ];
        if (installedNow.size > 0) {
          items.push({
            kind: 'group',
            to: 'installed',
            label: 'Installed packs',
            hint: `${String(installedNow.size)} here · remove any you no longer want`,
          });
        }
        return items;
      }
      case 'browse': {
        const picked = (list: readonly PickerBundle[]): number =>
          list.filter((b) => selected.has(b.id)).length;
        const items: Item[] = neither.map((b) => ({
          kind: 'pack' as const,
          id: b.id,
          label: plainName(b.name),
          hint: b.description.slice(0, 64),
        }));
        items.push(
          {
            kind: 'group',
            to: 'languages',
            label: 'Languages',
            hint: `${String(languages.length)} available${picked(languages) ? ` · ${String(picked(languages))} picked` : ''}`,
          },
          {
            kind: 'group',
            to: 'regions',
            label: 'Countries',
            hint: `${String(countries.length)} available${picked(countries) ? ` · ${String(picked(countries))} picked` : ''}`,
          },
          {
            kind: 'group',
            to: 'review',
            label: 'Review and install',
            hint: selected.size > 0 ? `${String(selected.size)} in the basket` : 'basket is empty',
          },
        );
        return items;
      }
      case 'languages':
        return languages.map((b) => ({
          kind: 'pack' as const,
          id: b.id,
          label: plainName(b.name),
          hint: `${b.id} · ${sizeOf(b.id)}`,
        }));
      case 'regions':
        return CONTINENTS.map((c) => {
          const here = inRegion(c.key);
          const picked = here.filter((b) => selected.has(b.id)).length;
          return {
            kind: 'group' as const,
            to: `region:${c.key}`,
            label: c.name,
            region: c.key,
            hint: `${String(here.length)} countries${picked ? ` · ${String(picked)} picked` : ''}`,
          };
        });
      case 'installed':
        return [...installedNow].sort().map((id) => ({
          kind: 'pack' as const,
          id,
          label: plainName(byId.get(id)?.name ?? id),
          hint: dropping.has(id) ? 'marked for removal' : `${id} · installed`,
        }));
      case 'review': {
        const chosen = [...selected].sort();
        if (chosen.length === 0 && dropping.size === 0) return [];
        const total = chosen.reduce((n, id) => n + (byId.get(id)?.bytes ?? 0), 0);
        const items: Item[] = chosen.map((id) => ({
          kind: 'pack' as const,
          id,
          label: plainName(byId.get(id)?.name ?? id),
          hint: `${id} · ${sizeOf(id)}`,
        }));
        for (const id of [...dropping].sort()) {
          items.push({
            kind: 'pack',
            id,
            label: plainName(byId.get(id)?.name ?? id),
            hint: 'will be removed',
          });
        }
        const what = [
          chosen.length > 0 ? `install ${String(chosen.length)}` : '',
          dropping.size > 0 ? `remove ${String(dropping.size)}` : '',
        ]
          .filter(Boolean)
          .join(', ');
        items.push({
          kind: 'action',
          act: 'confirm',
          label: `Apply — ${what}`,
          hint: chosen.length > 0 ? humanSize(total) : '',
        });
        return items;
      }
      case 'search': {
        const q = query.trim().toLowerCase();
        if (q === '') return [];
        return bundles
          .filter((b) => b.id.includes(q) || plainName(b.name).toLowerCase().includes(q))
          .map((b) => {
            const where =
              b.locale !== undefined
                ? 'language'
                : b.country !== undefined
                  ? CONTINENTS.filter((c) => (b.regions ?? []).includes(c.key))
                      .map((c) => c.name)
                      .join(' / ')
                  : 'no language, no country';
            return {
              kind: 'pack' as const,
              id: b.id,
              label: plainName(b.name),
              hint: `${where} · ${sizeOf(b.id)}`,
            };
          });
      }
      default: {
        const key = state.screen.slice('region:'.length);
        return inRegion(key).map((b) => ({
          kind: 'pack' as const,
          id: b.id,
          label: plainName(b.name),
          hint: `${b.id} · ${sizeOf(b.id)}${(b.regions ?? []).length > 1 ? ' · spans two continents' : ''}`,
        }));
      }
    }
  }

  function titleFor(state: Screen): string {
    switch (state.screen) {
      case 'start':
        return 'Data packs';
      case 'browse':
        return 'Data packs › Choose';
      case 'languages':
        return 'Data packs › Languages';
      case 'regions':
        return 'Data packs › Countries';
      case 'installed':
        return 'Data packs › Installed';
      case 'review':
        return 'Data packs › Review';
      case 'search':
        return 'Data packs › Search';
      default: {
        const key = state.screen.slice('region:'.length);
        return `Data packs › Countries › ${CONTINENTS.find((c) => c.key === key)?.name ?? key}`;
      }
    }
  }

  function renderMap(size: { w: number; h: number }, focused: string | null): readonly string[] {
    const { w, h, land, edge } = raster(size.w, size.h);
    const counts = countsByRegion();
    const lit = new Set<number>();
    for (const id of selected) {
      const point = byId.get(id)?.point;
      if (!point) continue;
      const col = Math.round(((point[0] - LON_MIN) / (LON_MAX - LON_MIN)) * w - 0.5);
      const row = Math.round(((LAT_MAX - point[1]) / (LAT_MAX - LAT_MIN)) * h - 0.5);
      if (col >= 0 && col < w && row >= 0 && row < h) lit.add(row * w + col);
    }

    // Land you have not chosen is a grey body under a coloured coastline: the shape stays
    // readable, but nothing is filled in until you pick it.
    const shade = (index: number): string | null => {
      if (lit.has(index)) return '1;97';
      const key = land[index];
      if (key === null || key === undefined) return null;
      const continent = CONTINENTS.find((c) => c.key === key);
      if (continent === undefined) return null;
      const isEdge = edge[index] === true;
      if (key === focused)
        return isEdge ? `1;${String(continent.bright)}` : String(continent.colour);
      if ((counts.get(key) ?? 0) > 0)
        return isEdge ? String(continent.bright) : `2;${String(continent.colour)}`;
      if (isEdge) return String(continent.colour);
      return bodyVisible ? '90' : null;
    };

    const lines: string[] = [];
    if (UNICODE && COLOUR) {
      for (let row = 0; row < h; row += 2) {
        let line = '  ';
        for (let col = 0; col < w; col++) {
          const upper = shade(row * w + col);
          const lower = row + 1 < h ? shade((row + 1) * w + col) : null;
          if (upper === null && lower === null) {
            line += ' ';
            continue;
          }
          if (upper !== null && lower !== null) {
            // One cell, two pixels: the top is drawn, the bottom becomes its background.
            const background = Number(lower.split(';').pop()) + 10;
            line += `${ESC}${upper};${String(background)}m▀${ESC}0m`;
          } else if (upper !== null) {
            line += `${ESC}${upper}m▀${ESC}0m`;
          } else if (lower !== null) {
            line += `${ESC}${lower}m▄${ESC}0m`;
          }
        }
        lines.push(line);
      }
    } else {
      // No half-blocks, or no colour to tell the two pixels apart: one row per line, coastlines
      // only. Still a world, and it still shows where a pick landed.
      for (let row = 0; row < h; row++) {
        let line = '  ';
        for (let col = 0; col < w; col++) {
          const index = row * w + col;
          const code = shade(index);
          if (code === null || (!COLOUR && edge[index] !== true && !lit.has(index))) {
            line += ' ';
            continue;
          }
          line += COLOUR ? `${ESC}${code}m${GLYPHS.land}${ESC}0m` : GLYPHS.land;
        }
        lines.push(line);
      }
    }

    const chips = CONTINENTS.map((c) => {
      const picked = counts.get(c.key) ?? 0;
      const label = picked > 0 ? `${c.name} (${String(picked)})` : c.name;
      return sgr(
        `${GLYPHS.chip} ${label}`,
        c.key === focused ? `1;${String(c.bright)}` : `2;${String(c.colour)}`,
      );
    });
    lines.push('');
    if (process.stdout.columns >= 92) {
      lines.push(`  ${chips.join('   ')}`);
    } else {
      lines.push(`  ${chips.slice(0, 3).join('   ')}`);
      lines.push(`  ${chips.slice(3).join('   ')}`);
    }
    return lines;
  }

  function draw(): void {
    const state = top();
    const items = itemsFor(state);
    const rows = process.stdout.rows;
    const columns = process.stdout.columns;

    const onMap = state.screen === 'regions' || state.screen.startsWith('region:');
    const size = onMap ? mapSize(columns, rows, 13) : null;
    const chrome = size ? (UNICODE && COLOUR ? size.h / 2 : size.h) + 13 : 8;
    const viewport = Math.max(4, Math.min(items.length, rows - chrome));

    // An empty list still has to draw. Clamping only the upper end let the cursor reach -1 on a
    // screen with nothing in it, and the row loop then started below zero.
    state.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, items.length - 1));
    if (state.cursor < state.offset) state.offset = state.cursor;
    if (state.cursor >= state.offset + viewport) state.offset = state.cursor - viewport + 1;
    state.offset = Math.max(0, state.offset);

    const out: string[] = [`${ESC}2J${ESC}H`, '', `  ${bold(titleFor(state))}`, ''];

    if (size) {
      const focused = state.screen.startsWith('region:')
        ? state.screen.slice('region:'.length)
        : (items[state.cursor]?.region ?? null);
      out.push(...renderMap(size, focused), '');
    }

    if (state.screen === 'search')
      out.push(`  Search: ${query === '' ? dim('type a name…') : bold(query)}`, '');

    if (items.length === 0) {
      out.push(
        dim(
          state.screen === 'search'
            ? '  nothing matches'
            : state.screen === 'review'
              ? '  Nothing picked yet — go back and choose something.'
              : '  empty',
        ),
      );
    }

    for (let i = state.offset; i < Math.min(items.length, state.offset + viewport); i++) {
      const item = items[i];
      if (item === undefined) continue;
      const here = i === state.cursor;
      let mark = '   ';
      if (item.kind === 'pack' && item.id !== undefined) {
        mark = dropping.has(item.id)
          ? bold(` ${GLYPHS.drop} `)
          : selected.has(item.id)
            ? bold(` ${GLYPHS.on} `)
            : installedNow.has(item.id)
              ? dim(` ${GLYPHS.done} `)
              : ` ${GLYPHS.off} `;
      } else if (item.kind === 'group') {
        mark = ` ${GLYPHS.group} `;
      }
      const label = item.label.padEnd(26);
      out.push(
        `  ${here ? bold(GLYPHS.cursor) : ' '}${mark}${here ? bold(label) : label} ${dim(item.hint)}`,
      );
    }

    if (items.length > viewport) {
      out.push(
        '',
        dim(
          `  ${String(state.offset + 1)}–${String(Math.min(items.length, state.offset + viewport))} of ${String(items.length)}`,
        ),
      );
    }

    out.push('');
    out.push(
      dim(
        `  ${
          state.screen === 'search'
            ? '↑↓ move · enter pick · esc leave search'
            : state.screen === 'review'
              ? '↑↓ move · space drop · enter apply · backspace back · q cancel'
              : state.screen === 'installed'
                ? '↑↓ move · space mark for removal · backspace back · q cancel'
                : '↑↓ move · enter open · space pick · / search · m map · backspace back · q cancel'
        }`,
      ),
    );
    if (selected.size > 0 || dropping.size > 0) {
      const parts = [
        selected.size > 0 ? `${String(selected.size)} to install` : '',
        dropping.size > 0 ? `${String(dropping.size)} to remove` : '',
      ].filter(Boolean);
      out.push(`  ${dim('basket: ')}${bold(parts.join(', '))}`);
    }
    if (flash !== '') out.push('', `  ${flash}`);

    process.stdout.write(`${out.join('\n')}\n`);
  }

  return new Promise<PickerResult | null>((resolve) => {
    let finished = false;

    const stop = (result: PickerResult | null): void => {
      if (finished) return;
      finished = true;
      process.stdin.off('keypress', onKeyGuarded);
      process.stdout.off('resize', drawGuarded);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(`${ESC}?25h${ESC}2J${ESC}H`);
      resolve(result);
    };

    function toggle(id: string): void {
      if (top().screen === 'installed' || dropping.has(id)) {
        if (dropping.has(id)) dropping.delete(id);
        else dropping.add(id);
        return;
      }
      if (installedNow.has(id)) {
        flash = dim(`${id} is already installed`);
        return;
      }
      if (selected.has(id)) selected.delete(id);
      else selected.add(id);
    }

    function onKey(str: string | undefined, rawKey: Key | undefined): void {
      const key = rawKey ?? {};
      const state = top();
      const items = itemsFor(state);
      flash = '';

      if (key.ctrl === true && key.name === 'c') {
        stop(null);
        return;
      }

      if (state.screen === 'search') {
        if (key.name === 'escape') {
          stack.pop();
          query = '';
          draw();
          return;
        }
        if (key.name === 'backspace') {
          query = query.slice(0, -1);
          state.cursor = 0;
          draw();
          return;
        }
        if (key.name === 'space') {
          query += ' ';
          state.cursor = 0;
          draw();
          return;
        }
        // Terminals disagree: some send CR, some LF, and node names them differently.
        if (key.name === 'return' || key.name === 'enter') {
          const item = items[state.cursor];
          if (item?.id !== undefined) toggle(item.id);
          draw();
          return;
        }
        if (
          str?.length === 1 &&
          key.ctrl !== true &&
          key.meta !== true &&
          key.name !== 'up' &&
          key.name !== 'down'
        ) {
          query += str;
          state.cursor = 0;
          draw();
          return;
        }
      }

      switch (key.name) {
        case 'q':
          stop(null);
          return;
        case 'up':
          state.cursor = Math.max(0, state.cursor - 1);
          break;
        case 'down':
          state.cursor = Math.max(0, Math.min(items.length - 1, state.cursor + 1));
          break;
        case 'pageup':
          state.cursor = Math.max(0, state.cursor - 10);
          break;
        case 'pagedown':
          state.cursor = Math.max(0, Math.min(items.length - 1, state.cursor + 10));
          break;
        case 'home':
          state.cursor = 0;
          break;
        case 'end':
          state.cursor = Math.max(0, items.length - 1);
          break;
        case 'm':
          bodyVisible = !bodyVisible;
          flash = dim(bodyVisible ? 'land filled' : 'coastlines only');
          break;
        case 'space': {
          const item = items[state.cursor];
          if (item?.kind === 'pack' && item.id !== undefined) toggle(item.id);
          else if (item?.kind === 'group' && item.to?.startsWith('region:') === true) {
            // Space on a continent takes the whole continent — the shortcut for "all of Africa".
            const here = inRegion(item.to.slice('region:'.length)).filter(
              (b) => !installedNow.has(b.id),
            );
            const all = here.every((b) => selected.has(b.id));
            for (const b of here) {
              if (all) selected.delete(b.id);
              else selected.add(b.id);
            }
            flash = dim(all ? 'continent cleared' : 'whole continent added');
          }
          break;
        }
        case 'return':
        case 'enter': {
          const item = items[state.cursor];
          if (item === undefined) break;
          if (item.kind === 'group' && item.to !== undefined) {
            stack.push({ screen: item.to, cursor: 0, offset: 0 });
          } else if (item.kind === 'action' && item.act === 'all') {
            for (const id of notInstalled()) selected.add(id);
            stack.push({ screen: 'review', cursor: 0, offset: 0 });
          } else if (item.kind === 'action' && item.act === 'confirm') {
            stop({ install: [...selected].sort(), remove: [...dropping].sort() });
            return;
          }
          break;
        }
        case 'backspace':
        case 'escape':
        case 'left':
          if (stack.length > 1) stack.pop();
          break;
        default:
          if (str === '/') {
            stack.push({ screen: 'search', cursor: 0, offset: 0 });
            query = '';
          }
          break;
      }
      draw();
    }

    // A crash anywhere in the UI must not leave the terminal in raw mode with
    // a hidden cursor — restore first, then let the error surface normally.
    // (These are function declarations so `stop`, defined above, can name them.)
    function onKeyGuarded(str: string | undefined, rawKey: Key | undefined): void {
      try {
        onKey(str, rawKey);
      } catch (err) {
        stop(null);
        throw err;
      }
    }

    function drawGuarded(): void {
      try {
        draw();
      } catch (err) {
        stop(null);
        throw err;
      }
    }

    emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write(`${ESC}?25l`);
    process.stdin.on('keypress', onKeyGuarded);
    process.stdout.on('resize', drawGuarded);
    drawGuarded();
  });
}
