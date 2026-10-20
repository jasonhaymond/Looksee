// File access confined to a known folder.
//
// Why: a file path that's built at runtime (a file name from a URL, a
// setting, an environment variable) could point outside where it's meant to
// — "../../etc/passwd" ("path traversal"). Every runtime-built path the
// engine reads or writes goes through these helpers, which resolve the path
// and refuse it unless it stays inside the given base folder. The base
// folders themselves are fixed by the code (the repo's agent/ folder, the
// collector's state folder, a backup's staging folder).
//
// The file-system calls below take a variable path by design; ESLint's
// security plugin flags every such call, so each one carries a comment
// saying why it's safe: the path was checked by within() first.

import fs from "node:fs";
import path from "node:path";

/**
 * The absolute path of `parts` inside `base`, or an error when it would
 * leave `base` (via "..", an absolute part, or a symlink-free trick).
 *
 * @param base the folder the path must stay inside
 * @param parts path pieces under it (file names, sub-folders)
 * @throws Error if the result is outside `base`
 */
export function within(base: string, ...parts: string[]): string {
  const root = path.resolve(base);
  const full = path.resolve(root, ...parts);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`Path is outside ${root}`);
  return full;
}

/** Whether a file exists inside `base` (false for paths outside it). */
export function existsIn(base: string, ...parts: string[]): boolean {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to base by within()
    return fs.existsSync(within(base, ...parts));
  } catch {
    return false;
  }
}

/** Reads a text file inside `base`. */
export function readTextIn(base: string, ...parts: string[]): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to base by within()
  return fs.readFileSync(within(base, ...parts), "utf-8");
}

/** Writes a text file inside `base`. */
export function writeTextIn(base: string, name: string, text: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to base by within()
  fs.writeFileSync(within(base, name), text);
}

/** A write stream to a file inside `base`. */
export function writeStreamIn(base: string, name: string): fs.WriteStream {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to base by within()
  return fs.createWriteStream(within(base, name));
}

/** A read stream from a file inside `base`. */
export function readStreamIn(base: string, name: string): fs.ReadStream {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- confined to base by within()
  return fs.createReadStream(within(base, name));
}

/**
 * Whether an absolute path from a fixed list in the code exists (e.g. where
 * Chrome is usually installed). Only for paths written in the code itself.
 */
export function knownPathExists(p: string): boolean {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- only called with paths hard-coded in the source
  return fs.existsSync(p);
}
