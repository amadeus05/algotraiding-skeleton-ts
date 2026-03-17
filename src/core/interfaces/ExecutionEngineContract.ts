import { Candle } from "../types/common";
import { ExecutionPlan, ExecutedOrder, Position } from "../types/trading";

export interface ExecutionEngineContract {
    /**
     * Execute a plan immediately at the given candle's close price.
     * Used for live trading or when immediate execution is desired.
     */
    execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder;

    /**
     * Execute a plan at the given candle's open price.
     * Used for backtest to simulate entry at next candle's open (avoiding look-ahead bias).
     */
    executeAtOpen(plan: ExecutionPlan, candle: Candle): ExecutedOrder;

    /**
     * Build a close order for an existing position at the candle's close price.
     * Used for immediate/live exits.
     */
    buildCloseOrder(position: Position, candle: Candle): ExecutedOrder;

    /**
     * Build a close order for an existing position at the candle's open price.
     * Used for backtest exits at next candle's open to avoid optimistic exit bias.
     */
    buildCloseOrderAtOpen(position: Position, candle: Candle): ExecutedOrder;
}