// Types for doc-examples.mjs, for the TypeScript scripts that share it (engine-sweep.ts).

export const REPO: string;
export const DOC_NOW: string;

export interface DocExample {
  readonly line: number;
  readonly config: string;
  readonly wrapped: boolean;
  readonly expected?: string;
  readonly skip?: string;
  readonly file: string;
  readonly name: string;
  readonly index: number;
}

export function allExamples(): DocExample[];
