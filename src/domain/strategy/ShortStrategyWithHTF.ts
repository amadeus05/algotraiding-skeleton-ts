import { StrategyContext } from "../../core/interfaces/StrategyContract";
import { Position, StrategySignal } from "../../core/types/trading";
import { BaseStrategy } from "./BaseStrategy";
import { ShortStrategyConfig, DefaultShortConfig } from "./config/StrategyConfigs";
import { TrendAnalysis } from "./modules/TrendAnalyzer";
import { RegimeAnalysis } from "./modules/RegimeDetector";
import { TechnicalIndicators } from "./utils/TechnicalIndicators";
import { Candle } from "../../core/types/common";

export interface ShortStrategyWithHTFConfig extends ShortStrategyConfig {
    htfRequired?: boolean;
    htfMinTrendStrength?: number;
    htfRequireBearish?: boolean;
    htfBlockRanging?: boolean;
    htfFastPeriod?: number;
    htfSlowPeriod?: number;
}

export const DefaultShortStrategyWithHTFConfig: ShortStrategyWithHTFConfig = {
    ...DefaultShortConfig,
    htfRequired: true,
    htfMinTrendStrength: 0.2,
    htfRequireBearish: true,
    htfBlockRanging: true,
    htfFastPeriod: 50,
    htfSlowPeriod: 200
};

export class ShortStrategyWithHTF extends BaseStrategy {
    private readonly config: ShortStrategyWithHTFConfig;

    constructor(config: Partial<ShortStrategyWithHTFConfig> = {}) {
        super({ aggressiveMode: config.aggressiveMode });
        this.config = { ...DefaultShortStrategyWithHTFConfig, ...config };
    }

    public evaluate(context: StrategyContext): StrategySignal {
        const { position, history } = context;

        if (!this.hasEnoughData(history, this.config.emaFastPeriod, this.config.emaSlowPeriod)) {
            return this.createHoldSignal(context);
        }

        const trend = this.trendAnalyzer.analyze(
            history,
            this.config.emaFastPeriod,
            this.config.emaSlowPeriod
        );
        const regime = this.regimeDetector.detect(history);

        if (position?.side === "short") {
            const exitCheck = this.shouldExit(context, position, trend, regime);
            if (exitCheck.shouldExit) {
                return this.createExitSignal(context, position, exitCheck.reason || "exit triggered");
            }
            return this.createHoldSignal(context);
        }

        if (position) {
            return this.createHoldSignal(context);
        }

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

        return this.createHoldSignal(context);
    }

