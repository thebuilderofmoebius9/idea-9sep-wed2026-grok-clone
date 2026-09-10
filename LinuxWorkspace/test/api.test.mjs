import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = fileURLToPath(new URL("../server.mjs", import.meta.url));

/** A local OpenAI-compatible SSE endpoint so the whole send path runs for real. */
async function fakeProvider() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const body = JSON.parse(await new Promise((resolve) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    }));
    requests.push({ url: request.url, authorization: request.headers.authorization, body });
    const last = body.messages.at(-1)?.content ?? "";
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `ตอบ: ${last}` } }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    requests,
    port: server.address().port,
    close: () => new Promise((done) => server.close(done)),
  };
}

async function bootWorkspace() {
  const directory = mkdtempSync(join(tmpdir(), "botworkspace-api-"));
  const port = 4200 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(port), BOTWORKSPACE_HOME: directory },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const probe = await fetch(`${base}/api/snapshot`);
      if (probe.ok) break;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 60));
  }
  const call = async (path, { method = "GET", body } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text.trim().startsWith("{") || text.trim().startsWith("[") ? JSON.parse(text) : text;
    if (!response.ok) throw Object.assign(new Error(payload.error ?? text), { status: response.status, payload });
    return payload;
  };
  return {
    base,
    call,
    cleanup: async () => {
      child.kill("SIGKILL");
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

const waitFor = async (probe, label, timeout = 6000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.fail(`หมดเวลารอ: ${label}`);
};

test("the local API serves a snapshot, presets and the UI shell", async () => {
  const workspace = await bootWorkspace();
  const snapshot = await workspace.call("/api/snapshot");
  assert.equal(snapshot.bots.length, 1);
  assert.ok(snapshot.presets.length >= 4);
  assert.deepEqual(snapshot.credentialReferences, []);
  const page = await fetch(`${workspace.base}/`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("BotWorkspace"));
  assert.equal((await fetch(`${workspace.base}/../server.mjs`)).status, 404);
  await workspace.cleanup();
});

test("a direct chat sends for real against a compatible endpoint and streams the reply back", async () => {
  const provider = await fakeProvider();
  const workspace = await bootWorkspace();
  const created = await workspace.call("/api/bots", {
    method: "POST", body: { name: "Nova", description: "ผู้ช่วยทดสอบ", color: "blue" },
  });
  const saved = await workspace.call("/api/providers", {
    method: "POST",
    body: {
      name: "local", apiRoot: `http://127.0.0.1:${provider.port}/v1`, modelID: "test-model",
      credentialReference: "reference-e2e", allowsLoopbackHTTP: true,
    },
  });
  await workspace.call("/api/credentials", { method: "POST", body: { reference: saved.credentialReference, value: "sk-test" } });
  await workspace.call(`/api/bots/${created.bot.id}/provider`, { method: "POST", body: { providerConfigID: saved.id } });

  const plan = await workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: created.conversation.id, text: "สวัสดี" },
  });
  assert.equal(plan.requestCount, 1);
  assert.equal(provider.requests.length, 0, "การตรวจทานต้องไม่ยิงผู้ให้บริการ");

  await workspace.call("/api/send/confirm", { method: "POST", body: { planID: plan.id } });
  const reply = await waitFor(async () => {
    const page = await workspace.call(`/api/messages?conversationID=${created.conversation.id}`);
    return page.messages.find((message) => message.role === "assistant" && message.text.startsWith("ตอบ:"));
  }, "คำตอบจากผู้ให้บริการ");
  assert.equal(reply.text, "ตอบ: สวัสดี");
  assert.equal(reply.speakerNameSnapshot, "Nova");
  assert.equal(provider.requests[0].authorization, "Bearer sk-test");
  assert.equal(provider.requests[0].body.messages[0].role, "system");
  assert.ok(provider.requests[0].body.messages[0].content.includes("Nova"));

  const snapshot = await workspace.call("/api/snapshot");
  const generation = snapshot.generations.at(-1);
  assert.equal(generation.state, "completed");
  const info = snapshot.conversationActivity.find((item) => item.conversationID === created.conversation.id);
  assert.equal(info.unreadAssistantCount, 1);
  await workspace.call("/api/read", {
    method: "POST",
    body: {
      conversationID: created.conversation.id,
      throughSequence: reply.sequence,
      observed: { messageID: reply.id, sequence: reply.sequence, byteCount: Buffer.byteLength(reply.text) },
    },
  });
  const cleared = await workspace.call("/api/snapshot");
  assert.equal(cleared.conversationActivity.find((item) => item.conversationID === created.conversation.id).unreadAssistantCount, 0);

  await workspace.cleanup();
  await provider.close();
});

