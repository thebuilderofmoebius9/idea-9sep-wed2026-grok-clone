// BotWorkspace Linux — workspace shell. Talks only to the local 127.0.0.1 API.

const $ = (selector) => document.querySelector(selector);
const el = (tag, attributes = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
};

const state = {
  snapshot: null,
  selectedID: null,
  page: { messages: [], hasMore: false },
  draft: { text: "", replyToID: null, attachmentIDs: [] },
  manualTargets: [],
  mentionOrder: null,
  bottomVisible: true,
  showHidden: false,
  searchResults: null,
  readRetry: null,
};

async function api(path, { method = "GET", body, raw } = {}) {
  const options = { method, headers: {} };
  if (raw) { options.body = raw.bytes; options.headers["content-type"] = raw.mime; }
  else if (body !== undefined) {
    options.headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) throw Object.assign(new Error(payload.error ?? `HTTP ${response.status}`), { payload, status: response.status });
  return payload;
}

let toastTimer;
function toast(message, { error = false } = {}) {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  node.style.borderColor = error ? "var(--warning)" : "var(--separator)";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, error ? 7000 : 3500);
}

const bots = () => state.snapshot?.bots ?? [];
const bot = (id) => bots().find((item) => item.id === id);
const conversation = () => state.snapshot?.conversations.find((item) => item.id === state.selectedID);
const activity = (id) => state.snapshot?.conversationActivity.find((item) => item.conversationID === id);
const generationsFor = (userMessageID) =>
  (state.snapshot?.generations ?? []).filter((item) => item.userMessageID === userMessageID);
const liveGenerations = (conversationID) => (state.snapshot?.generations ?? [])
  .filter((item) => item.conversationID === conversationID
    && !["completed", "failed", "cancelled", "interrupted"].includes(item.state));

const relative = (iso) => {
  if (!iso) return "";
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay
    ? date.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
};

const avatar = (record, size = 16) => el("span", {
  class: `avatar c-${record?.color ?? "gray"}`,
  "data-shape": record?.shape ?? "circle",
  style: `width:${size}px;height:${size}px`,
  "aria-hidden": "true",
});

/** Minimal, escaping-first inline rendering: fenced blocks, inline code, nothing else. */
function renderText(text) {
  const wrapper = el("div", { class: "body" });
  const parts = String(text).split(/```/);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      wrapper.append(el("pre", {}, [el("code", { text: part.replace(/^\w*\n/, "") })]));
      return;
    }
    const segments = part.split(/`([^`]+)`/);
    segments.forEach((segment, position) => {
      if (position % 2 === 1) wrapper.append(el("code", { text: segment }));
      else if (segment) wrapper.append(document.createTextNode(segment));
    });
  });
  return wrapper;
}

// ── loading ────────────────────────────────────────────────────────────────

async function refresh({ keepScroll = true } = {}) {
  const previous = $("#messages").scrollTop;
  state.snapshot = await api("/api/snapshot");
  applyPreferences(state.snapshot.preferences);
  if (!state.selectedID || !conversation()) {
    state.selectedID = state.snapshot.conversations[0]?.id ?? null;
  }
  if (state.selectedID) {
    state.page = await api(`/api/messages?conversationID=${state.selectedID}&limit=200`);
    const draft = state.snapshot.drafts.find((item) => item.conversationID === state.selectedID);
    state.draft = draft
      ? { text: draft.text, replyToID: draft.replyToID, attachmentIDs: draft.attachmentIDs ?? [] }
      : { text: "", replyToID: null, attachmentIDs: [] };
  }
  render();
  if (keepScroll) $("#messages").scrollTop = previous || $("#messages").scrollHeight;
  else $("#messages").scrollTop = $("#messages").scrollHeight;
  maybeAcknowledgeRead();
}

function applyPreferences(preferences) {
  if (!preferences) return;
  const appearance = preferences.appearance === "system"
    ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark")
    : preferences.appearance;
  document.documentElement.dataset.appearance = appearance;
  document.documentElement.style.setProperty("--sidebar-width", `${preferences.sidebarWidth}px`);
  document.documentElement.style.setProperty("--inspector-width", `${preferences.inspectorWidth}px`);
  document.body.dataset.inspector = preferences.inspectorVisible ? "shown" : "hidden";
}

// ── rendering ──────────────────────────────────────────────────────────────

function render() {
  renderSidebar();
  renderChat();
  renderComposer();
  renderInspector();
}

function renderSidebar() {
  const list = $("#conversation-list");
  list.replaceChildren();
  const source = state.searchResults ?? state.snapshot.conversations;
  const hiddenIDs = new Set(bots().filter((item) => item.hiddenAt).map((item) => item.id));
  const visible = source.filter((item) =>
    state.showHidden || item.kind === "group" || !item.memberBotIDs.some((id) => hiddenIDs.has(id)));
  const ordered = [...visible].sort((left, right) => {
    const leftAt = activity(left.id)?.lastMessageAt ?? left.createdAt;
    const rightAt = activity(right.id)?.lastMessageAt ?? right.createdAt;
    return new Date(rightAt) - new Date(leftAt);
  });
  for (const item of ordered) {
    const info = activity(item.id);
    const unread = info?.unreadAssistantCount ?? 0;
    list.append(el("button", {
      class: "conversation",
      "aria-current": String(item.id === state.selectedID),
      onclick: () => select(item.id),
    }, [
      el("b", { text: item.kind === "group" ? `${item.title} · ${item.memberBotIDs.length} คน` : item.title }),
      el("span", { class: "preview", text: info?.lastMessagePreview ?? "ยังไม่มีข้อความ" }),
      el("time", { text: relative(info?.lastMessageAt) }),
      unread > 0
        ? el("span", {
            class: "badge",
            text: unread > 99 ? "99+" : String(unread),
            "aria-label": `ยังไม่ได้อ่าน ${unread} ข้อความ`,
          })
        : null,
    ]));
  }
  if (ordered.length === 0) list.append(el("small", { text: state.searchResults ? "ไม่พบผลการค้นหา" : "ยังไม่มีบทสนทนา" }));

  const botList = $("#bot-list");
  botList.replaceChildren();
  for (const item of bots()) {
    if (item.hiddenAt && !state.showHidden) continue;
    botList.append(el("li", { class: `bot${item.hiddenAt ? " hidden-bot" : ""}` }, [
      avatar(item),
      el("button", {
        class: "ghost",
        style: "text-align:left;padding:2px 4px",
        text: item.name,
        title: item.description || item.name,
        onclick: () => openBotEditor(item),
      }),
      el("button", {
        class: "ghost",
        text: item.hiddenAt ? "แสดง" : "ซ่อน",
        title: item.hiddenAt ? "เลิกซ่อนบอทนี้" : "ซ่อนบอทนี้ (ไม่เปลี่ยนสถานะการอ่าน)",
        onclick: async () => {
          await api(`/api/bots/${item.id}/hidden`, { method: "POST", body: { hidden: !item.hiddenAt } });
          await refresh();
        },
      }),
    ]));
  }
}

