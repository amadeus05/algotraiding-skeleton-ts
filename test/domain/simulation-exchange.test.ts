import test from "node:test";
import assert from "node:assert/strict";
import { IMarketDataRepository } from "../../src/core/interfaces/repositories/IMarketDataRepository";
import { Candle, TimeRange } from "../../src/core/types/common";
import { SimulationExchange } from "../../src/infrastructure/exchanges/simulation/SimulationExchange";

class InMemoryMarketDataRepository implements IMarketDataRepository {
    constructor(private readonly candleMap: Record<string, Candle[]>) {}

    public saveCandles(): void {}

    public getCandles(symbol: string, timeframe: string, startTime: number, endTime: number): Candle[] {
        return (this.candleMap[`${symbol}:${timeframe}`] ?? []).filter(
            (candle) => candle.timestamp >= startTime && candle.timestamp <= endTime
        );
    }

    public hasDataForRange(): boolean {
        return true;
    }

    public getMissingRanges(): TimeRange[] {
        return [];
    }
}

function createCandle(timestamp: number, close: number): Candle {
    return {
        timestamp,
        open: close,
        high: close,
        low: close,
        close,
        volume: 100
    };
}

test("SimulationExchange replays one candle per symbol in chronological order", async () => {
    const repository = new InMemoryMarketDataRepository({
        "BTCUSDT:1h": [
            createCandle(Date.UTC(2024, 0, 1, 0, 0, 0), 100),
            createCandle(Date.UTC(2024, 0, 1, 1, 0, 0), 101)
        ],
        "ETHUSDT:1h": [
            createCandle(Date.UTC(2024, 0, 1, 0, 0, 0), 200),
            createCandle(Date.UTC(2024, 0, 1, 1, 0, 0), 201)
        ]
    });
    const exchange = new SimulationExchange(repository);
    const events: string[] = [];

    for await (const event of exchange.streamHistoricalKlines({
        symbols: ["BTCUSDT", "ETHUSDT"],
        interval: "1h",
        startTime: Date.UTC(2024, 0, 1, 0, 0, 0),
        endTime: Date.UTC(2024, 0, 1, 1, 0, 0)
    })) {
        events.push(`${event.symbol}:${event.kline.openTime}:${event.kline.close}`);
    }

    assert.deepEqual(events, [
        `BTCUSDT:${Date.UTC(2024, 0, 1, 0, 0, 0)}:100`,
        `ETHUSDT:${Date.UTC(2024, 0, 1, 0, 0, 0)}:200`,
        `BTCUSDT:${Date.UTC(2024, 0, 1, 1, 0, 0)}:101`,
        `ETHUSDT:${Date.UTC(2024, 0, 1, 1, 0, 0)}:201`
    ]);
});
