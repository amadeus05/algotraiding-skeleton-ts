import { StrategyContext } from "../../core/interfaces/StrategyContract";
import { Position, StrategySignal } from "../../core/types/trading";
import { BaseStrategy } from "./BaseStrategy";
import { ShortStrategyConfig, DefaultShortConfig } from "./config/StrategyConfigs";
import { TrendAnalysis } from "./modules/TrendAnalyzer";
import { RegimeAnalysis } from "./modules/RegimeDetector";
import { TechnicalIndicators } from "./utils/TechnicalIndicators";

export class ShortStrategy extends BaseStrategy {
    private readonly config: ShortStrategyConfig;

    constructor(config: Partial<ShortStrategyConfig> = {}) {
        super();
        this.config = { ...DefaultShortConfig, ...config };
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

        // If we have a short position, check for exit conditions
        if (position?.side === "short") {
            const exitCheck = this.shouldExit(context, position, trend, regime);
            if (exitCheck.shouldExit) {
                return this.createExitSignal(context, position, exitCheck.reason || "exit triggered");
            }
            return this.createHoldSignal(context);
        }

        // If we already have a long position or any other position, hold
        if (position) {
            return this.createHoldSignal(context);
        }

        // Check for entry conditions
        const entryCheck = this.shouldEnter(context, trend, regime);
        if (entryCheck.shouldEnter) {
            return this.createEntrySignal(
                context,
                "short",
                entryCheck.confidence,
                this.config.stopLossATRMultiplier,
                this.config.takeProfitRR
            );
        }

        // Debug: log why entry was rejected (only occasionally to avoid spam)
        if (Math.random() < 0.05) {
            // console.log(`[ShortStrategy] ${context.symbol} entry rejected: ${entryCheck.reason}`);
        }

        return this.createHoldSignal(context);
    }

