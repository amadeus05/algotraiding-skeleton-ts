import { ExecutionEngineContract } from "../core/interfaces/ExecutionEngineContract";
import { NotifierContract } from "../core/interfaces/NotifierContract";
import { StrategyContract } from "../core/interfaces/StrategyContract";
import { Candle } from "../core/types/common";
import { ClosedKlineEvent } from "../core/types/trading";
import { ExecutionPlanner } from "../domain/execution/ExecutionPlanner";
import { PortfolioManager } from "../domain/execution/PortfolioManager";
import { RiskManager } from "../domain/risk/RiskManager";

export interface BotRunnerOptions {
    maxHistoryLength?: number;
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
        pendingSignalExitBySymbol: Set<string>;
        result: BotRunResult;
    } {
        return {
            historyBySymbol: new Map<string, Candle[]>(),
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

        this.portfolioManager.updateMarketPrice(event.symbol, candle.close, candle.timestamp);

        const position = this.portfolioManager.getPosition(event.symbol);

        const protectiveClose =
            position !== undefined
                ? this.executionEngine.buildCloseOrder(position, candle, { reason: "protective" })
                : undefined;

        if (protectiveClose !== undefined) {
            this.portfolioManager.applyExecution(protectiveClose);
            state.result.executedOrders += 1;
            state.result.protectiveExits += 1;
            state.pendingSignalExitBySymbol.delete(event.symbol);
            this.notifier.info(`[bot] ${event.symbol} protective exit at ${protectiveClose.price}`);
            return;
        }

        if (state.pendingSignalExitBySymbol.has(event.symbol) && position !== undefined) {
            const closeOrder = this.executionEngine.buildCloseOrder(position, candle, {
                reason: "signal",
                exitPrice: candle.open
            });
            if (closeOrder !== undefined) {
                this.portfolioManager.applyExecution(closeOrder);
                state.result.executedOrders += 1;
                state.pendingSignalExitBySymbol.delete(event.symbol);
                this.notifier.info(`[bot] ${event.symbol} exit executed at ${closeOrder.price}`);
            }
            return;
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

        const riskDecision = this.riskManager.assessSignal(signal, this.portfolioManager.getSnapshot(candle.timestamp));
        if (!riskDecision.approved) {
            state.result.rejectedSignals += 1;
            this.notifier.warn(`[bot] ${event.symbol} signal rejected: ${riskDecision.reason}`);
            return;
        }

        const executionPlan = this.executionPlanner.buildEntryPlan(signal, riskDecision);
        const order = this.executionEngine.execute(executionPlan, candle);
        this.portfolioManager.applyExecution(order);
        state.result.approvedEntries += 1;
        state.result.executedOrders += 1;
        this.notifier.info(
            `[bot] ${event.symbol} ${executionPlan.side} entry executed qty=${executionPlan.quantity} price=${order.price}`
        );
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
