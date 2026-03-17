import { ExecutionEngineContract } from "../core/interfaces/ExecutionEngineContract";
import { NotifierContract } from "../core/interfaces/NotifierContract";
import { StrategyContract } from "../core/interfaces/StrategyContract";
import { Candle } from "../core/types/common";
import { ClosedKlineEvent, ExecutedOrder, StrategySignal } from "../core/types/trading";
import { ExecutionPlanner } from "../domain/execution/ExecutionPlanner";
import { PortfolioManager } from "../domain/execution/PortfolioManager";
import { RiskManager } from "../domain/risk/RiskManager";
import { BacktestTradeLogger, ExitReason } from "./BacktestTradeLogger";

export interface BotRunnerOptions {
    maxHistoryLength?: number;
    tradeLogger?: BacktestTradeLogger;
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
    protectiveExits: number;
}

export class BotRunner {
    private readonly maxHistoryLength: number;

    private readonly tradeLogger?: BacktestTradeLogger;

    constructor(
        private readonly strategy: StrategyContract,
        private readonly riskManager: RiskManager,
        private readonly executionPlanner: ExecutionPlanner,
        private readonly executionEngine: ExecutionEngineContract,
        private readonly portfolioManager: PortfolioManager,
        private readonly notifier: NotifierContract,
        options: BotRunnerOptions = {}
    ) {
        this.maxHistoryLength = Math.max(options.maxHistoryLength ?? 500, 1);
        this.tradeLogger = options.tradeLogger;
    }

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