function renderChat() {
  const active = conversation();
  $("#chat-title").textContent = active?.title ?? "ไม่มีบทสนทนา";
  const memberNames = active?.memberBotIDs.map((id) => bot(id)?.name ?? "บอทที่ถูกลบ") ?? [];
  $("#chat-subtitle").textContent = !active
    ? "สร้างบทสนทนาใหม่จากแถบซ้าย"
    : active.kind === "group"
      ? `กลุ่มแชต · ${memberNames.length} สมาชิก · ${memberNames.join(", ")}`
      : `แชตตรง · ${memberNames.join(", ")}`;

  const pill = $("#provider-state");
  const provider = active?.kind === "direct"
    ? (() => { const owner = bot(active.memberBotIDs[0]); return owner?.providerConfigID ? state.snapshot.providers.find((item) => item.id === owner.providerConfigID) : null; })()
    : null;
  if (active?.kind === "group") {
    const unbound = active.memberBotIDs.filter((id) => !bot(id)?.providerConfigID).length;
    pill.textContent = unbound === 0 ? "ผูกผู้ให้บริการครบทุกสมาชิก" : `ยังไม่ผูกผู้ให้บริการ ${unbound} สมาชิก`;
    pill.className = unbound === 0 ? "pill" : "pill warn";
  } else if (provider) {
    const ready = state.snapshot.credentialReferences.includes(provider.credentialReference);
    pill.textContent = `${provider.name} · ${provider.modelID}${ready ? "" : " · ยังไม่ใส่ credential"}`;
    pill.className = ready ? "pill" : "pill warn";
  } else {
    pill.textContent = "ยังไม่ได้เชื่อมผู้ให้บริการ";
    pill.className = "pill warn";
  }

  const host = $("#messages");
  host.replaceChildren();
  let day = null;
  for (const message of state.page.messages) {
    const stamp = new Date(message.createdAt).toLocaleDateString("th-TH", { dateStyle: "medium" });
    if (stamp !== day) { day = stamp; host.append(el("div", { class: "day", text: stamp })); }
    const generation = message.generationID
      ? state.snapshot.generations.find((item) => item.id === message.generationID) : null;
    const streaming = generation && generation.state === "streaming";
    const speaker = message.role === "user" ? "คุณ" : (message.speakerNameSnapshot ?? "บอท");
    const node = el("article", {
      class: `msg ${message.role}${streaming ? " streaming" : ""}`,
      "data-sequence": message.sequence,
    }, [
      el("div", { class: "who" }, [
        message.role === "assistant" ? avatar(bot(message.speakerBotID), 12) : null,
        el("span", { text: speaker }),
        el("span", { text: new Date(message.createdAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" }) }),
        el("span", { class: "tools" }, [
          el("button", { class: "ghost", text: "ตอบกลับ", onclick: () => setReply(message.id) }),
          generation && generation.state === "failed"
            ? el("button", { class: "ghost", text: "ลองใหม่", onclick: () => retry(generation.id) })
            : null,
        ]),
      ]),
    ]);
    if (message.replyToID) {
      const parent = state.page.messages.find((item) => item.id === message.replyToID);
      node.append(el("div", {
        class: "quote",
        text: parent ? `${parent.role === "user" ? "คุณ" : parent.speakerNameSnapshot ?? "บอท"}: ${parent.text}` : "ข้อความต้นทางใช้ไม่ได้แล้ว",
      }));
    }
    node.append(renderText(message.text));
    if (message.attachmentIDs?.length) {
      node.append(el("div", { class: "row", style: "flex-wrap:wrap;gap:6px;margin-top:4px" },
        message.attachmentIDs.map((id) => {
          const file = state.snapshot.attachments.find((item) => item.id === id);
          return el("a", { class: "chip", href: `/api/attachments/${id}`, text: file ? `${file.name} · ${Math.ceil(file.byteCount / 1024)} KB` : "ไฟล์" });
        })));
    }
    host.append(node);
  }
  if (state.page.messages.length === 0) {
    host.append(el("p", { class: "muted", text: "ยังไม่มีข้อความในบทสนทนานี้" }));
  }
  host.append(el("div", { id: "bottom-anchor", style: "height:1px" }));
  observeBottom();
  renderRoundStatus();
}

function renderRoundStatus() {
  const host = $("#round-status");
  const active = conversation();
  if (!active) { host.hidden = true; return; }
  const latestUser = [...state.page.messages].reverse().find((item) => item.role === "user");
  const generations = latestUser ? generationsFor(latestUser.id) : [];
  if (generations.length === 0) { host.hidden = true; return; }
  const labels = {
    queued: "เข้าคิว", connecting: "กำลังเชื่อมต่อ", streaming: "กำลังตอบ",
    completed: "เสร็จแล้ว", failed: "ผิดพลาด", cancelled: "ถูกยกเลิก", interrupted: "ถูกขัดจังหวะ",
  };
  host.replaceChildren();
  const ordered = [...generations].sort((left, right) => (left.roundIndex ?? 0) - (right.roundIndex ?? 0));
  for (const generation of ordered) {
    host.append(el("div", { class: "member" }, [
      avatar(bot(generation.targetBotID), 12),
      el("span", { text: generation.targetSpeakerNameSnapshot ?? "บอท" }),
      el("span", { class: `state${generation.state === "failed" ? " failed" : ""}`, text: labels[generation.state] ?? generation.state }),
      generation.error ? el("span", { class: "state failed", text: `— ${generation.error}` }) : null,
      generation.state === "failed"
        ? el("button", { class: "ghost", text: "ลองใหม่เฉพาะคนนี้", onclick: () => retry(generation.id) })
        : null,
    ]));
  }
  const live = ordered.some((item) => !["completed", "failed", "cancelled", "interrupted"].includes(item.state));
  if (live) {
    host.append(el("button", {
      class: "secondary",
      style: "justify-self:start",
      text: "หยุดรอบนี้ (เก็บคำตอบที่เสร็จแล้วไว้)",
      onclick: async () => {
        await api(`/api/rounds/${latestUser.id}/stop`, { method: "POST", body: {} });
        await refresh();
      },
    }));
  }
  host.hidden = false;
}

function renderComposer() {
  const active = conversation();
  $("#composer").value = state.draft.text;
  $("#composer").disabled = !active;
  $("#send").disabled = !active;

  const replyCard = $("#reply-card");
  if (state.draft.replyToID) {
    const parent = state.page.messages.find((item) => item.id === state.draft.replyToID);
    $("#reply-excerpt").textContent = parent
      ? `${parent.role === "user" ? "คุณ" : parent.speakerNameSnapshot ?? "บอท"}: ${parent.text}`
      : "ข้อความต้นทางใช้ไม่ได้แล้ว";
    replyCard.hidden = false;
  } else {
    replyCard.hidden = true;
  }

  const strip = $("#attachment-strip");
  strip.replaceChildren();
  if (state.draft.attachmentIDs.length) {
    for (const id of state.draft.attachmentIDs) {
      const file = state.snapshot.attachments.find((item) => item.id === id);
      strip.append(el("span", { class: "chip" }, [
        el("span", { text: file ? `${file.name} · ${Math.ceil(file.byteCount / 1024)} KB` : "ไฟล์" }),
        el("button", {
          type: "button", class: "ghost", text: "✕", "aria-label": "เอาไฟล์ออก",
          onclick: () => {
            state.draft.attachmentIDs = state.draft.attachmentIDs.filter((item) => item !== id);
            persistDraft(); renderComposer();
          },
        }),
      ]));
    }
    strip.hidden = false;
  } else {
    strip.hidden = true;
  }

  const recipients = $("#recipients");
  if (active?.kind === "group") {
    const available = active.memberBotIDs.map((id) => bot(id)).filter(Boolean);
    const mentioned = state.mentionOrder;
    const list = $("#recipient-list");
    list.replaceChildren();
    $("#recipient-source").textContent = mentioned
      ? "— มาจาก mention ในฉบับร่าง แก้ที่ mention เพื่อเปลี่ยนลำดับ"
      : "— เลือกเอง";
    const shown = mentioned ?? state.manualTargets.map((id) => bot(id)).filter(Boolean);
    for (const [index, member] of shown.entries()) {
      list.append(el("li", {}, [
        el("span", { text: `${index + 1}. ${member.name}` }),
        mentioned ? null : el("span", { class: "order" }, [
          el("button", { type: "button", class: "ghost", text: "↑", "aria-label": "เลื่อนขึ้น", onclick: () => moveTarget(member.id, -1) }),
          el("button", { type: "button", class: "ghost", text: "↓", "aria-label": "เลื่อนลง", onclick: () => moveTarget(member.id, 1) }),
          el("button", { type: "button", class: "ghost", text: "✕", "aria-label": "เอาออก", onclick: () => toggleTarget(member.id) }),
        ]),
      ]));
    }
    if (!mentioned) {
      const remaining = available.filter((member) => !state.manualTargets.includes(member.id));
      if (remaining.length) {
        list.append(el("li", {}, [el("span", { class: "row", style: "flex-wrap:wrap" },
          remaining.map((member) => el("button", {
            type: "button", class: "ghost", text: `＋ ${member.name}`, onclick: () => toggleTarget(member.id),
          })))]));
      }
    }
    recipients.hidden = false;
  } else {
    recipients.hidden = true;
  }
  $("#mention").hidden = active?.kind !== "group";
}

function renderInspector() {
  const active = conversation();
  const host = $("#routine-list");
  host.replaceChildren();
  const ownerIDs = active?.memberBotIDs ?? [];
  const routines = (state.snapshot?.routines ?? []).filter((item) => ownerIDs.includes(item.ownerBotID));
  if (routines.length === 0) host.append(el("p", { class: "muted small", text: "ยังไม่มี routine สำหรับบอทในบทสนทนานี้" }));
  for (const routine of routines) {
    const runs = (state.snapshot.routineRuns ?? []).filter((item) => item.routineID === routine.id).slice(-3).reverse();
    host.append(el("div", { class: "routine" }, [
      el("header", {}, [
        el("b", { text: routine.name }),
        el("span", { class: "small", text: routine.enabled ? "เปิด" : "ปิด" }),
      ]),
      el("span", {
        class: "small",
        text: routine.trigger.type === "interval"
          ? `ทุก ${routine.trigger.minutes} นาที · ${routine.timezoneID}`
          : `ทุกวัน ${String(routine.trigger.hour).padStart(2, "0")}:${String(routine.trigger.minute).padStart(2, "0")} · ${routine.timezoneID}`,
      }),
      el("span", { class: "small", text: routine.nextRunAt ? `รอบถัดไป ${new Date(routine.nextRunAt).toLocaleString("th-TH")}` : "ยังไม่กำหนดรอบถัดไป" }),
      ...runs.map((run) => el("span", { class: `run${run.status === "failed" ? " failed" : ""}` }, [
        el("span", { text: `${run.status} · ${new Date(run.startedAt).toLocaleString("th-TH")}` }),
        el("span", { text: run.skippedCount > 0 ? `ข้ามไป ${run.skippedCount}` : "" }),
      ])),
      el("div", { class: "row" }, [
        el("button", { class: "ghost", text: "แก้ไข", onclick: () => openRoutineEditor(routine) }),
        el("button", {
          class: "ghost", text: "รันเดี๋ยวนี้",
          onclick: async () => {
            try {
              await api(`/api/routines/${routine.id}/run`, { method: "POST", body: {} });
              toast("เริ่มรัน routine แล้ว");
              await refresh();
            } catch (error) { toast(error.message, { error: true }); }
          },
        }),
        el("button", { class: "ghost", text: "ประวัติ", onclick: () => openRoutineHistory(routine) }),
        el("button", { class: "ghost", text: "ลบ", onclick: () => confirmRoutineDeletion(routine) }),
      ]),
    ]));
  }
  const files = $("#inspector-files");
  const attachments = (state.snapshot?.attachments ?? []).filter((item) => item.conversationID === state.selectedID);
  files.replaceChildren();
  if (attachments.length === 0) files.append(el("span", { text: "—" }));
  for (const file of attachments) {
    files.append(el("div", {}, [el("a", { href: `/api/attachments/${file.id}`, text: `${file.name} · ${Math.ceil(file.byteCount / 1024)} KB` })]));
  }
  files.append(el("p", { class: "muted small", text: "routine ทำงานเฉพาะตอนที่แอปนี้เปิดอยู่และเครื่องยังไม่หลับ ไม่ใช่ตัวรัน 24/7" }));
}

// ── interactions ───────────────────────────────────────────────────────────

async function select(id) {
  state.selectedID = id;
  state.manualTargets = [];
  state.mentionOrder = null;
  await refresh({ keepScroll: false });
}

function setReply(messageID) {
  state.draft.replyToID = messageID;
  persistDraft();
  renderComposer();
  $("#composer").focus();
}

function toggleTarget(id) {
  state.manualTargets = state.manualTargets.includes(id)
    ? state.manualTargets.filter((item) => item !== id)
    : [...state.manualTargets, id];
  renderComposer();
}

function moveTarget(id, delta) {
  const index = state.manualTargets.indexOf(id);
  const next = index + delta;
  if (index === -1 || next < 0 || next >= state.manualTargets.length) return;
  const copy = [...state.manualTargets];
  [copy[index], copy[next]] = [copy[next], copy[index]];
  state.manualTargets = copy;
  renderComposer();
}

let draftTimer;
function persistDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(async () => {
    if (!state.selectedID) return;
    try {
      await api("/api/drafts", { method: "POST", body: { conversationID: state.selectedID, ...state.draft } });
    } catch (error) { toast(`บันทึกฉบับร่างไม่สำเร็จ: ${error.message}`, { error: true }); }
  }, 350);
}

/** Resolves mentions locally-ish by asking the server for a review plan, without sending. */
let mentionCheckTimer;
function scheduleMentionPreview() {
  clearTimeout(mentionCheckTimer);
  mentionCheckTimer = setTimeout(async () => {
    const active = conversation();
    const hint = $("#composer-hint");
    if (!active || active.kind !== "group" || !state.draft.text.includes("@")) {
      state.mentionOrder = null;
      hint.textContent = "";
      hint.classList.remove("error");
      renderComposer();
      return;
    }
    try {
      const plan = await api("/api/send/review", {
        method: "POST",
        body: {
          conversationID: active.id, text: state.draft.text,
          replyToID: state.draft.replyToID, attachmentIDs: state.draft.attachmentIDs,
          manualTargets: state.manualTargets,
        },
      });
      state.mentionOrder = plan.source === "mention"
        ? plan.recipients.map((item) => ({ id: item.id, name: item.name })) : null;
      hint.textContent = plan.source === "mention"
        ? `mention จะส่งถึง ${plan.recipients.map((item) => item.display).join(" → ")}`
        : "";
      hint.classList.remove("error");
    } catch (error) {
      state.mentionOrder = null;
      hint.textContent = error.message;
      hint.classList.add("error");
    }
    renderComposer();
  }, 250);
}

async function retry(generationID) {
  try {
    await api(`/api/generations/${generationID}/retry`, { method: "POST", body: {} });
    await refresh();
  } catch (error) { toast(error.message, { error: true }); }
}

// ── read acknowledgement ───────────────────────────────────────────────────

let observer;
function observeBottom() {
  observer?.disconnect();
  const anchor = $("#bottom-anchor");
  if (!anchor) return;
  observer = new IntersectionObserver((entries) => {
    state.bottomVisible = entries.some((entry) => entry.isIntersecting);
    maybeAcknowledgeRead();
  }, { root: $("#messages"), threshold: 1 });
  observer.observe(anchor);
}

/**
 * Selecting a chat is not acknowledgement. The window must be visible, the bottom anchor in
 * view, the rendered latest message must match the snapshot exactly, and no generation may
 * still be live in this conversation.
 */
async function maybeAcknowledgeRead() {
  const active = conversation();
  if (!active || !state.bottomVisible) return;
  if (document.hidden || !document.hasFocus()) return;
  if (!$("#sheet-host").hidden) return;
  if (liveGenerations(active.id).length > 0) return;
  const info = activity(active.id);
  const rendered = state.page.messages.at(-1);
  if (!info || !rendered || rendered.id !== info.latestMessageID) return;
  if (info.unreadAssistantCount === 0) return;
  const observed = {
    messageID: rendered.id,
    sequence: rendered.sequence,
    byteCount: new TextEncoder().encode(rendered.text).length,
  };
  try {
    await api("/api/read", {
      method: "POST",
      body: { conversationID: active.id, throughSequence: rendered.sequence, observed },
    });
    // Badges clear only from a returned snapshot, never optimistically.
    state.snapshot = await api("/api/snapshot");
    state.readRetry = null;
    renderSidebar();
  } catch (error) {
    state.readRetry = active.id;
    toast("บันทึกสถานะการอ่านไม่สำเร็จ — กด ‘ลองบันทึกสถานะการอ่านอีกครั้ง’ ในแถบล่าง", { error: true });
  }
}

// ── sheets ─────────────────────────────────────────────────────────────────

function closeSheet() {
  $("#sheet-host").hidden = true;
  $("#sheet-host").replaceChildren();
  $("#overlay").hidden = true;
  maybeAcknowledgeRead();
}

function openSheet(title, build, { onClose } = {}) {
  const host = $("#sheet-host");
  const sheet = el("div", { class: "sheet" });
  sheet.append(el("h2", { id: "sheet-title", text: title }));
  host.replaceChildren(sheet);
  host.hidden = false;
  $("#overlay").hidden = false;
  build(sheet, () => (onClose ? onClose(closeSheet) : closeSheet()));
  const focusable = sheet.querySelector("input, textarea, select, button");
  focusable?.focus();
  host.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); (onClose ? onClose(closeSheet) : closeSheet()); }
    if (event.key === "Tab") {
      // Dialog focus trapping.
      const nodes = [...sheet.querySelectorAll("input, textarea, select, button, a[href]")]
        .filter((node) => !node.disabled && node.offsetParent !== null);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  };
  return sheet;
}

