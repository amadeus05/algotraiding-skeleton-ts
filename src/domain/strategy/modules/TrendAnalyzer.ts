import { Candle } from "../../../core/types/common";
import { TechnicalIndicators } from "../utils/TechnicalIndicators";

export type TrendDirection = "uptrend" | "downtrend" | "sideways" | "undefined";

export interface TrendAnalysis {
    direction: TrendDirection;
    strength: number; // 0-1 scale
    emaFast: number;
    emaSlow: number;
    isBullish: boolean;
    isBearish: boolean;
    priceToFastEMADistance: number;
    priceToSlowEMADistance: number;
}

export class TrendAnalyzer {
    public analyze(
        candles: Candle[],
        fastPeriod: number = 50,
        slowPeriod: number = 200
    ): TrendAnalysis {
        if (candles.length < slowPeriod) {
            return {
                direction: "undefined",
                strength: 0,
                emaFast: 0,
                emaSlow: 0,
                isBullish: false,
                isBearish: false,
                priceToFastEMADistance: 0,
                priceToSlowEMADistance: 0
            };
        }

        const closes = candles.map(c => c.close);
        const currentPrice = closes[closes.length - 1];

        const emaFast = TechnicalIndicators.calculateEMA(closes, fastPeriod);
        const emaSlow = TechnicalIndicators.calculateEMA(closes, slowPeriod);

        const fastValue = emaFast.current;
        const slowValue = emaSlow.current;

        // Determine trend direction
        let direction: TrendDirection;
        let strength = 0;

        if (fastValue > slowValue * 1.001) {
            direction = "uptrend";
            // Calculate trend strength based on EMA separation and price position
            const emaSpread = (fastValue - slowValue) / slowValue;
            const pricePosition = currentPrice > fastValue ? 1 : currentPrice > slowValue ? 0.5 : 0;
            strength = Math.min(1, emaSpread * 10 + pricePosition * 0.3);
        } else if (fastValue < slowValue * 0.999) {
            direction = "downtrend";
            const emaSpread = (slowValue - fastValue) / slowValue;
            const pricePosition = currentPrice < fastValue ? 1 : currentPrice < slowValue ? 0.5 : 0;
            strength = Math.min(1, emaSpread * 10 + pricePosition * 0.3);
        } else {
            direction = "sideways";
            strength = 0.1;
        }

        const priceToFastDistance = TechnicalIndicators.calculatePriceDistanceFromEMA(currentPrice, fastValue);
        const priceToSlowDistance = TechnicalIndicators.calculatePriceDistanceFromEMA(currentPrice, slowValue);

        return {
            direction,
            strength,
            emaFast: fastValue,
            emaSlow: slowValue,
            isBullish: direction === "uptrend",
            isBearish: direction === "downtrend",
            priceToFastEMADistance: priceToFastDistance,
            priceToSlowEMADistance: priceToSlowDistance
        };
    }

    public isPullbackToEMA(
        candles: Candle[],
        trendAnalysis: TrendAnalysis,
        maxDistance: number = 0.03,
        side: "long" | "short" = "long"
    ): boolean {
        const currentPrice = candles[candles.length - 1].close;
        const emaFast = trendAnalysis.emaFast;
        const emaSlow = trendAnalysis.emaSlow;

        if (side === "long" && trendAnalysis.isBullish) {
            // For longs: price should be near or below fast EMA but above slow EMA
            const distanceFromFast = (emaFast - currentPrice) / emaFast;
            const isAboveSlow = currentPrice > emaSlow * 0.99;
            const isNearFast = distanceFromFast >= 0 && distanceFromFast <= maxDistance;

            return isAboveSlow && isNearFast;
        }

        if (side === "short" && trendAnalysis.isBearish) {
            // For shorts: price should be near or above fast EMA but below slow EMA
            const distanceFromFast = (currentPrice - emaFast) / emaFast;
            const isBelowSlow = currentPrice < emaSlow * 1.01;
            const isNearFast = distanceFromFast >= 0 && distanceFromFast <= maxDistance;

            return isBelowSlow && isNearFast;
        }

        return false;
    }

    public isPriceExtendedFromEMA(
        candles: Candle[],
        trendAnalysis: TrendAnalysis,
        threshold: number = 0.05
    ): boolean {
        const currentPrice = candles[candles.length - 1].close;
        const emaFast = trendAnalysis.emaFast;

        return TechnicalIndicators.calculatePriceDistanceFromEMA(currentPrice, emaFast) > threshold;
    }
}
