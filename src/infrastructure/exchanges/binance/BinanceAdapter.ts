import { injectable } from "inversify";
import { ExchangeContract } from "../../../core/interfaces/ExchangeContract";
import { HistoricalKlineRequest, Kline, KlineInterval } from "../../../core/types/common";
import { BinanceMapper } from "./BinanceMapper";
import { BinanceService } from "./BinanceService";

@injectable()
export class BinanceAdapter implements ExchangeContract {
    public readonly id = "binance";

    constructor(private readonly service: BinanceService = new BinanceService()) {}

    public async getHistoricalKlines(params: HistoricalKlineRequest): Promise<Kline[]> {
        const rawKlines = await this.service.fetchHistoricalKlines(params);
        const symbol = params.symbol.trim().toUpperCase();
        const interval = params.interval.trim() as KlineInterval;

        return BinanceMapper.toKlines(rawKlines, {
            symbol,
            interval
        });
    }
}