const field = (label, node) => el("label", {}, [label, node]);

function swatches(selected, onPick) {
  const row = el("div", { class: "swatches" });
  for (const color of ["green", "magenta", "gray", "violet", "blue", "orange"]) {
    row.append(el("button", {
      type: "button",
      class: `swatch avatar c-${color}`,
      "data-shape": "circle",
      "aria-pressed": String(color === selected.value),
      "aria-label": color,
      onclick: () => {
        selected.value = color;
        [...row.children].forEach((child) => child.setAttribute("aria-pressed", String(child.getAttribute("aria-label") === color)));
        onPick?.(color);
      },
    }));
  }
  return row;
}

function openBotCreator() {
  openSheet("สร้าง AI teammate", (sheet, close) => {
    const name = el("input", { maxlength: "80", required: true });
    const description = el("textarea", { rows: "3", placeholder: "บทบาทและวิธีทำงาน (ใช้เป็น system prompt)" });
    const color = { value: "green" };
    const shape = el("select", {}, ["circle", "square", "drop", "capsule"].map((value) => el("option", { value, text: value })));
    const templates = state.snapshot?.botTemplates ?? [];
    // A template only prefills these fields; the bot itself is created by the
    // normal path, so two installs are two independent bots.
    const template = el("select", {}, [
      el("option", { value: "", text: "เริ่มจากศูนย์" }),
      ...templates.map((item) => el("option", { value: item.id, text: item.name })),
    ]);
    template.onchange = () => {
      const chosen = templates.find((item) => item.id === template.value);
      if (!chosen) return;
      name.value = chosen.name;
      description.value = chosen.description;
      shape.value = chosen.shape;
      color.value = chosen.color;
      [...colorRow.children].forEach((child) => child.setAttribute("aria-pressed", String(child.getAttribute("aria-label") === chosen.color)));
    };
    const colorRow = swatches(color);
    sheet.append(el("div", { class: "fields" }, [
      field("เทมเพลตเริ่มต้น", template),
      field("ชื่อ", name), field("คำอธิบาย", description),
      field("รูปทรงอวาตาร", shape), el("div", {}, ["สีอวาตาร", colorRow]),
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "primary", text: "สร้าง",
        onclick: async () => {
          try {
            const created = await api("/api/bots", {
              method: "POST",
              body: { name: name.value, description: description.value, color: color.value, shape: shape.value },
            });
            close();
            await refresh();
            await select(created.conversation.id);
          } catch (error) { toast(error.message, { error: true }); }
        },
      }),
    ]));
  });
}

