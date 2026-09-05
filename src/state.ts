import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

export type DeliveryBatch = {
  id: string;
  keys: string[];
  parts: string[];
  nextPart: number;
};

type BatchRow = { id: string; parts: string; next_part: number };
type KeyRow = { deviation_key: string };

export class StateStore {
  private readonly db: DatabaseSync;
  private readonly sentQuery: StatementSync;
  private readonly queuedQuery: StatementSync;
  private readonly pendingQuery: StatementSync;
  private readonly keysQuery: StatementSync;
  private readonly enqueueBatch: (keys: string[], parts: string[]) => void;
  private readonly acknowledgeBatch: (id: string, nextPart: number) => void;
  private readonly pruneSent: (days: number, activeKeys: string[]) => void;

  constructor(filename = "state.db") {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sent (
        id TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_batches (
        id TEXT PRIMARY KEY,
        parts TEXT NOT NULL,
        next_part INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_keys (
        deviation_key TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES delivery_batches(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS delivery_keys_batch ON delivery_keys(batch_id);
      CREATE TEMP TABLE IF NOT EXISTS prune_active (id TEXT PRIMARY KEY);
    `);
    this.sentQuery = this.db.prepare("SELECT 1 FROM sent WHERE id = ?");
    this.queuedQuery = this.db.prepare("SELECT 1 FROM delivery_keys WHERE deviation_key = ?");
    this.pendingQuery = this.db.prepare(
      "SELECT id, parts, next_part FROM delivery_batches ORDER BY created_at, rowid"
    );
    this.keysQuery = this.db.prepare("SELECT deviation_key FROM delivery_keys WHERE batch_id = ? ORDER BY rowid");
    const insertBatch = this.db.prepare(
      "INSERT INTO delivery_batches(id, parts, next_part, created_at) VALUES (?, ?, 0, ?)"
    );
    const insertKey = this.db.prepare("INSERT INTO delivery_keys(deviation_key, batch_id) VALUES (?, ?)");
    const batchQuery = this.db.prepare("SELECT id, parts, next_part FROM delivery_batches WHERE id = ?");
    const updateProgress = this.db.prepare("UPDATE delivery_batches SET next_part = ? WHERE id = ?");
    const markSent = this.db.prepare("INSERT OR REPLACE INTO sent(id, sent_at) VALUES (?, ?)");
    const deleteBatch = this.db.prepare("DELETE FROM delivery_batches WHERE id = ?");
    const clearActive = this.db.prepare("DELETE FROM prune_active");
    const insertActive = this.db.prepare("INSERT OR IGNORE INTO prune_active(id) VALUES (?)");
    const deleteOld = this.db.prepare(`
      DELETE FROM sent WHERE datetime(sent_at) < datetime('now', ?)
      AND id NOT IN (SELECT id FROM prune_active)
      AND id NOT IN (SELECT deviation_key FROM delivery_keys)
    `);

    this.enqueueBatch = this.transaction((keys: string[], parts: string[]) => {
      if (keys.some(key => this.alreadySent(key) || this.isQueued(key))) {
        throw new Error("Delivery keys have already been recorded");
      }
      const id = randomUUID();
      insertBatch.run(id, JSON.stringify(parts), new Date().toISOString());
      for (const key of keys) insertKey.run(key, id);
    });
    this.acknowledgeBatch = this.transaction((id: string, nextPart: number) => {
      const batch = batchQuery.get(id) as BatchRow | undefined;
      // A repeated final acknowledgement is safe after the batch was removed.
      if (!batch) return;
      if (nextPart <= batch.next_part) return;
      const parts = this.parseParts(batch.parts);
      if (nextPart !== batch.next_part + 1 || nextPart > parts.length) {
        throw new Error("Invalid delivery acknowledgement");
      }
      if (nextPart < parts.length) {
        updateProgress.run(nextPart, id);
        return;
      }
      const sentAt = new Date().toISOString();
      for (const key of this.keysQuery.all(id) as KeyRow[]) markSent.run(key.deviation_key, sentAt);
      // Deleting the batch and marking every key happen in the same transaction.
      deleteBatch.run(id);
    });
    this.pruneSent = this.transaction((days: number, activeKeys: string[]) => {
      clearActive.run();
      for (const key of activeKeys) insertActive.run(key);
      deleteOld.run(`-${Math.max(1, Math.floor(days))} days`);
      clearActive.run();
    });
  }

  alreadySent(key: string): boolean {
    return Boolean(this.sentQuery.get(key));
  }

  isQueued(key: string): boolean {
    return Boolean(this.queuedQuery.get(key));
  }

  enqueue(keys: string[], parts: string[]): void {
    if (!keys.length || !parts.length || keys.some(key => typeof key !== "string" || !key)
      || new Set(keys).size !== keys.length
      || parts.some(part => typeof part !== "string" || !part.trim() || part.length > 4096)) {
      throw new Error("Invalid delivery batch");
    }
    this.enqueueBatch(keys, parts);
  }

  pending(): DeliveryBatch[] {
    return (this.pendingQuery.all() as BatchRow[]).map(row => ({
      id: row.id,
      keys: (this.keysQuery.all(row.id) as KeyRow[]).map(key => key.deviation_key),
      parts: this.parseParts(row.parts),
      nextPart: row.next_part,
    }));
  }

  acknowledgePart(id: string, nextPart: number): void {
    if (!Number.isSafeInteger(nextPart) || nextPart < 1) throw new Error("Invalid delivery acknowledgement");
    this.acknowledgeBatch(id, nextPart);
  }

  prune(days: number, activeKeys: string[] = []): void {
    if (!Number.isFinite(days)) throw new Error("Invalid retention period");
    this.pruneSent(days, activeKeys);
  }

  close(): void {
    this.db.close();
  }

  private transaction<Args extends unknown[]>(operation: (...args: Args) => void) {
    return (...args: Args): void => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        operation(...args);
        this.db.exec("COMMIT");
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK");
        throw error;
      }
    };
  }

  private parseParts(raw: string): string[] {
    const parts: unknown = JSON.parse(raw);
    if (!Array.isArray(parts) || !parts.length || parts.some(part => typeof part !== "string")) {
      throw new Error("Invalid stored delivery batch");
    }
    return parts;
  }
}
