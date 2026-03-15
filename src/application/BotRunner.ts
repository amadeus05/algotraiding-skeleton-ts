import { ExecutionEngineContract } from "../core/interfaces/ExecutionEngineContract";
import { NotifierContract } from "../core/interfaces/NotifierContract";
import { StrategyContext, StrategyContract } from "../core/interfaces/StrategyContract";
import { IMarketDataRepository } from "../core/interfaces/repositories/IMarketDataRepository";
import { Candle } from "../core/types/common";
import { ClosedKlineEvent, ExecutionPlan, StrategySignal, TradeSide } from "../core/types/trading";
import { ExecutionPlanner } from "../domain/execution/ExecutionPlanner";
import { PortfolioManager } from "../domain/execution/PortfolioManager";
import { RiskManager } from "../domain/risk/RiskManager";
import { formatDisplaySymbol, formatUtcDateTime, intervalToMilliseconds } from "../utils/Helpers";

export interface PendingEntry {
    plan: ExecutionPlan;
    signalTimestamp: number;
}

export interface BotRunnerContext {
    symbol: string;
    timeframe: string;
    candles: Candle[];
}

export interface BotRunResult {
    processedCandles: number;
    entrySignals: number;
    approvedEntries: number;
    executedOrders: number;
    rejectedSignals: number;
    skippedSignals: number;
}

export class BotRunner {
    private readonly pendingEntryPlans = new Map<string, PendingEntry>();

    constructor(
        private readonly strategy: StrategyContract,
        private readonly riskManager: RiskManager,
        private readonly executionPlanner: ExecutionPlanner,
        private readonly executionEngine: ExecutionEngineContract,
        private readonly portfolioManager: PortfolioManager,
        private readonly notifier: NotifierContract,
        private readonly marketDataRepository?: IMarketDataRepository,
        private readonly htfTimeframe?: string
    ) {}

    public run(context: BotRunnerContext): BotRunResult {
        const events: ClosedKlineEvent[] = context.candles.map((candle) => ({
            exchange: "simulation",
            symbol: context.symbol,
            interval: context.timeframe,
            kline: {
                exchange: "simulation",
                symbol: context.symbol,
                interval: context.timeframe,
                openTime: candle.timestamp,
                closeTime: candle.timestamp,
                open: candle.open,
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                takerBuyBaseVolume: candle.takerBuyBaseVolume,
                openInterest: candle.openInterest,
                isClosed: true
            }
        }));

        return this.runReplaySync(events);
    }

    public async runReplay(events: AsyncIterable<ClosedKlineEvent> | Iterable<ClosedKlineEvent>): Promise<BotRunResult> {
        if (Symbol.asyncIterator in Object(events)) {
            const asyncHistoryBySymbol = new Map<string, Candle[]>();
            const result = this.createEmptyResult();

            for await (const event of events as AsyncIterable<ClosedKlineEvent>) {
                this.processEvent(event, asyncHistoryBySymbol, result);
            }

            return result;
        }

        return this.runReplaySync(events as Iterable<ClosedKlineEvent>);
    }

    private runReplaySync(events: Iterable<ClosedKlineEvent>): BotRunResult {
        const historyBySymbol = new Map<string, Candle[]>();
        const result = this.createEmptyResult();

        for (const event of events) {
            this.processEvent(event, historyBySymbol, result);
        }

        return result;
    }

    private createEmptyResult(): BotRunResult {
        const result: BotRunResult = {
            processedCandles: 0,
            entrySignals: 0,
            approvedEntries: 0,
            executedOrders: 0,
            rejectedSignals: 0,
            skippedSignals: 0
        };

        return result;
    }

