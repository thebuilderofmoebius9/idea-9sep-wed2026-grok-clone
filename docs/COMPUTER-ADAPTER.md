# Computer adapter (Linux workspace)

The contract's R07 said the computer panel must report disconnected honestly
until a real adapter exists with its own permission policy. This is that
adapter, authorised by the fork owner on 2026-09-10 for browser control.

## What it actually controls

One browser tab that already exposes a Chrome DevTools endpoint, reached
through a tunnel to `127.0.0.1` on the machine running the workspace. It is not
a desktop, not a shell, and not the whole machine. `status().scope` says so in
the payload, and the panel prints it.

## Permission policy

- **Explicit connect.** Nothing happens until a human types a DevTools endpoint
  and presses connect. There is no discovery, no auto-reconnect, no endpoint
  remembered on disk.
- **Loopback only.** `ComputerConnection.connect` and the WebSocket client both
  refuse a non-loopback host, and the client refuses anything but `ws://`. A
  remote browser must be tunnelled by the operator, which keeps the decision to
  expose it outside this app.
- **Closed action set.** `navigate` (http/https only), `click`, `type`, `key`
  (six named keys), `scroll`. Anything else — script evaluation as an action,
  shell, downloads, file URLs — is rejected by `actionCommands`, with tests.
- **Human-driven.** No bot, routine, or generation path can reach the adapter.
  Bots have no tool that calls it; the endpoints exist for the UI only. Giving
  a model the same reach is a separate decision and a separate contract.
- **Explicit disconnect.** Disconnect closes the socket and fails every request
  in flight. Connection state is process memory: a restart is disconnected.
- **No pretending.** A disconnected panel renders as disconnected, with the last
  real error if there was one. There is no placeholder screen and no cached
  screenshot presented as live.

## Endpoints

```text
GET  /api/computer             สถานะจริง (connected, target, lastError, scope)
POST /api/computer/connect     { devtools, targetID? }
POST /api/computer/action      { kind, ... }  ตามชุดที่อนุญาตเท่านั้น
GET  /api/computer/screenshot  PNG ของแท็บที่ต่ออยู่ (no-store)
GET  /api/computer/info        url/title/ขนาดหน้าต่างจริง
POST /api/computer/disconnect
```

## Known limitation

The bundled WebSocket client reports the `Sec-WebSocket-Accept` digest but does
not enforce it, because a DevTools endpoint behind a local proxy answers with
the proxy's digest. The loopback-only rule is what bounds this client; enforce
the digest before ever pointing it at a socket the operator did not tunnel.