    protected shouldEnter(
        context: StrategyContext,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldEnter: boolean; confidence: number; reason?: string } {
        const { candle, history } = context;

        // 1. Trend must be bearish or we have a clear distribution pattern
        const isBearishTrend = trend.isBearish && trend.strength >= this.config.minTrendStrength;
        const isDistribution = regime.regime === "distribution" && this.config.requireDistribution;

        if (this.config.requireTrendConfirmation && !isBearishTrend && !isDistribution) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: `No bearish trend (strength: ${(trend.strength * 100).toFixed(0)}%) or distribution`
            };
        }

        // 2. Price should be bouncing to EMA from below (dead cat bounce)
        const currentPrice = candle.close;
        const emaFast = trend.emaFast;
        const emaSlow = trend.emaSlow;

        const bounceDistance = (currentPrice - emaFast) / emaFast;

        if (bounceDistance < this.config.bounceMinDistance || bounceDistance > this.config.bounceMaxDistance) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: `Bounce distance ${(bounceDistance * 100).toFixed(2)}% out of range`
            };
        }

        // 3. Price must stay below slow EMA (bear trend intact), unless in distribution
        if (currentPrice > emaSlow * 1.02 && !isDistribution) {
            return { shouldEnter: false, confidence: 0, reason: "Price above slow EMA" };
        }

        // 4. RSI check - should be falling from overbought or in upper zone
        const rsi = this.getRSI(history, this.config.rsiPeriod);
        if (rsi < this.config.rsiMin || rsi > this.config.rsiMax) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: `RSI ${rsi.toFixed(1)} outside range [${this.config.rsiMin}, ${this.config.rsiMax}]`
            };
        }

        // 5. Volume confirmation - especially important for shorts
        if (!this.hasVolumeConfirmation(candle, history, this.config.volumeSpikeMultiplier)) {
            return { shouldEnter: false, confidence: 0, reason: "No volume confirmation" };
        }

        // 6. Lower highs and lower lows structure (classic downtrend pattern)
        if (this.config.requireLowerHighsLowerLows) {
            const hasStructure = TechnicalIndicators.isLowerHighsLowerLows(history, 10);
            if (!hasStructure) {
                return { shouldEnter: false, confidence: 0, reason: "No LH/LL structure" };
            }
        }

        // 7. Regime check
        if (!this.regimeDetector.isGoodForShorts(regime)) {
            return { shouldEnter: false, confidence: 0, reason: `Regime ${regime.regime} not good for shorts` };
        }

        // 8. Avoid short squeeze - check if funding rate not too negative (would indicate crowded shorts)
        // Note: In real implementation, you'd fetch funding rate from exchange
        // For now, we use volatility as a proxy - high volatility + high volume on up move = potential squeeze
        if (regime.volatility > 0.04 && candle.close > candle.open * 1.02) {
            return { shouldEnter: false, confidence: 0, reason: "Potential short squeeze conditions" };
        }

        // Calculate confidence based on multiple factors
        let confidence = 0.4; // Lower base for shorts (more risky)

        // Trend strength contribution (0.2 max)
        if (trend.isBearish) {
            confidence += trend.strength * 0.2;
        }

        // RSI position - best near overbought (indicating rejection) (0.15 max)
        const rsiUpperZone = this.config.rsiMax - (this.config.rsiMax - this.config.rsiMin) * 0.3;
        const rsiQuality = rsi >= rsiUpperZone ? 1 : (rsi - this.config.rsiMin) / (rsiUpperZone - this.config.rsiMin);
        confidence += Math.max(0, rsiQuality) * 0.15;

        // Bounce quality (0.15 max)
        const idealBounce = (this.config.bounceMinDistance + this.config.bounceMaxDistance) / 2;
        const bounceQuality = 1 - Math.abs(bounceDistance - idealBounce) / idealBounce;
        confidence += Math.max(0, bounceQuality) * 0.15;

        // Volume boost (0.1 max)
        if (this.hasVolumeConfirmation(candle, history, this.config.volumeSpikeMultiplier * 1.2)) {
            confidence += 0.1;
        }

        // Distribution bonus (0.1 max)
        if (regime.regime === "distribution") {
            confidence += 0.15;
        }

        // LH/LL bonus (0.1 max)
        if (TechnicalIndicators.isLowerHighsLowerLows(history, 10)) {
            confidence += 0.1;
        }

        return {
            shouldEnter: true,
            confidence: Math.min(confidence, 1.0),
            reason: `Short entry: trend strength ${(trend.strength * 100).toFixed(0)}%, RSI ${rsi.toFixed(1)}, bounce ${(bounceDistance * 100).toFixed(2)}%`
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
        if (currentPrice >= position.stopLossPrice!) {
            return { shouldExit: true, reason: "Stop loss hit" };
        }

        // 2. Take profit hit
        if (position.takeProfitPrice && currentPrice <= position.takeProfitPrice) {
            return { shouldExit: true, reason: "Take profit hit" };
        }

        // 3. Trend reversal - fast EMA crosses above slow EMA
        if (!trend.isBearish) {
            return { shouldExit: true, reason: "Trend reversal to bullish" };
        }

        // 4. RSI oversold (potential bottom)
        const rsi = this.getRSI(history, this.config.rsiPeriod);
        if (rsi < 25) {
            return { shouldExit: true, reason: `RSI oversold at ${rsi.toFixed(1)}` };
        }

        // 5. Short squeeze warning - rapid price increase with volume
        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
        if (priceChange > 0.03 && this.hasVolumeConfirmation(candle, history, 1.5)) {
            return { shouldExit: true, reason: `Short squeeze warning: +${(priceChange * 100).toFixed(2)}%` };
        }

        // 6. Accumulation phase detected
        if (regime.regime === "accumulation") {
            return { shouldExit: true, reason: "Accumulation phase detected" };
        }

        // 7. Time-based exit - if short has been open too long in ranging market
        const positionAge = candle.timestamp - position.openedAt;
        const hoursOpen = positionAge / (1000 * 60 * 60);
        if (hoursOpen > 48 && regime.isRanging) {
            return { shouldExit: true, reason: "Time-based exit in ranging market" };
        }

        return { shouldExit: false };
    }
}
