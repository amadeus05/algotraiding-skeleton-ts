import Database from "better-sqlite3";
import { injectable } from "inversify";
import { mkdirSync } from "fs";
import path from "path";

@injectable()
export class DatabaseConnection {
    private readonly db: Database.Database;

    constructor(databasePath = process.env.SQLITE_PATH ?? path.resolve(process.cwd(), "data", "trading.sqlite")) {
        mkdirSync(path.dirname(databasePath), { recursive: true });
        this.db = new Database(databasePath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
    }

    public getDb(): Database.Database {
        return this.db;
    }

    public close(): void {
        this.db.close();
    }
}
