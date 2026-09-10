# Linux port

`LinuxWorkspace/` is the runnable Linux target for this fork. It is a local
browser workspace served only on `127.0.0.1`, with no package installation.

```sh
cd LinuxWorkspace
npm test
npm start
```

Then open the printed local URL. The workspace persists server-side in a
`workspace.json` file (atomic writes) under `$BOTWORKSPACE_HOME`, falling back
to `~/.local/share/botworkspace-linux`; attachments live in a sibling
`attachments/` directory. Provider credentials are session-only: the key value
is held in the server process and never written to the workspace file, export,
or disk — only its reference is stored.

The original SwiftUI/AppKit implementation remains under `Packages/` and
`Prototypes/` as the macOS reference. It cannot run on Linux because it depends
on Apple-only frameworks (AppKit, SwiftUI, Core Data and Security).

## Port boundary

Included now: local UI (bots, groups, direct chats, search including hidden
bots), server-side persistence with drafts and keyset-paginated messages,
provider settings for OpenAI-compatible endpoints with streamed replies, the
review-then-confirm send flow with ordered group rounds and identity-safe
mentions, Stop/Retry/cancel of generations, attachments (upload, download,
export-safe listing), routines with next-run scheduling, single-claim ticks,
run-now and run history, a local bot template catalog, unread/read state,
preferences, deletion plans and JSON export.

Verified by the offline test suite (66 tests) and by local fixture endpoints;
no live third-party provider has been validated.

Not ported: migration from the macOS Core Data store (different storage engine,
no importer), native accessibility flows (browser accessibility applies), and
live-provider validation beyond OpenAI-compatible chat-completions fixtures.
