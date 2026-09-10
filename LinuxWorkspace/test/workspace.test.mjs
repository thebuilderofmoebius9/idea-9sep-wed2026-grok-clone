import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceStore } from "../src/store.mjs";

const fresh = () => {
  const directory = mkdtempSync(join(tmpdir(), "botworkspace-"));
  const store = new WorkspaceStore({ directory });
  return { store, directory, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
};

test("a new workspace seeds one bot with its direct conversation", () => {
  const { store, cleanup } = fresh();
  const snapshot = store.snapshot();
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.conversations.length, 1);
  assert.equal(snapshot.conversations[0].kind, "direct");
  cleanup();
});

test("bot creation validates the profile and rejects unsupported colors", () => {
  const { store, cleanup } = fresh();
  assert.throws(() => store.createBot({ name: "", description: "" }), /1 ถึง 80/);
  assert.throws(() => store.createBot({ name: "Nova", color: "teal" }), /สีอวาตาร/);
  const { bot, conversation } = store.createBot({ name: "Nova", color: "blue", shape: "drop" });
  assert.equal(conversation.memberBotIDs[0], bot.id);
  cleanup();
});

test("profile editing rejects a stale expected buffer", () => {
  const { store, cleanup } = fresh();
  const { bot } = store.createBot({ name: "Nova" });
  const expected = { name: bot.name, description: bot.description, color: bot.color, shape: bot.shape };
  store.editBot(bot.id, expected, { ...expected, name: "Nova II" });
  assert.throws(() => store.editBot(bot.id, expected, { ...expected, name: "Nova III" }), /editConflict|เปลี่ยนไปแล้ว/);
  cleanup();
});

test("groups require two to six distinct available members", () => {
  const { store, cleanup } = fresh();
  const first = store.snapshot().bots[0];
  const second = store.createBot({ name: "Nova" }).bot;
  assert.throws(() => store.createGroup({ title: "เดี่ยว", memberBotIDs: [first.id] }), /2 ถึง 6/);
  assert.throws(() => store.createGroup({ title: "ซ้ำ", memberBotIDs: [first.id, first.id] }), /2 ถึง 6/);
  const group = store.createGroup({ title: "วางแผน", memberBotIDs: [first.id, second.id] });
  assert.equal(group.memberBotIDs.length, 2);
  cleanup();
});

test("a round commits one user message and one ordered generation per target", () => {
  const { store, cleanup } = fresh();
  const first = store.snapshot().bots[0];
  const second = store.createBot({ name: "Nova" }).bot;
  const group = store.createGroup({ title: "วางแผน", memberBotIDs: [first.id, second.id] });
  const committed = store.beginGenerationRound({
    conversationID: group.id,
    text: "เริ่มรอบ",
    targets: [{ targetBotID: second.id }, { targetBotID: first.id }],
  });
  assert.equal(committed.generations.length, 2);
  assert.deepEqual(committed.generations.map((item) => item.roundIndex), [0, 1]);
  assert.deepEqual(committed.generations.map((item) => item.targetBotID), [second.id, first.id]);
  assert.equal(store.messages(group.id).messages.filter((item) => item.role === "user").length, 1);
  cleanup();
});

test("a draft clears only when its raw source still matches exactly", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  const target = store.snapshot().bots[0];
  store.saveDraft({ conversationID: conversation.id, text: "ข้อความใหม่กว่า" });
  store.beginGeneration({ conversationID: conversation.id, targetBotID: target.id, text: "ของเก่า", expectedDraftText: "ของเก่า" });
  assert.equal(store.draft(conversation.id).text, "ข้อความใหม่กว่า", "ฉบับร่างที่ใหม่กว่าต้องอยู่รอด");
  store.saveDraft({ conversationID: conversation.id, text: "ตรงกัน" });
  store.beginGeneration({ conversationID: conversation.id, targetBotID: target.id, text: "ตรงกัน", expectedDraftText: "ตรงกัน" });
  assert.equal(store.draft(conversation.id), null);
  cleanup();
});

