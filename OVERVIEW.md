Remote Host shows the agents running on any other host your app is already connected to, read only. Pick a host from the row at the top and you get its live session list, its lifecycle events, its token usage and its decision signals, and you can open any session for its result, execution review, timeline, subtasks, diagnostics and an AI analysis. It borrows the connection the app already holds for that host, so there is nothing to install on the remote machine and no endpoint or password to enter anywhere.

It adds one sidebar page, Remote host, and a Command Center item that opens it. Everything runs in the app: the plugin has no server side, registers no daemon hooks, reads no files and keeps no data of its own.

## Setup

Requires Paseo 0.11.1 or later. Connect the other host in the app as you normally would. It then appears in the host row at the top of the page. A host that is offline is listed but cannot be read until the app reconnects to it.

## Languages

English and Simplified Chinese are built in, chosen by the device language, with English filling any gap.

## What it reads

Everything comes from the remote host's own connection, as the app already has it.

- Sessions: the live agent directory, grouped and sorted like the local dashboard, with search and scope filters for what needs attention, running, unread and awaiting reply.
- Row metrics: each row carries a strip of labelled, coloured chips — run time, turns, failed turns, tool calls, failed tool calls with their rate, checks, changes with line counts, thinking, skills, subagents, approvals with the time you kept it waiting, context compactions, tokens and errors. A metric that carries nothing is left out, so a clean session stays short. Failed turns, a tool failure rate over 20 %, checks that mostly failed, and errors are filled rather than tinted, so a session worth opening is visible without reading the numbers. The same strip is drawn for subagent rows, and a collapsed thread shows what its subagents cost in tokens.
- Events: the host's lifecycle stream, reconstructed from the attention and permission events it publishes.
- Tokens: each loaded agent's reported usage, summed per agent and in total.
- Signals: quiet, unread, waiting and repeated failure hints, computed from the directory and the observed events.
- Session detail: the latest result, an execution review with per turn timing and lanes, the full timeline with search, the subtask tree, diagnostics with the session's history evidence, and an analysis of how the run went.
- User prompts: what was typed for each turn, listed in the timeline tab with a copy button.

## Analysis

The Analysis tab reviews how a remote session went: what blocked it, where it looped, what to do next, each finding citing the trace entries it rests on. Press Analyze and the plugin reads that session's trajectory over the remote connection, then asks a model to review it — **on the host this screen is on**, never on the host being watched. There is nothing to install or enable on the remote machine.

The model is whichever provider this host already has: Claude Code, then Codex, then a provider that extends one of them, with its default model. The line beside the button names it before you press. The reading is bounded to the most recent 400 trace entries and 160,000 characters, and the review itself is one short session on this host, so it spends this host's tokens rather than the watched host's.

The temporary session that writes the report is pinned to a read-only or approval-gated mode, is told the trajectory describes a machine it cannot reach, has every tool request it makes denied, and is archived the moment it answers — including when you cancel. It lives in a workspace this host already has open, because a session has to live somewhere; it is never given anything to do there. A report that cites a trace entry the model was not actually sent has that finding removed, its confidence lowered, and the removal written into the report's own limitations. Credentials are masked out of the trajectory before any of it leaves the app.

One report at a time per session, kept while you move between tabs and lost when you leave the host. Nothing is stored anywhere, so there is no history and nothing runs on a schedule.

## What it writes

Nothing on the remote host. There is no server and no stored state, and the host you are watching is only ever read. The only actions are opening a session in the app, copying text to the clipboard, and — when you ask for an analysis — a short-lived session on your own host that is archived as soon as it has answered.

## Limits

Some of what Agent Observatory shows is recorded by a plugin running on the host itself, and no connection can supply it from outside. It is left out here rather than guessed at.

- Plugin observations are blank. Completed turns, failed turns, total runtime and approval wait are counted by a plugin watching that host, so the diagnostics observation row reads as not reported.
- Token rate and model call counts are absent. They come from the provider's own session logs on the host's disk. The token totals an agent reports over the connection are shown instead, so the review's token tile is filled but the output rate tile is not.
- The Statistics and token ledger pages are not included. They read local log files and local history.
- There is no AI recap button. Writing one needs a model runner on the daemon, which would mean a server side; the execution review in the Recap tab is computed in the app from the timeline and needs no model. This is the main deliberate difference from Agent Observatory.
- Analysis has no history, no automatic runs and no follow-up state. Observatory keeps its reports, its per finding resolved / false positive marks and its schedule on the host that recorded the session; with no server there is nowhere here to keep them. Sending a finding to the agent it is about is not offered either: that would be a write to the remote host.
- An analysis needs a provider on your own host and one open workspace for the temporary session to live in. With neither, the tab says so instead of offering a button that cannot work.
- Approval wait and turn outcomes in the review cover only the time the page has been open, because the event stream starts when you open it.
- The subtask tree is built from the agent directory. A provider's own native subagent list is read by a host local plugin and is not available.
- Statistics that depend on read receipts, snoozes or saved views are not offered, since those are kept per host by the plugin that recorded them.

## Relation to Agent Observatory

This plugin is a standalone copy of Agent Observatory's remote host page, for people who want that page alone on a machine. If both plugins are installed you will see two Remote host entries in the sidebar until you remove one of them.
