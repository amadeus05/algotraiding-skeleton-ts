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
import { StrategySignal, ClosedKlineEvent } from "../../src/core/types/trading";

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
    public minHistoryRequired(): number {
        return 1;
    }

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

function createCandle(timestamp: number, open: number, close: number, high?: number, low?: number): Candle {
    return {
        timestamp,
        open,
        high: high ?? Math.max(open, close),
        low: low ?? Math.min(open, close),
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

test("BotRunner executes strategy -> risk -> planner -> execution -> portfolio chain with next-open execution (no look-ahead bias)", () => {
    // Create candles with distinct open/close to verify next-open execution
    // Entry signal generated at candle 1 close (100)
    // Entry executed at candle 2 open (101) - next candle open!
    // Exit executed at candle 3 close (105)
    const candles = [
        createCandle(Date.UTC(2024, 0, 1, 0, 0, 0), 100, 100),  // Signal generated at close=100
        createCandle(Date.UTC(2024, 0, 1, 1, 0, 0), 101, 102),  // Entry at open=101
        createCandle(Date.UTC(2024, 0, 1, 2, 0, 0), 104, 105)   // Exit at close=105
    ];
    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(1000);
    const botRunner = new BotRunner(
        new EnterExitStrategy(),
        new RiskManager(createRiskParameters()),
        new ExecutionPlanner({ defaultTakeProfitRatio: 2, defaultExecutionTiming: "next_open" }),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier,
        { interval: "1h" }
    );

    const result = botRunner.run({
        symbol: "BTCUSDT",
        timeframe: "1h",
        candles
    });
    const snapshot = portfolioManager.getSnapshot(candles[candles.length - 1].timestamp);

    // Verify execution pipeline
    assert.equal(result.processedCandles, 3);
    assert.equal(result.entrySignals, 1);
    assert.equal(result.approvedEntries, 1);
    assert.equal(result.pendingOrdersCreated, 1);  // Entry queued for next open
    assert.equal(result.executedOrders, 2);  // 1 entry + 1 exit
    assert.equal(result.rejectedSignals, 0);
    assert.equal(snapshot.openTradeCount, 0);

    // PnL calculation:
    // Entry at 101 (next open from signal at 100)
    // Exit at 105
    // Gross PnL = (105 - 101) * 10 = 40
    assert.equal(snapshot.balance, 1040);
    assert.equal(snapshot.realizedPnl, 40);
    assert.equal(snapshot.equity, 1040);
    assert.equal(notifier.warnMessages.length, 0);
    // 3 info messages: entry queued, entry executed (next-open), exit executed
    assert.equal(notifier.infoMessages.length, 3);
});

test("BotRunner batch processing eliminates ordering bias with MAX_OPEN_TRADES=1", async () => {
    // This test verifies that when multiple symbols have entry signals at the same timestamp,
    // the selection is based on signal quality (R/R ratio) rather than symbol order.
    // This eliminates the ordering bias where symbols earlier in the array had priority.

    const sharedTimestamp = Date.UTC(2024, 0, 1, 0, 0, 0);
    const nextTimestamp = Date.UTC(2024, 0, 1, 1, 0, 0);

    // Create a strategy that returns signals with different quality for different symbols
    // Only generates entry on first candle (when history length is 1)
    class QualityBasedStrategy implements StrategyContract {
        public minHistoryRequired(): number {
            return 1;
        }

        public evaluate(context: StrategyContext): StrategySignal {
            // Only enter on first candle for each symbol
            if (context.history.length !== 1) {
                return { symbol: context.symbol, action: "hold", timestamp: context.candle.timestamp };
            }

            // BTC has better R/R (stop closer to entry relative to potential reward)
            if (context.symbol === "BTCUSDT") {
                return {
                    symbol: context.symbol,
                    action: "enter",
                    side: "long",
                    entryPrice: 100,
                    stopLossPrice: 99,    // 1% risk
                    takeProfitPrice: 110, // 10% reward = 10:1 R/R
                    timestamp: context.candle.timestamp
                };
            }
            // ETH has worse R/R
            if (context.symbol === "ETHUSDT") {
                return {
                    symbol: context.symbol,
                    action: "enter",
                    side: "long",
                    entryPrice: 100,
                    stopLossPrice: 95,    // 5% risk
                    takeProfitPrice: 110, // 10% reward = 2:1 R/R
                    timestamp: context.candle.timestamp
                };
            }
            return { symbol: context.symbol, action: "hold", timestamp: context.candle.timestamp };
        }
    }

    // Create events with same timestamp but different symbols
    // Order: ETH first (would win in old implementation), BTC second (should win with fair selection)
    const events: ClosedKlineEvent[] = [
        {
            exchange: "simulation",
            symbol: "ETHUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "ETHUSDT",
                interval: "1h",
                openTime: sharedTimestamp,
                closeTime: sharedTimestamp,
                open: 100,
                high: 105,
                low: 95,
                close: 102,
                volume: 1000,
                isClosed: true
            }
        },
        {
            exchange: "simulation",
            symbol: "BTCUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "BTCUSDT",
                interval: "1h",
                openTime: sharedTimestamp,
                closeTime: sharedTimestamp,
                open: 100,
                high: 105,
                low: 99,
                close: 101,
                volume: 1000,
                isClosed: true
            }
        },
        // Next candle for execution (need one for each symbol that got an order queued)
        {
            exchange: "simulation",
            symbol: "BTCUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "BTCUSDT",
                interval: "1h",
                openTime: nextTimestamp,
                closeTime: nextTimestamp,
                open: 101,
                high: 102,
                low: 100,
                close: 102,
                volume: 1000,
                isClosed: true
            }
        },
        {
            exchange: "simulation",
            symbol: "ETHUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "ETHUSDT",
                interval: "1h",
                openTime: nextTimestamp,
                closeTime: nextTimestamp,
                open: 102,
                high: 103,
                low: 101,
                close: 103,
                volume: 1000,
                isClosed: true
            }
        }
    ];

    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(10000);
    const botRunner = new BotRunner(
        new QualityBasedStrategy(),
        new RiskManager(createRiskParameters({ maxOpenTrades: 1 })),  // Only 1 slot!
        new ExecutionPlanner({ defaultTakeProfitRatio: 2, defaultExecutionTiming: "next_open" }),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier,
        { interval: "1h" }
    );

    const result = botRunner.runReplaySync(events);
    const snapshot = portfolioManager.getSnapshot(nextTimestamp);

    // Both signals should be evaluated at the shared timestamp
    assert.equal(result.entrySignals, 2, "Both symbols should generate entry signals");
    assert.equal(result.approvedEntries, 1, "Only 1 entry should be approved due to MAX_OPEN_TRADES=1");
    assert.equal(result.pendingOrdersCreated, 1, "Only 1 order should be queued");
    assert.equal(result.rejectedSignals, 1, "1 signal should be rejected due to limit");

    // BTC should be approved (better R/R ratio) despite coming SECOND in the event order
    // This proves ordering bias is eliminated
    const btcApproved = notifier.infoMessages.some(m => m.includes("BTCUSDT") && m.includes("queued"));
    const ethRejected = notifier.warnMessages.some(m => m.includes("ETHUSDT") && m.includes("rejected"));

    assert.equal(btcApproved, true, "BTC should be approved (better R/R ratio, 10:1 vs 2:1)");
    assert.equal(ethRejected, true, "ETH should be rejected (lower priority due to worse R/R)");

    // Verify portfolio has BTC position, not ETH
    assert.equal(snapshot.openTradeCount, 1, "Should have 1 open position");
    const position = portfolioManager.getPosition("BTCUSDT");
    assert.ok(position, "BTC position should exist");
    assert.equal(position?.side, "long", "Position should be long");
});

