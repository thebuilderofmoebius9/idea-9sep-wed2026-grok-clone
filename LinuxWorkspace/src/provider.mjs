// Streaming chat provider, ported from ChatProvider/ChatCompletionsProvider/ChatSSEParser.swift.
// Credentials are supplied per request by the caller and are never written to the workspace.

export const PROVIDER_PRESETS = [
  {
    id: "custom",
    name: "Custom compatible endpoint",
    apiRoot: "https://api.example.com/v1",
    suggestedModel: "",
    guidance: "ใช้ endpoint แบบ OpenAI-compatible ที่มีเอกสารรองรับ พร้อม API key ของตัวเอง",
  },
  {
    id: "openAI",
    name: "OpenAI Platform",
    apiRoot: "https://api.openai.com/v1",
    suggestedModel: "",
    guidance: "ต้องใช้ API key ของ OpenAI Platform และมี API billing ไม่ใช่ ChatGPT subscription หรือ auth.json",
  },
  {
    id: "zai",
    name: "Z.ai general API",
    apiRoot: "https://api.z.ai/api/paas/v4",
    suggestedModel: "glm-5.3",
    guidance: "ใช้ billing และ API key ของ Z.ai แอปนี้ไม่ได้ใช้โควต้า Coding Plan และยังไม่ได้ยืนยันสิทธิ์บัญชี",
  },
  {
    id: "nineRouter",
    name: "9router local gateway",
    apiRoot: "http://127.0.0.1:20128/v1",
    suggestedModel: "",
    guidance: "เปิด 9router เองแยก ใส่ router API key ไม่ใช่คีย์ต้นทาง และต้องติ๊กอนุญาต loopback HTTP",
  },
];

export const PROVIDER_ERRORS = {
  invalidCredential: "credential ไม่ถูกต้องหรือว่าง",
  invalidResponse: "ผู้ให้บริการตอบกลับในรูปแบบที่อ่านไม่ได้",
  timedOut: "ผู้ให้บริการไม่ตอบภายในเวลาที่กำหนด",
  cancelled: "ถูกยกเลิก",
  redirectRefused: "ปฏิเสธการ redirect เพื่อไม่ให้ credential รั่วไปโฮสต์อื่น",
  codexLoginRequired: "ต้องเข้าสู่ระบบ Codex ใหม่",
  offline: "เชื่อมต่อผู้ให้บริการไม่ได้",
};

export class ProviderError extends Error {
  constructor(code, status) {
    super(status ? `HTTP ${status}` : (PROVIDER_ERRORS[code] ?? code));
    this.name = "ProviderError";
    this.code = code;
    this.status = status;
  }
}

/// Bounded SSE parser: one `data:` payload per event, `[DONE]` terminates the stream.
export class ChatSSEParser {
  constructor({ maxEventBytes = 1_048_576 } = {}) {
    this.buffer = "";
    this.maxEventBytes = maxEventBytes;
    this.done = false;
  }

  append(chunk) {
    if (this.done) return [];
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > this.maxEventBytes) {
      throw new ProviderError("invalidResponse");
    }
    const events = [];
    let separator = this.buffer.search(/\r?\n\r?\n/);
    while (separator !== -1) {
      const match = /\r?\n\r?\n/.exec(this.buffer.slice(separator));
      const block = this.buffer.slice(0, separator);
      this.buffer = this.buffer.slice(separator + match[0].length);
      for (const event of this.#block(block)) {
        events.push(event);
        if (event.kind === "finished") { this.done = true; return events; }
      }
      separator = this.buffer.search(/\r?\n\r?\n/);
    }
    return events;
  }

  finish() {
    if (this.done) return [];
    const events = this.buffer.trim() ? this.#block(this.buffer) : [];
    this.buffer = "";
    this.done = true;
    if (!events.some((event) => event.kind === "finished")) events.push({ kind: "finished" });
    return events;
  }

  #block(block) {
    const events = [];
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!payload) return events;
    if (payload === "[DONE]") return [{ kind: "finished" }];
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new ProviderError("invalidResponse");
    }
    if (json.error) {
      throw new ProviderError("invalidResponse");
    }
    // Chat Completions delta, plus the Codex/Responses output_text form.
    const delta = json.choices?.[0]?.delta?.content
      ?? (json.type === "response.output_text.delta" ? json.delta : undefined);
    if (typeof delta === "string" && delta.length > 0) events.push({ kind: "delta", text: delta });
    const finish = json.choices?.[0]?.finish_reason;
    if (finish || json.type === "response.completed") events.push({ kind: "finished" });
    return events;
  }
}

