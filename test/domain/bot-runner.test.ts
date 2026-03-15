import test from "node:test";
import assert from "node:assert/strict";
import { BotRunner } from "../../src/application/BotRunner";
import { StrategyContext, StrategyContract } from "../../src/core/interfaces/StrategyContract";
import { ExecutionPlanner } from "../../src/domain/execution/ExecutionPlanner";
import { PortfolioManager } from "../../src/domain/execution/PortfolioManager";
import { RiskManager } from "../../src/domain/risk/RiskManager";
import { SimulatedExecutionEngine } from "../../src/infrastructure/execution/SimulatedExecutionEngine";
import { Candle, RiskParameters } from "../../src/core/types/common";
import { NotifierContract } from "../../src/core/interfaces/NotifierContract";
import { StrategySignal } from "../../src/core/types/trading";

class CollectingNotifier implements NotifierContract {
    public readonly infoMessages: string[] = [];
    public readonly warnMessages: string[] = [];

    public info(message: string): void {
        this.infoMessages.push(message);
    }

    public warn(message: string): void {
        this.warnMessages.push(message);
    }
}

class EnterExitStrategy implements StrategyContract {
    public evaluate(context: StrategyContext): StrategySignal {
        if (context.history.length === 1) {
            return {
                symbol: context.symbol,
                action: "enter",
                side: "long",
                entryPrice: context.candle.close,
                timestamp: context.candle.timestamp
            };
        }

        if (context.history.length === 3) {
            return {
                symbol: context.symbol,
                action: "exit",
                timestamp: context.candle.timestamp
            };
        }

        return {
            symbol: context.symbol,
            action: "hold",
            timestamp: context.candle.timestamp
        };
    }
}

function createCandle(timestamp: number, close: number): Candle {
    return {
        timestamp,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1000
    };
}

function createRiskParameters(overrides: Partial<RiskParameters> = {}): RiskParameters {
    return {
        accountBalance: 1000,
        riskPerTrade: 0.01,
        capitalAllocation: 1,
        maxOpenTrades: 2,
        leverage: 1,
        maxDailyLoss: 0.05,
        maxDrawdown: 0.15,
        minRR: 1.5,
        ...overrides
    };
}

