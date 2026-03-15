import { ExchangeContract } from "../../../core/interfaces/ExchangeContract";
import { HistoricalReplayRequest, ReplayExchangeContract } from "../../../core/interfaces/ReplayExchangeContract";
import { IMarketDataRepository } from "../../../core/interfaces/repositories/IMarketDataRepository";
import { HistoricalKlineRequest, Kline, KlineInterval, Candle } from "../../../core/types/common";
import { ClosedKlineEvent } from "../../../core/types/trading";
import { intervalToMilliseconds, normalizeInterval, normalizeSymbol } from "../../../utils/Helpers";

interface SimulationCursor {
    symbol: string;
    candles: Candle[];
    index: number;
}

export class SimulationExchange implements ExchangeContract, ReplayExchangeContract {
    public readonly id = "simulation";

    constructor(
        private readonly marketDataRepository: IMarketDataRepository,
        private readonly exchangeId = "binance"
    ) {}

    public async getHistoricalKlines(params: HistoricalKlineRequest): Promise<Kline[]> {
        const symbol = normalizeSymbol(params.symbol);
        const interval = normalizeInterval(params.interval);
        const { startTime, endTime } = this.resolveRange(params, interval);
        const candles = this.marketDataRepository.getCandles(symbol, interval, startTime, endTime);

        return candles.map((candle) => this.toKline(symbol, interval, candle));
    }

    public async *streamHistoricalKlines(params: HistoricalReplayRequest): AsyncIterable<ClosedKlineEvent> {
        const interval = normalizeInterval(params.interval);
        const symbols = params.symbols.map((symbol) => normalizeSymbol(symbol));
        const cursors = symbols.map((symbol) => ({
            symbol,
            candles: this.marketDataRepository.getCandles(symbol, interval, params.startTime, params.endTime),
            index: 0
        }));

        while (true) {
            const nextTimestamp = this.findNextTimestamp(cursors);

            if (nextTimestamp === undefined) {
                return;
            }

            for (const cursor of cursors) {
                const candle = cursor.candles[cursor.index];

                if (!candle || candle.timestamp !== nextTimestamp) {
                    continue;
                }

                cursor.index += 1;
                yield {
                    exchange: this.exchangeId,
                    symbol: cursor.symbol,
                    interval,
                    kline: this.toKline(cursor.symbol, interval, candle)
                };
            }
        }
    }

    private resolveRange(params: HistoricalKlineRequest, interval: KlineInterval): { startTime: number; endTime: number } {
        if (params.startTime !== undefined && params.endTime !== undefined) {
            return {
                startTime: params.startTime,
                endTime: params.endTime
            };
        }

        if (params.startTime !== undefined && params.limit !== undefined) {
            const intervalMs = intervalToMilliseconds(interval);

            return {
                startTime: params.startTime,
                endTime: params.startTime + intervalMs * (params.limit - 1)
            };
        }

        if (params.endTime !== undefined && params.limit !== undefined) {
            const intervalMs = intervalToMilliseconds(interval);

            return {
                startTime: params.endTime - intervalMs * (params.limit - 1),
                endTime: params.endTime
            };
        }

        throw new Error("SimulationExchange requires startTime and endTime, or one boundary plus limit.");
    }

    private findNextTimestamp(cursors: SimulationCursor[]): number | undefined {
        let nextTimestamp: number | undefined;

        for (const cursor of cursors) {
            const candle = cursor.candles[cursor.index];

            if (!candle) {
                continue;
            }

            if (nextTimestamp === undefined || candle.timestamp < nextTimestamp) {
                nextTimestamp = candle.timestamp;
            }
        }

        return nextTimestamp;
    }

    private toKline(symbol: string, interval: KlineInterval, candle: Candle): Kline {
        const intervalMs = intervalToMilliseconds(interval);

        return {
            exchange: this.exchangeId,
            symbol,
            interval,
            openTime: candle.timestamp,
            closeTime: candle.timestamp + intervalMs - 1,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            takerBuyBaseVolume: candle.takerBuyBaseVolume,
            openInterest: candle.openInterest,
            isClosed: true
        };
    }
}