export const chatCompletionsURL = (provider) => {
  const root = String(provider.apiRoot).replace(/\/$/, "");
  return provider.kind === "codexResponses" ? `${root}/responses` : `${root}/chat/completions`;
};

/**
 * Streams one reply. `onEvent` receives { kind: "started" | "delta" | "finished" }.
 * Redirects are refused outright rather than risk forwarding the credential.
 */
export async function streamChat({ provider, credential, turns, signal, onEvent, timeouts = {} }) {
  const firstEvent = timeouts.firstEvent ?? 30_000;
  const idle = timeouts.idle ?? 60_000;
  const total = timeouts.total ?? 300_000;
  if (typeof credential !== "string" || !credential || credential.length > 16_384
    || /[\n\r\0]/.test(credential)) {
    throw new ProviderError("invalidCredential");
  }
  if (!Array.isArray(turns) || turns.length === 0
    || !turns.every((turn) => ["system", "user", "assistant"].includes(turn.role))) {
    throw new ProviderError("invalidResponse");
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const totalTimer = setTimeout(() => controller.abort("timedOut"), total);
  let eventTimer = setTimeout(() => controller.abort("timedOut"), firstEvent);
  const armIdle = () => {
    clearTimeout(eventTimer);
    eventTimer = setTimeout(() => controller.abort("timedOut"), idle);
  };
  const cleanup = () => {
    clearTimeout(totalTimer);
    clearTimeout(eventTimer);
    signal?.removeEventListener("abort", abort);
  };

  const body = provider.kind === "codexResponses"
    ? { model: provider.modelID, input: turns.map((turn) => ({ role: turn.role, content: turn.content })), stream: true }
    : { model: provider.modelID, messages: turns, stream: true, n: 1 };

  let response;
  try {
    response = await fetch(chatCompletionsURL(provider), {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    cleanup();
    if (controller.signal.aborted) {
      throw new ProviderError(controller.signal.reason === "timedOut" ? "timedOut" : "cancelled");
    }
    throw new ProviderError("offline");
  }

  try {
    if (response.status >= 300 && response.status < 400) throw new ProviderError("redirectRefused");
    if (!response.ok) {
      if (provider.kind === "codexResponses" && [401, 403].includes(response.status)) {
        throw new ProviderError("codexLoginRequired");
      }
      throw new ProviderError("http", response.status);
    }
    const mime = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const missingCodexMIME = provider.kind === "codexResponses" && !response.headers.get("content-type");
    if (mime !== "text/event-stream" && !missingCodexMIME) throw new ProviderError("invalidResponse");

    onEvent?.({ kind: "started" });
    const parser = new ChatSSEParser();
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of response.body) {
      armIdle();
      for (const event of parser.append(decoder.decode(chunk, { stream: true }))) {
        if (event.kind === "delta") text += event.text;
        onEvent?.(event);
        if (event.kind === "finished") return text;
      }
    }
    for (const event of parser.finish()) {
      if (event.kind === "delta") text += event.text;
      onEvent?.(event);
    }
    return text;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (controller.signal.aborted) {
      throw new ProviderError(controller.signal.reason === "timedOut" ? "timedOut" : "cancelled");
    }
    throw new ProviderError("offline");
  } finally {
    cleanup();
  }
}

/// Session-only credential store. Values live in this process and are never persisted.
export class SessionCredentialStore {
  #values = new Map();
  set(reference, value) {
    if (!reference || typeof value !== "string" || !value) throw new ProviderError("invalidCredential");
    this.#values.set(reference, value);
  }
  get(reference) { return this.#values.get(reference); }
  has(reference) { return this.#values.has(reference); }
  remove(reference) { this.#values.delete(reference); }
  /// Only the references are ever reportable; values stay inside this object.
  references() { return [...this.#values.keys()]; }
}
