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
    assert.equal(result.protectiveExits, 1);
    assert.equal(snapshot.openTradeCount, 0);
    assert.equal(snapshot.balance, 1020);
    assert.equal(snapshot.realizedPnl, 20);
    assert.equal(snapshot.equity, 1020);
    assert.equal(notifier.warnMessages.length, 0);
    assert.equal(notifier.infoMessages.length, 2);
});
