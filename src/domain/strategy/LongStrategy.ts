import { StrategyContext } from "../../core/interfaces/StrategyContract";
import { Position, StrategySignal } from "../../core/types/trading";
import { BaseStrategy } from "./BaseStrategy";
import { LongStrategyConfig, DefaultLongConfig } from "./config/StrategyConfigs";
import { TrendAnalysis } from "./modules/TrendAnalyzer";
import { RegimeAnalysis } from "./modules/RegimeDetector";
import { TechnicalIndicators } from "./utils/TechnicalIndicators";

export class LongStrategy extends BaseStrategy {
    private readonly config: LongStrategyConfig;

    constructor(config: Partial<LongStrategyConfig> = {}) {
        super();
        this.config = { ...DefaultLongConfig, ...config };
    }

    public evaluate(context: StrategyContext): StrategySignal {
        const { position, history, symbol } = context;

        // Check if we have enough data
        if (!this.hasEnoughData(history, this.config.emaFastPeriod, this.config.emaSlowPeriod)) {
            return this.createHoldSignal(context);
        }

        // Analyze trend and regime
        const trend = this.trendAnalyzer.analyze(
            history,
            this.config.emaFastPeriod,
            this.config.emaSlowPeriod
        );
        const regime = this.regimeDetector.detect(history);

        // If we have a long position, check for exit conditions
        if (position?.side === "long") {
            const exitCheck = this.shouldExit(context, position, trend, regime);
            if (exitCheck.shouldExit) {
                return this.createExitSignal(context, position, exitCheck.reason || "exit triggered");
            }
            return this.createHoldSignal(context);
        }

        // If we already have a short position or any other position, hold
        if (position) {
            return this.createHoldSignal(context);
        }

        // Check for entry conditions
        const entryCheck = this.shouldEnter(context, trend, regime);
        if (entryCheck.shouldEnter) {
            return this.createEntrySignal(
                context,
                "long",
                entryCheck.confidence,
                this.config.stopLossATRMultiplier,
                this.config.takeProfitRR
            );
        }

        // Debug: log why entry was rejected (only occasionally to avoid spam)
        if (Math.random() < 0.05) {
            // console.log(`[LongStrategy] ${context.symbol} entry rejected: ${entryCheck.reason}`);
        }

        return this.createHoldSignal(context);
    }

    protected shouldEnter(
        context: StrategyContext,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldEnter: boolean; confidence: number; reason?: string } {
        const { candle, history } = context;

        // 1. Trend must be bullish
        if (this.config.requireTrendConfirmation && !trend.isBullish) {
            return { shouldEnter: false, confidence: 0, reason: "No bullish trend" };
        }

        if (trend.strength < this.config.minTrendStrength) {
            return { shouldEnter: false, confidence: 0, reason: "Trend too weak" };
        }

        // 2. Price should be pulling back to EMA (not chasing)
        const currentPrice = candle.close;
        const emaFast = trend.emaFast;
        const pullbackDistance = (emaFast - currentPrice) / emaFast;

        if (pullbackDistance < this.config.pullbackMinDistance || pullbackDistance > this.config.pullbackMaxDistance) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: `Pullback distance ${(pullbackDistance * 100).toFixed(2)}% out of range`
            };
        }

        // 3. Price must stay above slow EMA (trend intact)
        if (currentPrice < trend.emaSlow * 0.98) {
            return { shouldEnter: false, confidence: 0, reason: "Price below slow EMA" };
        }

        // 4. RSI check - should be recovering from oversold or in neutral zone
        const rsi = this.getRSI(history, this.config.rsiPeriod);
        if (rsi < this.config.rsiMin || rsi > this.config.rsiMax) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: `RSI ${rsi.toFixed(1)} outside range [${this.config.rsiMin}, ${this.config.rsiMax}]`
            };
        }

        // 5. Volume confirmation
        if (!this.hasVolumeConfirmation(candle, history, this.config.volumeSpikeMultiplier)) {
            return { shouldEnter: false, confidence: 0, reason: "No volume confirmation" };
        }

        // 6. Optional: Check for higher highs and higher lows structure
        if (this.config.requireHigherHighsHigherLows) {
            const hasStructure = TechnicalIndicators.isHigherHighsHigherLows(history, 10);
            if (!hasStructure) {
                return { shouldEnter: false, confidence: 0, reason: "No HH/HL structure" };
            }
        }

        // 7. Regime check
        if (!this.regimeDetector.isGoodForLongs(regime)) {
            return { shouldEnter: false, confidence: 0, reason: `Regime ${regime.regime} not good for longs` };
        }

        // Calculate confidence based on multiple factors
        let confidence = 0.5;

        // Trend strength contribution (0.2 max)
        confidence += trend.strength * 0.2;

        // RSI position - best around 50 (0.15 max)
        const rsiMidpoint = (this.config.rsiMin + this.config.rsiMax) / 2;
        const rsiDistanceFromMid = Math.abs(rsi - rsiMidpoint) / (this.config.rsiMax - this.config.rsiMin);
        confidence += (1 - rsiDistanceFromMid) * 0.15;

        // Pullback quality - ideal around middle of range (0.15 max)
        const idealPullback = (this.config.pullbackMinDistance + this.config.pullbackMaxDistance) / 2;
        const pullbackQuality = 1 - Math.abs(pullbackDistance - idealPullback) / idealPullback;
        confidence += Math.max(0, pullbackQuality) * 0.15;

        // Volume boost (0.1 max)
        if (this.hasVolumeConfirmation(candle, history, this.config.volumeSpikeMultiplier * 1.2)) {
            confidence += 0.1;
        }

        // HH/HL bonus (0.1 max)
        if (TechnicalIndicators.isHigherHighsHigherLows(history, 10)) {
            confidence += 0.1;
        }

        return {
            shouldEnter: true,
            confidence: Math.min(confidence, 1.0),
            reason: `Long entry: trend strength ${(trend.strength * 100).toFixed(0)}%, RSI ${rsi.toFixed(1)}, pullback ${(pullbackDistance * 100).toFixed(2)}%`
        };
    }

    protected shouldExit(
        context: StrategyContext,
        position: Position,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldExit: boolean; reason?: string } {
        const { candle, history } = context;
        const currentPrice = candle.close;

        // 1. Stop loss hit
        if (currentPrice <= position.stopLossPrice!) {
            return { shouldExit: true, reason: "Stop loss hit" };
        }

        // 2. Take profit hit
        if (position.takeProfitPrice && currentPrice >= position.takeProfitPrice) {
            return { shouldExit: true, reason: "Take profit hit" };
        }

        // 3. Trend reversal - fast EMA crosses below slow EMA
        if (!trend.isBullish) {
            return { shouldExit: true, reason: "Trend reversal detected" };
        }

        // 4. RSI overbought (potential top)
        const rsi = this.getRSI(history, this.config.rsiPeriod);
        if (rsi > 80) {
            return { shouldExit: true, reason: `RSI overbought at ${rsi.toFixed(1)}` };
        }

        // 5. Trailing stop - price extended too far from EMA
        const extendedDistance = this.trendAnalyzer.isPriceExtendedFromEMA(history, trend, 0.08);
        if (extendedDistance) {
            return { shouldExit: true, reason: "Price too extended from EMA" };
        }

        // 6. Regime change to distribution or strong downtrend
        if (regime.regime === "distribution" || regime.regime === "trending_down") {
            return { shouldExit: true, reason: `Regime changed to ${regime.regime}` };
        }

        return { shouldExit: false };
    }
}