test("a mention round sends one request per member in mention order", async () => {
  const provider = await fakeProvider();
  const workspace = await bootWorkspace();
  const saved = await workspace.call("/api/providers", {
    method: "POST",
    body: {
      name: "local", apiRoot: `http://127.0.0.1:${provider.port}/v1`, modelID: "test-model",
      credentialReference: "reference-round", allowsLoopbackHTTP: true,
    },
  });
  await workspace.call("/api/credentials", { method: "POST", body: { reference: saved.credentialReference, value: "sk-test" } });
  const first = await workspace.call("/api/bots", { method: "POST", body: { name: "Research" } });
  const second = await workspace.call("/api/bots", { method: "POST", body: { name: "Writer" } });
  for (const bot of [first.bot, second.bot]) {
    await workspace.call(`/api/bots/${bot.id}/provider`, { method: "POST", body: { providerConfigID: saved.id } });
  }
  const group = await workspace.call("/api/groups", {
    method: "POST", body: { title: "รอบกลุ่ม", memberBotIDs: [first.bot.id, second.bot.id] },
  });

  await assert.rejects(workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: group.id, text: "@Nobody ช่วยดู" },
  }), /ไม่พบสมาชิกชื่อนี้/);

  // A bound token proves the local {uuid} binding is stripped before the transcript is stored.
  const bound = await workspace.call("/api/mention-token", {
    method: "POST", body: { id: second.bot.id, name: "Writer" },
  });
  const plan = await workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: group.id, text: `${bound.token} แล้ว @Research ช่วยสรุป` },
  });
  assert.equal(plan.source, "mention");
  assert.deepEqual(plan.recipients.map((item) => item.name), ["Writer", "Research"]);
  await workspace.call("/api/send/confirm", { method: "POST", body: { planID: plan.id } });

  await waitFor(async () => {
    const page = await workspace.call(`/api/messages?conversationID=${group.id}`);
    return page.messages.filter((message) => message.role === "assistant").length === 2;
  }, "คำตอบครบสองสมาชิก");
  const page = await workspace.call(`/api/messages?conversationID=${group.id}`);
  assert.deepEqual(
    page.messages.filter((message) => message.role === "assistant").map((message) => message.speakerNameSnapshot),
    ["Writer", "Research"], "ต้องตอบตามลำดับ mention");
  assert.equal(provider.requests.length, 2, "หนึ่งคำขอต่อหนึ่งสมาชิก");
  const transcript = page.messages.map((message) => message.text).join("\n");
  assert.ok(transcript.includes('@"Writer"'), "การสะกดที่อ่านได้ต้องยังอยู่");
  assert.ok(!transcript.includes(second.bot.id), "การผูก {uuid} ต้องไม่เข้าไปในบทถอด");
  assert.ok(!JSON.stringify(provider.requests).includes(second.bot.id),
    "การผูกในเครื่องต้องไม่ถูกส่งไปให้ผู้ให้บริการ");

  const stale = await workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: group.id, text: "@Research อีกรอบ" },
  });
  await workspace.call(`/api/bots/${first.bot.id}`, {
    method: "PATCH",
    body: {
      expected: { name: "Research", description: "", color: "green", shape: "circle" },
      replacement: { name: "Research II", description: "", color: "green", shape: "circle" },
    },
  });
  const requestsBefore = provider.requests.length;
  await assert.rejects(
    workspace.call("/api/send/confirm", { method: "POST", body: { planID: stale.id } }),
    (error) => [400, 409].includes(error.status),
    "เปลี่ยนชื่อสมาชิกหลังตรวจทานต้องบล็อกการส่ง");
  assert.equal(provider.requests.length, requestsBefore, "ต้องไม่มีคำขอใหม่ไปถึงผู้ให้บริการ");

  await workspace.cleanup();
  await provider.close();
});

