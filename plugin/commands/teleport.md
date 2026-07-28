---
description: Move this conversation to another machine or folder
argument-hint: "[machine[:folder]]"
allowed-tools: mcp__ccteleport__teleport
---

Call the `mcp__ccteleport__teleport` tool now.

- If the user supplied a target, pass it through verbatim as `target`: `$ARGUMENTS`
- If they supplied nothing, call the tool with no `target` so they get the picker.

Then reply with a single short line — something like "Teleporting." or "Heading to gpu-box." Do not call any other tool, do not summarise the conversation, and do not try to move anything yourself: the session is moved for you the moment your turn ends.
