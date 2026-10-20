// Runs an external program (borg, pg_dump, psql) for the backup service,
// with arguments passed as a list — never through a shell — so a value with
// spaces or quotes can't become a second command.
//
// Where this sits: used by services/backup.ts. Output can be streamed to or
// from files (a database dump), which stay inside the backup's own folder
// (lib/safeFs.ts).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { readStreamIn, writeStreamIn } from "./safeFs.js";

/**
 * Runs a child process to completion, capturing stdout/stderr as text.
 * Rejects with an Error carrying stderr on a non-zero exit. `stdinFile`/
 * `stdoutFile` stream a file directly to/from the child's stdin/stdout
 * rather than buffering as a string — needed for the Postgres dump/restore
 * steps, which can be arbitrarily large.
 */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdinFile?: string; stdoutFile?: string } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
    });

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

    const stdoutChunks: Buffer[] = [];
    let stdoutFileStream: fs.WriteStream | undefined;
    if (opts.stdoutFile) {
      // Paths built by the backup code; written only inside their own folder.
      stdoutFileStream = writeStreamIn(path.dirname(opts.stdoutFile), path.basename(opts.stdoutFile));
      child.stdout.pipe(stdoutFileStream);
    } else {
      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    }

    if (opts.stdinFile) {
      readStreamIn(path.dirname(opts.stdinFile), path.basename(opts.stdinFile)).pipe(child.stdin);
    } else {
      // Closed immediately rather than left open — every command this runs
      // is unattended (no terminal attached), so an open, unwritten stdin
      // would make a prompting subprocess hang forever instead of seeing EOF.
      child.stdin.end();
    }

    child.on("error", (err) => reject(err));

    child.on("close", (code) => {
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      const finish = () => {
        if (code !== 0) {
          reject(new Error(stderr || `${cmd} ${args[0] ?? ""} exited with code ${code}`));
          return;
        }
        resolve(opts.stdoutFile ? "" : Buffer.concat(stdoutChunks).toString("utf8"));
      };
      if (stdoutFileStream && !stdoutFileStream.writableFinished) {
        stdoutFileStream.on("finish", finish);
      } else {
        finish();
      }
    });
  });
}
