import { Candle } from "../types/common";
import { ExecutionPlan, ExecutedOrder, Position } from "../types/trading";

export interface CloseOrderOptions {
    /** Явная цена закрытия при внутрисвечном SL/TP (иначе используется candle.close) */
    exitPrice?: number;
}

export interface ExecutionEngineContract {
    execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder;
    buildCloseOrder(position: Position, candle: Candle, options?: CloseOrderOptions): ExecutedOrder;
}
