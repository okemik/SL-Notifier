import { buildMessageBatches, type PreparedDeviation } from "./format.js";
import { safeError, TelegramDeliveryError } from "./errors.js";
import type { StateStore } from "./state.js";
import type { Deviation } from "./types.js";

type Store = Pick<StateStore, "alreadySent" | "isQueued" | "enqueue" | "pending" | "acknowledgePart" | "prune">;
export type CheckResult = {
  ok: boolean; ran: boolean; skipped?: "running" | "interval" | "stopping";
  nextCheckAt?: string; fetched?: number; queued?: number; sent?: number; failed?: number; error?: string;
};
export type NotifierStatus = {
  running: boolean; stopping: boolean; ready: boolean;
  lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null;
  nextCheckAt: string | null; consecutiveFailures: number; pendingBatches: number;
};
export type NotifierDependencies = {
  store: Store;
  fetch: () => Promise<{ deviations: Deviation[]; rejectedCount: number }>;
  prepare: (deviation: Deviation) => Promise<PreparedDeviation>;
  send: (text: string) => Promise<void>;
  intervalMs: number; pruneDays: number; now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  abort?: () => void; log?: (message: string) => void;
};

export class Notifier {
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private timer: unknown;
  private started = false;
  private stopping = false;
  private activeCheck: Promise<CheckResult> | null = null;
  private nextFetchAt = 0;
  private retryDeliveryAt = 0;
  private lastAttemptAt: number | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private pendingBatches = 0;
  // Keep accepted parts in memory until SQLite confirms them, avoiding resends on a DB failure.
  private readonly receipts = new Map<string, number>();

  constructor(private readonly deps: NotifierDependencies) {
    if (!Number.isFinite(deps.intervalMs) || deps.intervalMs < 60000) {
      throw new Error("Polling interval must be at least 60000 ms");
    }
    this.now = deps.now ?? Date.now;
    this.schedule = deps.schedule ?? ((callback, delay) => setTimeout(callback, delay));
    this.cancel = deps.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }
  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    void this.poll();
  }
  private async poll(): Promise<void> {
    await this.check();
    if (!this.stopping) this.timer = this.schedule(() => { void this.poll(); }, this.deps.intervalMs);
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) this.cancel(this.timer);
    this.deps.abort?.();
    // Storage must remain open until all in-flight work has settled.
    // The service shutdown handler enforces the process-level deadline.
    await this.activeCheck;
  }
  status(): NotifierStatus {
    const recent = this.lastSuccessAt !== null && this.now() - this.lastSuccessAt <= Math.max(120000, this.deps.intervalMs * 3);
    return {
      running: this.activeCheck !== null, stopping: this.stopping,
      ready: !this.stopping && recent && this.consecutiveFailures === 0,
      lastAttemptAt: this.lastAttemptAt === null ? null : new Date(this.lastAttemptAt).toISOString(),
      lastSuccessAt: this.lastSuccessAt === null ? null : new Date(this.lastSuccessAt).toISOString(),
      lastError: this.lastError, nextCheckAt: this.nextFetchAt ? new Date(this.nextFetchAt).toISOString() : null,
      consecutiveFailures: this.consecutiveFailures, pendingBatches: this.pendingBatches,
    };
  }
  async check(): Promise<CheckResult> {
    if (this.stopping) return { ok: false, ran: false, skipped: "stopping" };
    if (this.activeCheck) return { ok: true, ran: false, skipped: "running" };
    if (this.now() < this.nextFetchAt) {
      return { ok: true, ran: false, skipped: "interval", nextCheckAt: new Date(this.nextFetchAt).toISOString() };
    }
    this.nextFetchAt = this.now() + this.deps.intervalMs;
    this.activeCheck = this.run();
    try { return await this.activeCheck; }
    finally { this.activeCheck = null; }
  }
  private async run(): Promise<CheckResult> {
    this.lastAttemptAt = this.now();
    let fetched = 0, queued = 0, sent = 0, failed = 0;
    let error: string | undefined;
    const fail = (message: string, count = 1) => {
      failed += count; error = message; this.deps.log?.(message);
    };
    try {
      for (const [id, nextPart] of this.receipts) {
        this.deps.store.acknowledgePart(id, nextPart);
        this.receipts.delete(id);
      }
      let activeKeys: string[] | undefined;
      let deviations: Deviation[] = [];
      try {
        this.nextFetchAt = this.now() + this.deps.intervalMs;
        const result = await this.deps.fetch();
        deviations = result.deviations;
        fetched = deviations.length;
        if (result.rejectedCount > 0) fail("SL returned invalid deviation records", result.rejectedCount);
        else activeKeys = deviations.map(d => `${d.deviation_case_id}:${d.version}`);
      } catch (cause) { fail(`SL check failed: ${safeError(cause)}`); }

      const seen = new Set<string>();
      const prepared: PreparedDeviation[] = [];
      for (const deviation of deviations) {
        if (this.stopping) break;
        const key = `${deviation.deviation_case_id}:${deviation.version}`;
        if (seen.has(key) || this.deps.store.alreadySent(key) || this.deps.store.isQueued(key)) continue;
        seen.add(key);
        try { prepared.push(await this.deps.prepare(deviation)); }
        catch (cause) { fail(`Message preparation failed: ${safeError(cause)}`); }
      }
      for (const batch of buildMessageBatches(prepared)) {
        this.deps.store.enqueue(batch.keys, batch.parts);
        queued += batch.keys.length;
      }
      const pending = this.deps.store.pending();
      this.pendingBatches = pending.length;
      if (pending.length > 0 && this.now() < this.retryDeliveryAt) {
        fail("Telegram delivery is waiting for the retry interval");
      } else {
        delivery: for (const batch of pending) {
          for (let part = batch.nextPart; part < batch.parts.length; part += 1) {
            if (this.stopping) break delivery;
            try { await this.deps.send(batch.parts[part]); }
            catch (cause) {
              fail(`Telegram delivery failed: ${safeError(cause)}`);
              if (cause instanceof TelegramDeliveryError && cause.status === 429) {
                this.retryDeliveryAt = this.now() + Math.max(1000, cause.retryAfterMs ?? this.deps.intervalMs);
                break delivery;
              }
              if (cause instanceof TelegramDeliveryError && (cause.status === 401 || cause.status === 403)) break delivery;
              continue delivery;
            }
            this.receipts.set(batch.id, part + 1);
            this.deps.store.acknowledgePart(batch.id, part + 1);
            this.receipts.delete(batch.id);
          }
          sent += batch.keys.length;
        }
      }
      if (activeKeys !== undefined && !this.stopping) this.deps.store.prune(this.deps.pruneDays, activeKeys);
      this.pendingBatches = this.deps.store.pending().length;
    } catch (cause) { fail(`Notification state failed: ${safeError(cause)}`); }
    if (this.stopping) fail("Notification check interrupted by shutdown");
    const ok = failed === 0;
    this.lastError = error ?? null;
    if (ok) { this.lastSuccessAt = this.now(); this.consecutiveFailures = 0; }
    else this.consecutiveFailures += 1;
    return { ok, ran: true, fetched, queued, sent, failed, ...(error ? { error } : {}) };
  }
}
