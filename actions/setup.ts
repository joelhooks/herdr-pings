#!/usr/bin/env bun

import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const pluginRoot = process.env.HERDR_PLUGIN_ROOT?.trim()
  ? resolve(process.env.HERDR_PLUGIN_ROOT)
  : resolve(import.meta.dir, "..");

const links = [
  {
    path: join(homedir(), ".pi", "agent", "extensions", "herdr-turn-ping"),
    target: join(pluginRoot, "herdr-turn-ping"),
  },
  {
    path: join(homedir(), ".pi", "agent", "extensions", "herdr-name-sync"),
    target: join(pluginRoot, "herdr-name-sync"),
  },
  {
    path: join(homedir(), ".pi", "agent", "extensions", "herdr-callsign"),
    target: join(pluginRoot, "herdr-callsign"),
  },
  {
    path: join(homedir(), ".local", "bin", "herdr-ping-wait"),
    target: join(pluginRoot, "herdr-ping-wait", "herdr-ping-wait.ts"),
  },
];
const spoolDirectory = join(homedir(), ".local", "state", "herdr-pings");

async function ensureDirectory(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isDirectory()) throw new Error(`${path} exists but is not a directory`);
    console.log(`unchanged directory ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path, { recursive: true });
    console.log(`created directory ${path}`);
  }
}

async function ensureLink(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });

  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() && resolve(dirname(path), await readlink(path)) === target) {
      console.log(`unchanged symlink ${path} -> ${target}`);
      return;
    }
    await unlink(path);
    console.log(`removed ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await symlink(target, path);
  console.log(`created symlink ${path} -> ${target}`);
}

try {
  await ensureDirectory(spoolDirectory);
  for (const link of links) await ensureLink(link.path, link.target);
} catch (error) {
  console.error(`setup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