/** Profile editing uses a detached buffer: navigation cannot redirect a save. */
function openBotEditor(record) {
  const expected = { name: record.name, description: record.description, color: record.color, shape: record.shape };
  const buffer = { ...expected };
  let dirty = false;
  const guard = (close) => {
    if (!dirty) return close();
    if (confirm("มีการแก้ไขที่ยังไม่บันทึก ต้องการทิ้งการแก้ไขนี้ไหม")) close();
  };
  openSheet(`แก้โปรไฟล์ ${record.name}`, (sheet, close) => {
    const name = el("input", { value: buffer.name, maxlength: "80", oninput: (event) => { buffer.name = event.target.value; dirty = true; } });
    const description = el("textarea", { rows: "4", oninput: (event) => { buffer.description = event.target.value; dirty = true; } });
    description.value = buffer.description;
    const color = { value: buffer.color };
    const shape = el("select", { onchange: (event) => { buffer.shape = event.target.value; dirty = true; } },
      ["circle", "square", "drop", "capsule"].map((value) => el("option", { value, text: value, selected: value === buffer.shape })));
    const providerSelect = el("select", {}, [
      el("option", { value: "", text: "ยังไม่ผูก" }),
      ...state.snapshot.providers.map((provider) => el("option", {
        value: provider.id, text: `${provider.name} · ${provider.modelID}`,
        selected: provider.id === record.providerConfigID,
      })),
    ]);
    sheet.append(el("div", { class: "fields" }, [
      field("ชื่อ", name), field("คำอธิบาย", description), field("รูปทรง", shape),
      el("div", {}, ["สี", swatches(color, () => { dirty = true; })]),
      field("ผู้ให้บริการของบอทนี้", providerSelect),
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "danger", text: "ลบบอทนี้", onclick: () => confirmBotDeletion(record) }),
      el("button", { class: "secondary", text: "ยกเลิก", onclick: () => guard(close) }),
      el("button", {
        class: "primary", text: "บันทึก",
        onclick: async () => {
          try {
            await api(`/api/bots/${record.id}`, {
              method: "PATCH",
              body: { expected, replacement: { ...buffer, color: color.value } },
            });
            await api(`/api/bots/${record.id}/provider`, {
              method: "POST", body: { providerConfigID: providerSelect.value || null },
            });
            dirty = false;
            close();
            await refresh();
          } catch (error) {
            toast(error.message === "editConflict" ? "โปรไฟล์นี้เปลี่ยนไปแล้ว โหลดค่าล่าสุดก่อนบันทึกอีกครั้ง" : error.message, { error: true });
          }
        },
      }),
    ]));
  }, { onClose: guard });
}