function stripAnsi(value: string): string {
    return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("BotRunner executes strategy -> risk -> planner -> execution -> portfolio chain", () => {
    const candles = [
        createCandle(Date.UTC(2024, 0, 1, 0, 0, 0), 100),
        createCandle(Date.UTC(2024, 0, 1, 1, 0, 0), 101),
        createCandle(Date.UTC(2024, 0, 1, 2, 0, 0), 105)
    ];
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const botRunner = new BotRunner(
        new EnterExitStrategy(),
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner({ defaultTakeProfitRatio: 2 }),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier
    );

    const result = botRunner.run({
        symbol: "BTCUSDT",
        timeframe: "1h",
        candles
    });
    const snapshot = portfolioManager.getSnapshot(candles[candles.length - 1].timestamp);

    assert.equal(result.processedCandles, 3);
    assert.equal(result.entrySignals, 1);
    assert.equal(result.approvedEntries, 1);
    assert.equal(result.executedOrders, 2);
    assert.equal(result.rejectedSignals, 0);
    assert.equal(snapshot.openTradeCount, 0);
    assert.ok(snapshot.balance > 1015 && snapshot.balance < 1025);
    assert.ok(snapshot.realizedPnl > 15 && snapshot.realizedPnl < 25);
    assert.equal(notifier.warnMessages.length, 0);
    assert.equal(notifier.infoMessages.length, 2);
    assert.match(stripAnsi(notifier.infoMessages[0]), /OPEN LONG/);
    assert.match(stripAnsi(notifier.infoMessages[1]), /Reason: TP/);
});

test("deferred entry uses next candle open as execution price", () => {
    const candles = [
        createCandle(1000, 50),
        createCandle(2000, 52)
    ];
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const engine = new SimulatedExecutionEngine({ entrySlippageRate: 0, exitSlippageRate: 0 });
    const strategy: StrategyContract = {
        evaluate: (ctx) => ctx.history.length === 1
            ? { symbol: ctx.symbol, action: "enter", side: "long", entryPrice: 50, stopLossPrice: 49.5, takeProfitPrice: 54, timestamp: ctx.candle.timestamp }
            : { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp }
    };
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner({ defaultTakeProfitRatio: 2 }),
        engine,
        portfolioManager,
        notifier
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    const pos = portfolioManager.getPosition("X");
    assert.ok(pos, "position should exist");
    assert.equal(pos.entryPrice, 52, "entry must be at candle 2 open (52), not signal price (50)");
});

test("no lag on closed bar — strategy receives full history including current candle", () => {
    const candles = [
        createCandle(1000, 10),
        createCandle(2000, 11),
        createCandle(3000, 12)
    ];
    let maxHistoryLength = 0;
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            maxHistoryLength = Math.max(maxHistoryLength, ctx.history.length);
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner(),
        new SimulatedExecutionEngine(),
        new PortfolioManager(1000),
        new CollectingNotifier()
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    assert.equal(maxHistoryLength, 3, "strategy must receive full history including closed bar");
});

test("multisymbol pending entries don't overwrite each other", () => {
    const events: Array<{ symbol: string; open: number; high: number; low: number; close: number; ts: number }> = [
        { symbol: "A", open: 100, high: 100, low: 100, close: 100, ts: 1000 },
        { symbol: "B", open: 200, high: 200, low: 200, close: 200, ts: 1000 },
        { symbol: "A", open: 101, high: 101, low: 101, close: 101, ts: 2000 },
        { symbol: "B", open: 201, high: 201, low: 201, close: 201, ts: 2000 }
    ];
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            if (ctx.history.length === 1) {
                const e = ctx.candle.close;
                return { symbol: ctx.symbol, action: "enter", side: "long", entryPrice: e, stopLossPrice: e * 0.99, takeProfitPrice: e * 1.05, timestamp: ctx.candle.timestamp };
            }
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(10_000);
    const klineEvents = events.map((e) => ({
        exchange: "sim",
        symbol: e.symbol,
        interval: "1m",
        kline: { exchange: "sim", symbol: e.symbol, interval: "1m", openTime: e.ts, closeTime: e.ts, open: e.open, high: e.high, low: e.low, close: e.close, volume: 0, takerBuyBaseVolume: 0, openInterest: 0, isClosed: true }
    }));
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters({ maxOpenTrades: 10 })),
        new ExecutionPlanner(),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier
    );
    botRunner.runReplay(klineEvents);
    const trades = portfolioManager.getClosedTrades();
    assert.equal(trades.length, 0, "positions still open - no exit in 2 bars");
    const posA = portfolioManager.getPosition("A");
    const posB = portfolioManager.getPosition("B");
    assert.ok(posA && posB, "both symbols must have positions");
    assert.equal(posA.entryPrice, 101, "A enters at candle 2 open");
    assert.equal(posB.entryPrice, 201, "B enters at candle 2 open");
});

test("ambiguous candle closes by SL", () => {
    const candles = [
        { timestamp: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 2000, open: 101, high: 101, low: 101, close: 101, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 3000, open: 98, high: 106, low: 96, close: 105, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 }
    ];
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            if (ctx.history.length === 1) {
                return { symbol: ctx.symbol, action: "enter", side: "long", entryPrice: 100, stopLossPrice: 99.5, takeProfitPrice: 103, timestamp: ctx.candle.timestamp };
            }
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner(),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    const trades = portfolioManager.getClosedTrades();
    assert.equal(trades.length, 1);
    assert.equal(trades[0].closeReason, "SL (ambiguous candle)", "must close by SL when both hit");
});

// Test A: protective SL/TP срабатывает внутри свечи — позиция закрывается через BotRunner,
// даже если стратегия возвращает hold (protective exits централизованно в BotRunner).
test("protective SL closes position via BotRunner when strategy returns hold", () => {
    const candles = [
        { timestamp: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 2000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 3000, open: 99, high: 101, low: 98, close: 98, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 }
    ];
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            if (ctx.history.length === 1) {
                return { symbol: ctx.symbol, action: "enter", side: "long", entryPrice: 100, stopLossPrice: 99, takeProfitPrice: 102, timestamp: ctx.candle.timestamp };
            }
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner(),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    const trades = portfolioManager.getClosedTrades();
    assert.equal(trades.length, 1, "position must be closed");
    assert.equal(trades[0].closeReason, "SL (or liquidation)", "BotRunner protective SL must close, not strategy");
});