test("streamed deltas append to one assistant message and stop at a terminal state", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  const target = store.snapshot().bots[0];
  const { generations } = store.beginGeneration({ conversationID: conversation.id, targetBotID: target.id, text: "ถาม" });
  const id = generations[0].id;
  store.applyGenerationEvent({ generationID: id, kind: "started" });
  store.applyGenerationEvent({ generationID: id, kind: "delta", text: "ตอบ" });
  store.applyGenerationEvent({ generationID: id, kind: "delta", text: "กลับ" });
  store.applyGenerationEvent({ generationID: id, kind: "completed" });
  store.applyGenerationEvent({ generationID: id, kind: "delta", text: "หลังจบ" });
  const assistant = store.messages(conversation.id).messages.filter((item) => item.role === "assistant");
  assert.equal(assistant.at(-1).text, "ตอบกลับ");
  assert.equal(store.generation(id).state, "completed");
  cleanup();
});

test("a failed generation records an event row that never counts as an unread reply", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  const target = store.snapshot().bots[0];
  store.markRead(conversation.id, store.conversation(conversation.id).nextSequence - 1);
  const { generations } = store.beginGeneration({ conversationID: conversation.id, targetBotID: target.id, text: "ถาม" });
  store.applyGenerationEvent({ generationID: generations[0].id, kind: "failed", error: "ไม่มี credential" });
  const info = store.activity().find((item) => item.conversationID === conversation.id);
  assert.equal(info.unreadAssistantCount, 0);
  assert.equal(store.messages(conversation.id).messages.at(-1).role, "event");
  cleanup();
});

test("stopping a round keeps completed replies and cancels the rest", () => {
  const { store, cleanup } = fresh();
  const first = store.snapshot().bots[0];
  const second = store.createBot({ name: "Nova" }).bot;
  const group = store.createGroup({ title: "รอบ", memberBotIDs: [first.id, second.id] });
  const committed = store.beginGenerationRound({
    conversationID: group.id, text: "ไป", targets: [{ targetBotID: first.id }, { targetBotID: second.id }],
  });
  store.applyGenerationEvent({ generationID: committed.generations[0].id, kind: "delta", text: "เสร็จ" });
  store.applyGenerationEvent({ generationID: committed.generations[0].id, kind: "completed" });
  assert.equal(store.cancelGenerationRound(committed.userMessage.id), 1);
  assert.equal(store.generation(committed.generations[0].id).state, "completed");
  assert.equal(store.generation(committed.generations[1].id).state, "cancelled");
  cleanup();
});

test("unread counts are exact past one page and read state is monotonic", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  const target = store.snapshot().bots[0];
  for (let index = 0; index < 130; index += 1) {
    const { generations } = store.beginGeneration({ conversationID: conversation.id, targetBotID: target.id, text: `q${index}` });
    store.applyGenerationEvent({ generationID: generations[0].id, kind: "delta", text: `a${index}` });
    store.applyGenerationEvent({ generationID: generations[0].id, kind: "completed" });
  }
  const info = store.activity().find((item) => item.conversationID === conversation.id);
  assert.equal(info.unreadAssistantCount, 131, "รวมข้อความ seed หนึ่งข้อความ");
  const latest = store.messages(conversation.id, { limit: 1 }).messages[0];
  store.markRead(conversation.id, latest.sequence);
  store.markRead(conversation.id, 3);
  assert.equal(store.conversation(conversation.id).lastReadSequence, latest.sequence, "watermark ต้องไม่ถอยหลัง");
  cleanup();
});

