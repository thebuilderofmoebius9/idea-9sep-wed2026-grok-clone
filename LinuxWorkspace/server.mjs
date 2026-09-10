// Local-only HTTP surface for the Linux workspace. Bound to 127.0.0.1 and dependency-free.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkspaceStore, defaultStoreDirectory } from "./src/store.mjs";
import { SessionCredentialStore, PROVIDER_PRESETS } from "./src/provider.mjs";
import { Engine } from "./src/engine.mjs";
import { resolveMentions, displayNames, mentionToken } from "./src/mentions.mjs";
import { nextRun } from "./src/routines.mjs";
import { uuid, BOT_TEMPLATES } from "./src/domain.mjs";

const root = fileURLToPath(new URL("./public/", import.meta.url));
const port = Number(process.env.PORT ?? 4173);
const types = {
  ".css": "text/css", ".html": "text/html", ".js": "text/javascript",
  ".svg": "image/svg+xml", ".json": "application/json",
};

const store = new WorkspaceStore({ directory: process.env.BOTWORKSPACE_HOME ?? defaultStoreDirectory() });
const credentials = new SessionCredentialStore();
const engine = new Engine(store, credentials);
engine.startScheduler();

/// Review plans live only in this process: a confirmation can never be replayed after a restart.
const reviews = new Map();

const json = (response, status, body) => {
  const payload = JSON.stringify(body);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(payload);
};

const readBody = (request, limit = 32 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(new Error("payload ใหญ่เกินกำหนด")); request.destroy(); return; }
    chunks.push(chunk);
  });
  request.on("end", () => resolve(Buffer.concat(chunks)));
  request.on("error", reject);
});

const readJSON = async (request) => {
  const body = await readBody(request);
  if (!body.length) return {};
  try { return JSON.parse(body.toString("utf8")); } catch { throw new Error("JSON ไม่ถูกต้อง"); }
};

const members = (conversation) => conversation.memberBotIDs
  .map((id) => store.bot(id)).filter(Boolean).map((bot) => ({ id: bot.id, name: bot.name }));

/** Resolves recipients and returns the review plan the user must confirm before anything is sent. */
function buildReview(input) {
  const { conversationID, replyToID, attachmentIDs, manualTargets } = input;
  const rawText = String(input.text ?? "");
  let text = rawText;
  const conversation = store.conversation(conversationID);
  if (!conversation) throw Object.assign(new Error("ไม่พบบทสนทนา"), { status: 404 });
  const available = members(conversation);
  let ordered;
  let source = "manual";
  if (conversation.kind === "group") {
    const resolved = resolveMentions(text, available);
    if (resolved.hasMentions) {
      // Mentions replace manual recipients and the preview becomes read-only.
      ordered = resolved.ordered;
      source = "mention";
      text = resolved.readableText;
    } else {
      const selected = (manualTargets ?? []).filter((id) => available.some((member) => member.id === id));
      if (selected.length === 0) throw Object.assign(new Error("เลือกผู้รับอย่างน้อยหนึ่งคน"), { status: 400 });
      ordered = selected.map((id) => available.find((member) => member.id === id));
    }
  } else {
    ordered = available.slice(0, 1);
    if (ordered.length === 0) throw Object.assign(new Error("บทสนทนานี้ไม่มีบอท"), { status: 400 });
  }

  const labelled = displayNames(available);
  const plan = {
    id: uuid(),
    conversationID,
    source,
    readableText: text,
    rawText,
    replyToID: replyToID ?? null,
    attachmentIDs: attachmentIDs ?? [],
    revision: store.revision,
    recipients: ordered.map((member, index) => ({
      index,
      id: member.id,
      name: member.name,
      display: labelled.find((item) => item.id === member.id)?.display ?? member.name,
      provider: (() => {
        const bot = store.bot(member.id);
        const provider = bot?.providerConfigID ? store.provider(bot.providerConfigID) : null;
        return provider ? { name: provider.name, modelID: provider.modelID } : null;
      })(),
    })),
    requestCount: ordered.length,
    files: (attachmentIDs ?? []).map((id) => store.attachments([id])[0]).filter(Boolean),
    disclosure: "ยืนยันแล้วจะส่งคำขอแยกกันหนึ่งคำขอต่อสมาชิกหนึ่งคน โดยใช้บริบทที่ตรึงไว้ก่อนเริ่มรอบนี้",
  };
  reviews.set(plan.id, plan);
  setTimeout(() => reviews.delete(plan.id), 10 * 60 * 1000).unref?.();
  return plan;
}

const routes = {
  "GET /api/snapshot": () => ({
    ...store.snapshot(), credentialReferences: credentials.references(),
    presets: PROVIDER_PRESETS, botTemplates: BOT_TEMPLATES,
  }),
  "GET /api/presets": () => PROVIDER_PRESETS,
  "GET /api/bot-templates": () => BOT_TEMPLATES,
};