/** Permanent deletion: affected-record counts, group names, explicit no-undo disclosure. */
async function confirmBotDeletion(record) {
  let plan;
  try { plan = await api(`/api/bots/${record.id}/deletion-plan`); }
  catch (error) { return toast(error.message, { error: true }); }
  openSheet(`ลบ ${plan.name} อย่างถาวร`, (sheet, close) => {
    sheet.append(el("p", { class: "warn-text", text: "การลบนี้ย้อนกลับไม่ได้ ประวัติในกลุ่มจะยังอยู่และคงชื่อผู้พูดเดิมไว้ แต่สมาชิกภาพในอนาคตจะถูกเอาออก" }));
    sheet.append(el("div", { class: "impact" }, [
      el("div", { text: `แชตตรงที่จะถูกลบ: ${plan.directConversationIDs.length}` }),
      el("div", { text: `ข้อความที่จะถูกลบ: ${plan.messageIDs.length}` }),
      el("div", { text: `ฉบับร่าง: ${plan.draftConversationIDs.length}` }),
      el("div", { text: `การตอบที่บันทึกไว้: ${plan.generationIDs.length}` }),
      el("div", { text: `routine: ${plan.routineIDs.length} · ประวัติรัน: ${plan.routineRunIDs.length}` }),
      el("div", { text: `ไฟล์แนบ: ${plan.attachmentIDs.length} (${Math.ceil(plan.attachmentBytes / 1024)} KB)` }),
      ...plan.affectedGroups.map((group) => el("div", {
        text: `กลุ่ม “${group.title}” จะเหลือสมาชิก ${group.remainingMemberBotIDs.length} คน`
          + (group.remainingMemberBotIDs.length < 2 ? " — จะแสดงปุ่มซ่อมแทนช่องพิมพ์" : ""),
      })),
      plan.activeGenerationIDs.length
        ? el("div", { class: "warn-text", text: `ยังมีการตอบที่ทำงานอยู่ ${plan.activeGenerationIDs.length} รายการ ต้องหยุดก่อนจึงจะลบได้` })
        : null,
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "danger", text: "ลบถาวร", disabled: plan.activeGenerationIDs.length > 0,
        onclick: async () => {
          try {
            await api(`/api/bots/${record.id}/delete`, { method: "POST", body: { expected: plan } });
            close();
            state.selectedID = null;
            await refresh({ keepScroll: false });
            toast(`ลบ ${plan.name} แล้ว`);
          } catch (error) {
            toast(error.code === "confirmationChanged"
              ? "รายการที่จะถูกลบเปลี่ยนไปแล้ว เปิดหน้ายืนยันใหม่"
              : error.message, { error: true });
          }
        },
      }),
    ]));
  });
}

function openGroupSheet(existing = null) {
  const available = bots().filter((item) => !item.hiddenAt);
  const selected = existing ? [...existing.memberBotIDs] : [];
  openSheet(existing ? `แก้กลุ่ม ${existing.title}` : "สร้างกลุ่มแชต", (sheet, close) => {
    const title = el("input", { value: existing?.title ?? "", maxlength: "80" });
    const list = el("div", { class: "impact" });
    const draw = () => {
      list.replaceChildren();
      for (const member of available) {
        const checked = selected.includes(member.id);
        list.append(el("label", { class: "check" }, [
          el("input", {
            type: "checkbox", checked,
            onchange: () => {
              if (selected.includes(member.id)) selected.splice(selected.indexOf(member.id), 1);
              else selected.push(member.id);
              draw();
            },
          }),
          `${checked ? `${selected.indexOf(member.id) + 1}. ` : ""}${member.name}`,
        ]));
      }
    };
    draw();
    sheet.append(el("div", { class: "fields" }, [field("ชื่อกลุ่ม", title), el("div", {}, ["สมาชิก 2–6 คน (ลำดับตามที่เลือก)", list])]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "primary", text: existing ? "บันทึก" : "สร้าง",
        onclick: async () => {
          try {
            if (existing) {
              await api(`/api/groups/${existing.id}`, {
                method: "PATCH",
                body: {
                  expected: { title: existing.title, memberBotIDs: existing.memberBotIDs },
                  replacement: { title: title.value, memberBotIDs: selected },
                },
              });
              close();
              await refresh();
            } else {
              const created = await api("/api/groups", { method: "POST", body: { title: title.value, memberBotIDs: selected } });
              close();
              await refresh();
              await select(created.id);
            }
          } catch (error) { toast(error.message, { error: true }); }
        },
      }),
    ]));
  });
}

// ── send review and confirmation ───────────────────────────────────────────

/** Nothing is sent and no credential is read merely because this review is open. */
async function openSendReview() {
  const active = conversation();
  if (!active) return;
  const text = $("#composer").value;
  if (!text.trim() && state.draft.attachmentIDs.length === 0) return;
  let plan;
  try {
    plan = await api("/api/send/review", {
      method: "POST",
      body: {
        conversationID: active.id, text,
        replyToID: state.draft.replyToID, attachmentIDs: state.draft.attachmentIDs,
        manualTargets: state.manualTargets,
      },
    });
  } catch (error) {
    const hint = $("#composer-hint");
    hint.textContent = error.message;
    hint.classList.add("error");
    return;
  }

  // A direct chat with one bound recipient does not need the round review sheet.
  if (active.kind === "direct") return confirmSend(plan, text);

  openSheet("ตรวจทานก่อนส่ง", (sheet, close) => {
    sheet.append(el("p", { class: "small", text: plan.disclosure }));
    sheet.append(el("div", { class: "impact" }, [
      el("div", { text: `จำนวนคำขอแยกกัน: ${plan.requestCount}` }),
      ...plan.recipients.map((recipient) => el("div", {
        text: `${recipient.index + 1}. ${recipient.display} — ${recipient.provider ? `${recipient.provider.name} · ${recipient.provider.modelID}` : "ยังไม่ผูกผู้ให้บริการ"}`,
      })),
      el("div", { text: `ที่มาของผู้รับ: ${plan.source === "mention" ? "mention ในฉบับร่าง" : "เลือกเอง"}` }),
      el("div", { text: `ไฟล์ที่จะส่งไปด้วย: ${plan.files.length ? plan.files.map((file) => file.name).join(", ") : "ไม่มี"}` }),
      el("div", { class: "mono", text: plan.readableText.slice(0, 400) }),
      plan.readableText !== plan.rawText
        ? el("div", { class: "small", text: "การผูก {uuid} ในฉบับร่างเป็นตัวระบุในเครื่องเท่านั้น จะไม่ถูกส่งออกไปกับข้อความ" })
        : null,
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", { class: "primary", text: `ยืนยันส่ง ${plan.requestCount} คำขอ`, onclick: () => { close(); confirmSend(plan, text); } }),
    ]));
  });
}

