import { Candle } from "../types/common";
import { ExecutionPlan, ExecutedOrder, Position } from "../types/trading";

export interface ExecutionEngineContract {
    execute(plan: ExecutionPlan, candle: Candle): ExecutedOrder;
    buildCloseOrder(position: Position, candle: Candle): ExecutedOrder;
}
