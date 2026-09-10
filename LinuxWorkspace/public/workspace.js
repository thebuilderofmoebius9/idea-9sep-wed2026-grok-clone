export const storageKey = "botworkspace-linux-v1";

export function freshWorkspace() {
  return {
    bots: [{ id: "atom", name: "Atom", role: "ผู้ช่วยวิศวกรรม", color: "#8b5cf6" }],
    conversations: [{ id: "welcome", title: "เริ่มต้นใช้งาน", members: ["atom"], messages: [{ author: "Atom", text: "สร้างบอท กลุ่ม หรือเริ่มบทสนทนาใหม่ได้จากแถบซ้าย", at: Date.now() }] }],
  };
}

export function loadWorkspace(storage) {
  try {
    const value = JSON.parse(storage.getItem(storageKey));
    if (Array.isArray(value?.bots) && Array.isArray(value?.conversations)) return value;
  } catch { /* Start clean if an old browser value is malformed. */ }
  return freshWorkspace();
}

export function saveWorkspace(storage, workspace) {
  storage.setItem(storageKey, JSON.stringify(workspace));
}

export function addConversation(workspace, title = "บทสนทนาใหม่") {
  const conversation = { id: crypto.randomUUID(), title, members: [], messages: [] };
  workspace.conversations.unshift(conversation);
  return conversation;
}

export function addBot(workspace, name, role) {
  const bot = { id: crypto.randomUUID(), name, role: role || "AI teammate", color: "#0ea5e9" };
  workspace.bots.push(bot);
  return bot;
}

export function addMessage(conversation, text) {
  if (!text.trim()) return false;
  conversation.messages.push({ author: "คุณ", text: text.trim(), at: Date.now() });
  return true;
}
