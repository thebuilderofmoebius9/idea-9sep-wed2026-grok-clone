// Generation dispatch and the awake-only routine scheduler.
// Nothing here fabricates a reply: an unconfigured provider fails the generation honestly.

import { TERMINAL_STATES, fail } from "./domain.mjs";
import { PROVIDER_ERRORS, ProviderError, streamChat } from "./provider.mjs";
import { dueWindow, nextRun, occurrenceID, routineFailureLabel } from "./routines.mjs";

const HISTORY_TURNS = 40;

export class Engine {
  #store;
  #credentials;
  #listeners = new Set();
  #running = new Map();
  #timer = null;

  constructor(store, credentials) {
    this.#store = store;
    this.#credentials = credentials;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try { listener(event); } catch { /* a dead SSE client must not break dispatch */ }
    }
  }

  get activeCount() { return this.#running.size; }

  /// Builds the provider turns for one target from the persisted transcript.
  #turns(generation) {
    const bot = this.#store.bot(generation.targetBotID);
    const page = this.#store.messages(generation.conversationID, { limit: 500 });
    const history = page.messages
      .filter((message) => message.role !== "event")
      .filter((message) => message.sequence <= this.#userSequence(generation))
      .slice(-HISTORY_TURNS)
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.role === "assistant" && message.speakerNameSnapshot
          ? message.text
          : message.text,
      }))
      .filter((turn) => turn.content.trim().length > 0);
    const system = [
      bot?.name ? `คุณคือ ${bot.name}` : null,
      bot?.description || null,
    ].filter(Boolean).join(". ");
    return system ? [{ role: "system", content: system }, ...history] : history;
  }

  #userSequence(generation) {
    const message = this.#store.messages(generation.conversationID, { limit: 500 }).messages
      .find((item) => item.id === generation.userMessageID);
    return message?.sequence ?? Number.MAX_SAFE_INTEGER;
  }

  /// Runs the ordered generations for one committed round, one member at a time.
  async runRound(generationIDs) {
    for (const id of generationIDs) {
      const generation = this.#store.generation(id);
      if (!generation || TERMINAL_STATES.has(generation.state)) continue;
      await this.run(id);
    }
  }

  async run(generationID) {
    if (this.#running.has(generationID)) return;
    const generation = this.#store.generation(generationID);
    if (!generation || TERMINAL_STATES.has(generation.state)) return;
    const controller = new AbortController();
    this.#running.set(generationID, controller);

    const bot = this.#store.bot(generation.targetBotID);
    const routineBinding = generation.routineRunID
      ? this.#store.routineRuns({ limit: 500 }).find((run) => run.id === generation.routineRunID)
      : null;
    const providerID = bot?.providerConfigID
      ?? this.#store.routine(routineBinding?.routineID)?.providerBinding?.providerID
      ?? null;
    const provider = providerID ? this.#store.provider(providerID) : null;

    try {
      if (!provider) {
        throw new ProviderError("noProvider");
      }
      const credential = this.#credentials.get(provider.credentialReference);
      if (!credential) throw new ProviderError("noCredential");

      this.#apply({ generationID, attemptID: generation.attemptID, kind: "started" });
      const text = await streamChat({
        provider,
        credential,
        accountID: this.#credentials.accountFor?.(provider.credentialReference) ?? null,
        turns: this.#turns(generation),
        signal: controller.signal,
        onEvent: (event) => {
          if (event.kind === "delta") {
            this.#apply({ generationID, attemptID: generation.attemptID, kind: "delta", text: event.text });
          }
        },
      });
      this.#apply({ generationID, attemptID: generation.attemptID, kind: "completed", text });
      if (generation.routineRunID) this.#store.finishRoutineRun(generation.routineRunID, "succeeded");
    } catch (error) {
      const message = error instanceof ProviderError
        ? (error.code === "noProvider"
          ? "บอทนี้ยังไม่ได้ผูกผู้ให้บริการ เปิด Settings เพื่อผูกก่อน"
          : error.code === "noCredential"
            ? "ยังไม่ได้ใส่ credential ของผู้ให้บริการในเซสชันนี้"
            : error.message)
        : "เกิดข้อผิดพลาดที่ไม่คาดคิดระหว่างเรียกผู้ให้บริการ";
      if (!(error instanceof ProviderError)) console.error("generation failed", error);
      this.#apply({ generationID, attemptID: generation.attemptID, kind: "failed", error: message });
      if (generation.routineRunID) {
        this.#store.finishRoutineRun(generation.routineRunID, "failed",
          error instanceof ProviderError && error.code === "noCredential"
            ? routineFailureLabel("missingCredential") : message);
      }
    } finally {
      this.#running.delete(generationID);
      this.#emit({ type: "revision", revision: this.#store.revision });
    }
  }

  #apply(event) {
    const revision = this.#store.applyGenerationEvent(event);
    this.#emit({ type: "generation", generationID: event.generationID, kind: event.kind, text: event.text, revision });
  }

  cancel(generationID) {
    this.#running.get(generationID)?.abort();
  }

  cancelRound(userMessageID) {
    for (const generation of this.#store.snapshot().generations) {
      if (generation.userMessageID === userMessageID) this.cancel(generation.id);
    }
    const stopped = this.#store.cancelGenerationRound(userMessageID);
    this.#emit({ type: "revision", revision: this.#store.revision });
    return stopped;
  }

  // ── routines: awake-only, never a 24/7 claim ─────────────────────────────

  startScheduler({ intervalMS = 30_000 } = {}) {
    if (this.#timer) return;
    this.#timer = setInterval(() => { this.tickRoutines().catch(() => {}); }, intervalMS);
    this.#timer.unref?.();
  }

  stopScheduler() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  /// Claims at most one catch-up occurrence per routine per tick.
  async tickRoutines(now = Date.now()) {
    const started = [];
    for (const routine of this.#store.snapshot().routines) {
      if (!routine.enabled) continue;
      const first = routine.nextRunAt ?? nextRun(now, routine.trigger, routine.timezoneID);
      if (routine.nextRunAt === null) {
        this.#store.setRoutineNextRun(routine.id, first);
        continue;
      }
      let window;
      try {
        window = dueWindow(first, now, routine.trigger, routine.timezoneID);
      } catch {
        continue;
      }
      if (!window) continue;
      const occurrence = occurrenceID(routine.scheduleID, window.latest, routine.trigger, routine.timezoneID);
      const run = this.#store.claimRoutineRun({ routine, window, occurrence });
      if (!run) continue;
      if (this.#startRoutineRun(routine, run)) started.push(run.id);
    }
    return started;
  }

  /// Run-now: a manual occurrence that never moves the schedule watermark,
  /// so the next scheduled run still fires at its planned time.
  async runRoutineNow(routineID, now = Date.now()) {
    const routine = this.#store.routine(routineID) ?? fail("missingRecord");
    const window = {
      latest: now, next: routine.nextRunAt,
      skippedCount: 0, firstSkippedAt: null, lastSkippedAt: null,
    };
    const occurrence = `${routine.scheduleID}:manual-${now.toString(16)}`;
    const run = this.#store.claimRoutineRun({ routine, window, occurrence });
    if (!run) fail("duplicateRun");
    this.#startRoutineRun(routine, run);
    return this.#store.routineRuns({ routineID }).find((item) => item.id === run.id) ?? run;
  }

  #startRoutineRun(routine, run) {
    const bot = this.#store.bot(routine.ownerBotID);
    const conversation = this.#store.snapshot().conversations
      .find((item) => item.kind === "direct" && item.memberBotIDs[0] === routine.ownerBotID);
    if (!bot || !conversation) {
      this.#store.finishRoutineRun(run.id, "failed", routineFailureLabel("missingBot"));
      return false;
    }
    const committed = this.#store.beginGenerationRound({
      conversationID: conversation.id,
      text: routine.prompt,
      targets: [{ targetBotID: bot.id }],
      routineRunID: run.id,
    });
    this.#store.attachRoutineRunGeneration(run.id, {
      generationID: committed.generations[0].id,
      conversationID: conversation.id,
    });
    this.#emit({ type: "revision", revision: this.#store.revision });
    this.run(committed.generations[0].id).catch(() => {});
    return true;
  }
}

export { PROVIDER_ERRORS };
