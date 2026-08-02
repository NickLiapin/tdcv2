/**
 * Shared attribute-map type.
 *
 * Kept minimal for now: string → string. Quoting is stripped at parse
 * time (see `extractAttr`). Future work may need richer values (e.g.
 * parsed numbers, compiled expressions) but for Phase 3 strings suffice.
 */

export type AttrMap = Readonly<Record<string, string>>;
