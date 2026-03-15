import { Candle, TimeRange } from "../../types/common";

export interface IMarketDataRepository {
    saveCandles(symbol: string, timeframe: string, candles: Candle[]): void;
    getCandles(symbol: string, timeframe: string, startTime: number, endTime: number): Candle[];
    hasDataForRange(symbol: string, timeframe: string, startTime: number, endTime: number): boolean;
    getMissingRanges(symbol: string, timeframe: string, startTime: number, endTime: number): TimeRange[];
}
