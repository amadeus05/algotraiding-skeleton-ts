import { Candle, Kline, KlineInterval } from "../core/types/common";

const FIXED_INTERVAL_MULTIPLIERS: Record<string, number> = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
};

export function intervalToMilliseconds(interval: string): number {
    const match = interval.trim().match(/^(\d+)([mhdw])$/);

    if (!match) {
        throw new Error(`Unsupported interval for local cache coverage checks: ${interval}`);
    }

    const [, amountRaw, unit] = match;
    const amount = Number(amountRaw);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid interval amount: ${interval}`);
    }

    return amount * FIXED_INTERVAL_MULTIPLIERS[unit];
}

export function normalizeRangeStart(startTime: number, interval: string): number {
    const intervalMs = intervalToMilliseconds(interval);
    const remainder = startTime % intervalMs;

    return remainder === 0 ? startTime : startTime + (intervalMs - remainder);
}

export function normalizeRangeEnd(endTime: number, interval: string): number {
    const intervalMs = intervalToMilliseconds(interval);
    return endTime - (endTime % intervalMs);
}

export function toStoredCandles(klines: Kline[]): Candle[] {
    return klines.map((kline) => ({
        timestamp: kline.openTime,
        open: kline.open,
        high: kline.high,
        low: kline.low,
        close: kline.close,
        volume: kline.volume,
        takerBuyBaseVolume: kline.takerBuyBaseVolume,
        openInterest: kline.openInterest
    }));
}

export function parseTimeInput(value: string): number {
    const trimmedValue = value.trim();

    if (/^\d+$/.test(trimmedValue)) {
        return Number(trimmedValue);
    }

    const parsedTimestamp = Date.parse(trimmedValue);

    if (Number.isNaN(parsedTimestamp)) {
        throw new Error(`Unable to parse time value: ${value}`);
    }

    return parsedTimestamp;
}

export function normalizeSymbol(symbol: string): string {
    return symbol.trim().toUpperCase();
}

export function normalizeInterval(interval: KlineInterval): KlineInterval {
    return interval.trim() as KlineInterval;
}

export function formatUtcDateTime(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    const seconds = String(date.getUTCSeconds()).padStart(2, "0");

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatDisplaySymbol(symbol: string): string {
    const knownQuotes = ["USDT", "USDC", "BUSD", "FDUSD", "BTC", "ETH"];

    for (const quote of knownQuotes) {
        if (symbol.endsWith(quote) && symbol.length > quote.length) {
            return `${symbol.slice(0, -quote.length)}/${quote}`;
        }
    }

    return symbol;
}