    private processEvent(
        event: ClosedKlineEvent,
        historyBySymbol: Map<string, Candle[]>,
        result: BotRunResult
    ): void {
        const candle = {
            timestamp: event.kline.openTime,
            open: event.kline.open,
            high: event.kline.high,
            low: event.kline.low,
            close: event.kline.close,
            volume: event.kline.volume,
            takerBuyBaseVolume: event.kline.takerBuyBaseVolume,
            openInterest: event.kline.openInterest
        };
        const history = historyBySymbol.get(event.symbol) ?? [];

        result.processedCandles += 1;
        this.portfolioManager.updateMarketPrice(event.symbol, candle.close, candle.timestamp);

        // Исполняем отложенный вход от предыдущей свечи (только для текущего symbol)
        const pendingForSymbol = this.pendingEntryPlans.get(event.symbol);
        if (pendingForSymbol && !this.portfolioManager.getPosition(event.symbol)) {
            this.pendingEntryPlans.delete(event.symbol);
            const entryPlan = pendingForSymbol.plan;

            const openCandle: Candle = { ...candle, close: candle.open, high: candle.open, low: candle.open };
            const order = this.executionEngine.execute(entryPlan, openCandle);

            // Reference-based protective levels: strategy signal задаёт stopLossPrice/takeProfitPrice
            // относительно reference entry price (signal.entryPrice). После фактического fill они
            // нормализуются к executed entry price, чтобы сохранить risk distance / reward distance.
            // Формула: shift = executedEntryPrice - referenceEntryPrice.
            const priceDifference = order.price - entryPlan.entryPrice;
            if (order.stopLossPrice !== undefined) {
                order.stopLossPrice += priceDifference;
            }
            if (order.takeProfitPrice !== undefined) {
                order.takeProfitPrice += priceDifference;
            }

            this.portfolioManager.applyExecution(order);

            result.approvedEntries += 1;
            result.executedOrders += 1;
            const notional = order.price * order.quantity;
            this.notifier.info(
                this.formatEntryLog(event.symbol, entryPlan.side, entryPlan.entryPrice, notional, entryPlan.leverage, order.price, candle.timestamp)
            );
        }

        history.push(candle);
        historyBySymbol.set(event.symbol, history);

        const portfolioSnapshot = this.portfolioManager.getSnapshot(candle.timestamp);
        const position = this.portfolioManager.getPosition(event.symbol);

        // Centralized protective exit по SL/TP через high/low текущей свечи (до strategy.evaluate)
        if (position && position.stopLossPrice !== undefined && position.takeProfitPrice !== undefined) {
            const slHit = position.side === "long"
                ? candle.low <= position.stopLossPrice
                : candle.high >= position.stopLossPrice;
            const tpHit = position.side === "long"
                ? candle.high >= position.takeProfitPrice
                : candle.low <= position.takeProfitPrice;

            if (slHit && tpHit) {
                const closeOrder = this.executionEngine.buildCloseOrder(position, candle, {
                    exitPrice: position.stopLossPrice
                });
                closeOrder.metadata = { ...closeOrder.metadata, closeReason: "SL (ambiguous candle)" };
                this.portfolioManager.applyExecution(closeOrder);
                result.executedOrders += 1;
                const snapshot = this.portfolioManager.getSnapshot(candle.timestamp);
                const closeSlippage = typeof closeOrder.metadata?.slippagePercent === "number"
                    ? closeOrder.metadata.slippagePercent * 100
                    : undefined;
                this.notifier.info(this.formatExitLog(event.symbol, { symbol: event.symbol, action: "exit", timestamp: candle.timestamp, metadata: { exitReason: "SL (ambiguous candle)" } }, closeOrder.fees ?? 0, snapshot.balance, closeSlippage));
                return;
            }
            if (slHit) {
                const closeOrder = this.executionEngine.buildCloseOrder(position, candle, {
                    exitPrice: position.stopLossPrice
                });
                closeOrder.metadata = { ...closeOrder.metadata, closeReason: "SL (or liquidation)" };
                this.portfolioManager.applyExecution(closeOrder);
                result.executedOrders += 1;
                const snapshot = this.portfolioManager.getSnapshot(candle.timestamp);
                const closeSlippage = typeof closeOrder.metadata?.slippagePercent === "number"
                    ? closeOrder.metadata.slippagePercent * 100
                    : undefined;
                this.notifier.info(this.formatExitLog(event.symbol, { symbol: event.symbol, action: "exit", timestamp: candle.timestamp, metadata: { exitReason: "SL (or liquidation)" } }, closeOrder.fees ?? 0, snapshot.balance, closeSlippage));
                return;
            }
            if (tpHit) {
                const closeOrder = this.executionEngine.buildCloseOrder(position, candle, {
                    exitPrice: position.takeProfitPrice
                });
                closeOrder.metadata = { ...closeOrder.metadata, closeReason: "TP" };
                this.portfolioManager.applyExecution(closeOrder);
                result.executedOrders += 1;
                const snapshot = this.portfolioManager.getSnapshot(candle.timestamp);
                const closeSlippage = typeof closeOrder.metadata?.slippagePercent === "number"
                    ? closeOrder.metadata.slippagePercent * 100
                    : undefined;
                this.notifier.info(this.formatExitLog(event.symbol, { symbol: event.symbol, action: "exit", timestamp: candle.timestamp, metadata: { exitReason: "TP" } }, closeOrder.fees ?? 0, snapshot.balance, closeSlippage));
                return;
            }
        } else if (position && (position.stopLossPrice !== undefined || position.takeProfitPrice !== undefined)) {
            const exitPrice = position.stopLossPrice ?? position.takeProfitPrice;
            if (exitPrice !== undefined) {
                const slHit = position.side === "long"
                    ? candle.low <= (position.stopLossPrice ?? Infinity)
                    : candle.high >= (position.stopLossPrice ?? -Infinity);
                const tpHit = position.side === "long"
                    ? candle.high >= (position.takeProfitPrice ?? -Infinity)
                    : candle.low <= (position.takeProfitPrice ?? Infinity);
                if (slHit || tpHit) {
                    const reason = slHit ? "SL (or liquidation)" : "TP";
                    const price = slHit ? position.stopLossPrice! : position.takeProfitPrice!;
                    const closeOrder = this.executionEngine.buildCloseOrder(position, candle, { exitPrice: price });
                    closeOrder.metadata = { ...closeOrder.metadata, closeReason: reason };
                    this.portfolioManager.applyExecution(closeOrder);
                    result.executedOrders += 1;
                    const snapshot = this.portfolioManager.getSnapshot(candle.timestamp);
                    const closeSlippage = typeof closeOrder.metadata?.slippagePercent === "number"
                        ? closeOrder.metadata.slippagePercent * 100
                        : undefined;
                    this.notifier.info(this.formatExitLog(event.symbol, { symbol: event.symbol, action: "exit", timestamp: candle.timestamp, metadata: { exitReason: reason } }, closeOrder.fees ?? 0, snapshot.balance, closeSlippage));
                    return;
                }
            }
        }

        const strategyContext: StrategyContext = {
            symbol: event.symbol,
            timeframe: event.interval,
            candle,
            history,
            portfolio: portfolioSnapshot,
            position
        };

        if (this.marketDataRepository && this.htfTimeframe && this.htfTimeframe !== event.interval) {
            const htfMs = intervalToMilliseconds(this.htfTimeframe);
            const rangeStart = (history[0]?.timestamp ?? candle.timestamp) - 300 * htfMs;
            const lastClosedHtfTimestamp = candle.timestamp - (candle.timestamp % htfMs) - htfMs;
            const htfEnd = Math.max(rangeStart, lastClosedHtfTimestamp);
            strategyContext.htfTimeframe = this.htfTimeframe;
            strategyContext.htfHistory = this.marketDataRepository.getCandles(
                event.symbol,
                this.htfTimeframe,
                rangeStart,
                htfEnd
            );
        }

        const signal = this.strategy.evaluate(strategyContext);

        if (signal.action === "hold") {
            result.skippedSignals += 1;
            return;
        }

        if (signal.action === "exit") {
            if (!position) {
                result.skippedSignals += 1;
                this.notifier.info(`[bot] ${event.symbol} exit signal ignored: no open position`);
                return;
            }

            const closeOrder = this.executionEngine.buildCloseOrder(position, candle);
            const closeReason = typeof signal.metadata?.exitReason === "string" ? signal.metadata.exitReason : "Signal exit";
            closeOrder.metadata = { ...closeOrder.metadata, closeReason };
            this.portfolioManager.applyExecution(closeOrder);
            result.executedOrders += 1;
            const snapshot = this.portfolioManager.getSnapshot(candle.timestamp);
            const closeSlippage = typeof closeOrder.metadata?.slippagePercent === "number"
                ? closeOrder.metadata.slippagePercent * 100
                : undefined;
            this.notifier.info(this.formatExitLog(event.symbol, signal, closeOrder.fees ?? 0, snapshot.balance, closeSlippage));
            return;
        }

        result.entrySignals += 1;

        if (position) {
            result.skippedSignals += 1;
            this.notifier.info(`[bot] ${event.symbol} entry signal ignored: position already open`);
            return;
        }

        // Если уже есть отложенный план для символа - заменяем новым сигналом
        if (this.pendingEntryPlans.has(event.symbol)) {
            this.notifier.info(`[bot] ${event.symbol} replacing pending entry plan with new signal`);
        }

        const riskDecision = this.riskManager.assessSignal(signal, portfolioSnapshot);

        if (!riskDecision.approved) {
            result.rejectedSignals += 1;
            this.notifier.warn(`[bot] ${event.symbol} signal rejected: ${riskDecision.reason}`);
            this.pendingEntryPlans.delete(event.symbol);
            return;
        }

        // Сохраняем план для входа на следующей свече (per symbol)
        const executionPlan = this.executionPlanner.buildEntryPlan(signal, riskDecision);
        this.pendingEntryPlans.set(event.symbol, { plan: executionPlan, signalTimestamp: candle.timestamp });
    }

