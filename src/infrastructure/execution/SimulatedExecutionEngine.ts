import { CloseOrderOptions, ExecutionEngineContract } from "../../core/interfaces/ExecutionEngineContract";
import { Candle } from "../../core/types/common";
import { ExecutedOrder, ExecutionPlan, Position } from "../../core/types/trading";

export interface SimulatedExecutionEngineOptions {
    /** Комиссия (e.g. 0.0005 = 0.05%). Для совместимости: makerFeeRate/takerFeeRate → используется takerFeeRate. */
    feeRate?: number;
    makerFeeRate?: number;
    takerFeeRate?: number;
    entrySlippageRate?: number;
    exitSlippageRate?: number;
}

export class SimulatedExecutionEngine implements ExecutionEngineContract {
    private readonly feeRate: number;
    private readonly entrySlippageRate: number;
    private readonly exitSlippageRate: number;

    constructor(options: SimulatedExecutionEngineOptions = {}) {
        const feeRate = options.feeRate ?? options.takerFeeRate ?? options.makerFeeRate ?? 0;
        this.feeRate = Math.max(feeRate, 0);
        this.entrySlippageRate = Math.max(options.entrySlippageRate ?? 0, 0);
        this.exitSlippageRate = Math.max(options.exitSlippageRate ?? 0, 0);
    }

    public execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder {
        // Для честного deferred market entry исполняем по open текущей свечи,
        // а не по старому signal.entryPrice
        const rawPrice = plan.orderType === "market" ? candle.open : plan.entryPrice;
        const price = this.applyEntrySlippage(rawPrice, plan.side);
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
            takeProfitPrice: plan.takeProfitPrice,
            metadata: {
                slippagePercent: rawPrice === 0 ? 0 : Math.abs(price - rawPrice) / rawPrice
            }
        };
    }

    public buildCloseOrder(position: Position, candle: Candle, options?: CloseOrderOptions): ExecutedOrder {
        const rawPrice = options?.exitPrice ?? candle.close;
        const price = this.applyExitSlippage(rawPrice, position.side);
        const notional = price * position.quantity;

        return {
            action: "close",
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            price,
            leverage: position.leverage,
            timestamp: candle.timestamp,
            fees: notional * this.feeRate,
            metadata: {
                slippagePercent: rawPrice === 0 ? 0 : Math.abs(price - rawPrice) / rawPrice
            }
        };
    }

    private applyEntrySlippage(price: number, side: Position["side"]): number {
        if (this.entrySlippageRate <= 0) {
            return price;
        }

        return side === "long"
            ? price * (1 + this.entrySlippageRate)
            : price * (1 - this.entrySlippageRate);
    }

    private applyExitSlippage(price: number, side: Position["side"]): number {
        if (this.exitSlippageRate <= 0) {
            return price;
        }

        // На выходе тоже двигаем в неблагоприятную сторону
        return side === "long"
            ? price * (1 - this.exitSlippageRate)
            : price * (1 + this.exitSlippageRate);
    }
}