test("an unbound bot fails the generation honestly instead of inventing a reply", async () => {
  const workspace = await bootWorkspace();
  const created = await workspace.call("/api/bots", { method: "POST", body: { name: "Nova" } });
  const plan = await workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: created.conversation.id, text: "ถามหน่อย" },
  });
  await workspace.call("/api/send/confirm", { method: "POST", body: { planID: plan.id } });
  const failure = await waitFor(async () => {
    const snapshot = await workspace.call("/api/snapshot");
    return snapshot.generations.find((generation) => generation.state === "failed");
  }, "generation ที่ล้มเหลว");
  assert.match(failure.error, /ยังไม่ได้ผูกผู้ให้บริการ/);
  const page = await workspace.call(`/api/messages?conversationID=${created.conversation.id}`);
  assert.equal(page.messages.filter((message) => message.role === "assistant").length, 0, "ห้ามมีคำตอบปลอม");
  assert.equal(page.messages.at(-1).role, "event");
  await workspace.cleanup();
});

test("a routine tick claims one due occurrence, runs it and records the run", async () => {
  const provider = await fakeProvider();
  const workspace = await bootWorkspace();
  const saved = await workspace.call("/api/providers", {
    method: "POST",
    body: {
      name: "local", apiRoot: `http://127.0.0.1:${provider.port}/v1`, modelID: "test-model",
      credentialReference: "reference-routine", allowsLoopbackHTTP: true,
    },
  });
  await workspace.call("/api/credentials", { method: "POST", body: { reference: saved.credentialReference, value: "sk-test" } });
  const created = await workspace.call("/api/bots", { method: "POST", body: { name: "Nova" } });
  await workspace.call(`/api/bots/${created.bot.id}/provider`, { method: "POST", body: { providerConfigID: saved.id } });
  const routine = await workspace.call("/api/routines", {
    method: "POST",
    body: {
      ownerBotID: created.bot.id, name: "สรุปเช้า", prompt: "สรุปงานเมื่อวาน",
      trigger: { type: "interval", minutes: 60 }, timezoneID: "Asia/Bangkok", enabled: true,
    },
  });
  assert.ok(routine.nextRunAt, "routine ที่เปิดใช้งานต้องมีรอบถัดไป");

  // Nothing is due yet: the watermark is in the future.
  assert.deepEqual((await workspace.call("/api/routines/tick", { method: "POST", body: {} })).started, []);
  const later = routine.nextRunAt + 61 * 60_000;
  const first = await workspace.call("/api/routines/tick", { method: "POST", body: { now: later } });
  assert.equal(first.started.length, 1);
  // The same occurrence must not be claimed twice.
  assert.deepEqual((await workspace.call("/api/routines/tick", { method: "POST", body: { now: later } })).started, []);

  const run = await waitFor(async () => {
    const runs = await workspace.call(`/api/routines/${routine.id}/runs`);
    return runs.find((item) => item.status === "succeeded");
  }, "รอบ routine ที่สำเร็จ");
  assert.equal(run.skippedCount, 1, "ต้องรายงานรอบที่ข้ามไปเป็นตัวเลขรวม ไม่ใช่รันซ้ำทุกครั้งที่พลาด");
  const page = await workspace.call(`/api/messages?conversationID=${created.conversation.id}`);
  assert.ok(page.messages.some((message) => message.text === "ตอบ: สรุปงานเมื่อวาน"));
  await workspace.cleanup();
  await provider.close();
});

test("attachments upload, download and appear in the transcript", async () => {
  const workspace = await bootWorkspace();
  const created = await workspace.call("/api/bots", { method: "POST", body: { name: "Nova" } });
  const upload = await fetch(
    `${workspace.base}/api/attachments?conversationID=${created.conversation.id}&name=${encodeURIComponent("บันทึก.txt")}`,
    { method: "POST", headers: { "content-type": "text/plain" }, body: "เนื้อหาไฟล์" });
  const file = await upload.json();
  assert.equal(file.byteCount, Buffer.byteLength("เนื้อหาไฟล์"));
  assert.equal(file.path, undefined, "ไม่ส่งพาธในเครื่องออกไปให้ไคลเอนต์");
  const download = await fetch(`${workspace.base}/api/attachments/${file.id}`);
  assert.equal(await download.text(), "เนื้อหาไฟล์");
  const plan = await workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: created.conversation.id, text: "ดูไฟล์นี้", attachmentIDs: [file.id] },
  });
  assert.equal(plan.files[0].name, "บันทึก.txt");
  await workspace.cleanup();
});