async function confirmSend(plan, rawText) {
  try {
    await api("/api/send/confirm", {
      method: "POST",
      body: { planID: plan.id, expectedDraftText: rawText },
    });
    state.draft = { text: "", replyToID: null, attachmentIDs: [] };
    state.mentionOrder = null;
    $("#composer").value = "";
    $("#composer-hint").textContent = "";
    await refresh({ keepScroll: false });
  } catch (error) { toast(error.message, { error: true }); }
}

// ── routines ───────────────────────────────────────────────────────────────

function openRoutineEditor(existing = null) {
  const active = conversation();
  const owners = (active?.memberBotIDs ?? bots().map((item) => item.id)).map((id) => bot(id)).filter(Boolean);
  openSheet(existing ? `แก้ routine ${existing.name}` : "สร้าง routine", (sheet, close) => {
    const owner = el("select", {}, owners.map((item) => el("option", {
      value: item.id, text: item.name, selected: item.id === existing?.ownerBotID,
    })));
    const name = el("input", { value: existing?.name ?? "", maxlength: "80" });
    const prompt = el("textarea", { rows: "3" });
    prompt.value = existing?.prompt ?? "";
    const kind = el("select", {}, [
      el("option", { value: "interval", text: "ทุก ๆ ช่วงเวลา", selected: existing?.trigger.type === "interval" }),
      el("option", { value: "daily", text: "ทุกวันตามเวลาท้องถิ่น", selected: existing?.trigger.type === "daily" }),
    ]);
    const minutes = el("input", { type: "number", min: "5", max: "525600", value: existing?.trigger.minutes ?? 60 });
    const hour = el("input", { type: "number", min: "0", max: "23", value: existing?.trigger.hour ?? 9 });
    const minute = el("input", { type: "number", min: "0", max: "59", value: existing?.trigger.minute ?? 0 });
    const timezone = el("input", { value: existing?.timezoneID ?? Intl.DateTimeFormat().resolvedOptions().timeZone });
    const enabled = el("input", { type: "checkbox", checked: existing?.enabled ?? false });
    const intervalRow = field("ทุกกี่นาที (อย่างน้อย 5)", minutes);
    const dailyRow = el("div", { class: "grid2" }, [field("ชั่วโมง", hour), field("นาที", minute)]);
    const sync = () => {
      intervalRow.hidden = kind.value !== "interval";
      dailyRow.hidden = kind.value !== "daily";
    };
    kind.addEventListener("change", sync);
    sheet.append(el("div", { class: "fields" }, [
      field("บอทเจ้าของ", owner), field("ชื่อ", name), field("prompt", prompt),
      field("รูปแบบเวลา", kind), intervalRow, dailyRow, field("ไทม์โซน", timezone),
      el("label", { class: "check" }, [enabled, "เปิดใช้งาน"]),
      el("p", { class: "small", text: "routine ทำงานเฉพาะตอนแอปเปิดและเครื่องไม่หลับ ถ้าพลาดหลายรอบจะรันรอบล่าสุดหนึ่งครั้งและรายงานจำนวนที่ข้ามไป" }),
    ]));
    sync();
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "primary", text: existing ? "บันทึก" : "สร้าง",
        onclick: async () => {
          const trigger = kind.value === "interval"
            ? { type: "interval", minutes: Number(minutes.value) }
            : { type: "daily", hour: Number(hour.value), minute: Number(minute.value) };
          const payload = {
            ownerBotID: owner.value, name: name.value, prompt: prompt.value,
            trigger, timezoneID: timezone.value, enabled: enabled.checked,
          };
          try {
            if (existing) {
              await api(`/api/routines/${existing.id}`, {
                method: "PATCH",
                body: {
                  expected: {
                    id: existing.id, name: existing.name, prompt: existing.prompt,
                    trigger: existing.trigger, timezoneID: existing.timezoneID, enabled: existing.enabled,
                  },
                  replacement: { ...payload, nextRunAt: existing.enabled === payload.enabled ? existing.nextRunAt : null },
                },
              });
            } else {
              await api("/api/routines", { method: "POST", body: payload });
            }
            close();
            await refresh();
          } catch (error) { toast(error.message, { error: true }); }
        },
      }),
    ]));
  });
}

async function openRoutineHistory(routine) {
  const runs = await api(`/api/routines/${routine.id}/runs`);
  openSheet(`ประวัติ ${routine.name}`, (sheet, close) => {
    sheet.append(el("div", { class: "impact" },
      runs.length === 0 ? [el("div", { text: "ยังไม่มีประวัติการรัน" })] : runs.map((run) => el("div", {
        class: run.status === "failed" ? "warn-text" : null,
        text: `${new Date(run.startedAt).toLocaleString("th-TH")} · ${run.status}`
          + (run.skippedCount ? ` · ข้ามไป ${run.skippedCount} รอบ` : "")
          + (run.error ? ` · ${run.error}` : ""),
      }))));
    sheet.append(el("div", { class: "actions" }, [el("button", { class: "secondary", text: "ปิด", onclick: close })]));
  });
}

async function confirmRoutineDeletion(routine) {
  const plan = await api(`/api/routines/${routine.id}/deletion-plan`);
  openSheet(`ลบ routine ${plan.name}`, (sheet, close) => {
    sheet.append(el("p", { class: "warn-text", text: "การลบนี้ย้อนกลับไม่ได้ ประวัติการรันจะถูกลบไปด้วย" }));
    sheet.append(el("div", { class: "impact" }, [
      el("div", { text: `ประวัติการรันที่จะถูกลบ: ${plan.runIDs.length}` }),
      plan.activeRunIDs.length ? el("div", { class: "warn-text", text: "ยังมีรอบที่กำลังรัน ต้องรอให้จบก่อน" }) : null,
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "danger", text: "ลบ", disabled: plan.activeRunIDs.length > 0,
        onclick: async () => {
          try {
            await api(`/api/routines/${routine.id}/delete`, { method: "POST", body: { expected: plan } });
            close();
            await refresh();
          } catch (error) { toast(error.message, { error: true }); }
        },
      }),
    ]));
  });
}

// ── settings ───────────────────────────────────────────────────────────────

