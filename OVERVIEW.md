Remote Host shows the agents running on any other host your app is already connected to, read only. Pick a host from the row at the top and you get its live session list, its lifecycle events, its token usage and its decision signals, and you can open any session for its result, execution review, timeline, subtasks and diagnostics. It borrows the connection the app already holds for that host, so there is nothing to install on the remote machine and no endpoint or password to enter anywhere.

It adds one sidebar page, Remote host, and a Command Center item that opens it. Everything runs in the app: the plugin has no server side, registers no daemon hooks, reads no files and keeps no data of its own.

## Setup

Requires Paseo 0.11.1 or later. Connect the other host in the app as you normally would. It then appears in the host row at the top of the page. A host that is offline is listed but cannot be read until the app reconnects to it.

## Languages

English and Simplified Chinese are built in, chosen by the device language, with English filling any gap.

## What it reads

Everything comes from the remote host's own connection, as the app already has it.

- Sessions: the live agent directory, grouped and sorted like the local dashboard, with search, scope filters for what needs attention, running, unread and awaiting reply, and a per row summary of runtime, turns, thinking, tool calls, skills, subagents, changes, checks, tokens and errors.
- Events: the host's lifecycle stream, reconstructed from the attention and permission events it publishes.
- Tokens: each loaded agent's reported usage, summed per agent and in total.
- Signals: quiet, unread, waiting and repeated failure hints, computed from the directory and the observed events.
- Session detail: the latest result, an execution review with per turn timing and lanes, the full timeline with search, the subtask tree, and diagnostics with the session's history evidence.
- User prompts: what was typed for each turn, listed in the timeline tab with a copy button.

## What it writes

Nothing. There is no server, no stored state and no write of any kind to the remote host. The only actions are opening a session in the app and copying text to the clipboard.

## Limits

Some of what Agent Observatory shows is recorded by a plugin running on the host itself, and no connection can supply it from outside. It is left out here rather than guessed at.

- Plugin observations are blank. Completed turns, failed turns, total runtime and approval wait are counted by a plugin watching that host, so the diagnostics observation row reads as not reported.
- Token rate and model call counts are absent. They come from the provider's own session logs on the host's disk. The token totals an agent reports over the connection are shown instead, so the review's token tile is filled but the output rate tile is not.
- Statistics, the token ledger and AI analysis pages are not included. They read local log files and local history.
- There is no AI recap button. Writing one needs a model runner on the daemon, which would mean a server side; the execution review in the Recap tab is computed in the app from the timeline and needs no model. This is the main deliberate difference from Agent Observatory.
- Approval wait and turn outcomes in the review cover only the time the page has been open, because the event stream starts when you open it.
- The subtask tree is built from the agent directory. A provider's own native subagent list is read by a host local plugin and is not available.
- Statistics that depend on read receipts, snoozes or saved views are not offered, since those are kept per host by the plugin that recorded them.

## Relation to Agent Observatory

This plugin is a standalone copy of Agent Observatory's remote host page, for people who want that page alone on a machine. If both plugins are installed you will see two Remote host entries in the sidebar until you remove one of them.