test("read acknowledgement rejects a stale rendered snapshot and a live generation", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  const target = store.snapshot().bots[0];
  const latest = store.messages(conversation.id, { limit: 1 }).messages[0];
  assert.throws(() => store.markRead(conversation.id, latest.sequence, {
    messageID: latest.id, sequence: latest.sequence, byteCount: 1,
  }), /รีเฟรชก่อนลองใหม่/, "ความยาวที่เรนเดอร์ไม่ตรงต้องถูกปฏิเสธ");
  store.beginGeneration({ conversationID: conversation.id, targetBotID: target.id, text: "ถาม" });
  const user = store.messages(conversation.id).messages.at(-1);
  assert.throws(() => store.markRead(conversation.id, user.sequence, {
    messageID: user.id, sequence: user.sequence, byteCount: Buffer.byteLength(user.text),
  }), /รีเฟรชก่อนลองใหม่/, "generation ที่ยังไม่จบต้องหน่วงการมาร์คอ่าน");
  cleanup();
});

test("hiding a bot does not change its read state", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  const before = store.conversation(conversation.id).lastReadSequence;
  store.setHidden(store.snapshot().bots[0].id, new Date().toISOString());
  assert.equal(store.conversation(conversation.id).lastReadSequence, before);
  assert.equal(store.activity().find((item) => item.conversationID === conversation.id).unreadAssistantCount, 1);
  cleanup();
});

test("bot deletion needs a matching plan, keeps group history and trims membership", () => {
  const { store, cleanup } = fresh();
  const first = store.snapshot().bots[0];
  const second = store.createBot({ name: "Nova" }).bot;
  const group = store.createGroup({ title: "กลุ่ม", memberBotIDs: [first.id, second.id] });
  store.beginGenerationRound({ conversationID: group.id, text: "ประวัติกลุ่ม", targets: [{ targetBotID: second.id }] });
  store.cancelGenerationRound(store.messages(group.id).messages.at(-1).id);
  const plan = store.botDeletionPlan(second.id);
  assert.equal(plan.affectedGroups[0].remainingMemberBotIDs.length, 1);
  assert.throws(
    () => store.deleteBot({ ...plan, affectedGroups: [] }),
    /ตรวจอีกครั้งก่อนลบ/,
    "แผนที่ไม่ตรงกับผลกระทบจริงต้องถูกปฏิเสธ");
  store.deleteBot(plan);
  assert.equal(store.bot(second.id), undefined);
  assert.deepEqual(store.conversation(group.id).memberBotIDs, [first.id]);
  assert.ok(store.messages(group.id).messages.some((item) => item.text === "ประวัติกลุ่ม"), "ประวัติกลุ่มต้องยังอยู่");
  cleanup();
});

test("deletion is refused while work targeting the bot is still active", () => {
  const { store, cleanup } = fresh();
  const bot = store.createBot({ name: "Nova" });
  store.beginGeneration({ conversationID: bot.conversation.id, targetBotID: bot.bot.id, text: "ถาม" });
  assert.throws(() => store.deleteBot(store.botDeletionPlan(bot.bot.id)), /รอให้การตอบ/);
  cleanup();
});

test("provider validation refuses plain HTTP, embedded credentials and queries", () => {
  const { store, cleanup } = fresh();
  const base = { name: "ทดสอบ", modelID: "glm-5.3", credentialReference: "reference-1" };
  assert.throws(() => store.saveProvider({ ...base, apiRoot: "http://api.example.com/v1" }), /HTTPS/);
  assert.throws(() => store.saveProvider({ ...base, apiRoot: "https://user:pass@api.example.com/v1" }), /HTTPS/);
  assert.throws(() => store.saveProvider({ ...base, apiRoot: "https://api.example.com/v1?key=abc" }), /HTTPS/);
  const loopback = store.saveProvider({ ...base, apiRoot: "http://127.0.0.1:20128/v1", allowsLoopbackHTTP: true });
  assert.equal(loopback.allowsLoopbackHTTP, true);
  cleanup();
});

