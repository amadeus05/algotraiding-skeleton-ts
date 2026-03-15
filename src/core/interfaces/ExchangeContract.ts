import { HistoricalKlineRequest, Kline } from "../types/common";

export interface ExchangeContract {
    readonly id: string;
    getHistoricalKlines(params: HistoricalKlineRequest): Promise<Kline[]>;
}
