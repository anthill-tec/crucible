// The repository root, derived from this file's own location (`scripts/` sits
// directly under it), so a script resolves repo paths the same way whatever
// directory it was started from.

import * as path from "node:path";

export const REPO_ROOT = path.dirname(import.meta.dir);
