/**
 * VS Code extension — a thin wrapper that (1) contributes the `.tdc`
 * language + TextMate grammar (declared in package.json, so highlighting
 * works with no code) and (2) launches our language server for diagnostics,
 * autocomplete, hover and navigation.
 *
 * The server itself is `typescript/dist/lsp/server.js` in this repo. By
 * default we resolve it relative to this extension; set `tdc.server.path` to
 * an absolute path when the extension is installed outside the repo.
 */
import * as path from "node:path";

import { type ExtensionContext, workspace } from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const configured = workspace
    .getConfiguration("tdc")
    .get<string>("server.path");
  const serverModule =
    configured && configured.length > 0
      ? configured
      : context.asAbsolutePath(
          path.join("..", "..", "typescript", "dist", "lsp", "server.js"),
        );

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: { module: serverModule, transport: TransportKind.stdio },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "tdc" }],
  };

  client = new LanguageClient(
    "tdc",
    "TDC Language Server",
    serverOptions,
    clientOptions,
  );
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
