// Group draft mention routing, ported from docs/GROUP-MENTIONS.md and GroupMentions.swift.
// The parser only ever sees the current group user draft: never transcripts or assistant output.

import { isUUID } from "./domain.mjs";

// Combining marks count as name characters: Thai vowels and tone marks are separate code
// points even in NFC, so leaving \p{M} out would truncate every Thai bare-name mention.
const NAME_CHAR = /[\p{L}\p{N}\p{M}_-]/u;
// A mention may only start at the beginning, after whitespace, or after opening/separator
// punctuation. A letter or digit before "@" is what keeps bare email local-parts literal.
const BOUNDARY_BEFORE = /[\s([{<,;:!?/|"'‘’“”–—]/u;

export const MENTION_ERRORS = {
  malformed: "รูปแบบ mention ไม่ถูกต้อง แก้ให้ครบก่อนส่ง",
  unknown: "ไม่พบสมาชิกชื่อนี้ในกลุ่ม",
  ambiguous: "ชื่อนี้ซ้ำกันในกลุ่ม เลือกด้วยเมนู Mention เพื่อระบุตัวตน",
  stale: "mention นี้อ้างสมาชิกที่ถูกลบหรือเปลี่ยนชื่อแล้ว ใส่ใหม่ด้วยเมนู Mention",
  tooMany: "ส่งได้ 1 ถึง 6 สมาชิกต่อหนึ่งรอบ",
};

/// Ranges that are routing exclusions rather than recipient instructions.
export function excludedRanges(text) {
  const ranges = [];
  const push = (start, end) => { if (end > start) ranges.push([start, end]); };

  // Fenced code blocks: line boundary, up to three leading spaces, >=3 backticks or tildes,
  // closed by the same marker at least as long followed only by spaces or tabs.
  let index = 0;
  let openFence = null;
  while (index <= text.length) {
    let lineEnd = text.indexOf("\n", index);
    if (lineEnd === -1) lineEnd = text.length;
    const line = text.slice(index, lineEnd);
    const fence = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/.exec(line);
    if (openFence) {
      const close = fence
        && fence[1][0] === openFence.marker
        && fence[1].length >= openFence.length
        && /^[ \t]*$/.test(fence[2]);
      if (close) {
        push(openFence.start, lineEnd);
        openFence = null;
      }
    } else if (fence) {
      openFence = { start: index, marker: fence[1][0], length: fence[1].length };
    }
    if (lineEnd === text.length) break;
    index = lineEnd + 1;
  }
  // An unclosed fence extends to the end of the draft.
  if (openFence) push(openFence.start, text.length);

  const inFence = (position) => ranges.some(([start, end]) => position >= start && position < end);

  // Inline code spans: delimiter runs match only equal run lengths, never across a fence.
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== "`" || inFence(cursor)) { cursor += 1; continue; }
    let run = 0;
    while (text[cursor + run] === "`") run += 1;
    let scan = cursor + run;
    let closed = -1;
    while (scan < text.length) {
      if (text[scan] !== "`") { scan += 1; continue; }
      if (inFence(scan)) break;
      let closeRun = 0;
      while (text[scan + closeRun] === "`") closeRun += 1;
      if (closeRun === run) { closed = scan + closeRun; break; }
      scan += closeRun;
    }
    // An unmatched inline run stays literal text.
    if (closed === -1) { cursor += run; continue; }
    push(cursor, closed);
    cursor = closed;
  }

  // URL spans and email addresses are not recipient instructions.
  for (const pattern of [
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/giu,
    /\bwww\.[^\s<>"']+/giu,
    /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/giu,
  ]) {
    for (const match of text.matchAll(pattern)) {
      if (!inFence(match.index)) push(match.index, match.index + match[0].length);
    }
  }
  return ranges.sort((left, right) => left[0] - right[0]);
}

const inside = (ranges, position) =>
  ranges.some(([start, end]) => position >= start && position < end);

/// Reads a JSON-quoted name starting at the opening quote. Returns null when malformed.
function readQuotedName(text, start) {
  let cursor = start + 1;
  let value = "";
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "\\") {
      const escaped = text[cursor + 1];
      if (escaped === undefined) return null;
      const simple = { '"': '"', "\\": "\\", "/": "/", n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" };
      if (escaped in simple) { value += simple[escaped]; cursor += 2; continue; }
      if (escaped === "u") {
        const hex = text.slice(cursor + 2, cursor + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
        value += String.fromCharCode(parseInt(hex, 16));
        cursor += 6;
        continue;
      }
      return null;
    }
    if (character === '"') return { value, end: cursor + 1 };
    if (character === "\n") return null;
    value += character;
    cursor += 1;
  }
  return null;
}

/**
 * Resolves every mention in a raw group draft.
 * Returns { hasMentions, ordered, readableText } or throws a routing error object.
 */
export function resolveMentions(rawDraft, members) {
  const text = String(rawDraft ?? "").normalize("NFC");
  const ranges = excludedRanges(text);
  const byName = new Map();
  for (const member of members) {
    const name = String(member.name).normalize("NFC");
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(member);
  }
  const byID = new Map(members.map((member) => [member.id, member]));

  const ordered = [];
  const seen = new Set();
  let readable = "";
  let cursor = 0;
  let recognized = 0;

  const boundaryOK = (position) =>
    position === 0 || BOUNDARY_BEFORE.test(text[position - 1]);

  while (cursor < text.length) {
    const character = text[cursor];

    // Routing escape: a literal "@" that must not be read as a recipient.
    if (character === "\\" && text[cursor + 1] === "@" && !inside(ranges, cursor) && boundaryOK(cursor)) {
      readable += "@";
      cursor += 2;
      continue;
    }
    if (character !== "@" || inside(ranges, cursor) || !boundaryOK(cursor)) {
      readable += character;
      cursor += 1;
      continue;
    }

    // A candidate mention: either a JSON-quoted name or a bare name.
    let name = null;
    let nameEnd = cursor + 1;
    let quoted = false;
    if (text[cursor + 1] === '"') {
      const parsed = readQuotedName(text, cursor + 1);
      // A quote directly after "@" is a recognized mention attempt; malformed blocks the send.
      if (!parsed) throw { code: "malformed", message: MENTION_ERRORS.malformed, at: cursor };
      name = parsed.value;
      nameEnd = parsed.end;
      quoted = true;
    } else {
      let scan = cursor + 1;
      while (scan < text.length && NAME_CHAR.test(text[scan])) scan += 1;
      if (scan === cursor + 1) { readable += character; cursor += 1; continue; }
      name = text.slice(cursor + 1, scan);
      nameEnd = scan;
    }

    recognized += 1;
    let binding = null;
    let end = nameEnd;
    if (text[nameEnd] === "{") {
      const close = text.indexOf("}", nameEnd);
      const candidate = close === -1 ? null : text.slice(nameEnd + 1, close);
      if (!candidate || !isUUID(candidate)) {
        throw { code: "malformed", message: MENTION_ERRORS.malformed, at: cursor };
      }
      binding = candidate;
      end = close + 1;
    }

    let member = null;
    if (binding) {
      const bound = byID.get(binding);
      // A removed member or renamed binding is stale, never silently redirected.
      if (!bound || String(bound.name).normalize("NFC") !== name.normalize("NFC")) {
        throw { code: "stale", message: MENTION_ERRORS.stale, at: cursor };
      }
      member = bound;
    } else {
      const candidates = byName.get(name.normalize("NFC")) ?? [];
      if (candidates.length === 0) throw { code: "unknown", message: MENTION_ERRORS.unknown, at: cursor, name };
      if (candidates.length > 1) throw { code: "ambiguous", message: MENTION_ERRORS.ambiguous, at: cursor, name };
      member = candidates[0];
    }

    // First occurrence sets reply order; repeating a member does not add a request.
    if (!seen.has(member.id)) {
      seen.add(member.id);
      ordered.push({ id: member.id, name: member.name });
    }
    // Valid local bindings never enter the stored transcript; the readable spelling stays.
    readable += quoted ? `@"${name}"` : `@${name}`;
    cursor = end;
  }

  if (recognized === 0) return { hasMentions: false, ordered: [], readableText: readable };
  if (ordered.length > 6) throw { code: "tooMany", message: MENTION_ERRORS.tooMany };
  return { hasMentions: true, ordered, readableText: readable };
}

/// The exact plain text the picker inserts. Deliberately visible in the draft.
export const mentionToken = (member) => `@"${String(member.name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"{${member.id}}`;

/// Duplicate names get a distinguishing identity prefix in menus and confirmation.
export function displayNames(members) {
  const counts = new Map();
  for (const member of members) counts.set(member.name, (counts.get(member.name) ?? 0) + 1);
  return members.map((member) => ({
    ...member,
    display: counts.get(member.name) > 1 ? `${member.name} · ${member.id.slice(0, 8)}` : member.name,
  }));
}
