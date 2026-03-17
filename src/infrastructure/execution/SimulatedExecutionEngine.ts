import { ExecutionEngineContract } from "../../core/interfaces/ExecutionEngineContract";
import { Candle } from "../../core/types/common";
import { ExecutedOrder, ExecutionPlan, Position } from "../../core/types/trading";

export interface SimulatedExecutionEngineOptions {
    feeRate?: number;
}

export class SimulatedExecutionEngine implements ExecutionEngineContract {
    private readonly feeRate: number;

    constructor(options: SimulatedExecutionEngineOptions = {}) {
        this.feeRate = Math.max(options.feeRate ?? 0, 0);
    }

    /**
     * Execute immediately at the plan's entry price (typically candle.close).
     * Used for immediate execution scenarios.
     */
    public execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder {
        return this.buildExecutedOrder(plan, plan.entryPrice, candle.timestamp);
    }

    /**
     * Execute at the candle's open price.
     * Used for backtest to avoid look-ahead bias by executing at next candle's open.
     */
    public executeAtOpen(plan: ExecutionPlan, candle: Candle): ExecutedOrder {
        return this.buildExecutedOrder(plan, candle.open, candle.timestamp);
    }

    /**
     * Build a close order for an existing position at the candle's close price.
     * Used for immediate/live exits.
     */
    public buildCloseOrder(position: Position, candle: Candle): ExecutedOrder {
        return this.buildCloseExecutedOrder(position, candle.close, candle.timestamp);
    }

    /**
     * Build a close order for an existing position at the candle's open price.
     * Used for backtest exits at next candle's open to avoid optimistic exit bias.
     */
    public buildCloseOrderAtOpen(position: Position, candle: Candle): ExecutedOrder {
        return this.buildCloseExecutedOrder(position, candle.open, candle.timestamp);
    }

    private buildExecutedOrder(plan: ExecutionPlan, price: number, timestamp: number): ExecutedOrder {
        const notional = price * plan.quantity;

        return {
            action: plan.action,
            symbol: plan.symbol,
            side: plan.side,
            quantity: plan.quantity,
            price,
            leverage: plan.leverage,
            timestamp,
            fees: notional * this.feeRate,
            stopLossPrice: plan.stopLossPrice,
            takeProfitPrice: plan.takeProfitPrice
        };
    }

    private buildCloseExecutedOrder(position: Position, price: number, timestamp: number): ExecutedOrder {
        const notional = price * position.quantity;

        return {
            action: "close",
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            price,
            leverage: position.leverage,
            timestamp,
            fees: notional * this.feeRate,
            stopLossPrice: position.stopLossPrice,
            takeProfitPrice: position.takeProfitPrice
        };
    }
}