    private formatEntryLog(
        symbol: string,
        side: TradeSide,
        referencePrice: number,
        notional: number,
        leverage: number,
        executedPrice: number,
        timestamp: number
    ): string {
        const sideLabel = side === "long" ? "OPEN LONG" : "OPEN SHORT";
        const sideIcon = side === "long" ? "\u{1F680}" : "\u{1F525}";
        const margin = leverage > 0 ? notional / leverage : notional;
        const slippage = referencePrice === 0 ? 0 : Math.abs((executedPrice - referencePrice) / referencePrice) * 100;

        return `[${formatUtcDateTime(timestamp)}] ${formatDisplaySymbol(symbol)}: ${sideIcon} ${sideLabel} at ${executedPrice.toFixed(4)} | Size: ${notional.toFixed(2)}$ Margin: ${margin.toFixed(2)}$ (slip ${slippage.toFixed(3)}%)`;
    }

    private formatExitLog(
        symbol: string,
        signal: StrategySignal,
        fees: number,
        balance: number,
        closeSlippagePercent?: number
    ): string {
        const closedTrades = this.portfolioManager.getClosedTrades();
        const closedTrade = closedTrades[closedTrades.length - 1];
        const pnlPercent = closedTrade?.pnlPercent ?? 0;
        const pnlLabel = `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`;
        const coloredPnl = this.colorizePnl(pnlPercent, pnlLabel);
        const successIcon = pnlPercent >= 0 ? "\u2705" : "\u274C";
        const reason = this.resolveCloseReason(signal);

        const slippageInfo = closeSlippagePercent !== undefined && closeSlippagePercent > 0
            ? ` (slip ${closeSlippagePercent.toFixed(3)}%)`
            : "";

        return `[${formatUtcDateTime(signal.timestamp ?? Date.now())}] ${formatDisplaySymbol(symbol)}: ${successIcon} | PnL: ${coloredPnl} | Com: ${fees.toFixed(2)}$ | Bal: ${balance.toFixed(2)}$${slippageInfo} | Reason: ${reason}`;
    }

    private resolveCloseReason(signal: StrategySignal): string {
        const rawReason = typeof signal.metadata?.exitReason === "string"
            ? signal.metadata.exitReason
            : "Signal exit";
        const normalizedReason = rawReason.toLowerCase();

        if (normalizedReason.includes("take profit")) {
            return "TP";
        }

        if (normalizedReason.includes("stop loss")) {
            return "SL (or liquidation)";
        }

        return rawReason;
    }

    private colorizePnl(value: number, label: string): string {
        if (value > 0) {
            return `\u001b[32m${label}\u001b[0m`;
        }

        if (value < 0) {
            return `\u001b[31m${label}\u001b[0m`;
        }

        return label;
    }
}
