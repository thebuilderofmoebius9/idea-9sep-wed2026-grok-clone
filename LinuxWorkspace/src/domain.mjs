// Domain rules ported from Packages/WorkspaceCore/Sources/WorkspaceCore/Domain.swift.
// Validation limits, colors, shapes and error identities are kept identical on purpose.

export const AVATAR_SHAPES = ["circle", "square", "drop", "capsule"];
export const AVATAR_COLORS = ["green", "magenta", "gray", "violet", "blue", "orange"];
export const PROVIDER_KINDS = ["chatCompletions", "codexResponses"];

/// Local starter catalog. Installing a template only prefills a normal bot
/// creation, so every install is an independent bot with its own id, its own
/// conversation and no shared credential.
export const BOT_TEMPLATES = [
  {
    id: "assistant", name: "ผู้ช่วยทั่วไป", shape: "circle", color: "green",
    description: "ตอบสั้น ตรงคำถาม ถ้าไม่รู้ให้บอกว่าไม่รู้และเสนอสิ่งที่ต้องตรวจต่อ",
  },
  {
    id: "reviewer", name: "ผู้ตรวจโค้ด", shape: "square", color: "violet",
    description: "อ่าน diff แล้วชี้บั๊ก ความเสี่ยง และจุดที่ทำให้ง่ายกว่านี้ได้ อ้างบรรทัดที่เกี่ยวข้องเสมอ",
  },
  {
    id: "writer", name: "นักเขียน", shape: "drop", color: "magenta",
    description: "เรียบเรียงข้อความให้อ่านง่าย รักษาความหมายเดิม ไม่เติมข้อมูลที่ไม่มีในต้นฉบับ",
  },
  {
    id: "researcher", name: "นักค้นข้อมูล", shape: "capsule", color: "blue",
    description: "สรุปประเด็นเป็นข้อ ๆ แยกข้อเท็จจริงออกจากการตีความ และบอกสิ่งที่ยังไม่รู้",
  },
];
export const GENERATION_STATES = [
  "queued", "connecting", "streaming", "completed", "failed", "cancelled", "interrupted",
];
export const TERMINAL_STATES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const CODEX_CREDENTIAL_PREFIX = "codex-session:";

const MESSAGES = {
  invalidName: "ใช้ชื่อความยาว 1 ถึง 80 ตัวอักษร",
  invalidDescription: "คำอธิบายยาวได้ไม่เกิน 8,000 ตัวอักษร",
  invalidMembers: "เลือกบอทที่ใช้งานได้ 2 ถึง 6 ตัว และห้ามซ้ำ",
  invalidAvatar: "เลือกสีอวาตารจากรายการที่รองรับ",
  invalidRoutine: "ตรวจ prompt, ช่วงเวลา, เวลาท้องถิ่น และไทม์โซนของ routine",
  invalidProvider: "ต้องใช้ API root แบบ HTTPS, model และ credential reference ที่ถูกต้อง",
  invalidDraft: "ฉบับร่างว่าง หรืออ้างถึงเนื้อหาที่ใช้ไม่ได้",
  missingRecord: "ไม่พบรายการนี้ในเวิร์กสเปซแล้ว",
  identityConflict: "identity นี้ถูกใช้โดยรายการอื่นแล้ว",
  staleRevision: "เวิร์กสเปซถูกแก้ไปแล้ว รีเฟรชก่อนลองใหม่",
  editConflict: "โปรไฟล์นี้เปลี่ยนไปแล้ว ตรวจค่าล่าสุดก่อนบันทึกอีกครั้ง",
  invalidPage: "ขนาดหน้าต้องอยู่ระหว่าง 1 ถึง 500",
  storeUnavailable: "บันทึกเวิร์กสเปซไม่ได้ ตรวจพื้นที่ดิสก์และสิทธิ์",
  invalidStore: "อ่านเวิร์กสเปซไม่ได้ ข้อมูลเดิมยังไม่ถูกลบ",
  unsupportedSchema: "เวิร์กสเปซเวอร์ชันนี้ไม่รองรับ ข้อมูลเดิมยังไม่ถูกลบ",
  confirmationChanged: "รายการที่จะถูกลบเปลี่ยนไปแล้ว ตรวจอีกครั้งก่อนลบ",
  activeWork: "รอให้การตอบที่เกี่ยวข้องหยุดก่อนลบบอทนี้",
};

export class WorkspaceError extends Error {
  constructor(code) {
    super(MESSAGES[code] ?? code);
    this.name = "WorkspaceError";
    this.code = code;
  }
}
export const fail = (code) => { throw new WorkspaceError(code); };

