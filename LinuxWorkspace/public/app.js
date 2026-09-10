import { addBot, addConversation, addMessage, loadWorkspace, saveWorkspace } from "./workspace.js";

let workspace = loadWorkspace(localStorage);
let selectedId = workspace.conversations[0]?.id;
const $ = (selector) => document.querySelector(selector);
const conversation = () => workspace.conversations.find((item) => item.id === selectedId);

function persist() { saveWorkspace(localStorage, workspace); }
function escape(text) { return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"); }

function render() {
  $("#bot-list").innerHTML = workspace.bots.map((bot) => `<li><i style="background:${bot.color}"></i><span>${escape(bot.name)}</span><small>${escape(bot.role)}</small></li>`).join("");
  $("#conversation-list").innerHTML = workspace.conversations.map((item) => `<button class="conversation ${item.id === selectedId ? "active" : ""}" data-id="${item.id}"><b>${escape(item.title)}</b><small>${item.messages.at(-1)?.text ? escape(item.messages.at(-1).text.slice(0, 42)) : "ยังไม่มีข้อความ"}</small></button>`).join("");
  const active = conversation();
  $("#title").textContent = active?.title ?? "ไม่มีบทสนทนา";
  $("#messages").innerHTML = active?.messages.map((message) => `<article class="${message.author === "คุณ" ? "mine" : ""}"><strong>${escape(message.author)}</strong><p>${escape(message.text)}</p></article>`).join("") ?? "";
  $("#conversation-list").querySelectorAll("button").forEach((button) => button.addEventListener("click", () => { selectedId = button.dataset.id; render(); }));
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

$("#new-chat").addEventListener("click", () => { selectedId = addConversation(workspace).id; persist(); render(); $("#composer").focus(); });
$("#new-bot").addEventListener("click", () => {
  const name = prompt("ชื่อ AI teammate");
  if (!name?.trim()) return;
  addBot(workspace, name.trim(), prompt("บทบาท (เลือกเว้นว่างได้)") ?? "");
  persist(); render();
});
$("#send-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!conversation() || !addMessage(conversation(), $("#composer").value)) return;
  $("#composer").value = "";
  persist(); render();
});

render();
