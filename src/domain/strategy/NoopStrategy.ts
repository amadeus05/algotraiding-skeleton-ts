import { StrategyContext, StrategyContract } from "../../core/interfaces/StrategyContract";
import { StrategySignal } from "../../core/types/trading";

export class NoopStrategy implements StrategyContract {
    public evaluate(context: StrategyContext): StrategySignal {
        return {
            symbol: context.symbol,
            action: "hold",
            timestamp: context.candle.timestamp
        };
    }
}
