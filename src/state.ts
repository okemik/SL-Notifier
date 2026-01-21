import Database from "better-sqlite3";

export class StateStore {
  private db: Database.Database;

  constructor(filename = "state.db") {
    this.db = new Database(filename);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sent (
        id TEXT PRIMARY KEY,
        sent_at TEXT NOT NULL
      );
    `);
  }

  alreadySent(id: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM sent WHERE id = ?").get(id);
    return !!row;
  }

  markSent(id: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO sent (id, sent_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
  }

  // Keep DB small by removing old "sent" rows
  prune(daysToKeep: number) {
    this.db
      .prepare(
        `DELETE FROM sent
         WHERE datetime(sent_at) < datetime('now', ?);`
      )
      .run(`-${Math.max(1, daysToKeep)} days`);
  }
}
