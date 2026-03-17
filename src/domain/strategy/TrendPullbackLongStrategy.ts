import { StrategyContext, StrategyContract } from "../../core/interfaces/StrategyContract";
import { StrategySignal } from "../../core/types/trading";
import { atrSeries, emaSeries, rsiSeries } from "../../utils/IndicatorsHelper";

const SLOPE_WINDOW = 10;
const MIN_HISTORY = 220;

export class TrendPullbackLongStrategy implements StrategyContract {
    public diagnostics?: {
        bullRegime: number;
        pullbackValid: number;
        closeGtPrevHigh: number;
        closeGtEma20: number;
        prevCondition: number;
        enterTrigger: number;
        stopOk: number;
    };

    public evaluate(context: StrategyContext): StrategySignal {
        const { symbol, candle, history, position } = context;

        if (position !== undefined && position.side !== "long") {
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

        const bullRegime =
            ema50 > ema200 &&
            candle.close > ema200 &&
            ema200 - ema200TenBarsAgo > 0;

        if (process.env.DEBUG_STRATEGY === "1") {
            this.diagnostics ??= {
                bullRegime: 0,
                pullbackValid: 0,
                closeGtPrevHigh: 0,
                closeGtEma20: 0,
                prevCondition: 0,
                enterTrigger: 0,
                stopOk: 0
            };
            if (bullRegime) this.diagnostics.bullRegime++;
        }

        if (!bullRegime) {
            return this.hold(symbol, candle.timestamp);
        }

        const prevIdx = idx - 1;
        const prevCandle = history[prevIdx];
        const prevHigh = prevCandle.high;
        const prevRsi = rsiSeriesData[prevIdx];
        const prevEma20 = ema20Series[prevIdx];
        const prevEma50 = ema50Series[prevIdx];
        const prevEma200 = ema200Series[prevIdx];
        const prevPreviousSwingLow = prevIdx >= 20 ? this.minLow(history, prevIdx - 20, prevIdx - 1) : Infinity;
        const prevAtr = atrSeriesData[prevIdx];
        const prevValidStructure =
            prevPreviousSwingLow === Infinity || prevCandle.low > prevPreviousSwingLow - 0.2 * (prevAtr ?? 0);

        const prevPullbackValid =
            prevEma20 !== undefined &&
            prevEma50 !== undefined &&
            prevEma200 !== undefined &&
            prevRsi !== undefined &&
            prevAtr !== undefined &&
            (prevCandle.low <= prevEma20 || prevCandle.low <= prevEma50) &&
            prevCandle.close >= prevEma50 * 0.995 &&
            prevRsi < 48 &&
            prevCandle.close > prevEma200 &&
            prevValidStructure;

        const pullbackValid = prevPullbackValid;

        if (process.env.DEBUG_STRATEGY === "1" && pullbackValid) this.diagnostics!.pullbackValid++;
        if (!pullbackValid) {
            return this.hold(symbol, candle.timestamp);
        }

        const prevCondition = prevCandle.close <= ema20 || (prevRsi !== undefined && prevRsi < 50);
        const closeGtPrevHigh = candle.close > prevHigh;
        const closeGtEma20 = candle.close > ema20;
        const enterTrigger = closeGtPrevHigh && closeGtEma20 && prevCondition;

        if (process.env.DEBUG_STRATEGY === "1") {
            if (closeGtPrevHigh) this.diagnostics!.closeGtPrevHigh++;
            if (closeGtEma20) this.diagnostics!.closeGtEma20++;
            if (prevCondition) this.diagnostics!.prevCondition++;
            if (enterTrigger) this.diagnostics!.enterTrigger++;
        }
        if (!enterTrigger) {
            return this.hold(symbol, candle.timestamp);
        }

        const entryPrice = candle.close;
        const swingLow = this.minLow(history, idx - 4, idx);
        const atrStop = entryPrice - 1.2 * atr;
        const structureStop = swingLow - 0.15 * atr;
        const stopLossPrice = Math.min(atrStop, structureStop);

        if (stopLossPrice >= entryPrice) {
            return this.hold(symbol, candle.timestamp);
        }
        if (process.env.DEBUG_STRATEGY === "1") this.diagnostics!.stopOk++;

        const risk = entryPrice - stopLossPrice;
        const takeProfitPrice = entryPrice + 2.2 * risk;

        if (!(risk > 0 && takeProfitPrice > entryPrice)) {
            return this.hold(symbol, candle.timestamp);
        }

        return {
            symbol,
            action: "enter",
            side: "long",
            entryPrice,
            stopLossPrice,
            takeProfitPrice,
            timestamp: candle.timestamp
        };
    }

    private checkDiscretionaryExit(context: StrategyContext): StrategySignal | null {
        const { symbol, candle, history, position } = context;
        if (position === undefined || position.side !== "long") return null;

        if (history.length < 30) return null;

        const closes = history.map((c) => c.close);
        const ema20Series = emaSeries(20, closes);
        const rsiSeriesData = rsiSeries(14, closes);
        const idx = history.length - 1;

        const ema20 = ema20Series[idx];
        const rsi = rsiSeriesData[idx];

        if (ema20 === undefined || rsi === undefined) return null;

        if (candle.close < ema20 && rsi < 45) {
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

    private hold(symbol: string, timestamp: number): StrategySignal {
        return { symbol, action: "hold", timestamp };
    }
}