test("export downloads as a file and stays format v3", async () => {
  const workspace = await bootWorkspace();
  const response = await fetch(`${workspace.base}/api/export`);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename=/);
  const document = await response.json();
  assert.equal(document.format, 3);
  assert.ok(document.secretScrubbing.length > 0);
  await workspace.cleanup();
});

test("live events are pushed over SSE while a reply streams", async () => {
  const provider = await fakeProvider();
  const workspace = await bootWorkspace();
  const saved = await workspace.call("/api/providers", {
    method: "POST",
    body: {
      name: "local", apiRoot: `http://127.0.0.1:${provider.port}/v1`, modelID: "test-model",
      credentialReference: "reference-sse", allowsLoopbackHTTP: true,
    },
  });
  await workspace.call("/api/credentials", { method: "POST", body: { reference: saved.credentialReference, value: "sk-test" } });
  const created = await workspace.call("/api/bots", { method: "POST", body: { name: "Nova" } });
  await workspace.call(`/api/bots/${created.bot.id}/provider`, { method: "POST", body: { providerConfigID: saved.id } });

  const events = [];
  const stream = await fetch(`${workspace.base}/api/events`);
  const reader = stream.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    while (events.length < 4) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const line of decoder.decode(value).split("\n")) {
        if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
      }
    }
  })();

  const plan = await workspace.call("/api/send/review", {
    method: "POST", body: { conversationID: created.conversation.id, text: "สวัสดี" },
  });
  await workspace.call("/api/send/confirm", { method: "POST", body: { planID: plan.id } });
  await Promise.race([pump, new Promise((resolve) => setTimeout(resolve, 4000))]);
  await reader.cancel().catch(() => {});
  assert.equal(events[0].type, "hello");
  assert.ok(events.some((event) => event.type === "generation" && event.kind === "delta"),
    "ต้องมี delta ส่งผ่าน SSE เพื่อให้ UI สตรีมได้จริง");
  await workspace.cleanup();
  await provider.close();
});

test("run-now starts an extra routine run without moving the next scheduled run", async () => {
  const provider = await fakeProvider();
  const workspace = await bootWorkspace();
  const saved = await workspace.call("/api/providers", {
    method: "POST",
    body: {
      name: "local", apiRoot: `http://127.0.0.1:${provider.port}/v1`, modelID: "test-model",
      credentialReference: "reference-run-now", allowsLoopbackHTTP: true,
    },
  });
  await workspace.call("/api/credentials", { method: "POST", body: { reference: saved.credentialReference, value: "sk-test" } });
  const created = await workspace.call("/api/bots", { method: "POST", body: { name: "Nova" } });
  await workspace.call(`/api/bots/${created.bot.id}/provider`, { method: "POST", body: { providerConfigID: saved.id } });
  const routine = await workspace.call("/api/routines", {
    method: "POST",
    body: {
      ownerBotID: created.bot.id, name: "สรุปเช้า", prompt: "รันมือ",
      trigger: { type: "interval", minutes: 60 }, timezoneID: "Asia/Bangkok", enabled: true,
    },
  });
  const started = await workspace.call(`/api/routines/${routine.id}/run`, { method: "POST", body: {} });
  assert.equal(started.status, "running");
  const run = await waitFor(async () => {
    const runs = await workspace.call(`/api/routines/${routine.id}/runs`);
    return runs.find((item) => item.id === started.id && item.status === "succeeded");
  }, "รอบที่สั่งรันเองสำเร็จ");
  assert.equal(run.skippedCount, 0, "การสั่งรันเองไม่ใช่รอบที่พลาด");
  const after = await workspace.call("/api/snapshot");
  assert.equal(
    after.routines.find((item) => item.id === routine.id).nextRunAt,
    routine.nextRunAt,
    "สั่งรันเองต้องไม่เลื่อนรอบตามตารางถัดไป");
  const page = await workspace.call(`/api/messages?conversationID=${created.conversation.id}`);
  assert.ok(page.messages.some((message) => message.text === "ตอบ: รันมือ"));
  await workspace.cleanup();
  await provider.close();
});

