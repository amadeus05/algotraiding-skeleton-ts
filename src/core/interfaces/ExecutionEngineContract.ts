import { Candle } from "../types/common";
import { ExecutionPlan, ExecutedOrder, Position } from "../types/trading";

export interface CloseOrderOptions {
    reason: "signal" | "protective";
    /** Только для reason="protective": при касании и SL и TP в одной свече */
    protectivePolicy?: "pessimistic" | "optimistic";
    /** Явная цена исполнения (для deferred signal exit по open следующей свечи) */
    exitPrice?: number;
}

export interface ExecutionEngineContract {
    execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder;
    /**
     * reason="signal" — закрытие по текущей модели исполнения, без проверки high/low.
     * reason="protective" — проверка SL/TP; если ничего не задето, возвращает undefined.
     */
    buildCloseOrder(position: Position, candle: Candle, options?: CloseOrderOptions): ExecutedOrder | undefined;
}