// Test B: discretionary exit — стратегия возвращает exit, protective SL/TP не срабатывают,
// позиция закрывается именно по сигналу стратегии.
test("discretionary strategy exit closes position when protective SL/TP not hit", () => {
    const candles = [
        { timestamp: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 2000, open: 101, high: 101, low: 101, close: 101, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 3000, open: 101.5, high: 102, low: 101, close: 101.5, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 }
    ];
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            if (ctx.history.length === 1) {
                return { symbol: ctx.symbol, action: "enter", side: "long", entryPrice: 100, stopLossPrice: 99, takeProfitPrice: 102, timestamp: ctx.candle.timestamp };
            }
            if (ctx.history.length === 3 && ctx.position) {
                return { symbol: ctx.symbol, action: "exit", timestamp: ctx.candle.timestamp, metadata: { exitReason: "Trend reversal" } };
            }
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner(),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    const trades = portfolioManager.getClosedTrades();
    assert.equal(trades.length, 1);
    assert.equal(trades[0].closeReason, "Trend reversal", "discretionary exit reason must be preserved");
    assert.match(notifier.infoMessages[1], /Trend reversal/);
});

// Test C: после входного slippage stopLoss/takeProfit сдвигаются на executedPrice - referenceEntryPrice,
// risk distance от фактического входа сохраняется.
test("SL/TP shifted by entry slippage preserves risk distance", () => {
    const candles = [
        { timestamp: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 2000, open: 102, high: 102, low: 102, close: 102, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 }
    ];
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            if (ctx.history.length === 1) {
                return {
                    symbol: ctx.symbol,
                    action: "enter",
                    side: "long",
                    entryPrice: 100,
                    stopLossPrice: 99,
                    takeProfitPrice: 102,
                    timestamp: ctx.candle.timestamp
                };
            }
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const portfolioManager = new PortfolioManager(1000);
    const engine = new SimulatedExecutionEngine({ entrySlippageRate: 0, exitSlippageRate: 0 });
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner(),
        engine,
        portfolioManager,
        new CollectingNotifier()
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    const pos = portfolioManager.getPosition("X");
    assert.ok(pos, "position must exist");
    assert.equal(pos.entryPrice, 102, "executed at candle 2 open (+2 vs reference)");
    assert.equal(pos.stopLossPrice, 101, "SL shifted +2: 99 + (102-100) = 101");
    assert.equal(pos.takeProfitPrice, 104, "TP shifted +2: 102 + (102-100) = 104");
    assert.equal(pos.entryPrice - (pos.stopLossPrice ?? 0), 1, "risk distance from executed entry = 1");
});

// Test D: в стратегиях больше нет exit по SL/TP — intra-candle protective logic удалена.
// Проверяем, что BotRunner — единственное место protective exit.
test("protective TP closes via BotRunner, strategy holds", () => {
    const candles = [
        { timestamp: 1000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 2000, open: 100, high: 100, low: 100, close: 100, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 },
        { timestamp: 3000, open: 101, high: 115, low: 100, close: 110, volume: 1000, takerBuyBaseVolume: 0, openInterest: 0 }
    ];
    const strategy: StrategyContract = {
        evaluate: (ctx) => {
            if (ctx.history.length === 1) {
                return { symbol: ctx.symbol, action: "enter", side: "long", entryPrice: 100, stopLossPrice: 99, takeProfitPrice: 101.5, timestamp: ctx.candle.timestamp };
            }
            return { symbol: ctx.symbol, action: "hold", timestamp: ctx.candle.timestamp };
        }
    };
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const botRunner = new BotRunner(
        strategy,
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner(),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier
    );
    botRunner.run({ symbol: "X", timeframe: "1m", candles });
    const trades = portfolioManager.getClosedTrades();
    assert.equal(trades.length, 1);
    assert.equal(trades[0].closeReason, "TP", "BotRunner protective TP must close; strategy only returns hold");
});
