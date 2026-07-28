#!/usr/bin/env node
/**
 * Ends the session when a move is pending.
 *
 * Firing at Stop rather than inside the tool matters: by the time this runs the
 * turn is complete and the transcript is fully written, so what arrives on the
 * other machine includes the exchange that asked for the move. Killing mid-tool
 * would ship a truncated conversation.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const file = process.env.CCTELEPORT_REQ || path.join(os.homedir(), ".ccteleport", "request.json");

if (fs.existsSync(file)) {
  const pid = Number(process.env.CLAUDE_PID);
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone — the supervisor will still see the request */
    }
  }
}

process.exit(0);