function openSettings() {
  const buffer = { ...state.snapshot.preferences };
  let dirty = false;
  const guard = (close) => {
    if (!dirty) return close();
    if (confirm("มีการตั้งค่าที่ยังไม่บันทึก ต้องการทิ้งไหม")) close();
  };
  openSheet("ตั้งค่า", (sheet, close) => {
    const appearance = el("select", { onchange: (event) => { buffer.appearance = event.target.value; dirty = true; } },
      [["dark", "Dark (ค่าเริ่มต้นตามรีเฟอเรนซ์)"], ["light", "Light"], ["system", "ตามระบบ"]]
        .map(([value, text]) => el("option", { value, text, selected: buffer.appearance === value })));
    sheet.append(el("div", { class: "fields" }, [field("ธีม", appearance)]));

    sheet.append(el("div", { class: "label", text: "ผู้ให้บริการโมเดล" }));
    const providers = el("div", { class: "impact" });
    const drawProviders = () => {
      providers.replaceChildren();
      if (state.snapshot.providers.length === 0) providers.append(el("div", { text: "ยังไม่มีผู้ให้บริการ" }));
      for (const provider of state.snapshot.providers) {
        const ready = state.snapshot.credentialReferences.includes(provider.credentialReference);
        providers.append(el("div", { class: "run" }, [
          el("span", { text: `${provider.name} · ${provider.modelID} · ${ready ? "มี credential ในเซสชันนี้" : "ยังไม่ใส่ credential"}` }),
          el("span", {}, [
            el("button", { class: "ghost", text: "ใส่ credential", onclick: () => askCredential(provider, drawProviders) }),
            el("button", {
              class: "ghost", text: "ลบ",
              onclick: async () => {
                if (!confirm(`ลบผู้ให้บริการ ${provider.name}?`)) return;
                await api(`/api/providers/${provider.id}`, { method: "DELETE", body: {} });
                await refresh();
                drawProviders();
              },
            }),
          ]),
        ]));
      }
    };
    drawProviders();
    sheet.append(providers);
    sheet.append(el("button", { class: "secondary", style: "justify-self:start", text: "＋ เพิ่มผู้ให้บริการ", onclick: () => openProviderSheet(drawProviders) }));

    sheet.append(el("div", { class: "label", text: "ส่งออกเวิร์กสเปซ" }));
    sheet.append(el("p", { class: "small", text: "ไฟล์ export รูปแบบ v3 มีบอท บทสนทนา ข้อความ ฉบับร่าง routine ประวัติการรัน และรายการไฟล์แนบ — มีเฉพาะ credential reference ไม่มีค่า secret จริง และไม่รวมฟอร์มที่ยังไม่บันทึก" }));
    sheet.append(el("a", { class: "secondary", style: "justify-self:start;padding:9px 12px;text-decoration:none", href: "/api/export", text: "ดาวน์โหลดไฟล์ export" }));

    sheet.append(el("div", { class: "label", text: "เกี่ยวกับ" }));
    sheet.append(el("p", { class: "small", text: "BotWorkspace Linux เป็นการเขียนใหม่แบบอิสระตามภาพและโฟลว์ที่ผู้ใช้ให้มา ไม่ได้ใช้โค้ดหรือ API ส่วนตัวของแอปต้นทาง แผงคอมพิวเตอร์เป็นสถานะตัดการเชื่อมต่อ ไม่ใช่เครื่องจริงบนคลาวด์" }));

    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: () => guard(close) }),
      el("button", {
        class: "primary", text: "บันทึก",
        onclick: async () => {
          await api("/api/preferences", { method: "POST", body: buffer });
          dirty = false;
          close();
          await refresh();
        },
      }),
    ]));
  }, { onClose: guard });
}

function openProviderSheet(after) {
  openSheet("เพิ่มผู้ให้บริการ", (sheet, close) => {
    const preset = el("select", {}, state.snapshot.presets.map((item) => el("option", { value: item.id, text: item.name })));
    const name = el("input", { value: "" });
    const apiRoot = el("input", { value: state.snapshot.presets[0].apiRoot });
    const model = el("input", { value: "" });
    const loopback = el("input", { type: "checkbox" });
    const guidance = el("p", { class: "small", text: state.snapshot.presets[0].guidance });
    preset.addEventListener("change", () => {
      const chosen = state.snapshot.presets.find((item) => item.id === preset.value);
      apiRoot.value = chosen.apiRoot;
      model.value = chosen.suggestedModel;
      name.value = chosen.name;
      guidance.textContent = chosen.guidance;
      loopback.checked = chosen.apiRoot.startsWith("http://");
    });
    const secret = el("input", { type: "password", placeholder: "API key (เก็บในหน่วยความจำเซสชันนี้เท่านั้น)" });
    // Codex uses a session handed over from an auth file instead of an API key,
    // so the key field and the API root are locked while it is selected.
    const codex = el("input", { type: "checkbox" });
    const codexPath = el("input", { placeholder: "/home/<ผู้ใช้>/.codex/auth.json" });
    codex.onchange = () => {
      apiRoot.value = codex.checked ? "https://chatgpt.com/backend-api/codex" : state.snapshot.presets[0].apiRoot;
      apiRoot.disabled = codex.checked;
      secret.disabled = codex.checked;
      if (codex.checked && !model.value) model.value = "gpt-5.6-luna";
    };
    sheet.append(el("div", { class: "fields" }, [
      el("label", { class: "check" }, [codex, "ใช้ Codex (ChatGPT) ผ่านไฟล์ auth — สถานะทดลอง"]),
      field("พาธไฟล์ auth ของ Codex", codexPath),
      field("เทมเพลต", preset), guidance, field("ชื่อที่ใช้เรียก", name),
      field("API root", apiRoot), field("model", model),
      el("label", { class: "check" }, [loopback, "อนุญาต HTTP บน loopback (สำหรับ gateway ในเครื่อง)"]),
      field("credential", secret),
      el("p", { class: "small", text: "ค่า credential ไม่ถูกเขียนลงไฟล์เวิร์กสเปซและไม่อยู่ในไฟล์ export — ต้องใส่ใหม่ทุกครั้งที่เริ่มเซิร์ฟเวอร์" }),
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "primary", text: "บันทึก",
        onclick: async () => {
          try {
            const imported = codex.checked
              ? await api("/api/codex-auth", { method: "POST", body: { path: codexPath.value } })
              : null;
            const reference = imported?.credentialReference ?? `provider-${crypto.randomUUID()}`;
            const saved = await api("/api/providers", {
              method: "POST",
              body: {
                name: name.value || "ผู้ให้บริการ", apiRoot: apiRoot.value, modelID: model.value,
                credentialReference: reference, allowsLoopbackHTTP: loopback.checked,
                kind: codex.checked ? "codexResponses" : "chatCompletions",
              },
            });
            if (!codex.checked && secret.value) await api("/api/credentials", { method: "POST", body: { reference: saved.credentialReference, value: secret.value } });
            close();
            await refresh();
            after?.();
          } catch (error) { toast(error.message, { error: true }); }
        },
      }),
    ]));
  });
}

function askCredential(provider, after) {
  openSheet(`credential ของ ${provider.name}`, (sheet, close) => {
    const secret = el("input", { type: "password", placeholder: "API key" });
    sheet.append(el("div", { class: "fields" }, [
      field("credential", secret),
      el("p", { class: "small", text: "เก็บในหน่วยความจำของกระบวนการเซิร์ฟเวอร์เท่านั้น ไม่เขียนลงดิสก์" }),
    ]));
    sheet.append(el("div", { class: "actions" }, [
      el("button", { class: "secondary", text: "ยกเลิก", onclick: close }),
      el("button", {
        class: "primary", text: "บันทึกในเซสชัน",
        onclick: async () => {
          try {
            await api("/api/credentials", { method: "POST", body: { reference: provider.credentialReference, value: secret.value } });
            close();
            await refresh();
            after?.();
          } catch (error) { toast(error.message, { error: true }); }
        },
      }),
    ]));
  });
}

// ── mention insertion ──────────────────────────────────────────────────────

/**
 * One-shot insertion bound to conversation and expected draft. Navigation or newer text
 * rejects it rather than performing a surprise delayed edit.
 */
