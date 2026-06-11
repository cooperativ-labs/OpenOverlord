import Database from 'better-sqlite3';
export declare function withMemoryDb<T>(fn: (db: Database.Database) => T | Promise<T>): Promise<T>;
export declare function applyMigrations(db: Database.Database): void;
//# sourceMappingURL=harness.d.ts.map