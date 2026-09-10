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

Verified by the offline test suite (78 tests, run on Node 18 and Node 22) and by local fixture endpoints;
no live third-party provider has been validated.

The workspace is installable: it ships a web app manifest, icons and a
shell-only service worker. `/api/` requests are never cached, so no reply and no
credential reference is served from a stale cache. Installing it gives the
standalone window that R01 asks for on a platform that has no `.app` bundle,
and browser install/keyboard/zoom behaviour covers the R09 quality matrix.

The Codex adapter is wired to the real ChatGPT Codex endpoint. An explicit
`POST /api/codex-auth { path }` reads one user-named Codex `auth.json`, accepts
only `auth_mode: "chatgpt"`, and keeps `access_token` plus `account_id` in the
session credential store under a `codex-session:` reference. Re-importing into the reference an existing provider already holds is supported,
because a restart empties the session store while the provider record survives.
The refresh token is never read back or used, the auth file is never copied or modified, the
destination host is pinned regardless of `apiRoot`, and the request is
text-only (`tools: []`, `tool_choice: "none"`, `parallel_tool_calls: false`,
`store: false`). It is experimental: it proves one account works, not an
entitlement for every account or model.

The computer panel is a real adapter now, not a placeholder: it drives one
tunnelled Chrome DevTools tab under the permission policy in
`docs/COMPUTER-ADAPTER.md` (loopback only, closed action set, human-driven, no
bot access). Disconnected still renders as disconnected.

Not ported: migration from the macOS Core Data store (dropped on the owner's
instruction: import the fork's tools instead of writing an importer), and
native macOS accessibility flows (browser accessibility applies).
