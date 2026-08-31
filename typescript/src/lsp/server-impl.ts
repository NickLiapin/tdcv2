/**
 * TDC language server — thin LSP protocol adapter.
 *
 * All real logic lives in the pure brains (`diagnostics.ts`, and later
 * `completion.ts`). This file only wires the Language Server Protocol: it
 * syncs open documents, runs `computeDiagnostics` on every change, and
 * publishes the results. Because it is pure I/O glue — exercised end to end
 * by real editors, not unit tests — it is excluded from coverage.
 *
 * Loaded by `server.ts` (the `tdcv2-lsp` bin), which dynamically imports this
 * module so a missing optional LSP dependency becomes a friendly message
 * rather than a raw ERR_MODULE_NOT_FOUND. The `vscode-languageserver*` imports
 * below are OPTIONAL peer dependencies — not installed by a plain
 * `npm install tdcv2`; only needed to actually run the LSP.
 */

import { fileURLToPath } from 'node:url';

import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  type CompletionItem as ProtocolCompletionItem,
  type CompletionParams,
  createConnection,
  type DefinitionParams,
  type Diagnostic as ProtocolDiagnostic,
  type DocumentFormattingParams,
  type Hover as ProtocolHover,
  type HoverParams,
  type InitializeParams,
  type InitializeResult,
  type Location,
  MarkupKind,
  ProposedFeatures,
  type ReferenceParams,
  type RenameParams,
  type TextDocumentChangeEvent,
  TextDocuments,
  TextDocumentSyncKind,
  type TextEdit as ProtocolTextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node.js';

import { type PackRegistry, scanPacks } from '../data-pack/index.js';
import { packRootsFor, rootsChanged, stampRoots } from './pack-roots.js';
import { formatTdc } from '../formatter/format.js';

import { computeCompletions, type PackAddressInfo } from './completion.js';
import { computeDiagnostics } from './diagnostics.js';
import { computeDefinition, computeHover, computeReferences, computeRename } from './navigation.js';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

// Packs scanned on init and refreshed when a root changes underneath us.
// Addresses feed diagnostics (don't flag known pack templates); the richer
// infos (address + description) feed completion.
let packAddresses: readonly string[] = [];
let packInfos: readonly PackAddressInfo[] = [];
let initParams: InitializeParams | undefined;
/** Root path → its mtime when last scanned, for the staleness check below. */
let rootStamps: ReadonlyMap<string, number> = new Map();

function adoptRegistry(registry: PackRegistry): void {
  packAddresses = [...registry.keys()];
  packInfos = [...registry.values()].map((entry) => ({
    address: entry.address,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
  }));
}

/**
 * Rescan if a pack root has changed since the last scan.
 *
 * `tdcv2 pack add` unpacks a bundle into the store, which changes that
 * directory's mtime, and the set of roots itself changes when the install
 * registers a new `dataPaths` entry. Scanning a hundred locale packs takes
 * seconds and must not happen per keystroke, so the check is a stat per root —
 * microseconds — and the walk only runs when one of them actually moved.
 *
 * Without this, installing a pack meant restarting the editor before its
 * addresses could be completed, and nothing said so.
 */
function refreshPacksIfStale(): void {
  if (initParams === undefined) return;
  const roots = workspaceRoots(initParams);
  const stamps = stampRoots(roots);
  if (!rootsChanged(rootStamps, stamps)) return;
  rootStamps = stamps;
  adoptRegistry(scanPacks(roots).registry);
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  initParams = params;
  rootStamps = stampRoots(workspaceRoots(params));
  adoptRegistry(loadPacks(params));
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: { triggerCharacters: ['<', ' ', '"', '.'] },
      hoverProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: true,
      documentFormattingProvider: true,
    },
  };
});

connection.onDocumentFormatting((params: DocumentFormattingParams): ProtocolTextEdit[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const text = doc.getText();
  const formatted = formatTdc(text);
  // formatTdc returns the source unchanged on a syntax error → no edit.
  if (formatted === text) return [];
  return [
    {
      range: { start: { line: 0, character: 0 }, end: doc.positionAt(text.length) },
      newText: formatted,
    },
  ];
});

connection.onCompletion((params: CompletionParams): ProtocolCompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  refreshPacksIfStale();
  return computeCompletions(doc.getText(), params.position, { packAddresses: packInfos }).map(
    (c) => ({
      label: c.label,
      ...(c.kind !== undefined ? { kind: c.kind } : {}),
      ...(c.detail !== undefined ? { detail: c.detail } : {}),
      ...(c.insertText !== undefined ? { insertText: c.insertText } : {}),
    }),
  );
});

function loadPacks(params: InitializeParams): PackRegistry {
  return scanPacks(workspaceRoots(params)).registry;
}

/** Workspace folders as plain directories, for `packRootsFor`. */
function workspaceRoots(params: InitializeParams): readonly string[] {
  const dirs: string[] = [];
  for (const folder of params.workspaceFolders ?? []) {
    const dir = uriToPath(folder.uri);
    if (dir !== undefined) dirs.push(dir);
  }
  return packRootsFor(dirs);
}

function uriToPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

function publish(doc: TextDocument): void {
  const diagnostics: ProtocolDiagnostic[] = computeDiagnostics(doc.getText(), {
    packAddresses,
  }).map((d) => ({
    range: d.range,
    severity: d.severity,
    message: d.message,
    source: d.source,
    ...(d.code !== undefined ? { code: d.code } : {}),
  }));
  void connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

connection.onHover((params: HoverParams): ProtocolHover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const hover = computeHover(doc.getText(), params.position);
  return hover
    ? { contents: { kind: MarkupKind.Markdown, value: hover.contents }, range: hover.range }
    : null;
});

connection.onDefinition((params: DefinitionParams): Location | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const range = computeDefinition(doc.getText(), params.position);
  return range ? { uri: params.textDocument.uri, range } : null;
});

connection.onReferences((params: ReferenceParams): Location[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return computeReferences(doc.getText(), params.position).map((range) => ({
    uri: params.textDocument.uri,
    range,
  }));
});

connection.onRenameRequest((params: RenameParams): WorkspaceEdit | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const edits = computeRename(doc.getText(), params.position, params.newName);
  return edits.length > 0 ? { changes: { [params.textDocument.uri]: edits } } : null;
});

documents.onDidChangeContent((event: TextDocumentChangeEvent<TextDocument>) => {
  publish(event.document);
});

documents.listen(connection);
connection.listen();
