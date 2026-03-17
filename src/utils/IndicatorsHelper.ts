import { Candle } from "../core/types/common";

export function ema(period: number, data: number[]): number | undefined {
    if (data.length < period) return undefined;

    const multiplier = 2 / (period + 1);
    let emaValue = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < data.length; i++) {
        emaValue = (data[i] - emaValue) * multiplier + emaValue;
    }
    return emaValue;
}

export function emaSeries(period: number, data: number[]): (number | undefined)[] {
    const result: (number | undefined)[] = new Array(data.length);

    if (data.length < period) {
        for (let i = 0; i < data.length; i++) result[i] = undefined;
        return result;
    }

    const multiplier = 2 / (period + 1);
    let emaValue = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = 0; i < period - 1; i++) result[i] = undefined;
    result[period - 1] = emaValue;

    for (let i = period; i < data.length; i++) {
        emaValue = (data[i] - emaValue) * multiplier + emaValue;
        result[i] = emaValue;
    }
    return result;
}

export function rsi(period: number, closes: number[]): number | undefined {
    if (closes.length < period + 1) return undefined;

    const changes = new Array<number>(closes.length);
    changes[0] = 0;
    for (let i = 1; i < closes.length; i++) {
        changes[i] = closes[i] - closes[i - 1];
    }

    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const c = changes[i];
        if (c > 0) gains += c;
        else losses += Math.abs(c);
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        const c = changes[i];
        avgGain = (avgGain * (period - 1) + (c > 0 ? c : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (c > 0 ? 0 : Math.abs(c))) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
}

export function rsiSeries(period: number, closes: number[]): (number | undefined)[] {
    const result: (number | undefined)[] = new Array(closes.length);

    if (closes.length < period + 1) {
        for (let i = 0; i < closes.length; i++) result[i] = undefined;
        return result;
    }

    const changes = new Array<number>(closes.length);
    changes[0] = 0;
    for (let i = 1; i < closes.length; i++) {
        changes[i] = closes[i] - closes[i - 1];
    }

    for (let i = 0; i <= period; i++) result[i] = undefined;

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= period; i++) {
        const c = changes[i];
        if (c > 0) avgGain += c;
        else avgLoss += Math.abs(c);
    }
    avgGain /= period;
    avgLoss /= period;

    for (let i = period; i < closes.length; i++) {
        if (i > period) {
            const c = changes[i];
            avgGain = (avgGain * (period - 1) + (c > 0 ? c : 0)) / period;
            avgLoss = (avgLoss * (period - 1) + (c > 0 ? 0 : Math.abs(c))) / period;
        }
        if (avgLoss === 0) {
            result[i] = 100;
        } else {
            const rs = avgGain / avgLoss;
            result[i] = 100 - 100 / (1 + rs);
        }
    }
    return result;
}

export function trueRange(candles: Candle[]): number[] {
    if (candles.length === 0) return [];
    const tr: number[] = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
        const prevClose = candles[i - 1].close;
        const high = candles[i].high;
        const low = candles[i].low;
        tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return tr;
}

export function atr(period: number, candles: Candle[]): number | undefined {
    const tr = trueRange(candles);
    if (tr.length < period) return undefined;

    let atrValue = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < tr.length; i++) {
        atrValue = (atrValue * (period - 1) + tr[i]) / period;
    }
    return atrValue;
}

export function atrSeries(period: number, candles: Candle[]): (number | undefined)[] {
    const tr = trueRange(candles);
    const result: (number | undefined)[] = new Array(candles.length);

    if (tr.length < period) {
        for (let i = 0; i < candles.length; i++) result[i] = undefined;
        return result;
    }

    for (let i = 0; i < period - 1; i++) result[i] = undefined;

    let atrValue = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    result[period - 1] = atrValue;

    for (let i = period; i < tr.length; i++) {
        atrValue = (atrValue * (period - 1) + tr[i]) / period;
        result[i] = atrValue;
    }
    return result;
}
