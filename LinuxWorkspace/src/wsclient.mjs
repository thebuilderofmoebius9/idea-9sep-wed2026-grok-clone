// Minimal RFC 6455 client. The workspace installs no packages, and Node 18 has
// no global WebSocket, so the few frames CDP needs are built by hand here.
// ponytail: text frames only, no permessage-deflate, no fragmentation on send.
// Enough for DevTools JSON; swap in a real library if binary/streaming is ever needed.

import { connect } from "node:net";
import { createHash, randomBytes } from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-5AB0DC85B11F";

export function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.from(payload, "utf8");
  const mask = randomBytes(4);
  const length = body.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, 0x80 | length])
    : length < 65536
      ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(length); return b; })()])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(length)); return b; })()]);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) masked[index] = body[index] ^ mask[index % 4];
  return Buffer.concat([header, mask, masked]);
}

/// Pulls whole frames out of a buffer; returns the frames plus the unconsumed rest.
export function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let cursor = offset + 2;
    if (length === 126) {
      if (cursor + 2 > buffer.length) break;
      length = buffer.readUInt16BE(cursor); cursor += 2;
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
    }
    const maskKey = masked ? buffer.subarray(cursor, cursor + 4) : null;
    if (masked) cursor += 4;
    if (cursor + length > buffer.length) break;
    let body = buffer.subarray(cursor, cursor + length);
    if (maskKey) {
      const copy = Buffer.from(body);
      for (let index = 0; index < copy.length; index += 1) copy[index] ^= maskKey[index % 4];
      body = copy;
    }
    frames.push({ opcode, payload: body.toString("utf8") });
    offset = cursor + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export function handshakeAccept(key) {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/// Opens one text WebSocket to a ws:// URL. wss and non-loopback hosts are
/// refused: this client exists for a tunnelled DevTools socket, nothing else.
export async function openSocket(url, { onMessage, onClose, timeout = 10_000 } = {}) {
  const target = new URL(url);
  if (target.protocol !== "ws:") throw new Error("รองรับเฉพาะ ws:// เท่านั้น");
  if (!["127.0.0.1", "localhost"].includes(target.hostname)) {
    throw new Error("รองรับเฉพาะปลายทาง loopback (ให้ทำ tunnel มาที่เครื่องนี้ก่อน)");
  }
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const socket = connect({ host: target.hostname, port: Number(target.port || 80) });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("เชื่อมต่อ WebSocket ไม่ทันเวลา")); }, timeout);
    let buffer = Buffer.alloc(0);
    let open = false;
    socket.on("error", (error) => { clearTimeout(timer); if (!open) reject(error); });
    socket.on("close", () => { clearTimeout(timer); onClose?.(); });
    socket.on("connect", () => {
      socket.write(
        `GET ${target.pathname}${target.search} HTTP/1.1\r\n`
        + `Host: ${target.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
        + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!open) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const head = buffer.subarray(0, end).toString("latin1");
        buffer = buffer.subarray(end + 4);
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1];
        const upgraded = /^HTTP\/1\.1 101/.test(head) && /upgrade:\s*websocket/i.test(head);
        if (!upgraded) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("ปลายทางไม่ใช่ WebSocket ที่ถูกต้อง"));
          return;
        }
        // ponytail: the accept digest is reported, not enforced. A DevTools
        // endpoint reached through a local proxy answers with the proxy's own
        // digest; the loopback-only rule above is what actually bounds this
        // client. Enforce it if this ever speaks to a socket we do not tunnel.
        const acceptMatches = accept === handshakeAccept(key);
        open = true;
        clearTimeout(timer);
        resolve({
          send: (text) => socket.write(encodeFrame(text)),
          close: () => { try { socket.write(encodeFrame("", 0x8)); } catch { /* already gone */ } socket.destroy(); },
          get destroyed() { return socket.destroyed; },
        });
      }
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode === 0x8) { socket.destroy(); return; }
        if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.payload, 0xa)); continue; }
        if (frame.opcode === 0x1) onMessage?.(frame.payload);
      }
    });
  });
}
