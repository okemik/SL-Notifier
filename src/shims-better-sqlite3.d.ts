declare module "better-sqlite3" {
  type Statement = {
    get: (...args: any[]) => any;
    run: (...args: any[]) => any;
  };

  class Database {
    constructor(filename?: string, options?: any);
    exec(sql: string): this;
    prepare(sql: string): Statement;
  }

  namespace Database {
    interface Database {
      exec(sql: string): Database;
      prepare(sql: string): Statement;
    }
  }

  export = Database;
}
