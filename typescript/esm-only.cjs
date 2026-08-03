// What a `require("tdcv2")` gets instead of a confusing Node error.
//
// This package is ESM-only. Without this file Node answers
// `ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined`, which reads as
// "this package is broken" rather than "this package is ESM" — and sends people
// to the issue tracker instead of to `import`.
//
// ESM-only rather than dual on purpose. A dual package is loaded twice when both
// entry points are reached in one process, and the two copies do not share
// module state. TDC keeps state that must be shared: the pack registry caches
// what it has read off disk, and two caches would answer the same address from
// two different reads. A confusing require is a worse first minute; two engines
// disagreeing inside one process is a worse everything after that.

throw new Error(
  'tdcv2 is an ES module and cannot be loaded with require().\n' +
    "  In an ES module:            import { TDC } from 'tdcv2'\n" +
    "  In CommonJS:                const { TDC } = await import('tdcv2')\n" +
    '  (top-level await needs Node 20 or newer, which this package already requires)\n' +
    '  Or run a config with no code at all:  npx tdcv2 config.tdc',
);
