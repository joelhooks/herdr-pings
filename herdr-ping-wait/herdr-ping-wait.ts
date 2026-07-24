#!/usr/bin/env bun

import { appendFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

const POLL_INTERVAL_MS = 1_000;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 10_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
export const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "herdr-pings");
const DEFAULT_CURSOR = join(DEFAULT_STATE_DIR, "cursor.json");

type Cursor = Record<string, number>;

export type Options = {
  paneIds: string[];
  timeoutMs?: number;
  cursorPath: string;
  stateDir?: string;
  follow?: boolean;
  outputPath?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
  write?: (line: string) => void | Promise<void>;
};

class ArgumentError extends Error {}

function usage(): string {
  return "Usage: herdr-ping-wait <pane_id...> [--timeout <seconds>] [--cursor <file>] [--follow] [--output <file>] [--state-dir <dir>]";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function parseArgs(args: string[]): Options {
  const paneIds: string[] = [];
  let timeoutMs: number | undefined;
  let cursorPath = DEFAULT_CURSOR;
  let stateDir: string | undefined;
  let follow = false;
  let outputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--timeout") {
      const value = args[++index];
      if (value === undefined) throw new ArgumentError("--timeout requires seconds");
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) {
        throw new ArgumentError("--timeout must be a non-negative number");
      }
      timeoutMs = seconds * 1_000;
      continue;
    }

    if (arg === "--cursor") {
      const value = args[++index];
      if (value === undefined || value.length === 0) throw new ArgumentError("--cursor requires a file");
      cursorPath = resolve(expandHome(value));
      continue;
    }

    if (arg === "--state-dir") {
      const value = args[++index];
      if (value === undefined || value.length === 0) throw new ArgumentError("--state-dir requires a directory");
      stateDir = resolve(expandHome(value));
      continue;
    }

    if (arg === "--follow") {
      follow = true;
      continue;
    }

    if (arg === "--output") {
      const value = args[++index];
      if (value === undefined || value.length === 0) throw new ArgumentError("--output requires a file");
      outputPath = resolve(expandHome(value));
      continue;
    }

    if (arg.startsWith("-")) throw new ArgumentError(`unknown option: ${arg}`);
    paneIds.push(arg);
  }

  if (paneIds.length === 0) throw new ArgumentError("at least one pane id is required");
  if (outputPath !== undefined && !follow) throw new ArgumentError("--output requires --follow");
  return { paneIds, timeoutMs, cursorPath, stateDir, follow, outputPath };
}

export function spoolPath(paneId: string, stateDir: string = DEFAULT_STATE_DIR): string {
  return join(stateDir, `${paneId.replaceAll(":", "-")}.jsonl`);
}

async function loadCursor(path: string): Promise<Cursor> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("cursor must be a JSON object");
    }

    const cursor: Cursor = {};
    for (const [spool, offset] of Object.entries(parsed)) {
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) {
        throw new Error(`invalid byte offset for ${spool}`);
      }
      cursor[spool] = offset as number;
    }
    return cursor;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`cannot read cursor ${path}: ${(error as Error).message}`);
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

async function saveCursor(path: string, cursor: Cursor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(temporaryPath, `${JSON.stringify(cursor, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

/**
 * Exclusive advisory lock around every cursor read-modify-write. Concurrent
 * waiters previously loaded the whole cursor at startup and rewrote the whole
 * stale map on save, rewinding sibling waiters' offsets and replaying
 * already-consumed events (observed on w25:p2V, 2026-07-24).
 */
async function withCursorLock<T>(cursorPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${cursorPath}.lock`;
  await mkdir(dirname(cursorPath), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n`, "utf8");
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const info = await stat(lockPath);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw new Error(`could not acquire cursor lock ${lockPath} within ${LOCK_ACQUIRE_TIMEOUT_MS / 1_000}s`);
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

async function firstCompleteLine(path: string, offset: number): Promise<{ line: string; nextOffset: number } | undefined> {
  const size = await fileSize(path);
  if (size <= offset) return undefined;

  const length = size - offset;
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(length);
    const { bytesRead } = await handle.read(bytes, 0, length, offset);
    const content = bytes.subarray(0, bytesRead);
    const newlineIndex = content.indexOf(0x0a);
    if (newlineIndex === -1) return undefined;

    return {
      line: content.subarray(0, newlineIndex).toString("utf8"),
      nextOffset: offset + newlineIndex + 1,
    };
  } finally {
    await handle.close();
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

/**
 * Register watched spools in the cursor at their current EOF (history is not
 * replayed). Returns the effective starting offsets as a fallback baseline in
 * case another process prunes the entries mid-run.
 */
async function initializeSpools(paths: string[], cursorPath: string): Promise<Cursor> {
  return withCursorLock(cursorPath, async () => {
    const cursor = await loadCursor(cursorPath);
    let changed = false;
    for (const path of paths) {
      if (!(path in cursor)) {
        cursor[path] = await fileSize(path);
        changed = true;
      }
    }
    if (changed) await saveCursor(cursorPath, cursor);
    const baseline: Cursor = {};
    for (const path of paths) baseline[path] = cursor[path];
    return baseline;
  });
}

/**
 * Atomically claim the next complete event across the watched spools. The
 * cursor is reloaded from disk inside the lock so concurrent waiters can never
 * double-consume, and the save touches only the consumed spool's offset.
 */
async function consumeNext(paths: string[], cursorPath: string, baseline: Cursor): Promise<string | undefined> {
  return withCursorLock(cursorPath, async () => {
    const cursor = await loadCursor(cursorPath);
    for (const path of paths) {
      let offset = cursor[path] ?? baseline[path] ?? 0;
      // A spool smaller than its offset was deleted and recreated (e.g. by the
      // Luggage between runs); restart it from the top rather than hanging.
      if (offset > (await fileSize(path))) offset = 0;

      const event = await firstCompleteLine(path, offset);
      if (!event) continue;

      cursor[path] = event.nextOffset;
      await saveCursor(cursorPath, cursor);
      return event.line;
    }
    return undefined;
  });
}

export async function run(options: Options): Promise<number> {
  const stateDir = options.stateDir ?? DEFAULT_STATE_DIR;
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const write =
    options.write ??
    (options.outputPath === undefined
      ? (line: string) => void process.stdout.write(`${line}\n`)
      : (line: string) => appendFile(options.outputPath as string, `${line}\n`, "utf8"));

  await mkdir(stateDir, { recursive: true });
  const paths = options.paneIds.map((paneId) => spoolPath(paneId, stateDir));
  const baseline = await initializeSpools(paths, options.cursorPath);
  const startedAt = Date.now();
  let delivered = 0;

  while (true) {
    if (options.signal?.aborted) return delivered > 0 ? 0 : 2;

    const line = await consumeNext(paths, options.cursorPath, baseline);
    if (line !== undefined) {
      await write(line);
      delivered += 1;
      if (!options.follow) return 0;
      continue;
    }

    if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) {
      // Follow mode treats --timeout as a bounded session, not a failure.
      return options.follow && delivered > 0 ? 0 : 2;
    }

    const remaining = options.timeoutMs === undefined
      ? pollIntervalMs
      : Math.min(pollIntervalMs, Math.max(0, options.timeoutMs - (Date.now() - startedAt)));
    await sleep(remaining);
  }
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    process.exitCode = await run(options);
  } catch (error) {
    if (error instanceof ArgumentError) {
      process.stderr.write(`${error.message}\n${usage()}\n`);
    } else {
      process.stderr.write(`${(error as Error).message}\n`);
    }
    process.exitCode = 1;
  }
}
