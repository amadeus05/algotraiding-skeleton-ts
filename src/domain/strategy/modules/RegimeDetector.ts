import { Candle } from "../../../core/types/common";
import { TechnicalIndicators } from "../utils/TechnicalIndicators";

export type MarketRegime = "trending_up" | "trending_down" | "ranging" | "volatile" | "accumulation" | "distribution" | "unknown";

export interface RegimeAnalysis {
    regime: MarketRegime;
    volatility: number;
    volumeProfile: "high" | "normal" | "low";
    isTrending: boolean;
    isRanging: boolean;
    description: string;
}

export interface RegimeDetectorConfig {
    aggressiveMode?: boolean;
}

export class RegimeDetector {
    private readonly config: RegimeDetectorConfig;

    constructor(config?: RegimeDetectorConfig) {
        this.config = config || {};
    }

    public detect(candles: Candle[], lookback: number = 20): RegimeAnalysis {
        if (candles.length < lookback * 2) {
            return {
                regime: "unknown",
                volatility: 0,
                volumeProfile: "normal",
                isTrending: false,
                isRanging: false,
                description: "Insufficient data"
            };
        }

        const recentCandles = candles.slice(-lookback);
        const previousCandles = candles.slice(-lookback * 2, -lookback);

        // Calculate volatility
        const volatility = this.calculateVolatility(recentCandles);
        const previousVolatility = this.calculateVolatility(previousCandles);

        // Calculate volume profile
        const volumeProfile = this.analyzeVolume(recentCandles, candles.slice(0, -lookback));

        // Calculate price range
        const highs = recentCandles.map(c => c.high);
        const lows = recentCandles.map(c => c.low);
        const rangeHigh = Math.max(...highs);
        const rangeLow = Math.min(...lows);
        const rangeSize = rangeHigh - rangeLow;
        const rangePercent = rangeSize / rangeLow;

        // Calculate directional movement
        const firstClose = recentCandles[0].close;
        const lastClose = recentCandles[recentCandles.length - 1].close;
        const priceChange = (lastClose - firstClose) / firstClose;

        // Detect higher highs / lower lows pattern
        const higherHighs = TechnicalIndicators.isHigherHighsHigherLows(recentCandles, lookback / 2);
        const lowerLows = TechnicalIndicators.isLowerHighsLowerLows(recentCandles, lookback / 2);

        // Determine regime
        let regime: MarketRegime;
        let description: string;

        if (volatility > previousVolatility * 1.5) {
            regime = "volatile";
            description = "High volatility detected";
        } else if (Math.abs(priceChange) > 0.05 && higherHighs) {
            regime = "trending_up";
            description = "Strong uptrend with HH/HL structure";
        } else if (Math.abs(priceChange) > 0.05 && lowerLows) {
            regime = "trending_down";
            description = "Strong downtrend with LH/LL structure";
        } else if (rangePercent < 0.03 && Math.abs(priceChange) < 0.01) {
            regime = "ranging";
            description = "Price in tight consolidation range";
        } else if (priceChange < -0.02 && volumeProfile === "high") {
            regime = "distribution";
            description = "Potential distribution phase (high volume on decline)";
        } else if (priceChange > 0.02 && volumeProfile === "high") {
            regime = "accumulation";
            description = "Potential accumulation phase (high volume on rise)";
        } else {
            regime = "unknown";
            description = "Mixed signals, no clear regime";
        }

        return {
            regime,
            volatility,
            volumeProfile,
            isTrending: regime === "trending_up" || regime === "trending_down",
            isRanging: regime === "ranging",
            description
        };
    }

    private calculateVolatility(candles: Candle[]): number {
        if (candles.length < 2) return 0;

        const trueRanges: number[] = [];
        for (let i = 1; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];

            const tr1 = current.high - current.low;
            const tr2 = Math.abs(current.high - previous.close);
            const tr3 = Math.abs(current.low - previous.close);

            trueRanges.push(Math.max(tr1, tr2, tr3));
        }

        const avgTrueRange = trueRanges.reduce((a, b) => a + b, 0) / trueRanges.length;
        const avgPrice = candles.reduce((sum, c) => sum + c.close, 0) / candles.length;

        return avgTrueRange / avgPrice;
    }

    private analyzeVolume(
        recentCandles: Candle[],
        historicalCandles: Candle[],
        period: number = 20
    ): "high" | "normal" | "low" {
        const recentAvgVolume = recentCandles.reduce((sum, c) => sum + c.volume, 0) / recentCandles.length;
        const historicalAvgVolume = historicalCandles.length >= period
            ? historicalCandles.slice(-period).reduce((sum, c) => sum + c.volume, 0) / period
            : historicalCandles.reduce((sum, c) => sum + c.volume, 0) / historicalCandles.length || 1;

        const ratio = recentAvgVolume / historicalAvgVolume;

        if (ratio > 1.5) return "high";
        if (ratio < 0.5) return "low";
        return "normal";
    }

    public isGoodForLongs(analysis: RegimeAnalysis): boolean {
        return this.config.aggressiveMode
            ? true
            : (analysis.regime === "trending_up" || analysis.regime === "accumulation");
    }

    public isGoodForShorts(analysis: RegimeAnalysis): boolean {
        return this.config.aggressiveMode
            ? true
            : (analysis.regime === "trending_down" || analysis.regime === "distribution");
    }
}
