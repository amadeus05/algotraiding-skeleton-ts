import test from "node:test";
import assert from "node:assert/strict";
import { Candle } from "../../src/core/types/common";
import { PortfolioSnapshot, Position } from "../../src/core/types/trading";
import { StrategyContext } from "../../src/core/interfaces/StrategyContract";
import { ShortStrategy } from "../../src/domain/strategy/ShortStrategy";
import { LongStrategy } from "../../src/domain/strategy/LongStrategy";

function createCandle(timestamp: number, open: number, high: number, low: number, close: number): Candle {
    return { timestamp, open, high, low, close, volume: 1000 };
}

function createHistory(closes: number[], baseTs = 1000000): Candle[] {
    return closes.map((c, i) => createCandle(baseTs + i * 60_000, c, c, c, c));
}

function createPosition(
    side: "long" | "short",
    entryPrice: number,
    currentPrice: number,
    openedAt: number
): Position {
    return {
        symbol: "BTCUSDT",
        side,
        quantity: 1,
        entryPrice,
        currentPrice,
        leverage: 1,
        openedAt,
        updatedAt: Date.now(),
        feesPaid: 0
    };
}

function createContext(
    history: Candle[],
    position: Position,
    portfolio?: PortfolioSnapshot
): StrategyContext {
    const candle = history[history.length - 1];
    return {
        symbol: "BTCUSDT",
        timeframe: "1h",
        candle,
        history,
        portfolio: portfolio ?? {
            balance: 1000,
            equity: 1000,
            realizedPnl: 0,
            unrealizedPnl: 0,
            dailyPnl: 0,
            drawdown: 0,
            openTradeCount: 1,
            positions: [position]
        },
        position
    };
}

// ShortStrategy: hasEnoughData требует max(50, slowPeriod)+20 свечей. Используем 20/50 для 70 свечей.
const minimalConfig = {
    emaFastPeriod: 20,
    emaSlowPeriod: 50,
    rsiPeriod: 14,
    rsiMin: 30,
    rsiMax: 85,
    volumeSpikeMultiplier: 1.0,
    minTrendStrength: 0.1,
    bounceMinDistance: 0,
    bounceMaxDistance: 0.2,
    stopLossATRMultiplier: 1,
    takeProfitRR: 1.5,
    requireTrendConfirmation: false,
    requireLowerHighsLowerLows: false,
    requireDistribution: false,
    maxFundingRate: 0,
    minProfitForReversalExitPercent: 1.0,
    minHoldingCandlesBeforeReversalExit: 3,
    reversalConfirmationCandles: 2
};

test("reversal exit blocked if pnl < threshold (short)", () => {
    // Нисходящая серия, затем сильный рост -> bullish reversal. PnL short = 0.5% (< 1%)
    const declining = Array.from({ length: 45 }, (_, i) => 100 - i * 0.5); // 100..77.5
    const rising = Array.from({ length: 35 }, (_, i) => 78 + i * 2.5); // 78..165
    const closes = [...declining, ...rising];
    const history = createHistory(closes);
    const entryPrice = 100;
    const currentPrice = 99.5; // short profit 0.5%
    const openedAt = history[history.length - 5].timestamp; // 4 свечи после входа (holding ok)

    const position = createPosition("short", entryPrice, currentPrice, openedAt);
    const strategy = new ShortStrategy({
        ...minimalConfig,
        minProfitForReversalExitPercent: 1.0
    });

    const signal = strategy.evaluate(createContext(history, position));
    assert.equal(signal.action, "hold", "reversal exit должен быть заблокирован при pnl < 1%");
});

test("reversal exit blocked before min holding candles (short)", () => {
    const declining = Array.from({ length: 45 }, (_, i) => 100 - i * 0.5);
    const rising = Array.from({ length: 35 }, (_, i) => 78 + i * 2.5);
    const history = createHistory([...declining, ...rising]);
    const entryPrice = 100;
    const currentPrice = 97; // short profit 3% (ok)
    const openedAt = history[history.length - 2].timestamp; // только 1 свеча после входа (< 3)

    const position = createPosition("short", entryPrice, currentPrice, openedAt);
    const strategy = new ShortStrategy({
        ...minimalConfig,
        minHoldingCandlesBeforeReversalExit: 3
    });

    const signal = strategy.evaluate(createContext(history, position));
    assert.equal(signal.action, "hold", "reversal exit должен быть заблокирован до min holding candles");
});

