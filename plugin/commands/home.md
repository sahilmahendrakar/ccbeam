---
description: Return this conversation to the device and folder it started in
allowed-tools: mcp__ccbeam__beam
---

Call the `mcp__ccbeam__beam` tool now with `target` set to exactly `home`.

Ignore any arguments: this command always means the device and folder this session started in, however many hops ago. If the user wants somewhere else, that is `/ccbeam:up <device>`.

Then reply with a single short line — something like "Heading home." Do not call any other tool, do not summarise the conversation, and do not try to move anything yourself: the session is moved for you the moment your turn ends.
