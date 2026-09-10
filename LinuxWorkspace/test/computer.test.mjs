import test from "node:test";
import assert from "node:assert/strict";
import { actionCommands, ComputerError, ComputerConnection, COMPUTER_ACTIONS } from "../src/computer.mjs";
import { encodeFrame, decodeFrames, handshakeAccept, openSocket } from "../src/wsclient.mjs";

test("the action set is closed and every action maps to explicit CDP calls", () => {
  assert.deepEqual(COMPUTER_ACTIONS, ["navigate", "click", "type", "key", "scroll"]);
  assert.deepEqual(actionCommands({ kind: "navigate", url: "https://example.org/" }),
    [{ method: "Page.navigate", params: { url: "https://example.org/" } }]);
  const click = actionCommands({ kind: "click", x: 10, y: 20 });
  assert.deepEqual(click.map((item) => item.params.type), ["mousePressed", "mouseReleased"]);
  assert.equal(actionCommands({ kind: "type", text: "สวัสดี" })[0].method, "Input.insertText");
  assert.deepEqual(actionCommands({ kind: "key", key: "Enter" }).map((item) => item.params.type), ["keyDown", "keyUp"]);
});

test("anything outside the allowed set is refused, including shell-shaped requests", () => {
  for (const action of [
    { kind: "evaluate", expression: "1" },
    { kind: "shell", command: "rm -rf /" },
    { kind: "download", url: "https://example.org/x" },
    { kind: "navigate", url: "file:///etc/passwd" },
    { kind: "key", key: "F12" },
    { kind: "click", x: "ที่ไหนก็ได้", y: 1 },
  ]) {
    assert.throws(() => actionCommands(action), ComputerError, `ต้องปฏิเสธ: ${action.kind}`);
  }
});

test("a fresh adapter reports disconnected and refuses to act", async () => {
  const computer = new ComputerConnection();
  const status = computer.status();
  assert.equal(status.connected, false);
  assert.equal(status.target, null);
  assert.ok(status.scope.includes("ไม่ใช่ทั้งเครื่อง"), "ต้องบอกขอบเขตตามจริง");
  assert.throws(() => computer.send("Page.navigate"), ComputerError);
});

test("connecting is refused unless the DevTools endpoint is tunnelled to loopback", async () => {
  const computer = new ComputerConnection();
  await assert.rejects(() => computer.connect("http://100.100.202.19:9224"), /tunnel/);
  await assert.rejects(() => openSocket("wss://example.org/socket"), /ws:/);
  await assert.rejects(() => openSocket("ws://example.org/socket"), /loopback/);
});

test("websocket frames survive a round trip, including a masked Thai payload", () => {
  const payload = JSON.stringify({ id: 1, method: "Page.navigate", params: { url: "https://ตัวอย่าง.th/" } });
  const { frames, rest } = decodeFrames(encodeFrame(payload));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload, payload);
  assert.equal(rest.length, 0);
  // A partial frame must be kept, not misread as a short message.
  const whole = encodeFrame(payload);
  const partial = decodeFrames(whole.subarray(0, whole.length - 5));
  assert.equal(partial.frames.length, 0);
  assert.equal(partial.rest.length, whole.length - 5);
  const long = decodeFrames(encodeFrame("x".repeat(70_000)));
  assert.equal(long.frames[0].payload.length, 70_000);
});

test("the handshake digest matches an independent sha1 implementation", () => {
  // Reference values produced with python hashlib, not with this module.
  assert.equal(handshakeAccept("x3JJHMbDL1EzLkh9GBhXDw=="), "NehNes/zC1C01D7vDzNM9XwJGTo=");
  assert.equal(handshakeAccept("dGhlIHNhbXBsZSBub25jZQ=="), "tF+4yo8PvjWV9zMFht911yVrKKY=");
});