test("reversal exit requires 2-candle confirmation (short)", () => {
    // Текущая свеча: bullish. Предыдущая: bearish. -> нет 2-candle confirmation
    const declining = Array.from({ length: 55 }, (_, i) => 100 - i * 0.5);
    const flip = Array.from({ length: 25 }, (_, i) => 72 + i * 3); // резко вверх
    const history = createHistory([...declining, ...flip]);
    const entryPrice = 100;
    const currentPrice = 115; // short в убытке, но нас интересует только reversal
    const openedAt = history[5].timestamp; // много свечей назад (holding ok)

    const position = createPosition("short", entryPrice, currentPrice, openedAt);
    const strategy = new ShortStrategy({
        ...minimalConfig,
        minProfitForReversalExitPercent: 0, // отключаем проверку pnl
        reversalConfirmationCandles: 2
    });

    const signal = strategy.evaluate(createContext(history, position));
    assert.equal(
        signal.action,
        "hold",
        "reversal exit должен быть заблокирован без 2-свечного подтверждения"
    );
});

test("reversal exit blocked if pnl < threshold (long)", () => {
    // Рост затем лёгкое снижение — bearish trend, но не distribution. PnL long 0.5%
    const rising = Array.from({ length: 50 }, (_, i) => 95 + i * 0.4);
    const mildDecline = Array.from({ length: 30 }, (_, i) => 115 - i * 0.3);
    const history = createHistory([...rising, ...mildDecline]);
    const entryPrice = 100;
    const currentPrice = 100.5; // long profit 0.5% < 1% threshold
    const openedAt = history[history.length - 6].timestamp;

    const position = createPosition("long", entryPrice, currentPrice, openedAt);
    const strategy = new LongStrategy({
        ...minimalConfig,
        minProfitForReversalExitPercent: 1.0
    });

    const signal = strategy.evaluate(createContext(history, position));
    assert.equal(signal.action, "hold", "reversal exit (long) должен быть заблокирован при pnl < 1%");
});

test("reversal exit blocked before min holding candles (long)", () => {
    const rising = Array.from({ length: 50 }, (_, i) => 95 + i * 0.4);
    const mildDecline = Array.from({ length: 30 }, (_, i) => 115 - i * 0.3);
    const history = createHistory([...rising, ...mildDecline]);
    const entryPrice = 100;
    const currentPrice = 103;
    const openedAt = history[history.length - 2].timestamp; // только 1 свеча после входа

    const position = createPosition("long", entryPrice, currentPrice, openedAt);
    const strategy = new LongStrategy({
        ...minimalConfig,
        minProfitForReversalExitPercent: 0,
        minHoldingCandlesBeforeReversalExit: 3,
        reversalConfirmationCandles: 2
    });

    const signal = strategy.evaluate(createContext(history, position));
    assert.equal(signal.action, "hold", "reversal exit (long) заблокирован до min holding candles");
});

test("reversal exit requires 2-candle confirmation (long)", () => {
    // Та же логика, что short: без 2-свечного подтверждения reversal exit не срабатывает.
    // Используем данные, где bearish только на последней свече (предыдущая ещё bullish).
    const rising = Array.from({ length: 60 }, (_, i) => 85 + i * 0.35);
    const flat = Array.from({ length: 15 }, () => 106);
    const lastDrop = [105, 98]; // последние 2 свечи: сначала 105, потом 98 — flip
    const history = createHistory([...rising, ...flat, ...lastDrop]);
    const lastClose = history[history.length - 1].close;
    const openedAt = history[10].timestamp;

    const position = createPosition("long", 100, lastClose, openedAt);
    const strategy = new LongStrategy({
        ...minimalConfig,
        minProfitForReversalExitPercent: 0,
        minHoldingCandlesBeforeReversalExit: 0,
        reversalConfirmationCandles: 2
    });

    const signal = strategy.evaluate(createContext(history, position));
    // history[:-1] заканчивается на 105 — trend ещё bullish. Только полная history даёт bearish.
    assert.equal(
        signal.action,
        "hold",
        "reversal exit (long) заблокирован без 2-свечного подтверждения"
    );
});
