/**
 * Minimal PNG decoder — zero external dependencies (only node's built-in
 * `zlib.inflateSync`). We need it so the pattern-graph can read a drawn image
 * (a histogram, a curve, a filled band) and turn it into a signal/corridor.
 *
 * Supports what real image exports actually produce: 8-bit (and 16-bit,
 * high-byte) grayscale/RGB/gray+alpha/RGBA, 8-bit palette (with tRNS alpha),
 * non-interlaced. Sub-byte depths and Adam7 interlace throw a clear "re-export"
 * error rather than decoding wrong. Output is a flat RGBA byte grid.
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Row-major RGBA, 4 bytes per pixel: `rgba[(y*width + x)*4 + c]`. */
  readonly rgba: Uint8Array;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

/** Channels carried by each color type (grayscale, RGB, palette-index, gray+α, RGBA). */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Decode a PNG buffer into an RGBA grid. Throws on anything it can't read exactly. */
export function decodePng(buf: Uint8Array): DecodedImage {
  if (!isPng(buf)) throw new Error('pattern: src is not a PNG image');
  let header: Header | undefined;
  let palette: Uint8Array | undefined; // RGB triples
  let transparency: Uint8Array | undefined; // tRNS chunk (palette alpha, or key color)
  const idat: Uint8Array[] = [];

  let pos = 8;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (pos + 8 <= buf.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(
      buf[pos + 4] ?? 0,
      buf[pos + 5] ?? 0,
      buf[pos + 6] ?? 0,
      buf[pos + 7] ?? 0,
    );
    const dataStart = pos + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      header = {
        width: view.getUint32(dataStart),
        height: view.getUint32(dataStart + 4),
        bitDepth: buf[dataStart + 8] ?? 0,
        colorType: buf[dataStart + 9] ?? 0,
        interlace: buf[dataStart + 12] ?? 0,
      };
    } else if (type === 'PLTE') {
      palette = data.slice();
    } else if (type === 'tRNS') {
      transparency = data.slice();
    } else if (type === 'IDAT') {
      idat.push(data.slice());
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4; // skip data + CRC
  }

  if (!header) throw new Error('pattern: PNG has no IHDR header');
  const { width, height, bitDepth, colorType, interlace } = header;
  if (interlace !== 0) {
    throw new Error('pattern: interlaced PNG is unsupported — re-export without interlacing');
  }
  const channels = CHANNELS[colorType];
  if (channels === undefined) {
    throw new Error(`pattern: unsupported PNG color type ${String(colorType)}`);
  }
  const supportedDepth = bitDepth === 8 || (bitDepth === 16 && colorType !== 3);
  if (!supportedDepth) {
    throw new Error(
      `pattern: PNG bit depth ${String(bitDepth)} (color type ${String(colorType)}) is unsupported — re-export as 8-bit`,
    );
  }

  const raw = inflateSync(concat(idat));
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const bpp = channels * bytesPerSample; // bytes per pixel in the filtered stream
  const stride = width * bpp;
  const pixels = defilter(raw, height, stride, bpp);

  return {
    width,
    height,
    rgba: toRgba(pixels, width, height, colorType, bitDepth, palette, transparency),
  };
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** Reverse the PNG scanline filters (None/Sub/Up/Average/Paeth). */
function defilter(raw: Uint8Array, height: number, stride: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * stride);
  let rawPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rawPos++] ?? 0;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rawPos++] ?? 0;
      const a = x >= bpp ? (out[row + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[prev + x] ?? 0) : 0;
      const c = y > 0 && x >= bpp ? (out[prev + x - bpp] ?? 0) : 0;
      let recon: number;
      switch (filter) {
        case 0:
          recon = cur;
          break;
        case 1:
          recon = cur + a;
          break;
        case 2:
          recon = cur + b;
          break;
        case 3:
          recon = cur + ((a + b) >> 1);
          break;
        case 4:
          recon = cur + paeth(a, b, c);
          break;
        default:
          throw new Error(`pattern: PNG scanline uses unknown filter ${String(filter)}`);
      }
      out[row + x] = recon & 0xff;
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Expand the defiltered samples into RGBA, resolving palette / alpha / bit depth. */
function toRgba(
  pixels: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  bitDepth: number,
  palette: Uint8Array | undefined,
  transparency: Uint8Array | undefined,
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  const channels = CHANNELS[colorType] ?? 1;
  const step = bitDepth === 16 ? 2 : 1; // read the high byte of 16-bit samples
  const bpp = channels * step;
  const count = width * height;
  for (let i = 0; i < count; i++) {
    const src = i * bpp;
    const dst = i * 4;
    let r: number;
    let g: number;
    let b: number;
    let a = 255;
    switch (colorType) {
      case 0: // grayscale
        r = g = b = pixels[src] ?? 0;
        break;
      case 2: // RGB
        r = pixels[src] ?? 0;
        g = pixels[src + step] ?? 0;
        b = pixels[src + 2 * step] ?? 0;
        break;
      case 3: {
        // palette index → PLTE rgb, tRNS alpha
        const idx = pixels[src] ?? 0;
        r = palette?.[idx * 3] ?? 0;
        g = palette?.[idx * 3 + 1] ?? 0;
        b = palette?.[idx * 3 + 2] ?? 0;
        a = transparency?.[idx] ?? 255;
        break;
      }
      case 4: // gray + alpha
        r = g = b = pixels[src] ?? 0;
        a = pixels[src + step] ?? 0;
        break;
      default: // 6: RGBA
        r = pixels[src] ?? 0;
        g = pixels[src + step] ?? 0;
        b = pixels[src + 2 * step] ?? 0;
        a = pixels[src + 3 * step] ?? 0;
        break;
    }
    rgba[dst] = r;
    rgba[dst + 1] = g;
    rgba[dst + 2] = b;
    rgba[dst + 3] = a;
  }
  return rgba;
}

/** Perceptual luminance 0..255 of an RGB triple (Rec. 601). */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Whether the PNG signature is present — lets callers branch PNG vs SVG on `src`. */
export function isPng(buf: Uint8Array): boolean {
  for (let i = 0; i < SIGNATURE.length; i++) if (buf[i] !== SIGNATURE[i]) return false;
  return true;
}