test("the workspace survives a restart and never leaves a live-looking generation", () => {
  const { store, directory, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  store.beginGeneration({ conversationID: conversation.id, targetBotID: store.snapshot().bots[0].id, text: "ค้างไว้" });
  store.saveDraft({ conversationID: conversation.id, text: "ฉบับร่างที่ต้องอยู่รอด" });
  const reopened = new WorkspaceStore({ directory });
  assert.equal(reopened.snapshot().generations.at(-1).state, "interrupted");
  assert.equal(reopened.draft(conversation.id).text, "ฉบับร่างที่ต้องอยู่รอด");
  assert.equal(reopened.messages(conversation.id).messages.at(-1).text, "ค้างไว้");
  cleanup();
});

test("export is format v3 and carries no credential value", () => {
  const { store, cleanup } = fresh();
  store.saveProvider({ name: "ทดสอบ", apiRoot: "https://api.example.com/v1", modelID: "m", credentialReference: "reference-1" });
  const document = store.exportDocument();
  assert.equal(document.format, 3);
  assert.equal(document.providers[0].credentialValueIncluded, false);
  const serialized = JSON.stringify(document);
  assert.ok(!serialized.includes("credentialValue\":"), "ห้ามมีค่า credential ในไฟล์ export");
  assert.ok(document.secretScrubbing.length > 0, "ต้องบอกข้อจำกัดการขูด secret ให้ผู้ใช้รู้");
  cleanup();
});

test("layout preferences clamp to the documented ranges", () => {
  const { store, cleanup } = fresh();
  assert.equal(store.savePreferences({ sidebarWidth: 90 }).sidebarWidth, 240);
  assert.equal(store.savePreferences({ sidebarWidth: 9000 }).sidebarWidth, 400);
  assert.equal(store.savePreferences({ inspectorWidth: 10 }).inspectorWidth, 280);
  assert.equal(store.savePreferences({ appearance: "light" }).appearance, "light");
  assert.equal(store.savePreferences({ appearance: "neon" }).appearance, "light", "ค่าที่ไม่รองรับต้องไม่เปลี่ยนของเดิม");
  cleanup();
});

test("search matches titles and transcripts and hides hidden bots by default", () => {
  const { store, cleanup } = fresh();
  const bot = store.createBot({ name: "Nova" });
  store.beginGeneration({ conversationID: bot.conversation.id, targetBotID: bot.bot.id, text: "เรื่องงบประมาณ" });
  assert.equal(store.search("งบประมาณ").length, 1);
  store.setHidden(bot.bot.id, new Date().toISOString());
  assert.equal(store.search("งบประมาณ").length, 0);
  assert.equal(store.search("งบประมาณ", { includeHidden: true }).length, 1);
  cleanup();
});

test("message pages are keyset paginated in ascending order", () => {
  const { store, cleanup } = fresh();
  const conversation = store.snapshot().conversations[0];
  for (let index = 0; index < 12; index += 1) {
    store.beginGeneration({ conversationID: conversation.id, targetBotID: store.snapshot().bots[0].id, text: `m${index}` });
  }
  const page = store.messages(conversation.id, { limit: 5 });
  assert.equal(page.messages.length, 5);
  assert.equal(page.hasMore, true);
  const older = store.messages(conversation.id, { beforeSequence: page.beforeSequence, limit: 5 });
  assert.ok(older.messages.at(-1).sequence < page.messages[0].sequence);
  assert.throws(() => store.messages(conversation.id, { limit: 0 }), /ขนาดหน้า/);
  cleanup();
});

test("attachments are stored on disk, listed without their path, and removed with the bot", () => {
  const { store, cleanup } = fresh();
  const bot = store.createBot({ name: "Nova" });
  const file = store.addAttachment({
    conversationID: bot.conversation.id, name: "note.txt", mime: "text/plain", bytes: Buffer.from("เนื้อหา"),
  });
  assert.equal(file.path, undefined);
  assert.equal(store.attachmentContent(file.id).bytes.toString(), "เนื้อหา");
  store.beginGeneration({
    conversationID: bot.conversation.id, targetBotID: bot.bot.id, text: "ดูไฟล์นี้", attachmentIDs: [file.id],
  });
  store.cancelGenerationRound(store.messages(bot.conversation.id).messages.at(-1).id);
  store.deleteBot(store.botDeletionPlan(bot.bot.id));
  assert.equal(store.attachments([file.id]).length, 0);
  cleanup();
});
