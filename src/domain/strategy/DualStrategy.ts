import { StrategyContext, StrategyContract } from "../../core/interfaces/StrategyContract";
import { StrategySignal, TradeSide } from "../../core/types/trading";
import { LongStrategy } from "./LongStrategy";
import { ShortStrategy } from "./ShortStrategy";
import { LongStrategyConfig, ShortStrategyConfig } from "./config/StrategyConfigs";
import { TrendAnalyzer } from "./modules/TrendAnalyzer";
import { RegimeDetector } from "./modules/RegimeDetector";

export interface DualStrategyConfig {
    long: Partial<LongStrategyConfig>;
    short: Partial<ShortStrategyConfig>;
    priorityMode: "balanced" | "trend_following" | "contrarian";
    minConfidenceThreshold: number;
    maxActivePositionsPerSide: number;
}

export const DefaultDualConfig: DualStrategyConfig = {
    long: {},
    short: {},
    priorityMode: "balanced",
    minConfidenceThreshold: 0.5,
    maxActivePositionsPerSide: 1
};

export class DualStrategy implements StrategyContract {
    private readonly longStrategy: LongStrategy;
    private readonly shortStrategy: ShortStrategy;
    private readonly config: DualStrategyConfig;
    private readonly trendAnalyzer: TrendAnalyzer;
    private readonly regimeDetector: RegimeDetector;

    constructor(config: Partial<DualStrategyConfig> = {}) {
        this.config = { ...DefaultDualConfig, ...config };
        this.longStrategy = new LongStrategy(this.config.long);
        this.shortStrategy = new ShortStrategy(this.config.short);
        this.trendAnalyzer = new TrendAnalyzer();
        this.regimeDetector = new RegimeDetector();
    }

    public evaluate(context: StrategyContext): StrategySignal {
        const { position, history, symbol } = context;

        // If we have an open position, let the corresponding strategy handle it
        if (position) {
            if (position.side === "long") {
                return this.longStrategy.evaluate(context);
            } else if (position.side === "short") {
                return this.shortStrategy.evaluate(context);
            }
        }

        // No position - evaluate both strategies
        const longSignal = this.longStrategy.evaluate(context);
        const shortSignal = this.shortStrategy.evaluate(context);

        // Select the best signal based on configuration
        return this.selectBestSignal(longSignal, shortSignal, context);
    }

    private selectBestSignal(
        longSignal: StrategySignal,
        shortSignal: StrategySignal,
        context: StrategyContext
    ): StrategySignal {
        // If neither wants to enter, return hold
        if (longSignal.action !== "enter" && shortSignal.action !== "enter") {
            return longSignal.action === "hold" && shortSignal.action === "hold"
                ? longSignal // Both hold
                : longSignal.action === "exit" ? longSignal : shortSignal; // One exit
        }

        // Only one wants to enter
        if (longSignal.action === "enter" && shortSignal.action !== "enter") {
            return this.validateSignal(longSignal) ? longSignal : this.createHoldSignal(context);
        }

        if (shortSignal.action === "enter" && longSignal.action !== "enter") {
            return this.validateSignal(shortSignal) ? shortSignal : this.createHoldSignal(context);
        }

        // Both want to enter - use priority mode to decide
        const longConfidence = (longSignal.metadata?.confidence as number) || 0;
        const shortConfidence = (shortSignal.metadata?.confidence as number) || 0;

        const trend = this.trendAnalyzer.analyze(context.history);
        const regime = this.regimeDetector.detect(context.history);

        let selectedSignal: StrategySignal;

        switch (this.config.priorityMode) {
            case "trend_following":
                // Follow the trend - prefer long in uptrend, short in downtrend
                if (trend.isBullish && longConfidence >= this.config.minConfidenceThreshold) {
                    selectedSignal = longSignal;
                } else if (trend.isBearish && shortConfidence >= this.config.minConfidenceThreshold) {
                    selectedSignal = shortSignal;
                } else {
                    // No clear trend or weak signals
                    selectedSignal = longConfidence > shortConfidence ? longSignal : shortSignal;
                }
                break;

            case "contrarian":
                // Trade against the trend - prefer short in uptrend (top fishing), long in downtrend (bottom fishing)
                // But only if confidence is very high
                if (trend.isBullish && shortConfidence >= 0.7 && regime.regime === "distribution") {
                    selectedSignal = shortSignal;
                } else if (trend.isBearish && longConfidence >= 0.7 && regime.regime === "accumulation") {
                    selectedSignal = longSignal;
                } else {
                    // Default to stronger signal
                    selectedSignal = longConfidence > shortConfidence ? longSignal : shortSignal;
                }
                break;

            case "balanced":
            default:
                // Simply choose the signal with higher confidence
                if (longConfidence > shortConfidence && longConfidence >= this.config.minConfidenceThreshold) {
                    selectedSignal = longSignal;
                } else if (shortConfidence >= this.config.minConfidenceThreshold) {
                    selectedSignal = shortSignal;
                } else {
                    selectedSignal = this.createHoldSignal(context);
                }
                break;
        }

        return this.validateSignal(selectedSignal) ? selectedSignal : this.createHoldSignal(context);
    }

    private validateSignal(signal: StrategySignal): boolean {
        if (signal.action !== "enter") return true;

        const confidence = signal.metadata?.confidence as number;
        return confidence >= this.config.minConfidenceThreshold;
    }

    private createHoldSignal(context: StrategyContext): StrategySignal {
        return {
            symbol: context.symbol,
            action: "hold",
            timestamp: context.candle.timestamp
        };
    }

    // Public methods for external access if needed
    public getLongStrategy(): LongStrategy {
        return this.longStrategy;
    }

    public getShortStrategy(): ShortStrategy {
        return this.shortStrategy;
    }

    public getConfig(): DualStrategyConfig {
        return this.config;
    }
}
