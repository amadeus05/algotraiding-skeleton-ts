import { StrategyContext, StrategyContract } from "../../core/interfaces/StrategyContract";
import { StrategySignal } from "../../core/types/trading";
import { atrSeries, emaSeries, rsiSeries } from "../../utils/IndicatorsHelper";

const SLOPE_WINDOW = 10;
const MIN_HISTORY = 220;

export class BreakdownRetestShortStrategy implements StrategyContract {
    public evaluate(context: StrategyContext): StrategySignal {
        const { symbol, candle, history, position } = context;

        if (position !== undefined && position.side !== "short") {
            return this.hold(symbol, candle.timestamp);
        }

        if (position !== undefined) {
            const exitSignal = this.checkDiscretionaryExit(context);
            if (exitSignal !== null) return exitSignal;
            return this.hold(symbol, candle.timestamp);
        }

        if (history.length < MIN_HISTORY) {
            return this.hold(symbol, candle.timestamp);
        }

        const closes = history.map((c) => c.close);
        const ema20Series = emaSeries(20, closes);
        const ema50Series = emaSeries(50, closes);
        const ema200Series = emaSeries(200, closes);
        const atrSeriesData = atrSeries(14, history);
        const rsiSeriesData = rsiSeries(14, closes);

        const idx = history.length - 1;
        const ema20 = ema20Series[idx];
        const ema50 = ema50Series[idx];
        const ema200 = ema200Series[idx];
        const atr = atrSeriesData[idx];
        const rsi = rsiSeriesData[idx];

        if (ema20 === undefined || ema50 === undefined || ema200 === undefined || atr === undefined || rsi === undefined) {
            return this.hold(symbol, candle.timestamp);
        }

        const ema200TenBarsAgo = history.length >= 200 + SLOPE_WINDOW ? ema200Series[idx - SLOPE_WINDOW] : undefined;
        if (ema200TenBarsAgo === undefined) {
            return this.hold(symbol, candle.timestamp);
        }

        const bearRegime =
            ema50 < ema200 &&
            candle.close < ema200 &&
            ema200 - ema200TenBarsAgo < 0;

        if (!bearRegime) {
            return this.hold(symbol, candle.timestamp);
        }

        const supportLevel = this.minLow(history, idx - 15, idx - 2);
        const prevIdx = idx - 1;
        const prevCandle = history[prevIdx];
        const prevClose = prevCandle.close;
        const prevHigh = prevCandle.high;

        const breakdownHappened = prevClose < supportLevel;

        if (!breakdownHappened) {
            return this.hold(symbol, candle.timestamp);
        }

        const retestCondition =
            candle.high >= supportLevel * 0.998 &&
            candle.close < supportLevel &&
            candle.close < ema20 &&
            rsi < 52;

        const weakRetestFilter =
            prevHigh <= ema20 * 1.01 || candle.high <= ema20 * 1.01;

        if (!retestCondition || !weakRetestFilter) {
            return this.hold(symbol, candle.timestamp);
        }

        const enterTrigger = candle.close < prevCandle.low;

        if (!enterTrigger) {
            return this.hold(symbol, candle.timestamp);
        }

        const entryPrice = candle.close;
        const retestHigh = this.maxHigh(history, idx - 2, idx);
        const atrStop = entryPrice + 1.2 * atr;
        const structureStop = retestHigh + 0.15 * atr;
        const stopLossPrice = Math.max(atrStop, structureStop);

        if (stopLossPrice <= entryPrice) {
            return this.hold(symbol, candle.timestamp);
        }

        const risk = stopLossPrice - entryPrice;
        const takeProfitPrice = entryPrice - 2.0 * risk;

        if (!(risk > 0 && takeProfitPrice < entryPrice)) {
            return this.hold(symbol, candle.timestamp);
        }

        return {
            symbol,
            action: "enter",
            side: "short",
            entryPrice,
            stopLossPrice,
            takeProfitPrice,
            timestamp: candle.timestamp
        };
    }

    private checkDiscretionaryExit(context: StrategyContext): StrategySignal | null {
        const { symbol, candle, history, position } = context;
        if (position === undefined || position.side !== "short") return null;

        if (history.length < 30) return null;

        const closes = history.map((c) => c.close);
        const ema20Series = emaSeries(20, closes);
        const rsiSeriesData = rsiSeries(14, closes);
        const idx = history.length - 1;

        const ema20 = ema20Series[idx];
        const rsi = rsiSeriesData[idx];

        if (ema20 === undefined || rsi === undefined) return null;

        if (candle.close > ema20 && rsi > 55) {
            return {
                symbol,
                action: "exit",
                timestamp: candle.timestamp
            };
        }

        return null;
    }

    private minLow(history: { low: number }[], from: number, to: number): number {
        let min = Infinity;
        const start = Math.max(0, from);
        const end = Math.min(history.length - 1, to);
        for (let i = start; i <= end; i++) {
            if (history[i].low < min) min = history[i].low;
        }
        return min === Infinity ? 0 : min;
    }

    private maxHigh(history: { high: number }[], from: number, to: number): number {
        let max = -Infinity;
        const start = Math.max(0, from);
        const end = Math.min(history.length - 1, to);
        for (let i = start; i <= end; i++) {
            if (history[i].high > max) max = history[i].high;
        }
        return max === -Infinity ? 0 : max;
    }

    private hold(symbol: string, timestamp: number): StrategySignal {
        return { symbol, action: "hold", timestamp };
    }
}
