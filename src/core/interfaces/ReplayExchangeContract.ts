import { KlineInterval } from "../types/common";
import { ClosedKlineEvent } from "../types/trading";

export interface HistoricalReplayRequest {
    symbols: string[];
    interval: KlineInterval;
    startTime: number;
    endTime: number;
}

export interface ReplayExchangeContract {
    streamHistoricalKlines(params: HistoricalReplayRequest): AsyncIterable<ClosedKlineEvent>;
}
