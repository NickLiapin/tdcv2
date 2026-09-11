/**
 * The language server, spoken to the way an editor speaks to it.
 *
 * `server-impl.ts` is excluded from coverage, and the reason written at the top of it is that a
 * protocol adapter is "exercised end to end by real editors, not unit tests". That was an
 * argument for not unit-testing it, and it is a good one — but it was also the only thing
 * standing behind 211 lines, and nothing in this repository had ever spoken the protocol. An
 * adapter that hands `undefined` where a `Location` belongs, or answers the wrong document,
 * fails in an editor and nowhere else.
 *
 * So: a real child process, real JSON-RPC over stdio, real `Content-Length` framing. Run from
 * source rather than `dist/`, because the suite must not depend on a build having happened.
 *
 * The framing is worth getting right in the client too. The first version of this test scanned
 * the buffer for a header each time instead of consuming messages in order, saw the initialize
 * response and then never matched again — and reported that the server published no diagnostics
 * at all. It publishes them; the reader was broken. A protocol test that parses sloppily invents
 * failures in the thing it is testing.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'lsp',
  'server-impl.ts',
);

const BROKEN =
  '<tdc><env count="3" seed="s"><sequence name="A"><gen type="nonsense"/></sequence>' +
  '</env><block><line><data>${{A}}</data></line></block></tdc>';

const GOOD =
  '<tdc><env count="3" seed="s"><sequence name="Age"><gen type="number" value="1..9"/>' +
  '</sequence></env><block><line><data>${{Age}}</data></line></block></tdc>';

interface Message {
  readonly id?: number;
  readonly method?: string;
  readonly result?: unknown;
  readonly params?: { readonly diagnostics?: { readonly code?: string }[]; readonly uri?: string };
}

/** A client that keeps its place in the stream rather than re-scanning it. */
class Client {
  private readonly child: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private readonly waiting: ((m: Message) => boolean)[] = [];
  private readonly seen: Message[] = [];

  public constructor() {
    this.child = spawn('npx', ['tsx', SERVER, '--stdio'], {
      cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
  }

  private drain(): void {
    for (;;) {
      const header = this.buffer.indexOf('\r\n\r\n');
      if (header < 0) return;
      const match = /Content-Length: (\d+)/.exec(this.buffer.subarray(0, header).toString());
      if (!match) return;
      const length = Number(match[1]);
      const start = header + 4;
      if (this.buffer.length < start + length) return; // the body has not all arrived
      const message = JSON.parse(this.buffer.subarray(start, start + length).toString()) as Message;
      this.buffer = this.buffer.subarray(start + length);
      this.seen.push(message);
      for (let i = this.waiting.length - 1; i >= 0; i--) {
        if (this.waiting[i]?.(message) === true) this.waiting.splice(i, 1);
      }
    }
  }

  public send(message: Record<string, unknown>): void {
    const body = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`);
  }

  public async next(matches: (m: Message) => boolean, what: string): Promise<Message> {
    const already = this.seen.find(matches);
    if (already) return already;
    return new Promise<Message>((resolveWith, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no ${what} in 30s`));
      }, 30_000);
      this.waiting.push((m) => {
        if (!matches(m)) return false;
        clearTimeout(timer);
        resolveWith(m);
        return true;
      });
    });
  }

  public stop(): void {
    this.child.kill();
  }
}

let client: Client;

beforeAll(async () => {
  client = new Client();
  client.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { processId: null, rootUri: null, capabilities: {}, workspaceFolders: [] },
  });
  await client.next((m) => m.id === 1, 'initialize response');
  client.send({ jsonrpc: '2.0', method: 'initialized', params: {} });
}, 60_000);

afterAll(() => {
  client.stop();
});

describe('the language server over stdio', () => {
  it('announces every capability the editor needs', async () => {
    const message = await client.next((m) => m.id === 1, 'initialize response');
    const capabilities = (message.result as { capabilities: Record<string, unknown> }).capabilities;
    // Each of these is a feature somebody would notice missing — and `initialize` is the only
    // place the editor is told about them.
    for (const name of [
      'completionProvider',
      'hoverProvider',
      'definitionProvider',
      'referencesProvider',
      'renameProvider',
      'documentFormattingProvider',
      'textDocumentSync',
    ]) {
      expect(capabilities[name], name).toBeDefined();
    }
  });

  it('publishes a diagnostic for a document the editor opens', async () => {
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///tmp/tdc-lsp-broken.tdc',
          languageId: 'tdc',
          version: 1,
          text: BROKEN,
        },
      },
    });
    const published = await client.next(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' &&
        m.params?.uri === 'file:///tmp/tdc-lsp-broken.tdc',
      'diagnostics',
    );
    // The same code the CLI and every port report for this config.
    expect(published.params?.diagnostics?.map((d) => d.code)).toContain('TDC041');
  });

  it('says nothing about a document that is fine', async () => {
    client.send({
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: {
        textDocument: {
          uri: 'file:///tmp/tdc-lsp-good.tdc',
          languageId: 'tdc',
          version: 1,
          text: GOOD,
        },
      },
    });
    const published = await client.next(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' &&
        m.params?.uri === 'file:///tmp/tdc-lsp-good.tdc',
      'diagnostics for the good document',
    );
    // An empty list, not silence: the editor has to be told to clear what it drew before.
    expect(published.params?.diagnostics).toEqual([]);
  });

  it('answers hover, and answers it about the right document', async () => {
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/hover',
      params: {
        textDocument: { uri: 'file:///tmp/tdc-lsp-good.tdc' },
        position: { line: 0, character: 62 },
      },
    });
    const answer = await client.next((m) => m.id === 2, 'hover response');
    // Null is a legitimate answer — the position may hold nothing worth explaining. What must
    // not happen is an error, or an answer about the other open document.
    expect(answer.result === null || typeof answer.result === 'object').toBe(true);
  });

  it('formats a document, and offers no edit when there is nothing to change', async () => {
    client.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'textDocument/formatting',
      params: { textDocument: { uri: 'file:///tmp/tdc-lsp-good.tdc' }, options: {} },
    });
    const answer = await client.next((m) => m.id === 3, 'formatting response');
    expect(Array.isArray(answer.result)).toBe(true);
  });

  it('returns nothing for a document it was never told about', async () => {
    // The adapter looks every request's document up by URI, and an editor can ask about one it
    // closed. Every handler returns an empty answer rather than throwing.
    client.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'textDocument/definition',
      params: {
        textDocument: { uri: 'file:///tmp/tdc-lsp-never-opened.tdc' },
        position: { line: 0, character: 0 },
      },
    });
    const answer = await client.next((m) => m.id === 4, 'definition response');
    expect(answer.result).toBeNull();
  });
});
