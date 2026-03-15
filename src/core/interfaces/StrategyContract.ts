import { Candle } from "../types/common";
import { PortfolioSnapshot, Position, StrategySignal } from "../types/trading";

export interface StrategyContext {
    symbol: string;
    timeframe: string;
    candle: Candle;
    history: Candle[];

    /** Optional higher timeframe context */
    htfTimeframe?: string;
    htfHistory?: Candle[];

    portfolio: PortfolioSnapshot;
    position?: Position;
}

export interface StrategyContract {
    evaluate(context: StrategyContext): StrategySignal;
}
