import test from "node:test";
import assert from "node:assert/strict";
import { addBot, addConversation, addMessage, freshWorkspace, loadWorkspace, saveWorkspace, storageKey } from "../public/workspace.js";

function storage() { const values = new Map(); return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values }; }

test("a fresh Linux workspace contains an Atom teammate and welcome conversation", () => {
  const workspace = freshWorkspace();
  assert.equal(workspace.bots[0].name, "Atom");
  assert.equal(workspace.conversations[0].id, "welcome");
});

test("bots and conversations are added and persisted locally", () => {
  const workspace = freshWorkspace();
  const bot = addBot(workspace, "Nova", "นักวิจัย");
  const chat = addConversation(workspace, "วางแผน Linux");
  assert.equal(addMessage(chat, "ย้ายจาก macOS"), true);
  const local = storage();
  saveWorkspace(local, workspace);
  assert.equal(JSON.parse(local.values.get(storageKey)).bots.at(-1).id, bot.id);
  assert.equal(loadWorkspace(local).conversations[0].title, "วางแผน Linux");
});

test("blank messages do not mutate the conversation", () => {
  const chat = freshWorkspace().conversations[0];
  assert.equal(addMessage(chat, "   "), false);
  assert.equal(chat.messages.length, 1);
});
