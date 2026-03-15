import { inject, injectable } from "inversify";
import { IMarketDataRepository } from "../../../core/interfaces/repositories/IMarketDataRepository";
import { Candle, TimeRange } from "../../../core/types/common";
import { TYPES } from "../../../core/types/di.types";
import { intervalToMilliseconds, normalizeRangeEnd, normalizeRangeStart } from "../../../utils/Helpers";
import { DatabaseConnection } from "../DatabaseConnection";

@injectable()
export class SQLiteKlineRepository implements IMarketDataRepository {
    constructor(@inject(TYPES.DatabaseConnection) private readonly dbConn: DatabaseConnection) {}

    public saveCandles(symbol: string, timeframe: string, candles: Candle[]): void {
        if (candles.length === 0) {
            return;
        }

        const db = this.dbConn.getDb();
        const insert = db.prepare(`
            INSERT OR IGNORE INTO historical_candles
            (symbol, timeframe, timestamp, open, high, low, close, volume, takerBuyBaseVolume, openInterest)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = db.transaction((items: Candle[]) => {
            for (const candle of items) {
                insert.run(
                    symbol,
                    timeframe,
                    candle.timestamp,
                    candle.open,
                    candle.high,
                    candle.low,
                    candle.close,
                    candle.volume,
                    candle.takerBuyBaseVolume ?? 0,
                    candle.openInterest ?? 0
                );
            }
        });

        transaction(candles);
    }

    public getCandles(symbol: string, timeframe: string, startTime: number, endTime: number): Candle[] {
        const db = this.dbConn.getDb();
        const rows = db.prepare(`
            SELECT timestamp, open, high, low, close, volume, takerBuyBaseVolume, openInterest
            FROM historical_candles
            WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(symbol, timeframe, startTime, endTime) as Candle[];

        return rows.map((row) => ({
            timestamp: row.timestamp,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            takerBuyBaseVolume: row.takerBuyBaseVolume,
            openInterest: row.openInterest
        }));
    }

    public hasDataForRange(symbol: string, timeframe: string, startTime: number, endTime: number): boolean {
        return this.getMissingRanges(symbol, timeframe, startTime, endTime).length === 0;
    }

    public getMissingRanges(symbol: string, timeframe: string, startTime: number, endTime: number): TimeRange[] {
        const normalizedStartTime = normalizeRangeStart(startTime, timeframe);
        const normalizedEndTime = normalizeRangeEnd(endTime, timeframe);

        if (normalizedStartTime > normalizedEndTime) {
            return [];
        }

        const db = this.dbConn.getDb();
        const intervalMs = intervalToMilliseconds(timeframe);
        const rows = db.prepare(`
            SELECT timestamp
            FROM historical_candles
            WHERE symbol = ? AND timeframe = ? AND timestamp >= ? AND timestamp <= ?
            ORDER BY timestamp ASC
        `).all(symbol, timeframe, normalizedStartTime, normalizedEndTime) as Array<{ timestamp: number }>;

        const missingRanges: TimeRange[] = [];
        let expectedTimestamp = normalizedStartTime;

        for (const row of rows) {
            if (row.timestamp < expectedTimestamp) {
                continue;
            }

            if (row.timestamp > expectedTimestamp) {
                missingRanges.push({
                    startTime: expectedTimestamp,
                    endTime: Math.min(row.timestamp - intervalMs, normalizedEndTime)
                });
            }

            expectedTimestamp = row.timestamp + intervalMs;

            if (expectedTimestamp > normalizedEndTime) {
                break;
            }
        }

        if (expectedTimestamp <= normalizedEndTime) {
            missingRanges.push({
                startTime: expectedTimestamp,
                endTime: normalizedEndTime
            });
        }

        return missingRanges.filter((range) => range.startTime <= range.endTime);
    }
}