        const state = this.createRunState();
        for (const event of events) {
            this.processEvent(event, state);
        }
        return state.result;
    }

    public async runReplay(events: AsyncIterable<ClosedKlineEvent> | Iterable<ClosedKlineEvent>): Promise<BotRunResult> {
        const state = this.createRunState();
        if (Symbol.asyncIterator in Object(events)) {
            for await (const event of events as AsyncIterable<ClosedKlineEvent>) {
                this.processEvent(event, state);
            }
        } else {
            for (const event of events as Iterable<ClosedKlineEvent>) {
                this.processEvent(event, state);
            }
        }
        return state.result;
    }

    private createRunState(): {
        historyBySymbol: Map<string, Candle[]>;
        pendingEntryBySymbol: Map<string, StrategySignal>;
        pendingSignalExitBySymbol: Set<string>;
        result: BotRunResult;
    } {
        return {
            historyBySymbol: new Map<string, Candle[]>(),
            pendingEntryBySymbol: new Map<string, StrategySignal>(),
            pendingSignalExitBySymbol: new Set<string>(),
            result: {
                processedCandles: 0,
                entrySignals: 0,
                approvedEntries: 0,
                executedOrders: 0,
                rejectedSignals: 0,
                skippedSignals: 0,
                protectiveExits: 0
            }
        };
    }

    private processEvent(
        event: ClosedKlineEvent,
        state: {
            historyBySymbol: Map<string, Candle[]>;
            pendingEntryBySymbol: Map<string, StrategySignal>;
            pendingSignalExitBySymbol: Set<string>;
            result: BotRunResult;
        }
    ): void {
        const candle = this.eventToCandle(event);
        const history = state.historyBySymbol.get(event.symbol) ?? [];
        history.push(candle);

        if (history.length > this.maxHistoryLength) {
            state.historyBySymbol.set(event.symbol, history.slice(-this.maxHistoryLength));
        } else {
            state.historyBySymbol.set(event.symbol, history);
        }

        state.result.processedCandles += 1;

        let position = this.portfolioManager.getPosition(event.symbol);

        if (state.pendingSignalExitBySymbol.has(event.symbol) && position !== undefined) {
            const closeOrder = this.executionEngine.buildCloseOrder(position, candle, {
                reason: "signal",
                exitPrice: candle.open
            });
            if (closeOrder !== undefined) {
                this.logAndApplyClose(position, closeOrder, event.symbol, candle.timestamp, "signal");
                state.result.executedOrders += 1;
            }
            state.pendingSignalExitBySymbol.delete(event.symbol);
            position = this.portfolioManager.getPosition(event.symbol);
        }

        const pendingEntry = state.pendingEntryBySymbol.get(event.symbol);
        if (pendingEntry !== undefined) {
            if (position !== undefined) {
                this.notifier.warn(`[bot] ${event.symbol} pending entry dropped: position already open`);
            } else {
                const executionSignal: StrategySignal = {
                    ...pendingEntry,
                    entryPrice: candle.open,
                    timestamp: candle.timestamp
                };
                const riskDecision = this.riskManager.assessSignal(
                    executionSignal,
                    this.portfolioManager.getSnapshot(candle.timestamp)
                );
                if (!riskDecision.approved) {
                    state.result.rejectedSignals += 1;
                    this.notifier.warn(`[bot] ${event.symbol} deferred signal rejected: ${riskDecision.reason}`);
                } else {
                    const executionPlan = this.executionPlanner.buildEntryPlan(executionSignal, riskDecision);
                    const order = this.executionEngine.execute(executionPlan, candle);
                    this.logAndApplyOpen(order, executionPlan, event.symbol, candle.timestamp);
                    this.portfolioManager.applyExecution(order);
                    state.result.approvedEntries += 1;
                    state.result.executedOrders += 1;
                    position = this.portfolioManager.getPosition(event.symbol);
                }
            }
            state.pendingEntryBySymbol.delete(event.symbol);
        }

        this.portfolioManager.updateMarketPrice(event.symbol, candle.close, candle.timestamp);
        position = this.portfolioManager.getPosition(event.symbol);

        const protectiveClose =
            position !== undefined
                ? this.executionEngine.buildCloseOrder(position, candle, { reason: "protective" })
                : undefined;

        if (protectiveClose !== undefined) {
            this.logAndApplyClose(position!, protectiveClose, event.symbol, candle.timestamp, "protective");
            state.result.executedOrders += 1;
            state.result.protectiveExits += 1;
            state.pendingSignalExitBySymbol.delete(event.symbol);
            position = this.portfolioManager.getPosition(event.symbol);
        }

        const portfolioSnapshot = this.portfolioManager.getSnapshot(candle.timestamp);
        const currentHistory = state.historyBySymbol.get(event.symbol)!;
        const signal = this.strategy.evaluate({
            symbol: event.symbol,
            timeframe: event.interval,
            candle,
            history: currentHistory,
            portfolio: portfolioSnapshot,
            position: position ?? undefined
        });

        if (signal.action === "hold") {
            state.result.skippedSignals += 1;
            return;
        }

        if (signal.action === "exit") {
            const currentPosition = this.portfolioManager.getPosition(event.symbol);
            if (currentPosition === undefined) {
                state.result.skippedSignals += 1;
                state.pendingSignalExitBySymbol.delete(event.symbol);
                this.notifier.info(`[bot] ${event.symbol} exit signal ignored: no open position`);
                return;
            }
            state.pendingSignalExitBySymbol.add(event.symbol);
            return;
        }

        state.result.entrySignals += 1;

        const openPosition = this.portfolioManager.getPosition(event.symbol);
        if (openPosition !== undefined) {
            state.result.skippedSignals += 1;
            this.notifier.info(`[bot] ${event.symbol} entry signal ignored: position already open`);
            return;
        }

        state.pendingEntryBySymbol.set(event.symbol, signal);
    }

    private logAndApplyOpen(
        order: { symbol: string; side: "long" | "short"; quantity: number; price: number; leverage: number },
        plan: { entryPrice: number },
        symbol: string,
        timestamp: number
    ): void {
        if (this.tradeLogger) {
            const sizeUsd = order.quantity * order.price;
            const marginUsd = sizeUsd / Math.max(order.leverage, 1);
            const slip = plan.entryPrice !== 0 ? ((order.price - plan.entryPrice) / plan.entryPrice) * 100 : 0;
            this.tradeLogger.logOpen({
                symbol,
                side: order.side,
                price: order.price,
                sizeUsd,
                marginUsd,
                slippagePct: slip,
                timestamp
            });
        } else {
            this.notifier.info(
                `[bot] ${symbol} ${order.side} entry executed qty=${order.quantity} price=${order.price}`
            );
        }
    }

    private logAndApplyClose(
        position: { symbol: string; side: "long" | "short"; quantity: number; entryPrice: number; leverage: number; feesPaid?: number; stopLossPrice?: number; takeProfitPrice?: number },
        closeOrder: ExecutedOrder,
        symbol: string,
        timestamp: number,
        reason: "protective" | "signal"
    ): void {
        const fees = closeOrder.fees ?? 0;
        const openFees = position.feesPaid ?? 0;
        const totalFees = openFees + fees;
        const grossPnl =
            position.side === "long"
                ? (closeOrder.price - position.entryPrice) * position.quantity
                : (position.entryPrice - closeOrder.price) * position.quantity;
        const marginUsed = (position.quantity * position.entryPrice) / Math.max(position.leverage, 1);
        const netPnl = grossPnl - totalFees;
        const pnlPct = marginUsed > 0 ? (netPnl / marginUsed) * 100 : 0;
        this.portfolioManager.applyExecution(closeOrder);
        const snapshotAfter = this.portfolioManager.getSnapshot(timestamp);

        const exitReason: ExitReason = reason === "protective" ? closeOrder.exitReason ?? "signal" : "signal";

        if (this.tradeLogger) {
            this.tradeLogger.logClose({
                symbol,
                side: position.side,
                pnlPct,
                commission: totalFees,
                balance: snapshotAfter.balance,
                reason: exitReason,
                timestamp
            });
            this.tradeLogger.recordClose(
                pnlPct,
                netPnl,
                totalFees,
                snapshotAfter.equity,
                symbol,
                timestamp,
                exitReason
            );
        } else {
            this.notifier.info(
                `[bot] ${symbol} ${reason} exit at ${closeOrder.price}`
            );
        }
    }

    private eventToCandle(event: ClosedKlineEvent): Candle {
        return {
            timestamp: event.kline.openTime,
            open: event.kline.open,
            high: event.kline.high,
            low: event.kline.low,
            close: event.kline.close,
            volume: event.kline.volume,
            takerBuyBaseVolume: event.kline.takerBuyBaseVolume,
            openInterest: event.kline.openInterest
        };
    }
}
