// Computer adapter: a real, explicitly connected browser session over a
// tunnelled Chrome DevTools socket. It reports honest connection state and
// refuses to pretend — a disconnected panel stays disconnected.
//
// Boundary (docs/COMPUTER-ADAPTER.md): human-driven only. Bots have no tool
// that reaches this module, and the action set is closed: navigate, click,
// type, key, scroll, screenshot. No shell, no file system, no downloads.

import { openSocket } from "./wsclient.mjs";

export const COMPUTER_ACTIONS = ["navigate", "click", "type", "key", "scroll"];

export class ComputerError extends Error {
  constructor(message) { super(message); this.name = "ComputerError"; }
}

const fetchJSON = async (url, timeout = 5_000) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!response.ok) throw new ComputerError(`DevTools ตอบ HTTP ${response.status}`);
  return response.json();
};

/// Maps one action to the CDP calls it needs. Pure, so the mapping is testable
/// without a browser.
export function actionCommands(action) {
  switch (action.kind) {
    case "navigate": {
      const url = new URL(String(action.url));
      if (!["http:", "https:"].includes(url.protocol)) throw new ComputerError("เปิดได้เฉพาะ http/https");
      return [{ method: "Page.navigate", params: { url: url.toString() } }];
    }
    case "click": {
      const x = Number(action.x); const y = Number(action.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ComputerError("พิกัดคลิกไม่ถูกต้อง");
      const base = { x, y, button: "left", clickCount: 1 };
      return [
        { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", ...base } },
        { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", ...base } },
      ];
    }
    case "type": {
      const text = String(action.text ?? "");
      if (!text || text.length > 4_000) throw new ComputerError("ข้อความที่พิมพ์ว่างหรือยาวเกินไป");
      return [{ method: "Input.insertText", params: { text } }];
    }
    case "key": {
      const keys = {
        Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
        Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
        Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
        Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
        ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
        ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
      };
      const key = keys[action.key];
      if (!key) throw new ComputerError("ปุ่มนี้ไม่อยู่ในรายการที่อนุญาต");
      return [
        { method: "Input.dispatchKeyEvent", params: { type: "keyDown", ...key } },
        { method: "Input.dispatchKeyEvent", params: { type: "keyUp", ...key } },
      ];
    }
    case "scroll": {
      const delta = Number(action.deltaY ?? 0);
      if (!Number.isFinite(delta)) throw new ComputerError("ระยะเลื่อนไม่ถูกต้อง");
      return [{
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: Number(action.x ?? 10), y: Number(action.y ?? 10), deltaX: 0, deltaY: delta },
      }];
    }
    default:
      throw new ComputerError("คำสั่งนี้ไม่อยู่ในชุดที่อนุญาต");
  }
}

export class ComputerConnection {
  #socket = null;
  #pending = new Map();
  #nextID = 1;
  #target = null;
  #connectedAt = null;
  #lastError = null;

  status() {
    return {
      connected: Boolean(this.#socket) && !this.#socket.destroyed,
      target: this.#target,
      connectedAt: this.#connectedAt,
      lastError: this.#lastError,
      actions: COMPUTER_ACTIONS,
      // Never claim more reach than the adapter has.
      scope: "เบราว์เซอร์ที่เปิด DevTools ไว้เท่านั้น ไม่ใช่ทั้งเครื่อง",
    };
  }

  /// `devtools` is the HTTP root of a tunnelled DevTools endpoint, e.g.
  /// http://127.0.0.1:9224. The page target is chosen explicitly, never guessed
  /// from a browser-wide socket that could touch other windows.
  async connect(devtools, { targetID = null } = {}) {
    await this.disconnect();
    const root = new URL(devtools);
    if (!["127.0.0.1", "localhost"].includes(root.hostname)) {
      throw new ComputerError("ต้องต่อผ่าน tunnel มาที่ 127.0.0.1 ของเครื่องนี้");
    }
    const targets = (await fetchJSON(new URL("/json/list", root))).filter((item) => item.type === "page");
    const page = targetID ? targets.find((item) => item.id === targetID) : targets[0];
    if (!page) throw new ComputerError("ไม่พบแท็บที่เชื่อมต่อได้");
    this.#socket = await openSocket(page.webSocketDebuggerUrl, {
      onMessage: (text) => this.#receive(text),
      onClose: () => { this.#socket = null; this.#connectedAt = null; },
    });
    this.#target = { id: page.id, title: page.title, url: page.url, devtools: root.origin };
    this.#connectedAt = new Date().toISOString();
    this.#lastError = null;
    await this.send("Page.enable");
    return this.status();
  }

  async disconnect() {
    this.#socket?.close();
    this.#socket = null;
    this.#connectedAt = null;
    for (const [, pending] of this.#pending) pending.reject(new ComputerError("ตัดการเชื่อมต่อแล้ว"));
    this.#pending.clear();
    return this.status();
  }

  #receive(text) {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    const pending = this.#pending.get(message.id);
    if (!pending) return; // an event, not a reply
    this.#pending.delete(message.id);
    if (message.error) pending.reject(new ComputerError(message.error.message ?? "DevTools ปฏิเสธคำสั่ง"));
    else pending.resolve(message.result);
  }

  send(method, params = {}, timeout = 20_000) {
    if (!this.#socket || this.#socket.destroyed) throw new ComputerError("ยังไม่ได้เชื่อมต่อคอมพิวเตอร์");
    const id = this.#nextID++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new ComputerError("คอมพิวเตอร์ไม่ตอบภายในเวลาที่กำหนด"));
      }, timeout);
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); this.#lastError = error.message; reject(error); },
      });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async act(action) {
    const commands = actionCommands(action);
    for (const command of commands) await this.send(command.method, command.params);
    return this.status();
  }

  async screenshot() {
    const result = await this.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(result.data, "base64");
  }

  async info() {
    const result = await this.send("Runtime.evaluate", {
      expression: "JSON.stringify({url: location.href, title: document.title, width: innerWidth, height: innerHeight})",
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  }
}