function openMentionPicker() {
  const active = conversation();
  if (!active || active.kind !== "group") return;
  const expectedConversationID = active.id;
  const composer = $("#composer");
  const expectedText = composer.value;
  const selectionStart = composer.selectionStart;
  const selectionEnd = composer.selectionEnd;
  const available = active.memberBotIDs.map((id) => bot(id)).filter(Boolean);
  const counts = new Map();
  for (const member of available) counts.set(member.name, (counts.get(member.name) ?? 0) + 1);

  openSheet("แทรก mention", (sheet, close) => {
    sheet.append(el("p", { class: "small", text: "เมนูนี้แทรกข้อความ @\"ชื่อ\"{uuid} ลงในฉบับร่าง ตัวระบุจะเห็นได้ตลอดและไม่ถูกส่งออกไปกับข้อความ" }));
    const list = el("div", { class: "impact" });
    for (const member of available) {
      const duplicated = counts.get(member.name) > 1;
      list.append(el("button", {
        class: "ghost",
        style: "text-align:left",
        text: duplicated ? `${member.name} · ${member.id.slice(0, 8)}` : member.name,
        title: `identity ${member.id}`,
        onclick: async () => {
          if (state.selectedID !== expectedConversationID || composer.value !== expectedText) {
            close();
            return toast("ฉบับร่างหรือบทสนทนาเปลี่ยนไปแล้ว จึงไม่แทรก mention — เลือก Mention อีกครั้ง", { error: true });
          }
          const { token } = await api("/api/mention-token", { method: "POST", body: { id: member.id, name: member.name } });
          const before = expectedText.slice(0, selectionStart);
          const after = expectedText.slice(selectionEnd);
          const spacedBefore = before && !/\s$/.test(before) ? `${before} ` : before;
          const spacedAfter = after && !/^\s/.test(after) ? ` ${after}` : after;
          composer.value = `${spacedBefore}${token}${spacedAfter}`;
          const caret = `${spacedBefore}${token}`.length;
          composer.setSelectionRange(caret, caret);
          state.draft.text = composer.value;
          persistDraft();
          scheduleMentionPreview();
          close();
          composer.focus();
        },
      }));
    }
    sheet.append(list);
    sheet.append(el("div", { class: "actions" }, [el("button", { class: "secondary", text: "ปิด", onclick: close })]));
  });
}

// ── divider dragging ───────────────────────────────────────────────────────

function wireDivider(node, key, { min, max, invert = false }) {
  const start = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const initial = Number(state.snapshot.preferences[key]);
    const move = (moveEvent) => {
      const delta = (moveEvent.clientX - startX) * (invert ? -1 : 1);
      const width = Math.min(max, Math.max(min, initial + delta));
      document.documentElement.style.setProperty(
        key === "sidebarWidth" ? "--sidebar-width" : "--inspector-width", `${width}px`);
      node.dataset.pending = String(Math.round(width));
    };
    const finish = async () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      if (node.dataset.pending) {
        // Dragged widths persist as a local UI preference, separate from workspace data.
        await api("/api/preferences", { method: "POST", body: { ...state.snapshot.preferences, [key]: Number(node.dataset.pending) } });
        state.snapshot.preferences[key] = Number(node.dataset.pending);
        delete node.dataset.pending;
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
  };
  node.addEventListener("pointerdown", start);
  node.addEventListener("keydown", async (event) => {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    const width = Math.min(max, Math.max(min, Number(state.snapshot.preferences[key]) + step * (invert ? -1 : 1)));
    await api("/api/preferences", { method: "POST", body: { ...state.snapshot.preferences, [key]: width } });
    await refresh();
  });
}

// ── wiring ─────────────────────────────────────────────────────────────────

$("#new-bot").addEventListener("click", openBotCreator);
$("#new-group").addEventListener("click", () => openGroupSheet());
$("#new-chat").addEventListener("click", openBotCreator);
$("#new-routine").addEventListener("click", () => openRoutineEditor());
$("#open-settings").addEventListener("click", openSettings);
$("#mention").addEventListener("click", openMentionPicker);
$("#cancel-reply").addEventListener("click", () => { state.draft.replyToID = null; persistDraft(); renderComposer(); });
$("#edit-conversation").addEventListener("click", () => {
  const active = conversation();
  if (!active) return;
  if (active.kind === "group") openGroupSheet(active);
  else {
    const owner = bot(active.memberBotIDs[0]);
    if (owner) openBotEditor(owner);
  }
});
$("#toggle-inspector").addEventListener("click", async () => {
  await api("/api/preferences", {
    method: "POST",
    body: { ...state.snapshot.preferences, inspectorVisible: !state.snapshot.preferences.inspectorVisible },
  });
  await refresh();
});
$("#show-hidden").addEventListener("change", (event) => { state.showHidden = event.target.checked; renderSidebar(); });

let searchTimer;
$("#search").addEventListener("input", (event) => {
  clearTimeout(searchTimer);
  const query = event.target.value.trim();
  searchTimer = setTimeout(async () => {
    state.searchResults = query ? await api(`/api/search?q=${encodeURIComponent(query)}&includeHidden=${state.showHidden ? 1 : 0}`) : null;
    renderSidebar();
  }, 200);
});

$("#composer").addEventListener("input", (event) => {
  state.draft.text = event.target.value;
  persistDraft();
  scheduleMentionPreview();
});
$("#composer").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    openSendReview();
  }
});
$("#composer-form").addEventListener("submit", (event) => { event.preventDefault(); openSendReview(); });

$("#file-input").addEventListener("change", async (event) => {
  const active = conversation();
  if (!active) return;
  for (const file of event.target.files) {
    try {
      const bytes = await file.arrayBuffer();
      const saved = await api(
        `/api/attachments?conversationID=${active.id}&name=${encodeURIComponent(file.name)}`,
        { method: "POST", raw: { bytes, mime: file.type || "application/octet-stream" } });
      state.draft.attachmentIDs = [...state.draft.attachmentIDs, saved.id];
    } catch (error) { toast(`แนบไฟล์ ${file.name} ไม่สำเร็จ: ${error.message}`, { error: true }); }
  }
  event.target.value = "";
  persistDraft();
  state.snapshot = await api("/api/snapshot");
  renderComposer();
  renderInspector();
});

$("#messages").addEventListener("scroll", async () => {
  const host = $("#messages");
  if (host.scrollTop < 60 && state.page.hasMore && state.page.beforeSequence) {
    const older = await api(`/api/messages?conversationID=${state.selectedID}&beforeSequence=${state.page.beforeSequence}&limit=100`);
    state.page = { messages: [...older.messages, ...state.page.messages], hasMore: older.hasMore, beforeSequence: older.beforeSequence };
    const previousHeight = host.scrollHeight;
    renderChat();
    host.scrollTop = host.scrollHeight - previousHeight;
  }
});
window.addEventListener("focus", maybeAcknowledgeRead);
document.addEventListener("visibilitychange", maybeAcknowledgeRead);
matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => applyPreferences(state.snapshot?.preferences));

// Live updates: deltas and revisions arrive over SSE so the transcript streams in place.
let liveTimer;
function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "hello") return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => { refresh().catch(() => {}); }, 90);
  };
  source.onerror = () => {
    source.close();
    setTimeout(connectEvents, 2000);
  };
}

(async function boot() {
  // Installable shell only; failing registration must never block the app.
  navigator.serviceWorker?.register("/service-worker.js").catch(() => {});
  try {
    await refresh({ keepScroll: false });
    wireDivider($("#divider-left"), "sidebarWidth", { min: 240, max: 400 });
    wireDivider($("#divider-right"), "inspectorWidth", { min: 280, max: 480, invert: true });
    connectEvents();
  } catch (error) {
    document.body.append(el("p", { class: "warn-text", style: "padding:24px", text: `เริ่มต้นไม่สำเร็จ: ${error.message}` }));
  }
})();
