import test from "node:test";
import assert from "node:assert/strict";
import { RiskParameters } from "../../src/core/types/common";
import { StrategySignal } from "../../src/core/types/trading";
import { ExecutionPlanner } from "../../src/domain/execution/ExecutionPlanner";
import { PortfolioManager } from "../../src/domain/execution/PortfolioManager";
import { RiskManager } from "../../src/domain/risk/RiskManager";

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

function createEntrySignal(overrides: Partial<StrategySignal> = {}): StrategySignal {
    return {
        symbol: "BTCUSDT",
        action: "enter",
        side: "long",
        entryPrice: 100,
        timestamp: Date.UTC(2024, 0, 1, 0, 0, 0),
        ...overrides
    };
}

test("RiskManager computes 1% risk with 100% capital allocation and full-deposit entry", () => {
    const portfolio = new PortfolioManager(1000);
    const snapshot = portfolio.getSnapshot(Date.UTC(2024, 0, 1, 0, 0, 0));
    const riskManager = new RiskManager(createRiskParameters());

    const decision = riskManager.assessSignal(createEntrySignal(), snapshot);

    assert.equal(decision.approved, true);
    assert.equal(decision.riskAmount, 10);
    assert.equal(decision.capitalToAllocate, 1000);
    assert.equal(decision.quantity, 10);
    assert.equal(decision.stopDistance, 1);
    assert.equal(decision.suggestedStopLossPrice, 99);
    assert.equal(decision.estimatedLossAtStop, 10);
});

test("RiskManager rejects entries when open trades limit is reached", () => {
    const portfolio = new PortfolioManager(1000);
    portfolio.applyExecution({
        action: "open",
        symbol: "ETHUSDT",
        side: "long",
        quantity: 1,
        price: 100,
        leverage: 1,
        timestamp: Date.UTC(2024, 0, 1, 1, 0, 0)
    });

    const snapshot = portfolio.getSnapshot(Date.UTC(2024, 0, 1, 1, 0, 0));
    const riskManager = new RiskManager(createRiskParameters({ maxOpenTrades: 1 }));
    const decision = riskManager.assessSignal(createEntrySignal({ symbol: "BTCUSDT" }), snapshot);

    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? "", /Maximum number of open trades reached/);
});

test("RiskManager rejects a strategy stop that exceeds configured trade risk", () => {
    const portfolio = new PortfolioManager(1000);
    const snapshot = portfolio.getSnapshot(Date.UTC(2024, 0, 1, 0, 0, 0));
    const riskManager = new RiskManager(createRiskParameters());

    const decision = riskManager.assessSignal(createEntrySignal({ stopLossPrice: 95 }), snapshot);

    assert.equal(decision.approved, false);
    assert.match(decision.reason ?? "", /exceeds configured risk per trade/);
});

test("ExecutionPlanner builds stop and take profit from risk decision", () => {
    const portfolio = new PortfolioManager(1000);
    const snapshot = portfolio.getSnapshot(Date.UTC(2024, 0, 1, 0, 0, 0));
    const riskManager = new RiskManager(createRiskParameters());
    const planner = new ExecutionPlanner({ defaultTakeProfitRatio: 2 });
    const signal = createEntrySignal();
    const decision = riskManager.assessSignal(signal, snapshot);

    const plan = planner.buildEntryPlan(signal, decision);

    assert.equal(plan.symbol, "BTCUSDT");
    assert.equal(plan.quantity, 10);
    assert.equal(plan.notional, 1000);
    assert.equal(plan.stopLossPrice, 99);
    assert.equal(plan.takeProfitPrice, 102);
    assert.equal(plan.estimatedLossAtStop, 10);
});

test("PortfolioManager tracks realized and unrealized pnl with fees", () => {
    const portfolio = new PortfolioManager(1001);
    const openedAt = Date.UTC(2024, 0, 1, 10, 0, 0);
    const closedAt = Date.UTC(2024, 0, 1, 12, 0, 0);

    portfolio.applyExecution({
        action: "open",
        symbol: "BTCUSDT",
        side: "long",
        quantity: 10,
        price: 100,
        leverage: 1,
        fees: 1,
        timestamp: openedAt,
        stopLossPrice: 99
    });

    const afterOpen = portfolio.getSnapshot(openedAt);
    assert.equal(afterOpen.balance, 0);
    assert.equal(afterOpen.realizedPnl, -1);
    assert.equal(afterOpen.equity, 1000);
    assert.equal(afterOpen.openTradeCount, 1);

    portfolio.updateMarketPrice("BTCUSDT", 110, Date.UTC(2024, 0, 1, 11, 0, 0));
    const afterMark = portfolio.getSnapshot(Date.UTC(2024, 0, 1, 11, 0, 0));
    assert.equal(afterMark.unrealizedPnl, 100);
    assert.equal(afterMark.equity, 1100);

    portfolio.applyExecution({
        action: "close",
        symbol: "BTCUSDT",
        side: "long",
        quantity: 10,
        price: 105,
        leverage: 1,
        fees: 1,
        timestamp: closedAt
    });

    const afterClose = portfolio.getSnapshot(closedAt);
    assert.equal(afterClose.balance, 1049);
    assert.equal(afterClose.realizedPnl, 48);
    assert.equal(afterClose.unrealizedPnl, 0);
    assert.equal(afterClose.dailyPnl, 48);
    assert.equal(afterClose.openTradeCount, 0);
});
