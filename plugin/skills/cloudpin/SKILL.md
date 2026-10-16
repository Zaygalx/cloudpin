---
name: cloudpin
description: Use before running cloud CLIs (az, aws, gcloud, vercel, gh, kubectl, helm, supabase, wrangler) in a project with a .cloudpin.yml, and whenever cloudpin blocks or asks about a command.
---

# cloudpin

This project pins the cloud accounts it uses in `.cloudpin.yml`. cloudpin stops any cloud CLI command that would run
on a different account. Two read-only tools let you check first; neither runs, switches or changes anything.

## Before cloud work

Call `cloudpin_status` once. Tell the user, in a line, which accounts are active and whether they match the pins
(and which environment applies, if the file defines environments).

## Before a command that changes something

Deploys, deletes, applies, secrets, migrations: call `cloudpin_check` with the exact command line (and `cwd` if it
runs elsewhere). Run the command only if the verdict is `allow`.

## When cloudpin blocks or asks

Stop. Show the user cloudpin's reason and its fix, and wait for them to decide. Never work around it: never retry
the command another way, never set `CLOUDPIN_SKIP` or `CLOUDPIN_CONFIRM`, never edit `.cloudpin.yml`, and never
switch accounts yourself. Switching is the user's call, because only they know which account the work is for.

## If the tools are missing

The plugin runs the `cloudpin` command. If its tools or hook fail with "command not found", tell the user to run
`npm install --global cloudpin` and restart Claude Code.
