---
description: Move this conversation to another device or folder
argument-hint: "[device[:folder] | cloud | home]"
allowed-tools: mcp__beamup__beam
---

Call the `mcp__beamup__beam` tool now.

- If the user supplied a target, pass it through verbatim as `target`: `$ARGUMENTS`
- If they supplied nothing, call the tool with no `target` so they get the picker.

Then reply with a single short line — something like "Beaming." or "Heading to gpu-box." Do not call any other tool, do not summarise the conversation, and do not try to move anything yourself: the session is moved for you the moment your turn ends.
