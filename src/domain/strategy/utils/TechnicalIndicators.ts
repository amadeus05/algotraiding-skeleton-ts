import { Candle } from "../../../core/types/common";

export interface EMAResult {
    values: number[];
    current: number;
}

export interface RSIResult {
    value: number;
    isOverbought: boolean;
    isOversold: boolean;
}

export interface ATRResult {
    value: number;
    stopLossOffset: number;
}

export class TechnicalIndicators {
    public static calculateEMA(prices: number[], period: number): EMAResult {
        if (prices.length < period) {
            return { values: [], current: 0 };
        }

        const k = 2 / (period + 1);
        const emaValues: number[] = [];

        // Initial SMA
        let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
        emaValues.push(ema);

        // Calculate EMA for remaining prices
        for (let i = period; i < prices.length; i++) {
            ema = prices[i] * k + ema * (1 - k);
            emaValues.push(ema);
        }

        return {
            values: emaValues,
            current: emaValues[emaValues.length - 1]
        };
    }

    public static calculateRSI(prices: number[], period: number = 14): RSIResult {
        if (prices.length < period + 1) {
            return { value: 50, isOverbought: false, isOversold: false };
        }

        let gains = 0;
        let losses = 0;

        // Initial average gain/loss
        for (let i = 1; i <= period; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) {
                gains += change;
            } else {
                losses -= change;
            }
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        // Calculate RSI for remaining prices
        for (let i = period + 1; i < prices.length; i++) {
            const change = prices[i] - prices[i - 1];
            if (change > 0) {
                avgGain = (avgGain * (period - 1) + change) / period;
                avgLoss = (avgLoss * (period - 1)) / period;
            } else {
                avgGain = (avgGain * (period - 1)) / period;
                avgLoss = (avgLoss * (period - 1) - change) / period;
            }
        }

        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        const rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + rs));

        return {
            value: rsi,
            isOverbought: rsi >= 70,
            isOversold: rsi <= 30
        };
    }

    public static calculateATR(candles: Candle[], period: number = 14): ATRResult {
        if (candles.length < period + 1) {
            const lastCandle = candles[candles.length - 1];
            const defaultAtr = lastCandle ? lastCandle.high - lastCandle.low : 0;
            return { value: defaultAtr, stopLossOffset: defaultAtr };
        }

        let trSum = 0;

        for (let i = candles.length - period; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];

            const tr1 = current.high - current.low;
            const tr2 = Math.abs(current.high - previous.close);
            const tr3 = Math.abs(current.low - previous.close);

            trSum += Math.max(tr1, tr2, tr3);
        }

        const atr = trSum / period;

        return {
            value: atr,
            stopLossOffset: atr
        };
    }

    public static calculateVolumeMA(candles: Candle[], period: number = 20): number {
        if (candles.length < period) {
            return candles.reduce((sum, c) => sum + c.volume, 0) / candles.length || 0;
        }

        const recentCandles = candles.slice(-period);
        return recentCandles.reduce((sum, c) => sum + c.volume, 0) / period;
    }

    public static calculateAverageVolume(candles: Candle[], period: number = 20): number {
        return this.calculateVolumeMA(candles, period);
    }

    public static hasVolumeSpike(candle: Candle, candles: Candle[], multiplier: number = 1.5, period: number = 20): boolean {
        const avgVolume = this.calculateAverageVolume(candles.slice(0, -1), period);
        return avgVolume > 0 && candle.volume > avgVolume * multiplier;
    }

    public static findSwingLow(candles: Candle[], lookback: number = 5): number {
        const recent = candles.slice(-lookback);
        if (recent.length === 0) return 0;
        return Math.min(...recent.map(c => c.low));
    }

    public static findSwingHigh(candles: Candle[], lookback: number = 5): number {
        const recent = candles.slice(-lookback);
        if (recent.length === 0) return 0;
        return Math.max(...recent.map(c => c.high));
    }

    public static isHigherHighsHigherLows(candles: Candle[], lookback: number = 10): boolean {
        if (candles.length < lookback * 2) return false;

        const recent = candles.slice(-lookback * 2);
        const highs: number[] = [];
        const lows: number[] = [];

        for (let i = 1; i < recent.length - 1; i++) {
            if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i + 1].high) {
                highs.push(recent[i].high);
            }
            if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i + 1].low) {
                lows.push(recent[i].low);
            }
        }

        if (highs.length < 2 || lows.length < 2) return false;

        const higherHighs = highs[highs.length - 1] > highs[0];
        const higherLows = lows[lows.length - 1] > lows[0];

        return higherHighs && higherLows;
    }

    public static isLowerHighsLowerLows(candles: Candle[], lookback: number = 10): boolean {
        if (candles.length < lookback * 2) return false;

        const recent = candles.slice(-lookback * 2);
        const highs: number[] = [];
        const lows: number[] = [];

        for (let i = 1; i < recent.length - 1; i++) {
            if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i + 1].high) {
                highs.push(recent[i].high);
            }
            if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i + 1].low) {
                lows.push(recent[i].low);
            }
        }

        if (highs.length < 2 || lows.length < 2) return false;

        const lowerHighs = highs[highs.length - 1] < highs[0];
        const lowerLows = lows[lows.length - 1] < lows[0];

        return lowerHighs && lowerLows;
    }

    public static calculatePriceDistanceFromEMA(price: number, ema: number): number {
        return Math.abs(price - ema) / ema;
    }
}