async function handleAPI(request, response, url) {
  const path = url.pathname;
  const method = request.method;
  const key = `${method} ${path}`;
  if (routes[key]) return json(response, 200, routes[key]());

  const segments = path.split("/").filter(Boolean); // ["api", ...]
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method) && !path.startsWith("/api/attachments")
    ? await readJSON(request) : {};

  // ── reads ──
  if (key === "GET /api/messages") {
    const conversationID = url.searchParams.get("conversationID");
    const before = url.searchParams.get("beforeSequence");
    return json(response, 200, store.messages(conversationID, {
      beforeSequence: before ? Number(before) : null,
      limit: Number(url.searchParams.get("limit") ?? 100),
    }));
  }
  if (key === "GET /api/search") {
    return json(response, 200, store.search(url.searchParams.get("q"), {
      includeHidden: url.searchParams.get("includeHidden") === "1",
    }));
  }
  if (key === "GET /api/export") {
    const document = store.exportDocument();
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="botworkspace-export-${Date.now()}.json"`,
    });
    return response.end(JSON.stringify(document, null, 2));
  }

  // ── bots ──
  if (key === "POST /api/bots") return json(response, 200, store.createBot(body));
  if (method === "PATCH" && segments[1] === "bots" && segments.length === 3) {
    return json(response, 200, store.editBot(segments[2], body.expected, body.replacement, { expectedRevision: body.expectedRevision ?? null }));
  }
  if (method === "POST" && segments[1] === "bots" && segments[3] === "hidden") {
    return json(response, 200, store.setHidden(segments[2], body.hidden ? new Date().toISOString() : null));
  }
  if (method === "POST" && segments[1] === "bots" && segments[3] === "provider") {
    return json(response, 200, store.setBotProvider(segments[2], body.providerConfigID ?? null));
  }
  if (method === "GET" && segments[1] === "bots" && segments[3] === "deletion-plan") {
    return json(response, 200, store.botDeletionPlan(segments[2]));
  }
  if (method === "POST" && segments[1] === "bots" && segments[3] === "delete") {
    return json(response, 200, { revision: store.deleteBot(body.expected) });
  }

  // ── groups ──
  if (key === "POST /api/groups") return json(response, 200, store.createGroup(body));
  if (method === "PATCH" && segments[1] === "groups" && segments.length === 3) {
    return json(response, 200, store.editGroup(segments[2], body.expected, body.replacement));
  }

  // ── drafts and attachments ──
  if (key === "POST /api/drafts") return json(response, 200, store.saveDraft(body));
  if (key === "POST /api/attachments") {
    const bytes = await readBody(request);
    return json(response, 200, store.addAttachment({
      conversationID: url.searchParams.get("conversationID"),
      name: decodeURIComponent(url.searchParams.get("name") ?? "attachment"),
      mime: request.headers["content-type"] ?? "application/octet-stream",
      bytes,
    }));
  }
  if (method === "GET" && segments[1] === "attachments" && segments.length === 3) {
    const content = store.attachmentContent(segments[2]);
    response.writeHead(200, {
      "content-type": content.mime,
      "content-disposition": `attachment; filename="${encodeURIComponent(content.name)}"`,
    });
    return response.end(content.bytes);
  }

  // ── sending: review then confirm ──
  if (key === "POST /api/send/review") return json(response, 200, buildReview(body));
  if (key === "POST /api/send/confirm") {
    const plan = reviews.get(body.planID);
    if (!plan) return json(response, 409, { error: "การตรวจทานหมดอายุ ตรวจทานอีกครั้งก่อนส่ง" });
    // Re-resolve the raw draft and compare the captured identities before any credential is read.
    const fresh = buildReview({
      conversationID: plan.conversationID,
      text: plan.rawText,
      replyToID: plan.replyToID,
      attachmentIDs: plan.attachmentIDs,
      manualTargets: plan.recipients.map((recipient) => recipient.id),
    });
    const same = JSON.stringify(fresh.recipients.map((item) => [item.id, item.name]))
      === JSON.stringify(plan.recipients.map((item) => [item.id, item.name]))
      && fresh.readableText === plan.readableText;
    reviews.delete(plan.id);
    reviews.delete(fresh.id);
    if (!same) return json(response, 409, { error: "ฉบับร่างหรือสมาชิกเปลี่ยนไปแล้ว ตรวจทานใหม่ก่อนส่ง" });

    const committed = store.beginGenerationRound({
      conversationID: plan.conversationID,
      text: plan.readableText,
      replyToID: plan.replyToID,
      attachmentIDs: plan.attachmentIDs,
      expectedDraftText: body.expectedDraftText,
      targets: plan.recipients.map((recipient) => ({ targetBotID: recipient.id })),
    }, { expectedRevision: body.expectedRevision ?? null });
    engine.runRound(committed.generations.map((generation) => generation.id)).catch(() => {});
    return json(response, 200, committed);
  }
  if (method === "POST" && segments[1] === "generations" && segments[3] === "cancel") {
    engine.cancel(segments[2]);
    return json(response, 200, { revision: store.cancelGeneration(segments[2]) });
  }
  if (method === "POST" && segments[1] === "generations" && segments[3] === "retry") {
    const generation = store.retryGeneration(segments[2]);
    engine.run(generation.id).catch(() => {});
    return json(response, 200, generation);
  }
  if (method === "POST" && segments[1] === "rounds" && segments[3] === "stop") {
    return json(response, 200, { stopped: engine.cancelRound(segments[2]) });
  }

  // ── read state, providers, credentials ──
  if (key === "POST /api/read") {
    return json(response, 200, {
      lastReadSequence: store.markRead(body.conversationID, body.throughSequence, body.observed ?? null),
    });
  }
  if (key === "POST /api/providers") return json(response, 200, store.saveProvider(body));
  if (method === "DELETE" && segments[1] === "providers" && segments.length === 3) {
    credentials.remove(store.provider(segments[2])?.credentialReference);
    return json(response, 200, { revision: store.deleteProvider(segments[2]) });
  }
  if (key === "POST /api/credentials") {
    // Session only: the value is held in this process and never written to the workspace file.
    credentials.set(body.reference, body.value);
    return json(response, 200, { reference: body.reference, stored: true, persisted: false });
  }
  if (method === "DELETE" && segments[1] === "credentials" && segments.length === 3) {
    credentials.remove(decodeURIComponent(segments[2]));
    return json(response, 200, { removed: true });
  }

  // ── routines ──
  if (key === "POST /api/routines") {
    const routine = store.createRoutine(body);
    if (routine.enabled && !routine.nextRunAt) {
      store.setRoutineNextRun(routine.id, nextRun(Date.now(), routine.trigger, routine.timezoneID));
    }
    return json(response, 200, store.routine(routine.id));
  }
  if (method === "PATCH" && segments[1] === "routines" && segments.length === 3) {
    const routine = store.editRoutine(body.expected, body.replacement);
    if (routine.enabled && !routine.nextRunAt) {
      store.setRoutineNextRun(routine.id, nextRun(Date.now(), routine.trigger, routine.timezoneID));
    }
    return json(response, 200, store.routine(routine.id));
  }
  if (method === "GET" && segments[1] === "routines" && segments[3] === "runs") {
    return json(response, 200, store.routineRuns({ routineID: segments[2] }));
  }
  if (method === "GET" && segments[1] === "routines" && segments[3] === "deletion-plan") {
    return json(response, 200, store.routineDeletionPlan(segments[2]));
  }
  if (method === "POST" && segments[1] === "routines" && segments[3] === "delete") {
    return json(response, 200, { revision: store.deleteRoutine(body.expected) });
  }
  if (method === "POST" && segments[1] === "routines" && segments[3] === "run") {
    return json(response, 200, await engine.runRoutineNow(segments[2], body.now ?? Date.now()));
  }
  if (key === "POST /api/routines/tick") {
    return json(response, 200, { started: await engine.tickRoutines(body.now ?? Date.now()) });
  }

  if (key === "POST /api/preferences") return json(response, 200, store.savePreferences(body));
  if (key === "POST /api/mention-token") {
    return json(response, 200, { token: mentionToken(body) });
  }

  return json(response, 404, { error: "ไม่พบ endpoint นี้" });
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);

  if (url.pathname === "/api/events") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(`data: ${JSON.stringify({ type: "hello", revision: store.revision })}\n\n`);
    const unsubscribe = engine.subscribe((event) => {
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const keepAlive = setInterval(() => response.write(": keep-alive\n\n"), 20_000);
    keepAlive.unref?.();
    request.on("close", () => { clearInterval(keepAlive); unsubscribe(); });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    try {
      return await handleAPI(request, response, url);
    } catch (error) {
      const status = error.status ?? (error.code ? 400 : 500);
      return json(response, status, { error: error.message, code: error.code ?? null });
    }
  }

  const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const file = normalize(join(root, requested));
  if (!file.startsWith(root)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": `${types[extname(file)] ?? "application/octet-stream"}; charset=utf-8`,
    }).end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`BotWorkspace Linux: http://127.0.0.1:${port}`);
  console.log(`ข้อมูลเวิร์กสเปซ: ${process.env.BOTWORKSPACE_HOME ?? defaultStoreDirectory()}`);
});
