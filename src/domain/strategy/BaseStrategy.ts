import { StrategyContext, StrategyContract } from "../../core/interfaces/StrategyContract";
import { Candle } from "../../core/types/common";
import { Position, StrategySignal } from "../../core/types/trading";
import { TechnicalIndicators } from "./utils/TechnicalIndicators";
import { TrendAnalyzer, TrendAnalysis } from "./modules/TrendAnalyzer";
import { RegimeDetector, RegimeAnalysis, RegimeDetectorConfig } from "./modules/RegimeDetector";

export abstract class BaseStrategy implements StrategyContract {
    protected readonly trendAnalyzer: TrendAnalyzer;
    protected readonly regimeDetector: RegimeDetector;

    constructor(regimeConfig?: RegimeDetectorConfig) {
        this.trendAnalyzer = new TrendAnalyzer();
        this.regimeDetector = new RegimeDetector(regimeConfig);
    }

    public abstract evaluate(context: StrategyContext): StrategySignal;

    protected abstract shouldEnter(
        context: StrategyContext,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldEnter: boolean; confidence: number; reason?: string };

    protected abstract shouldExit(
        context: StrategyContext,
        position: Position,
        trend: TrendAnalysis,
        regime: RegimeAnalysis
    ): { shouldExit: boolean; reason?: string };

    protected createEntrySignal(
        context: StrategyContext,
        side: "long" | "short",
        confidence: number,
        stopLossATRMultiplier: number,
        takeProfitRR: number
    ): StrategySignal {
        const { candle, history, symbol } = context;

        const atr = TechnicalIndicators.calculateATR(history, 14);
        const entryPrice = candle.close;

        let stopLossPrice: number;
        let takeProfitPrice: number;

        if (side === "long") {
            stopLossPrice = entryPrice - atr.stopLossOffset * stopLossATRMultiplier;
            const risk = entryPrice - stopLossPrice;
            takeProfitPrice = entryPrice + risk * takeProfitRR;
        } else {
            stopLossPrice = entryPrice + atr.stopLossOffset * stopLossATRMultiplier;
            const risk = stopLossPrice - entryPrice;
            takeProfitPrice = entryPrice - risk * takeProfitRR;
        }

        return {
            symbol,
            action: "enter",
            side,
            entryPrice,
            stopLossPrice,
            takeProfitPrice,
            timestamp: candle.timestamp,
            metadata: {
                confidence,
                atr: atr.value,
                riskRewardRatio: takeProfitRR
            }
        };
    }

    protected createExitSignal(
        context: StrategyContext,
        position: Position,
        reason: string
    ): StrategySignal {
        return {
            symbol: context.symbol,
            action: "exit",
            side: position.side,
            timestamp: context.candle.timestamp,
            metadata: { exitReason: reason }
        };
    }

    protected createHoldSignal(context: StrategyContext): StrategySignal {
        return {
            symbol: context.symbol,
            action: "hold",
            timestamp: context.candle.timestamp
        };
    }

    protected calculateMinimumHistoryLength(fastPeriod: number, slowPeriod: number): number {
        return Math.max(slowPeriod, 50) + 20; // Extra buffer for swing analysis
    }

    protected hasEnoughData(history: Candle[], fastPeriod: number, slowPeriod: number): boolean {
        return history.length >= this.calculateMinimumHistoryLength(fastPeriod, slowPeriod);
    }

    protected getRSI(history: Candle[], period: number = 14): number {
        const closes = history.map(c => c.close);
        const rsi = TechnicalIndicators.calculateRSI(closes, period);
        return rsi.value;
    }

    protected hasVolumeConfirmation(
        candle: Candle,
        history: Candle[],
        multiplier: number = 1.3,
        period: number = 20
    ): boolean {
        return TechnicalIndicators.hasVolumeSpike(candle, history, multiplier, period);
    }

    protected calculateStopDistance(
        history: Candle[],
        atrMultiplier: number,
        side: "long" | "short"
    ): { stopPrice: number; stopDistance: number } {
        const atr = TechnicalIndicators.calculateATR(history, 14);
        const currentPrice = history[history.length - 1].close;

        let stopPrice: number;
        if (side === "long") {
            stopPrice = currentPrice - atr.stopLossOffset * atrMultiplier;
        } else {
            stopPrice = currentPrice + atr.stopLossOffset * atrMultiplier;
        }

        const stopDistance = Math.abs(currentPrice - stopPrice);

        return { stopPrice, stopDistance };
    }

    /** Unrealized PnL в процентах (для long: (price-entry)/entry*100, для short: (entry-price)/entry*100) */
    protected getUnrealizedPnlPercent(position: Position, currentPrice: number): number {
        if (position.side === "long") {
            return ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        }
        return ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
    }

    /** Количество полных свечей, прошедших после входа (timestamp > openedAt) */
    protected getCandlesSinceEntry(history: Candle[], openedAt: number): number {
        return history.filter((c) => c.timestamp > openedAt).length;
    }

    /** Reversal подтверждён N свечами подряд (каждая из последних N показывает reversal) */
    protected isReversalConfirmed(
        history: Candle[],
        emaFastPeriod: number,
        emaSlowPeriod: number,
        confirmationCandles: number,
        reversalCheck: (t: TrendAnalysis) => boolean
    ): boolean {
        const minLength = Math.max(emaSlowPeriod, 50) + confirmationCandles;
        if (history.length < minLength) return false;

        for (let i = 0; i < confirmationCandles; i++) {
            const slice = i === 0 ? history : history.slice(0, -i);
            const trend = this.trendAnalyzer.analyze(slice, emaFastPeriod, emaSlowPeriod);
            if (!reversalCheck(trend)) return false;
        }
        return true;
    }
}
