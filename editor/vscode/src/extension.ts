/**
 * VS Code extension — a thin wrapper that (1) contributes the `.tdc`
 * language + TextMate grammar (declared in package.json, so highlighting
 * works with no code) and (2) launches our language server for diagnostics,
 * autocomplete, hover and navigation.
 *
 * Where the server is found is in `find-server.ts`; when it is nowhere to be
 * found this says so plainly rather than starting a client against a path that
 * does not exist.
 */
import { type ExtensionContext, window, workspace } from "vscode";

import { findServerModule } from "./find-server";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const configured = workspace.getConfiguration("tdc").get<string>("server.path");
  const dirs = (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const serverModule = findServerModule(context, configured, dirs);

  if (serverModule === undefined) {
    void window.showWarningMessage(
      "TDC: syntax highlighting is on, but the language server was not found, " +
        "so there is no autocomplete, hover or diagnostics. Install tdcv2 " +
        "(npm i -D tdcv2, or globally), or set tdc.server.path to " +
        "…/tdcv2/dist/lsp/server.js.",
    );
    return;
  }

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