test("installing the same bot template twice creates two independent bots", async () => {
  const workspace = await bootWorkspace();
  const templates = (await workspace.call("/api/snapshot")).botTemplates;
  assert.ok(templates.length >= 4);
  const template = templates[0];
  const first = await workspace.call("/api/bots", { method: "POST", body: { ...template, id: undefined } });
  const second = await workspace.call("/api/bots", { method: "POST", body: { ...template, id: undefined } });
  assert.notEqual(first.bot.id, second.bot.id);
  assert.notEqual(first.conversation.id, second.conversation.id);
  assert.equal(second.bot.description, template.description);
  assert.equal(first.bot.providerConfigID ?? null, null, "เทมเพลตต้องไม่แถม provider/credential มาให้");
  await workspace.cleanup();
});

test("Codex auth import refuses the wrong file and never returns the token", async () => {
  const workspace = await bootWorkspace();
  const directory = mkdtempSync(join(tmpdir(), "codex-auth-"));
  const apiKeyFile = join(directory, "apikey.json");
  const chatgptFile = join(directory, "chatgpt.json");
  writeFileSync(apiKeyFile, JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-nope" }));
  writeFileSync(chatgptFile, JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: "access-value", account_id: "acct-1", refresh_token: "refresh-value" },
  }));
  await assert.rejects(() => workspace.call("/api/codex-auth", { method: "POST", body: { path: apiKeyFile } }), /ChatGPT/);
  await assert.rejects(() => workspace.call("/api/codex-auth", { method: "POST", body: { path: "relative.json" } }), /พาธ/);
  const imported = await workspace.call("/api/codex-auth", { method: "POST", body: { path: chatgptFile } });
  assert.ok(imported.credentialReference.startsWith("codex-session:"));
  assert.equal(imported.persisted, false);
  assert.equal(imported.endpoint, "https://chatgpt.com/backend-api/codex/responses");
  assert.ok(!JSON.stringify(imported).includes("access-value"), "ต้องไม่คืนค่า token กลับมา");
  assert.ok(!JSON.stringify(imported).includes("refresh-value"), "ต้องไม่แตะ refresh token");
  const snapshot = await workspace.call("/api/snapshot");
  assert.deepEqual(snapshot.credentialReferences, [imported.credentialReference]);
  // A Codex session reference must never be accepted by the generic adapter.
  await assert.rejects(() => workspace.call("/api/providers", {
    method: "POST",
    body: {
      name: "generic", apiRoot: "https://api.example.com/v1", modelID: "x",
      credentialReference: imported.credentialReference, kind: "chatCompletions",
    },
  }));
  rmSync(directory, { recursive: true, force: true });
  await workspace.cleanup();
});

test("the workspace is installable: manifest, icon and a service worker that never caches the API", async () => {
  const workspace = await bootWorkspace();
  const manifest = await fetch(`${workspace.base}/manifest.webmanifest`);
  assert.equal(manifest.status, 200);
  assert.ok(manifest.headers.get("content-type").startsWith("application/manifest+json"));
  const parsed = await manifest.json();
  assert.equal(parsed.display, "standalone");
  assert.equal(parsed.start_url, "/");
  assert.ok(parsed.icons.some((icon) => icon.purpose === "maskable"));
  for (const icon of parsed.icons) {
    assert.equal((await fetch(`${workspace.base}${icon.src}`)).status, 200, `ไอคอนต้องมีจริง: ${icon.src}`);
  }
  const worker = await fetch(`${workspace.base}/service-worker.js`);
  assert.equal(worker.status, 200);
  const source = await worker.text();
  assert.ok(source.includes('url.pathname.startsWith("/api/")'), "service worker ต้องไม่แคชเส้นทาง /api/");
  const page = await (await fetch(`${workspace.base}/`)).text();
  assert.ok(page.includes('rel="manifest"'));
  await workspace.cleanup();
});
