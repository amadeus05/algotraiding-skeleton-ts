import { injectable } from "inversify";
import { existsSync, readdirSync, readFileSync } from "fs";
import path from "path";
import { DatabaseConnection } from "./DatabaseConnection";

@injectable()
export class MigrationService {
    constructor(private readonly dbConn: DatabaseConnection) {}

    public runMigrations(): void {
        const db = this.dbConn.getDb();
        const migrationsDir = this.resolveMigrationsDir();
        const migrationFiles = readdirSync(migrationsDir)
            .filter((fileName) => fileName.endsWith(".sql"))
            .sort((left, right) => left.localeCompare(right));

        db.exec(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                name TEXT PRIMARY KEY,
                executed_at TEXT NOT NULL
            )
        `);

        const insertMigration = db.prepare(`
            INSERT INTO schema_migrations (name, executed_at)
            VALUES (?, ?)
        `);

        const hasMigration = db.prepare(`
            SELECT 1
            FROM schema_migrations
            WHERE name = ?
        `);

        for (const fileName of migrationFiles) {
            const existingRow = hasMigration.get(fileName);

            if (existingRow) {
                continue;
            }

            const migrationSql = readFileSync(path.join(migrationsDir, fileName), "utf8");
            const transaction = db.transaction(() => {
                db.exec(migrationSql);
                insertMigration.run(fileName, new Date().toISOString());
            });

            transaction();
        }
    }

    private resolveMigrationsDir(): string {
        const candidateDirs = [
            path.resolve(__dirname, "migrations"),
            path.resolve(process.cwd(), "src", "infrastructure", "persistence", "migrations"),
            path.resolve(process.cwd(), "dist", "infrastructure", "persistence", "migrations")
        ];

        const existingDir = candidateDirs.find((candidateDir) => existsSync(candidateDir));

        if (!existingDir) {
            throw new Error("Unable to locate SQL migrations directory.");
        }

        return existingDir;
    }
}
