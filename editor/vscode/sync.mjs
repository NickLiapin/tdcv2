// Copy the canonical grammar + language configuration from ../ into this
// extension folder, so VS Code (which forbids contribution paths outside the
// extension root) has local copies while ../ stays the single source of
// truth. Runs on `npm install` (prepare) and `npm run build`.
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const file of ["tdc.tmLanguage.json", "language-configuration.json"]) {
  copyFileSync(join(here, "..", file), join(here, file));
}
console.log("Synced grammar + language-configuration from ../");
