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

    public execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder {
        const price = plan.entryPrice;
        const notional = price * plan.quantity;

        return {
            action: plan.action,
            symbol: plan.symbol,
            side: plan.side,
            quantity: plan.quantity,
            price,
            leverage: plan.leverage,
            timestamp: candle.timestamp,
            fees: notional * this.feeRate,
            stopLossPrice: plan.stopLossPrice,
            takeProfitPrice: plan.takeProfitPrice
        };
    }

    public buildCloseOrder(position: Position, candle: Candle): ExecutedOrder {
        const price = candle.close;
        const notional = price * position.quantity;

        return {
            action: "close",
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            price,
            leverage: position.leverage,
            timestamp: candle.timestamp,
            fees: notional * this.feeRate
        };
    }
}
