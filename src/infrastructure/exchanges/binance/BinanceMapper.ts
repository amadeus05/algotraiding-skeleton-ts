import { ExchangeId, Kline, KlineInterval } from "../../../core/types/common";

export type BinanceRawKline = [
    openTime: number,
    open: string,
    high: string,
    low: string,
    close: string,
    volume: string,
    closeTime: number,
    quoteVolume: string,
    trades: number,
    takerBuyBaseVolume: string,
    takerBuyQuoteVolume: string,
    ignore: string
];

interface BinanceKlineMeta {
    exchange?: ExchangeId;
    symbol: string;
    interval: KlineInterval;
}

export class BinanceMapper {
    public static toKline(rawKline: BinanceRawKline, meta: BinanceKlineMeta): Kline {
        return {
            exchange: meta.exchange ?? "binance",
            symbol: meta.symbol,
            interval: meta.interval,
            openTime: rawKline[0],
            open: Number(rawKline[1]),
            high: Number(rawKline[2]),
            low: Number(rawKline[3]),
            close: Number(rawKline[4]),
            volume: Number(rawKline[5]),
            closeTime: rawKline[6],
            quoteVolume: Number(rawKline[7]),
            trades: rawKline[8],
            takerBuyBaseVolume: Number(rawKline[9]),
            takerBuyQuoteVolume: Number(rawKline[10]),
            isClosed: true,
            raw: rawKline
        };
    }

    public static toKlines(rawKlines: BinanceRawKline[], meta: BinanceKlineMeta): Kline[] {
        return rawKlines.map((rawKline) => this.toKline(rawKline, meta));
    }
}
