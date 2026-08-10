// The types a `require("tdcv2")` gets, and why they are not the package's types.
//
// The package is ESM-only on purpose (see esm-only.cjs for the reason: a dual
// package is loaded twice in one process and the two copies do not share the
// pack registry's cache). `esm-only.cjs` therefore throws with instructions.
//
// Without this file the `types` condition above applied to BOTH entry points, so
// TypeScript told a CommonJS caller that `require("tdcv2")` returns the whole
// API — autocomplete, a clean compile — and the throw arrived at runtime.
// `attw --pack` names that exactly: "Import resolved to an ESM type declaration
// file, but a CommonJS JavaScript file."
//
// So the require side gets types that say what actually happens. The type IS the
// message: reaching for anything on it fails at compile time with the sentence a
// reader needs.

declare const tdcv2IsEsmOnly: 'tdcv2 is an ES module: use `import { TDC } from "tdcv2"`, or `await import("tdcv2")` from CommonJS';

export = tdcv2IsEsmOnly;
