#!/usr/bin/env node
// Packages a working tree's uncommitted changes so they can travel home.
// Runs on the machine being left; prints a single JSON line.
import fs from "node:fs";
import { captureBundle } from "../src/carry.mjs";

const [dir, bundleDir] = process.argv.slice(2);
fs.rmSync(bundleDir, { recursive: true, force: true });
const result = await captureBundle(dir, bundleDir);
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(result.ok ? 0 : 1);