    protected shouldEnter(
        context: StrategyContext,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldEnter: boolean; confidence: number; reason?: string } {
        const { candle, history, htfHistory } = context;

        const htfCheck = this.checkHTFBearishFilter(htfHistory);
        if (!htfCheck.allowed) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: htfCheck.reason
            };
        }

        if (this.config.requireTrendConfirmation && !trend.isBearish) {
            return { shouldEnter: false, confidence: 0, reason: "No bearish trend on main timeframe" };
        }

        if (trend.strength < this.config.minTrendStrength) {
            return { shouldEnter: false, confidence: 0, reason: "Main timeframe trend too weak" };
        }

        const currentPrice = candle.close;
        const emaFast = trend.emaFast;
        const bounceDistance = (currentPrice - emaFast) / emaFast;

        if (bounceDistance < this.config.bounceMinDistance) {
            return { shouldEnter: false, confidence: 0, reason: "Price not sufficiently bounced to EMA fast" };
        }

        if (bounceDistance > this.config.bounceMaxDistance) {
            return { shouldEnter: false, confidence: 0, reason: "Price too extended above EMA fast" };
        }

        const rsi = this.getRSI(history, this.config.rsiPeriod);
        if (rsi < this.config.rsiMin || rsi > this.config.rsiMax) {
            return {
                shouldEnter: false,
                confidence: 0,
                reason: `RSI out of range: ${rsi.toFixed(1)}`
            };
        }

        if (this.config.requireLowerHighsLowerLows && !this.hasLowerHighsLowerLows(history)) {
            return { shouldEnter: false, confidence: 0, reason: "No lower-high/lower-low structure" };
        }

        if (this.config.requireDistribution && regime.regime !== "distribution") {
            return { shouldEnter: false, confidence: 0, reason: "Not in distribution regime" };
        }

        const htfConfidenceBoost = htfCheck.trendStrength * 0.2;
        const confidence = Math.min(
            1,
            trend.strength * 0.55 +
                Math.min(bounceDistance / Math.max(this.config.bounceMaxDistance, 0.0001), 1) * 0.15 +
                (rsi >= 50 && rsi <= 75 ? 0.1 : 0) +
                htfConfidenceBoost
        );

        return {
            shouldEnter: true,
            confidence,
            reason: `Short entry confirmed by HTF bearish trend. Main trend ${(trend.strength * 100).toFixed(0)}%, HTF ${(htfCheck.trendStrength * 100).toFixed(0)}%, RSI ${rsi.toFixed(1)}`
        };
    }

    protected shouldExit(
        context: StrategyContext,
        position: Position,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldExit: boolean; reason?: string } {
        const { candle, history } = context;

        if (!trend.isBearish) {
            return { shouldExit: true, reason: "Trend reversal to bullish" };
        }

        const rsi = this.getRSI(history, this.config.rsiPeriod);
        if (rsi < 25) {
            return { shouldExit: true, reason: `RSI oversold at ${rsi.toFixed(1)}` };
        }

        const currentPrice = candle.close;
        const priceChange = (currentPrice - position.entryPrice) / position.entryPrice;
        if (priceChange > 0.03 && this.hasVolumeConfirmation(candle, history, 1.5)) {
            return { shouldExit: true, reason: `Short squeeze warning: +${(priceChange * 100).toFixed(2)}%` };
        }

        if (regime.regime === "accumulation") {
            return { shouldExit: true, reason: "Accumulation phase detected" };
        }

        const positionAgeMs = candle.timestamp - position.openedAt;
        const hoursOpen = positionAgeMs / (1000 * 60 * 60);
        if (hoursOpen > 48 && regime.isRanging) {
            return { shouldExit: true, reason: "Time-based exit in ranging market" };
        }

        return { shouldExit: false };
    }

    private checkHTFBearishFilter(
        htfHistory?: Candle[]
    ): { allowed: boolean; reason?: string; trendStrength: number } {
        if (!htfHistory || htfHistory.length === 0) {
            return this.config.htfRequired
                ? { allowed: false, reason: "Missing HTF history", trendStrength: 0 }
                : { allowed: true, trendStrength: 0 };
        }

        const requiredBars = this.calculateMinimumHistoryLength(
            this.config.htfFastPeriod ?? 50,
            this.config.htfSlowPeriod ?? 200
        );

        if (htfHistory.length < requiredBars) {
            return this.config.htfRequired
                ? { allowed: false, reason: "Not enough HTF history", trendStrength: 0 }
                : { allowed: true, trendStrength: 0 };
        }

        const htfTrend = this.trendAnalyzer.analyze(
            htfHistory,
            this.config.htfFastPeriod ?? 50,
            this.config.htfSlowPeriod ?? 200
        );

        const htfRegime = this.regimeDetector.detect(htfHistory);

        if (this.config.htfRequireBearish && !htfTrend.isBearish) {
            return {
                allowed: false,
                reason: "HTF is not bearish",
                trendStrength: htfTrend.strength
            };
        }

        if (htfTrend.strength < (this.config.htfMinTrendStrength ?? 0.2)) {
            return {
                allowed: false,
                reason: "HTF trend too weak",
                trendStrength: htfTrend.strength
            };
        }

        if (this.config.htfBlockRanging && htfRegime.isRanging) {
            return {
                allowed: false,
                reason: "HTF is ranging",
                trendStrength: htfTrend.strength
            };
        }

        return {
            allowed: true,
            trendStrength: htfTrend.strength
        };
    }

    private hasLowerHighsLowerLows(history: Candle[]): boolean {
        if (history.length < 5) {
            return false;
        }
        const recent = history.slice(-5);
        for (let i = 1; i < recent.length; i++) {
            if (recent[i].high >= recent[i - 1].high) {
                return false;
            }
            if (recent[i].low >= recent[i - 1].low) {
                return false;
            }
        }
        return true;
    }
}
