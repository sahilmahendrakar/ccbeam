#!/usr/bin/env node
/**
 * The bridge from a slash command to the supervisor.
 *
 * `/teleport` cannot move anything itself — a tool has no access to the
 * terminal. All it does is record where you want to go. The Stop hook ends the
 * session cleanly at the turn boundary and the supervisor, which owns the
 * terminal, performs the move.
 *
 * Deliberately dependency-free and standalone: this file is shipped to every
 * machine you teleport to.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const requestFile = () =>
  process.env.CCTELEPORT_REQ || path.join(os.homedir(), ".ccteleport", "request.json");

const TOOLS = [
  {
    name: "teleport",
    description:
      "Move this Claude Code session to another machine or folder. Call this when the user runs /teleport. " +
      "Pass the target exactly as the user typed it, or omit it to let them choose from a picker. " +
      "The move happens after your turn ends — reply with one short line confirming it, and do not call any other tools.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description:
            "Where to go: a machine name ('gpu-box'), a machine and folder ('gpu-box:~/src/api'), " +
            "'local' for this machine, or omitted to open the picker.",
        },
      },
    },
  },
  {
    name: "back",
    description:
      "Return this Claude Code session to the machine and folder it started from. Call this when the user runs /back. " +
      "The move happens after your turn ends — reply with one short line confirming it.",
    inputSchema: { type: "object", properties: {} },
  },
];

function call(name, args) {
  const file = requestFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });

  if (name === "back") {
    fs.writeFileSync(file, JSON.stringify({ action: "back" }));
    return "Returning to where this session started. Reply with one short line; the move happens when your turn ends.";
  }

  const target = typeof args?.target === "string" ? args.target.trim() : "";
  fs.writeFileSync(file, JSON.stringify({ action: "teleport", target: target || null }));
  return target
    ? `Teleport to ${target} requested. Reply with one short line; the move happens when your turn ends.`
    : "Teleport requested — a picker will open. Reply with one short line; the move happens when your turn ends.";
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification: nothing to answer

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "ccteleport", version: "0.1.0" },
      });
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      if (!TOOLS.some((t) => t.name === name)) return err(id, -32602, `unknown tool: ${name}`);
      try {
        return ok(id, { content: [{ type: "text", text: call(name, params?.arguments) }] });
      } catch (e) {
        return ok(id, { content: [{ type: "text", text: `Could not request the move: ${e.message}` }], isError: true });
      }
    }
    default:
      return err(id, -32601, `unknown method: ${method}`);
  }
});
