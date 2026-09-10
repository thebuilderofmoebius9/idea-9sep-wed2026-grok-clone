// File-backed workspace repository. Replaces Core Data on Linux while keeping the same
// mutation surface, revision checks and read-state contract as WorkspaceRepository.swift.

import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  TERMINAL_STATES, fail, isUUID, newBot, newConversation, previewText, utf8ByteCount,
  uuid, validBotProfile, validGroupProfile, validProvider, validRoutine,
} from "./domain.mjs";

export const SCHEMA = 4;
export const EXPORT_FORMAT = 3;

export function defaultStoreDirectory() {
  const base = process.env.BOTWORKSPACE_HOME
    ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "botworkspace-linux");
  return base;
}

const emptyState = () => ({
  schema: SCHEMA,
  revision: 0,
  bots: [],
  conversations: [],
  messages: [],
  drafts: [],
  generations: [],
  routines: [],
  routineRuns: [],
  providers: [],
  attachments: [],
  preferences: { appearance: "system", sidebarWidth: 280, inspectorWidth: 320, inspectorVisible: true },
});

export class WorkspaceStore {
  #state;
  #path;
  #attachmentDirectory;

  constructor({ directory = defaultStoreDirectory(), seed = true } = {}) {
    this.#path = join(directory, "workspace.json");
    this.#attachmentDirectory = join(directory, "attachments");
    mkdirSync(this.#attachmentDirectory, { recursive: true });
    this.#state = this.#load();
    if (seed && this.#state.bots.length === 0) this.#seed();
    // A previous process may have been killed mid-stream: never leave a live-looking generation.
    this.interruptPending();
  }

  #load() {
    if (!existsSync(this.#path)) return emptyState();
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch {
      return fail("invalidStore");
    }
    if (Number(parsed.schema) > SCHEMA) fail("unsupportedSchema");
    return { ...emptyState(), ...parsed, schema: SCHEMA };
  }

  #persist() {
    const temporary = `${this.#path}.tmp`;
    mkdirSync(dirname(this.#path), { recursive: true });
    try {
      writeFileSync(temporary, JSON.stringify(this.#state, null, 2), "utf8");
      renameSync(temporary, this.#path);
    } catch {
      fail("storeUnavailable");
    }
  }

  #commit() {
    this.#state.revision += 1;
    this.#persist();
    return this.#state.revision;
  }

  #seed() {
    const bot = newBot({ name: "Atom", description: "ผู้ช่วยวิศวกรรม", color: "violet", shape: "circle" });
    this.#state.bots.push(bot);
    const conversation = newConversation({ kind: "direct", title: bot.name, memberBotIDs: [bot.id] });
    this.#state.conversations.push(conversation);
    this.#append(conversation.id, {
      role: "assistant",
      speakerBotID: bot.id,
      speakerNameSnapshot: bot.name,
      text: "สร้างบอท กลุ่ม หรือ routine ได้จากแถบซ้าย ผูกผู้ให้บริการก่อนจะเริ่มคุยจริงได้",
    });
    this.#commit();
  }

  // ── reads ────────────────────────────────────────────────────────────────

  get revision() { return this.#state.revision; }

  bot(id) { return this.#state.bots.find((item) => item.id === id); }
  conversation(id) { return this.#state.conversations.find((item) => item.id === id); }
  generation(id) { return this.#state.generations.find((item) => item.id === id); }
  routine(id) { return this.#state.routines.find((item) => item.id === id); }
  provider(id) { return this.#state.providers.find((item) => item.id === id); }

  /// Activity is derived from the latest message only: a snapshot never loads a transcript.
  activity() {
    return this.#state.conversations.map((conversation) => {
      const messages = this.#state.messages.filter((message) => message.conversationID === conversation.id);
      const latest = messages.at(-1);
      const unread = messages.filter((message) =>
        message.role === "assistant" && message.sequence > conversation.lastReadSequence).length;
      return {
        conversationID: conversation.id,
        latestSequence: latest?.sequence ?? 0,
        latestMessageID: latest?.id ?? null,
        latestMessageTextByteCount: utf8ByteCount(latest?.text ?? ""),
        lastMessagePreview: previewText(latest),
        lastMessageAt: latest?.createdAt ?? null,
        unreadAssistantCount: unread,
      };
    });
  }

  snapshot() {
    return {
      revision: this.#state.revision,
      bots: this.#state.bots,
      conversations: this.#state.conversations,
      drafts: this.#state.drafts,
      generations: this.#state.generations,
      routines: this.#state.routines,
      routineRuns: this.#state.routineRuns.slice(-200),
      providers: this.#state.providers,
      attachments: this.#state.attachments.map(({ path, ...rest }) => rest),
      conversationActivity: this.activity(),
      preferences: this.#state.preferences,
    };
  }

  /// Ascending sequence order with an exclusive keyset cursor, exactly like MessagePage.
  messages(conversationID, { beforeSequence = null, limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) fail("invalidPage");
    if (!this.conversation(conversationID)) fail("missingRecord");
    const all = this.#state.messages
      .filter((message) => message.conversationID === conversationID
        && (beforeSequence === null || message.sequence < beforeSequence))
      .sort((left, right) => Number(left.sequence - right.sequence));
    const page = all.slice(Math.max(0, all.length - limit));
    return { messages: page, hasMore: page.length < all.length, beforeSequence: page.length < all.length ? page[0]?.sequence : null };
  }

  message(id) {
    const found = this.#state.messages.find((message) => message.id === id);
    return found ?? fail("missingRecord");
  }

  search(query, { includeHidden = false } = {}) {
    const needle = String(query ?? "").trim().toLocaleLowerCase();
    if (!needle) return [];
    const hidden = new Set(this.#state.bots.filter((bot) => bot.hiddenAt).map((bot) => bot.id));
    return this.#state.conversations.filter((conversation) => {
      if (!includeHidden && conversation.kind === "direct"
        && conversation.memberBotIDs.some((id) => hidden.has(id))) return false;
      if (conversation.title.toLocaleLowerCase().includes(needle)) return true;
      return this.#state.messages.some((message) =>
        message.conversationID === conversation.id && message.text.toLocaleLowerCase().includes(needle));
    });
  }

  routineRuns({ routineID = null, limit = 100 } = {}) {
    return this.#state.routineRuns
      .filter((run) => routineID === null || run.routineID === routineID)
      .slice(-limit)
      .reverse();
  }

  attachments(ids) {
    return ids.map((id) => this.#state.attachments.find((item) => item.id === id)).filter(Boolean)
      .map(({ path, ...rest }) => rest);
  }

  attachmentContent(id) {
    const record = this.#state.attachments.find((item) => item.id === id) ?? fail("missingRecord");
    return { ...record, bytes: readFileSync(record.path) };
  }

  /**
   * The exact persisted impact shown for confirmation before a bot is deleted.
   * Group transcripts are deliberately preserved: only future membership changes.
   */
  botDeletionPlan(botID) {
    const bot = this.bot(botID) ?? fail("missingRecord");
    const directs = this.#state.conversations.filter((conversation) =>
      conversation.kind === "direct" && conversation.memberBotIDs.includes(botID));
    const directIDs = directs.map((conversation) => conversation.id);
    const messageIDs = this.#state.messages
      .filter((message) => directIDs.includes(message.conversationID)).map((message) => message.id);
    const attachmentIDs = this.#state.messages
      .filter((message) => directIDs.includes(message.conversationID))
      .flatMap((message) => message.attachmentIDs ?? []);
    const attachmentBytes = attachmentIDs
      .map((id) => this.#state.attachments.find((item) => item.id === id)?.byteCount ?? 0)
      .reduce((total, value) => total + value, 0);
    const generations = this.#state.generations.filter((generation) =>
      generation.targetBotID === botID || directIDs.includes(generation.conversationID));
    const routines = this.#state.routines.filter((routine) => routine.ownerBotID === botID);
    const routineIDs = routines.map((routine) => routine.id);
    const runs = this.#state.routineRuns.filter((run) => routineIDs.includes(run.routineID));
    const active = generations.filter((generation) => !TERMINAL_STATES.has(generation.state));
    return {
      botID,
      name: bot.name,
      directConversationIDs: directIDs,
      messageIDs,
      draftConversationIDs: this.#state.drafts
        .filter((draft) => directIDs.includes(draft.conversationID)).map((draft) => draft.conversationID),
      generationIDs: generations.map((generation) => generation.id),
      routineIDs,
      routineRunIDs: runs.map((run) => run.id),
      attachmentIDs,
      attachmentBytes,
      affectedGroups: this.#state.conversations
        .filter((conversation) => conversation.kind === "group" && conversation.memberBotIDs.includes(botID))
        .map((conversation) => ({
          id: conversation.id,
          title: conversation.title,
          remainingMemberBotIDs: conversation.memberBotIDs.filter((id) => id !== botID),
        })),
      activeGenerationIDs: active.map((generation) => generation.id),
      activeRoutineRunIDs: runs.filter((run) => run.status === "running").map((run) => run.id),
      cancellationConversationIDs: [...new Set(active.map((generation) => generation.conversationID))],
    };
  }

  // ── writes ───────────────────────────────────────────────────────────────

  #guard(expectedRevision) {
    if (expectedRevision !== null && expectedRevision !== undefined
      && Number(expectedRevision) !== this.#state.revision) fail("staleRevision");
  }

  #append(conversationID, { role, speakerBotID = null, speakerNameSnapshot = null, text,
    replyToID = null, attachmentIDs = [], generationID = null, id = null, createdAt = null }) {
    const conversation = this.conversation(conversationID) ?? fail("missingRecord");
    const message = {
      id: id ?? uuid(),
      conversationID,
      sequence: conversation.nextSequence,
      role,
      speakerBotID,
      speakerNameSnapshot,
      text,
      createdAt: createdAt ?? new Date().toISOString(),
      replyToID,
      attachmentIDs,
      generationID,
    };
    conversation.nextSequence += 1;
    this.#state.messages.push(message);
    return message;
  }

  createBot(input, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const profile = validBotProfile(input);
    if (input.id && this.bot(input.id)) fail("identityConflict");
    const bot = newBot({ ...input, ...profile });
    this.#state.bots.push(bot);
    // Creation always pairs a bot with its direct conversation in one save.
    const conversation = newConversation({
      id: input.conversationID, kind: "direct", title: bot.name, memberBotIDs: [bot.id],
    });
    this.#state.conversations.push(conversation);
    this.#commit();
    return { bot, conversation };
  }

  /// Atomically replaces only editable fields while they still match what was displayed.
  editBot(id, expected, replacement, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const bot = this.bot(id) ?? fail("missingRecord");
    const current = { name: bot.name, description: bot.description, color: bot.color, shape: bot.shape };
    for (const key of Object.keys(current)) {
      if (current[key] !== expected?.[key]) fail("editConflict");
    }
    Object.assign(bot, validBotProfile(replacement));
    // A direct conversation title follows its bot's name.
    for (const conversation of this.#state.conversations) {
      if (conversation.kind === "direct" && conversation.memberBotIDs[0] === id) conversation.title = bot.name;
    }
    this.#commit();
    return bot;
  }

  setHidden(botID, at, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const bot = this.bot(botID) ?? fail("missingRecord");
    // Hiding never changes read state.
    bot.hiddenAt = at ?? null;
    this.#commit();
    return bot;
  }

  setBotProvider(botID, providerConfigID, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const bot = this.bot(botID) ?? fail("missingRecord");
    if (providerConfigID && !this.provider(providerConfigID)) fail("missingRecord");
    bot.providerConfigID = providerConfigID ?? null;
    this.#commit();
    return bot;
  }

  deleteBot(expected, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const current = this.botDeletionPlan(expected.botID);
    const same = ["name", "directConversationIDs", "messageIDs", "draftConversationIDs",
      "generationIDs", "routineIDs", "routineRunIDs", "attachmentIDs", "attachmentBytes"]
      .every((key) => JSON.stringify(current[key]) === JSON.stringify(expected[key]));
    if (!same || JSON.stringify(current.affectedGroups) !== JSON.stringify(expected.affectedGroups)) {
      fail("confirmationChanged");
    }
    if (current.activeGenerationIDs.length > 0) fail("activeWork");

    const directs = new Set(current.directConversationIDs);
    for (const id of current.attachmentIDs) {
      const record = this.#state.attachments.find((item) => item.id === id);
      if (record && existsSync(record.path)) unlinkSync(record.path);
    }
    this.#state.attachments = this.#state.attachments.filter((item) => !current.attachmentIDs.includes(item.id));
    this.#state.messages = this.#state.messages.filter((message) => !directs.has(message.conversationID));
    this.#state.conversations = this.#state.conversations.filter((conversation) => !directs.has(conversation.id));
    this.#state.drafts = this.#state.drafts.filter((draft) => !directs.has(draft.conversationID));
    this.#state.generations = this.#state.generations.filter((generation) =>
      !current.generationIDs.includes(generation.id));
    this.#state.routineRuns = this.#state.routineRuns.filter((run) => !current.routineRunIDs.includes(run.id));
    this.#state.routines = this.#state.routines.filter((routine) => !current.routineIDs.includes(routine.id));
    // Group history keeps its recorded speaker attribution; only membership changes.
    for (const conversation of this.#state.conversations) {
      conversation.memberBotIDs = conversation.memberBotIDs.filter((id) => id !== expected.botID);
    }
    this.#state.bots = this.#state.bots.filter((bot) => bot.id !== expected.botID);
    return this.#commit();
  }

  createGroup(profile, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const available = new Set(this.#state.bots.filter((bot) => !bot.hiddenAt).map((bot) => bot.id));
    const valid = validGroupProfile(profile, available);
    const conversation = newConversation({ kind: "group", title: valid.title, memberBotIDs: valid.memberBotIDs });
    this.#state.conversations.push(conversation);
    this.#commit();
    return conversation;
  }

  editGroup(id, expected, replacement, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const conversation = this.conversation(id) ?? fail("missingRecord");
    if (conversation.kind !== "group") fail("missingRecord");
    if (conversation.title !== expected?.title
      || JSON.stringify(conversation.memberBotIDs) !== JSON.stringify(expected?.memberBotIDs)) {
      fail("editConflict");
    }
    const available = new Set(this.#state.bots.filter((bot) => !bot.hiddenAt).map((bot) => bot.id));
    const valid = validGroupProfile(replacement, available);
    conversation.title = valid.title;
    conversation.memberBotIDs = valid.memberBotIDs;
    this.#commit();
    return conversation;
  }

  saveDraft(draft, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    if (!this.conversation(draft.conversationID)) fail("missingRecord");
    const record = {
      conversationID: draft.conversationID,
      text: String(draft.text ?? ""),
      attachmentIDs: draft.attachmentIDs ?? [],
      replyToID: draft.replyToID ?? null,
      updatedAt: new Date().toISOString(),
    };
    const index = this.#state.drafts.findIndex((item) => item.conversationID === record.conversationID);
    if (index === -1) this.#state.drafts.push(record); else this.#state.drafts[index] = record;
    this.#commit();
    return record;
  }

  draft(conversationID) {
    return this.#state.drafts.find((item) => item.conversationID === conversationID) ?? null;
  }

  addAttachment({ conversationID, name, mime, bytes }) {
    if (!this.conversation(conversationID)) fail("missingRecord");
    if (!bytes?.length) fail("invalidDraft");
    if (bytes.length > 25 * 1024 * 1024) fail("invalidDraft");
    const id = uuid();
    const path = join(this.#attachmentDirectory, id);
    writeFileSync(path, bytes);
    const record = {
      id, conversationID, name: String(name ?? "attachment"), mime: String(mime ?? "application/octet-stream"),
      byteCount: bytes.length, createdAt: new Date().toISOString(), path,
    };
    this.#state.attachments.push(record);
    this.#commit();
    const { path: _hidden, ...safe } = record;
    return safe;
  }

  /**
   * Commits the user message, one queued generation per ordered target, sequence allocation
   * and the exact-source draft clear in a single save. Transport stays outside the store.
   */
  beginGenerationRound(command, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const conversation = this.conversation(command.conversationID) ?? fail("missingRecord");
    const text = String(command.text ?? "");
    if (!text.trim() && (command.attachmentIDs ?? []).length === 0) fail("invalidDraft");
    const targets = command.targets ?? [];
    if (targets.length < 1 || targets.length > 6) fail("invalidMembers");
    if (new Set(targets.map((target) => target.targetBotID)).size !== targets.length) fail("invalidMembers");
    for (const target of targets) {
      const bot = this.bot(target.targetBotID) ?? fail("missingRecord");
      if (!conversation.memberBotIDs.includes(bot.id)) fail("invalidMembers");
    }
    if (command.replyToID && !this.#state.messages.some((message) => message.id === command.replyToID)) {
      fail("invalidDraft");
    }

    const userMessage = this.#append(conversation.id, {
      id: command.userMessageID,
      role: "user",
      text,
      replyToID: command.replyToID ?? null,
      attachmentIDs: command.attachmentIDs ?? [],
    });
    const generations = targets.map((target, index) => {
      const bot = this.bot(target.targetBotID);
      const generation = {
        id: target.generationID ?? uuid(),
        conversationID: conversation.id,
        userMessageID: userMessage.id,
        attemptID: target.attemptID ?? uuid(),
        targetBotID: bot.id,
        state: "queued",
        lastEventSequence: 0,
        error: null,
        assistantMessageID: null,
        routineRunID: command.routineRunID ?? null,
        roundIndex: targets.length > 1 ? index : null,
        targetSpeakerNameSnapshot: bot.name,
      };
      this.#state.generations.push(generation);
      return generation;
    });

    // Only clear a draft whose raw source still matches exactly; a newer draft survives.
    const draft = this.draft(conversation.id);
    if (draft) {
      const sourceMatches = command.expectedDraftText === undefined
        ? draft.text.trim() === text.trim()
        : draft.text === command.expectedDraftText;
      const sameReply = (draft.replyToID ?? null) === (command.replyToID ?? null);
      const sameFiles = JSON.stringify(draft.attachmentIDs ?? []) === JSON.stringify(command.attachmentIDs ?? []);
      if (sourceMatches && sameReply && sameFiles) {
        this.#state.drafts = this.#state.drafts.filter((item) => item.conversationID !== conversation.id);
      }
    }
    this.#commit();
    return { userMessage, generations, revision: this.#state.revision };
  }

  beginGeneration(command, options) {
    return this.beginGenerationRound({
      ...command,
      targets: [{
        targetBotID: command.targetBotID,
        generationID: command.generationID,
        attemptID: command.attemptID,
      }],
    }, options);
  }

  /// started / delta / completed / failed, applied with the attempt guard from GenerationEvent.
  applyGenerationEvent(event) {
    const generation = this.generation(event.generationID) ?? fail("missingRecord");
    if (event.attemptID && generation.attemptID !== event.attemptID) return this.#state.revision;
    if (TERMINAL_STATES.has(generation.state)) return this.#state.revision;
    generation.lastEventSequence += 1;

    if (event.kind === "started") {
      generation.state = "streaming";
    } else if (event.kind === "delta") {
      generation.state = "streaming";
      if (!generation.assistantMessageID) {
        const bot = this.bot(generation.targetBotID);
        const message = this.#append(generation.conversationID, {
          role: "assistant",
          speakerBotID: generation.targetBotID,
          speakerNameSnapshot: generation.targetSpeakerNameSnapshot ?? bot?.name ?? null,
          text: event.text ?? "",
          generationID: generation.id,
        });
        generation.assistantMessageID = message.id;
      } else {
        // Streamed text only ever appends, which is what the read-state length check relies on.
        const message = this.#state.messages.find((item) => item.id === generation.assistantMessageID);
        message.text += event.text ?? "";
      }
    } else if (event.kind === "completed") {
      generation.state = "completed";
      if (!generation.assistantMessageID) {
        const message = this.#append(generation.conversationID, {
          role: "assistant",
          speakerBotID: generation.targetBotID,
          speakerNameSnapshot: generation.targetSpeakerNameSnapshot,
          text: event.text ?? "",
          generationID: generation.id,
        });
        generation.assistantMessageID = message.id;
      }
    } else if (event.kind === "failed") {
      generation.state = "failed";
      generation.error = String(event.error ?? "providerError");
      // A retry record is an event row: it never counts as an incoming reply.
      this.#append(generation.conversationID, {
        role: "event",
        speakerBotID: generation.targetBotID,
        speakerNameSnapshot: generation.targetSpeakerNameSnapshot,
        text: generation.error,
        generationID: generation.id,
      });
    }
    return this.#commit();
  }

  cancelGeneration(id, attemptID) {
    const generation = this.generation(id) ?? fail("missingRecord");
    if (attemptID && generation.attemptID !== attemptID) fail("staleRevision");
    if (!TERMINAL_STATES.has(generation.state)) generation.state = "cancelled";
    return this.#commit();
  }

  /// Stop round: completed replies are preserved, remaining members stop.
  cancelGenerationRound(userMessageID) {
    let stopped = 0;
    for (const generation of this.#state.generations) {
      if (generation.userMessageID === userMessageID && !TERMINAL_STATES.has(generation.state)) {
        generation.state = "cancelled";
        stopped += 1;
      }
    }
    this.#commit();
    return stopped;
  }

  retryGeneration(id) {
    const generation = this.generation(id) ?? fail("missingRecord");
    generation.attemptID = uuid();
    generation.state = "queued";
    generation.error = null;
    generation.assistantMessageID = null;
    this.#commit();
    return generation;
  }

  interruptPending() {
    let changed = false;
    for (const generation of this.#state.generations) {
      if (!TERMINAL_STATES.has(generation.state)) {
        generation.state = "interrupted";
        changed = true;
      }
    }
    for (const run of this.#state.routineRuns) {
      if (run.status === "running") {
        run.status = "failed";
        run.error = "appQuit";
        run.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this.#commit();
    return changed;
  }

  // ── routines ─────────────────────────────────────────────────────────────

  createRoutine(input, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    if (!this.bot(input.ownerBotID)) fail("missingRecord");
    const valid = validRoutine(input);
    const routine = {
      id: input.id ?? uuid(),
      ownerBotID: input.ownerBotID,
      name: valid.name,
      prompt: valid.prompt,
      trigger: valid.trigger,
      timezoneID: input.timezoneID,
      enabled: Boolean(input.enabled),
      nextRunAt: input.nextRunAt ?? null,
      providerBinding: input.providerBinding ?? null,
      scheduleID: input.scheduleID ?? uuid(),
    };
    this.#state.routines.push(routine);
    this.#commit();
    return routine;
  }

  editRoutine(expected, replacement, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const routine = this.routine(expected.id) ?? fail("missingRecord");
    for (const key of ["name", "prompt", "timezoneID", "enabled"]) {
      if (routine[key] !== expected[key]) fail("editConflict");
    }
    if (JSON.stringify(routine.trigger) !== JSON.stringify(expected.trigger)) fail("editConflict");
    const valid = validRoutine({ ...routine, ...replacement });
    Object.assign(routine, {
      name: valid.name, prompt: valid.prompt, trigger: valid.trigger,
      timezoneID: replacement.timezoneID ?? routine.timezoneID,
      enabled: Boolean(replacement.enabled ?? routine.enabled),
      nextRunAt: replacement.nextRunAt ?? routine.nextRunAt,
      providerBinding: replacement.providerBinding ?? routine.providerBinding,
    });
    this.#commit();
    return routine;
  }

  setRoutineNextRun(id, nextRunAt) {
    const routine = this.routine(id) ?? fail("missingRecord");
    routine.nextRunAt = nextRunAt;
    this.#commit();
    return routine;
  }

  routineDeletionPlan(routineID) {
    const routine = this.routine(routineID) ?? fail("missingRecord");
    const runs = this.#state.routineRuns.filter((run) => run.routineID === routineID);
    return {
      routineID,
      name: routine.name,
      enabled: routine.enabled,
      runIDs: runs.map((run) => run.id),
      activeRunIDs: runs.filter((run) => run.status === "running").map((run) => run.id),
    };
  }

  deleteRoutine(expected, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const current = this.routineDeletionPlan(expected.routineID);
    if (JSON.stringify(current.runIDs) !== JSON.stringify(expected.runIDs)) fail("confirmationChanged");
    if (current.activeRunIDs.length > 0) fail("activeWork");
    this.#state.routineRuns = this.#state.routineRuns.filter((run) => run.routineID !== expected.routineID);
    this.#state.routines = this.#state.routines.filter((routine) => routine.id !== expected.routineID);
    return this.#commit();
  }

  /// Claims one due occurrence, records skipped aggregate and advances the watermark atomically.
  claimRoutineRun({ routine, window, occurrence }) {
    const live = this.routine(routine.id) ?? fail("missingRecord");
    if (live.nextRunAt !== routine.nextRunAt) fail("staleRevision");
    if (this.#state.routineRuns.some((run) => run.occurrenceID === occurrence)) return null;
    const run = {
      id: uuid(),
      routineID: live.id,
      occurrenceID: occurrence,
      scheduledFor: new Date(window.latest).toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
      status: "running",
      error: null,
      skippedCount: window.skippedCount,
      firstSkippedAt: window.firstSkippedAt ? new Date(window.firstSkippedAt).toISOString() : null,
      lastSkippedAt: window.lastSkippedAt ? new Date(window.lastSkippedAt).toISOString() : null,
      generationID: null,
      conversationID: null,
    };
    this.#state.routineRuns.push(run);
    live.nextRunAt = window.next;
    this.#commit();
    return run;
  }

  attachRoutineRunGeneration(runID, { generationID, conversationID }) {
    const run = this.#state.routineRuns.find((item) => item.id === runID) ?? fail("missingRecord");
    run.generationID = generationID;
    run.conversationID = conversationID;
    this.#commit();
    return run;
  }

  finishRoutineRun(runID, status, error = null) {
    const run = this.#state.routineRuns.find((item) => item.id === runID) ?? fail("missingRecord");
    run.status = status;
    run.error = error;
    run.finishedAt = new Date().toISOString();
    this.#commit();
    return run;
  }

  // ── providers, read state, preferences ───────────────────────────────────

  saveProvider(config, { expectedRevision = null } = {}) {
    this.#guard(expectedRevision);
    const valid = validProvider(config);
    const index = this.#state.providers.findIndex((item) => item.id === valid.id);
    if (index === -1) this.#state.providers.push(valid); else this.#state.providers[index] = valid;
    this.#commit();
    return valid;
  }

  deleteProvider(id) {
    const provider = this.provider(id) ?? fail("missingRecord");
    this.#state.providers = this.#state.providers.filter((item) => item.id !== provider.id);
    for (const bot of this.#state.bots) {
      if (bot.providerConfigID === provider.id) bot.providerConfigID = null;
    }
    for (const routine of this.#state.routines) {
      if (routine.providerBinding?.providerID === provider.id) {
        routine.providerBinding = null;
        routine.enabled = false;
      }
    }
    return this.#commit();
  }

  /**
   * Read acknowledgement. The caller must supply the exact rendered latest message identity,
   * sequence and UTF-8 length it observed; a newer reply is never substituted.
   */
  markRead(conversationID, throughSequence, observed = null) {
    const conversation = this.conversation(conversationID) ?? fail("missingRecord");
    const sequence = Number(throughSequence);
    if (!Number.isInteger(sequence) || sequence < 0 || sequence >= conversation.nextSequence) {
      fail("invalidPage");
    }
    if (observed) {
      const latest = this.#state.messages
        .filter((message) => message.conversationID === conversationID).at(-1);
      const matches = latest && latest.id === observed.messageID
        && latest.sequence === observed.sequence
        && utf8ByteCount(latest.text) === observed.byteCount;
      if (!matches) fail("staleRevision");
      // A nonterminal generation delays acknowledgement so a final delta is not marked read.
      const live = this.#state.generations.some((generation) =>
        generation.conversationID === conversationID && !TERMINAL_STATES.has(generation.state));
      if (live) fail("staleRevision");
    }
    // Monotonic watermark only.
    if (sequence > conversation.lastReadSequence) {
      conversation.lastReadSequence = sequence;
      this.#commit();
    }
    return conversation.lastReadSequence;
  }

  savePreferences(preferences) {
    const clamp = (value, low, high, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(high, Math.max(low, number)) : fallback;
    };
    const current = this.#state.preferences;
    this.#state.preferences = {
      appearance: ["dark", "light", "system"].includes(preferences?.appearance)
        ? preferences.appearance : current.appearance,
      sidebarWidth: clamp(preferences?.sidebarWidth, 240, 400, current.sidebarWidth),
      inspectorWidth: clamp(preferences?.inspectorWidth, 280, 480, current.inspectorWidth),
      inspectorVisible: preferences?.inspectorVisible ?? current.inspectorVisible,
    };
    this.#commit();
    return this.#state.preferences;
  }

  /**
   * Workspace export, format v3. Credential values never leave the session store, so only
   * references are exported; that limit is disclosed to the user before they choose a path.
   */
  exportDocument() {
    return {
      format: EXPORT_FORMAT,
      exportedAt: new Date().toISOString(),
      application: "BotWorkspace Linux",
      revision: this.#state.revision,
      secretScrubbing: "ส่งออกเฉพาะ credential reference ไม่มีค่า secret จริงในไฟล์นี้",
      bots: this.#state.bots,
      conversations: this.#state.conversations,
      messages: this.#state.messages,
      drafts: this.#state.drafts,
      routines: this.#state.routines,
      routineRuns: this.#state.routineRuns,
      // apiRoot/model/reference only: no credential value exists in the store to leak.
      providers: this.#state.providers.map(({ credentialReference, ...rest }) => ({
        ...rest, credentialReference, credentialValueIncluded: false,
      })),
      attachments: this.#state.attachments.map(({ path, ...rest }) => rest),
    };
  }
}
