import { CloseOrderOptions, ExecutionEngineContract } from "../../core/interfaces/ExecutionEngineContract";
import { Candle } from "../../core/types/common";
import { ExecutedOrder, ExecutionPlan, Position } from "../../core/types/trading";

export interface SimulatedExecutionEngineOptions {
    feeRate?: number;
    /** Скольжение в б.п., напр. 5 = 0.05% */
    slippageBps?: number;
    /** Только для buildCloseOrder reason="protective", когда задели и SL и TP */
    protectivePolicy?: "pessimistic" | "optimistic";
}

export class SimulatedExecutionEngine implements ExecutionEngineContract {
    private readonly feeRate: number;
    private readonly slippageMultiplier: number;
    private readonly protectivePolicy: "pessimistic" | "optimistic";

    constructor(options: SimulatedExecutionEngineOptions = {}) {
        this.feeRate = Math.max(options.feeRate ?? 0, 0);
        const bps = Math.max(options.slippageBps ?? 0, 0);
        this.slippageMultiplier = 1 + bps / 10_000;
        this.protectivePolicy = options.protectivePolicy ?? "pessimistic";
    }

    public execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder {
        const basePrice = candle.open;
        const price =
            plan.side === "long"
                ? basePrice * this.slippageMultiplier
                : basePrice / this.slippageMultiplier;
        const notional = price * plan.quantity;
        const fees = notional * this.feeRate;

        return {
            action: plan.action,
            symbol: plan.symbol,
            side: plan.side,
            quantity: plan.quantity,
            price,
            leverage: plan.leverage,
            timestamp: candle.timestamp,
            fees,
            stopLossPrice: plan.stopLossPrice,
            takeProfitPrice: plan.takeProfitPrice
        };
    }

    public buildCloseOrder(position: Position, candle: Candle, options?: CloseOrderOptions): ExecutedOrder | undefined {
        const reason = options?.reason ?? "signal";

        if (reason === "signal") {
            if (options?.exitPrice === undefined) {
                throw new Error("Signal exit requires exitPrice (deferred exit at next candle open).");
            }
            return this.buildCloseAtPrice(position, options.exitPrice, candle.timestamp);
        }

        const exitPrice = this.resolveProtectiveExit(position, candle, options?.protectivePolicy ?? this.protectivePolicy);
        if (exitPrice === undefined) {
            return undefined;
        }

        return this.buildCloseAtPrice(position, exitPrice, candle.timestamp);
    }

    private buildCloseAtPrice(position: Position, price: number, timestamp: number): ExecutedOrder {
        const notional = price * position.quantity;
        const fees = notional * this.feeRate;

        return {
            action: "close",
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            price,
            leverage: position.leverage,
            timestamp,
            fees
        };
    }

    private resolveProtectiveExit(
        position: Position,
        candle: Candle,
        policy: "pessimistic" | "optimistic"
    ): number | undefined {
        const slHit = position.stopLossPrice !== undefined && this.isStopLossHit(position, candle);
        const tpHit = position.takeProfitPrice !== undefined && this.isTakeProfitHit(position, candle);

        if (slHit && tpHit) {
            return policy === "pessimistic" ? position.stopLossPrice : position.takeProfitPrice;
        }
        if (slHit) {
            return position.stopLossPrice;
        }
        if (tpHit) {
            return position.takeProfitPrice;
        }
        return undefined;
    }

    private isStopLossHit(position: Position, candle: Candle): boolean {
        if (!position.stopLossPrice) return false;
        return position.side === "long"
            ? candle.low <= position.stopLossPrice
            : candle.high >= position.stopLossPrice;
    }

    private isTakeProfitHit(position: Position, candle: Candle): boolean {
        if (!position.takeProfitPrice) return false;
        return position.side === "long"
            ? candle.high >= position.takeProfitPrice
            : candle.low <= position.takeProfitPrice;
    }
}
