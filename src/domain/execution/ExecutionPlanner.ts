import { ExecutionPlan, ExecutionTiming, RiskDecision, StrategySignal } from "../../core/types/trading";

export interface ExecutionPlannerOptions {
    defaultOrderType?: ExecutionPlan["orderType"];
    defaultTakeProfitRatio?: number;
    /** Default execution timing - "next_open" for backtest to avoid look-ahead bias, "immediate" for live trading */
    defaultExecutionTiming?: ExecutionTiming;
}

export class ExecutionPlanner {
    private readonly defaultOrderType: ExecutionPlan["orderType"];
    private readonly defaultTakeProfitRatio?: number;
    private readonly defaultExecutionTiming: ExecutionTiming;

    constructor(options: ExecutionPlannerOptions = {}) {
        this.defaultOrderType = options.defaultOrderType ?? "market";
        this.defaultTakeProfitRatio = options.defaultTakeProfitRatio;
        this.defaultExecutionTiming = options.defaultExecutionTiming ?? "next_open";
    }

    public buildEntryPlan(signal: StrategySignal, riskDecision: RiskDecision): ExecutionPlan {
        if (!riskDecision.approved) {
            throw new Error(`Cannot build execution plan for rejected signal: ${riskDecision.reason ?? "unknown reason"}`);
        }

        if (signal.action !== "enter" || !signal.side || !signal.entryPrice) {
            throw new Error("Execution plan can only be built for entry signals with side and entry price.");
        }

        const stopLossPrice = signal.stopLossPrice ?? riskDecision.suggestedStopLossPrice;

        if (stopLossPrice === undefined) {
            throw new Error("Execution plan requires a stop loss price.");
        }

        const takeProfitPrice = signal.takeProfitPrice ?? this.buildDefaultTakeProfit(signal, riskDecision);
        const executionTiming = signal.executionTiming ?? this.defaultExecutionTiming;

        return {
            action: "open",
            symbol: signal.symbol,
            side: signal.side,
            orderType: this.defaultOrderType,
            quantity: riskDecision.quantity,
            entryPrice: signal.entryPrice,
            notional: riskDecision.quantity * signal.entryPrice,
            leverage: riskDecision.leverage,
            stopLossPrice,
            takeProfitPrice,
            reduceOnly: false,
            estimatedLossAtStop: riskDecision.estimatedLossAtStop,
            executionTiming
        };
    }

    private buildDefaultTakeProfit(signal: StrategySignal, riskDecision: RiskDecision): number | undefined {
        if (this.defaultTakeProfitRatio === undefined || !signal.side || !signal.entryPrice) {
            return undefined;
        }

        const rewardDistance = riskDecision.stopDistance * this.defaultTakeProfitRatio;

        return signal.side === "long"
            ? signal.entryPrice + rewardDistance
            : signal.entryPrice - rewardDistance;
    }
}
