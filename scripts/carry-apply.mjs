#!/usr/bin/env node
// Applies a carried bundle onto a working tree. Runs on the destination
// machine; prints a single JSON line the supervisor parses.
import { applyBundle } from "../src/carry.mjs";

const [dir, bundleDir] = process.argv.slice(2);
const result = await applyBundle(dir, bundleDir, { expectClean: true });
process.stdout.write(JSON.stringify(result) + "\n");
process.exit(result.ok ? 0 : 1);