export function uuid() {
  // Node 18+ exposes webcrypto globally; keep a dependency-free fallback for older hosts.
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const isUUID = (value) =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export function validName(value) {
  const clean = String(value ?? "").trim();
  // Count graphemes as code points so an emoji name is not rejected by UTF-16 length.
  const length = [...clean].length;
  if (length < 1 || length > 80) fail("invalidName");
  return clean;
}

export function validBotProfile(profile) {
  const name = validName(profile?.name);
  const description = String(profile?.description ?? "");
  if ([...description].length > 8000) fail("invalidDescription");
  const color = profile?.color ?? "green";
  const shape = profile?.shape ?? "circle";
  if (!AVATAR_COLORS.includes(color)) fail("invalidAvatar");
  if (!AVATAR_SHAPES.includes(shape)) fail("invalidAvatar");
  return { name, description, color, shape };
}

export function validGroupProfile(profile, availableBotIDs) {
  const title = validName(profile?.title);
  const members = Array.isArray(profile?.memberBotIDs) ? [...profile.memberBotIDs] : [];
  if (members.length < 2 || members.length > 6) fail("invalidMembers");
  if (new Set(members).size !== members.length) fail("invalidMembers");
  if (availableBotIDs && members.some((id) => !availableBotIDs.has(id))) fail("invalidMembers");
  return { title, memberBotIDs: members };
}

export function validRoutine(routine) {
  const name = validName(routine?.name);
  const prompt = String(routine?.prompt ?? "");
  if (!prompt.trim() || prompt.length > 32000) fail("invalidRoutine");
  if (!isValidTimezone(routine?.timezoneID)) fail("invalidRoutine");
  const trigger = validTrigger(routine?.trigger);
  return { ...routine, name, prompt, trigger, timezoneID: routine.timezoneID };
}

export function validTrigger(trigger) {
  if (trigger?.type === "interval") {
    const minutes = Number(trigger.minutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 525600) fail("invalidRoutine");
    return { type: "interval", minutes };
  }
  if (trigger?.type === "daily") {
    const hour = Number(trigger.hour);
    const minute = Number(trigger.minute);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) fail("invalidRoutine");
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) fail("invalidRoutine");
    return { type: "daily", hour, minute };
  }
  return fail("invalidRoutine");
}

export function isValidTimezone(id) {
  if (typeof id !== "string" || !id) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: id });
    return true;
  } catch {
    return false;
  }
}

export const isCodexReference = (reference) =>
  typeof reference === "string" && reference.startsWith(CODEX_CREDENTIAL_PREFIX);
export const makeCodexReference = () => `${CODEX_CREDENTIAL_PREFIX}${uuid()}`;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function validProvider(config) {
  const name = validName(config?.name);
  const kind = config?.kind ?? "chatCompletions";
  if (!PROVIDER_KINDS.includes(kind)) fail("invalidProvider");
  const allowsLoopbackHTTP = Boolean(config?.allowsLoopbackHTTP);
  let url;
  try {
    url = new URL(String(config?.apiRoot ?? ""));
  } catch {
    return fail("invalidProvider");
  }
  const host = url.hostname.toLowerCase();
  // Reject embedded credentials, queries and fragments exactly like the Swift validator.
  if (!host || url.username || url.password || url.search || url.hash) fail("invalidProvider");
  const httpsOk = url.protocol === "https:";
  const loopbackOk = url.protocol === "http:" && allowsLoopbackHTTP && LOOPBACK_HOSTS.has(host);
  if (!httpsOk && !loopbackOk) fail("invalidProvider");
  const modelID = String(config?.modelID ?? "");
  if (!modelID.trim()) fail("invalidProvider");
  const credentialReference = String(config?.credentialReference ?? "");
  if (credentialReference.length < 1 || credentialReference.length > 200) fail("invalidProvider");
  if (kind === "chatCompletions" && isCodexReference(credentialReference)) fail("invalidProvider");
  if (kind === "codexResponses" && !isCodexReference(credentialReference)) fail("invalidProvider");
  return {
    id: config.id ?? uuid(),
    name,
    apiRoot: url.toString().replace(/\/$/, ""),
    modelID: modelID.trim(),
    credentialReference,
    allowsLoopbackHTTP,
    kind,
  };
}

export function newBot(input = {}) {
  const profile = validBotProfile(input);
  return {
    id: input.id ?? uuid(),
    ...profile,
    createdAt: input.createdAt ?? new Date().toISOString(),
    hiddenAt: input.hiddenAt ?? null,
    providerConfigID: input.providerConfigID ?? null,
  };
}

export function newConversation({ id, kind, title, memberBotIDs, createdAt } = {}) {
  return {
    id: id ?? uuid(),
    kind: kind === "group" ? "group" : "direct",
    title: validName(title),
    memberBotIDs: [...(memberBotIDs ?? [])],
    createdAt: createdAt ?? new Date().toISOString(),
    lastReadSequence: 0,
    nextSequence: 1,
  };
}

/// Previews are capped at 160 graphemes to match the native sidebar contract.
export function previewText(message) {
  if (!message) return null;
  const text = String(message.text ?? "");
  if (!text.trim() && message.attachmentIDs?.length) return "ไฟล์แนบ";
  const graphemes = [...text.replace(/\s+/g, " ").trim()];
  return graphemes.length > 160 ? `${graphemes.slice(0, 160).join("")}…` : graphemes.join("");
}

export const utf8ByteCount = (text) => Buffer.byteLength(String(text ?? ""), "utf8");
