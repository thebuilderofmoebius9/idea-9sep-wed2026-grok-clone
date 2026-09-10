# Linux port

`LinuxWorkspace/` is the runnable Linux target for this fork. It is a local
browser workspace served only on `127.0.0.1`, with no package installation.

```sh
cd LinuxWorkspace
npm test
npm start
```

Then open the printed local URL. Bots, conversations and drafts in this first
slice are stored with browser local storage. It deliberately does not import a
provider credential, call a remote API, or claim compatibility with the macOS
Core Data store.

The original SwiftUI/AppKit implementation remains under `Packages/` and
`Prototypes/` as the macOS reference. It cannot run on Linux because it depends
on Apple-only frameworks (AppKit, SwiftUI, Core Data and Security).

## Port boundary

Included now: local UI, teammate creation, conversation creation, message
drafting and local persistence.

Not yet ported: provider streaming, group rounds, attachments, routines,
exports, native credential storage and migration from the macOS database.
