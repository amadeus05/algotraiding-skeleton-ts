import { ExchangeContract } from "../interfaces/ExchangeContract";
import { IMarketDataRepository } from "../interfaces/repositories/IMarketDataRepository";
import { HistoricalKlineRequest, TimeRange } from "../types/common";
import {
    normalizeInterval,
    normalizeRangeEnd,
    normalizeRangeStart,
    normalizeSymbol,
    toStoredCandles
} from "../../utils/Helpers";

export interface HistoricalDataPreparationResult {
    symbol: string;
    interval: string;
    startTime: number;
    endTime: number;
    missingRanges: TimeRange[];
    downloadedCandles: number;
    cachedCandles: number;
}

export class HistoricalMarketDataService {
    constructor(
        private readonly exchange: ExchangeContract,
        private readonly marketDataRepository: IMarketDataRepository
    ) {}

    public async ensureHistoricalRange(params: HistoricalKlineRequest): Promise<HistoricalDataPreparationResult> {
        if (params.startTime === undefined || params.endTime === undefined) {
            throw new Error("Historical data preparation requires both startTime and endTime.");
        }

        const symbol = normalizeSymbol(params.symbol);
        const interval = normalizeInterval(params.interval);
        const startTime = normalizeRangeStart(params.startTime, interval);
        const endTime = normalizeRangeEnd(params.endTime, interval);

        if (startTime > endTime) {
            throw new Error("Historical data range is empty after interval normalization.");
        }

        const missingRanges = this.marketDataRepository.getMissingRanges(symbol, interval, startTime, endTime);
        let downloadedCandles = 0;

        for (const missingRange of missingRanges) {
            const klines = await this.exchange.getHistoricalKlines({
                symbol,
                interval,
                startTime: missingRange.startTime,
                endTime: missingRange.endTime
            });

            const candles = toStoredCandles(klines);
            this.marketDataRepository.saveCandles(symbol, interval, candles);
            downloadedCandles += candles.length;
        }

        const cachedCandles = this.marketDataRepository.getCandles(symbol, interval, startTime, endTime).length;

        return {
            symbol,
            interval,
            startTime,
            endTime,
            missingRanges,
            downloadedCandles,
            cachedCandles
        };
    }
}