test("BotRunner batch processing evaluates all signals against same portfolio snapshot", async () => {
    // This test verifies that when multiple symbols have signals at the same timestamp,
    // all signals are evaluated against the portfolio state BEFORE any execution.

    const sharedTimestamp = Date.UTC(2024, 0, 1, 0, 0, 0);
    const nextTimestamp = Date.UTC(2024, 0, 1, 1, 0, 0);

    // Strategy that generates entry signals for all symbols on first candle only
    class AlwaysEnterStrategy implements StrategyContract {
        public minHistoryRequired(): number {
            return 1;
        }

        public evaluate(context: StrategyContext): StrategySignal {
            // Only enter on first candle for each symbol
            if (context.history.length !== 1) {
                return { symbol: context.symbol, action: "hold", timestamp: context.candle.timestamp };
            }
            return {
                symbol: context.symbol,
                action: "enter",
                side: "long",
                entryPrice: context.candle.close,
                timestamp: context.candle.timestamp
            };
        }
    }

    // Create events for 3 symbols at the SAME timestamp, plus next candles for execution
    const events: ClosedKlineEvent[] = [
        {
            exchange: "simulation",
            symbol: "BTCUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "BTCUSDT",
                interval: "1h",
                openTime: sharedTimestamp,
                closeTime: sharedTimestamp,
                open: 100,
                high: 105,
                low: 95,
                close: 102,
                volume: 1000,
                isClosed: true
            }
        },
        {
            exchange: "simulation",
            symbol: "ETHUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "ETHUSDT",
                interval: "1h",
                openTime: sharedTimestamp,
                closeTime: sharedTimestamp,
                open: 100,
                high: 105,
                low: 95,
                close: 102,
                volume: 1000,
                isClosed: true
            }
        },
        {
            exchange: "simulation",
            symbol: "SOLUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "SOLUSDT",
                interval: "1h",
                openTime: sharedTimestamp,
                closeTime: sharedTimestamp,
                open: 100,
                high: 105,
                low: 95,
                close: 102,
                volume: 1000,
                isClosed: true
            }
        },
        // Next candles for execution of queued orders
        {
            exchange: "simulation",
            symbol: "BTCUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "BTCUSDT",
                interval: "1h",
                openTime: nextTimestamp,
                closeTime: nextTimestamp,
                open: 103,
                high: 104,
                low: 101,
                close: 104,
                volume: 1000,
                isClosed: true
            }
        },
        {
            exchange: "simulation",
            symbol: "ETHUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "ETHUSDT",
                interval: "1h",
                openTime: nextTimestamp,
                closeTime: nextTimestamp,
                open: 103,
                high: 104,
                low: 101,
                close: 104,
                volume: 1000,
                isClosed: true
            }
        },
        {
            exchange: "simulation",
            symbol: "SOLUSDT",
            interval: "1h",
            kline: {
                exchange: "simulation",
                symbol: "SOLUSDT",
                interval: "1h",
                openTime: nextTimestamp,
                closeTime: nextTimestamp,
                open: 103,
                high: 104,
                low: 101,
                close: 104,
                volume: 1000,
                isClosed: true
            }
        }
    ];

    const notifier = new CollectingNotifier();
    const portfolioManager = new PortfolioManager(10000);
    const botRunner = new BotRunner(
        new AlwaysEnterStrategy(),
        new RiskManager(createRiskParameters({ maxOpenTrades: 2 })),  // 2 slots for 3 signals
        new ExecutionPlanner({ defaultTakeProfitRatio: 2, defaultExecutionTiming: "next_open" }),
        new SimulatedExecutionEngine(),
        portfolioManager,
        notifier,
        { interval: "1h" }
    );

    const result = botRunner.runReplaySync(events);
    const snapshot = portfolioManager.getSnapshot(nextTimestamp);

    // All 3 signals should be evaluated
    assert.equal(result.entrySignals, 3, "All 3 symbols should generate entry signals");

    // Only 2 should be approved (MAX_OPEN_TRADES=2)
    assert.equal(result.approvedEntries, 2, "Only 2 entries should be approved");
    assert.equal(result.rejectedSignals, 1, "1 signal should be rejected due to limit");

    // All 3 should have been evaluated against empty portfolio (0 open trades at start)
    // In old implementation, the 3rd symbol would see 1 or 2 open trades already
    assert.equal(snapshot.openTradeCount, 2, "Should have exactly 2 open positions");
});
