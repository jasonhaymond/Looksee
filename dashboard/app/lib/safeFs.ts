// Server-side file reads confined to a known folder (used when building the
// in-app help from the repo's docs/ folder).
//
// Why: a path built at runtime could point outside where it's meant to
// ("../../etc/passwd"). readTextIn resolves the path and refuses it unless it
// stays inside the given folder. The file-system call takes a variable path
// by design, so it carries a comment saying why it's safe.

import fs from "node:fs";
import path from "node:path";

/**
 * Reads a text file inside `base`.
 *
 * @param base the folder the file must be in
 * @param name the file name (or a path under `base`)
 * @throws Error if the path would leave `base`, or the file can't be read
 */
export function readTextIn(base: string, name: string): string {
  const root = path.resolve(base);
  const full = path.resolve(root, name);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path is outside ${root}`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to base by the check above
  return fs.readFileSync(full, "utf-8");
}
