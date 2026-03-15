import { readdirSync, statSync } from "fs";
import path from "path";

function collectTestFiles(directoryPath: string): string[] {
    const entries = readdirSync(directoryPath);
    const files: string[] = [];

    for (const entry of entries) {
        const fullPath = path.join(directoryPath, entry);
        const stats = statSync(fullPath);

        if (stats.isDirectory()) {
            files.push(...collectTestFiles(fullPath));
            continue;
        }

        if (entry.endsWith(".test.ts")) {
            files.push(fullPath);
        }
    }

    return files.sort((left, right) => left.localeCompare(right));
}

const testDirectory = path.resolve(__dirname);
const testFiles = collectTestFiles(testDirectory);

for (const testFile of testFiles) {
    require(testFile);
}
