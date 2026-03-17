import { DataProviderContract } from "../core/interfaces/DataProviderContract";
import { ExecutionEngineContract } from "../core/interfaces/ExecutionEngineContract";
import { FullStrategyContext, StrategyContract } from "../core/interfaces/StrategyContract";
import { NotifierContract } from "../core/interfaces/NotifierContract";
import { Candle, KlineInterval } from "../core/types/common";
import { ClosedKlineEvent, StrategySignal, PortfolioSnapshot } from "../core/types/trading";
import { ExecutionPlanner } from "../domain/execution/ExecutionPlanner";
import { ExecutableOrder, PendingOrdersQueue } from "../domain/execution/PendingOrdersQueue";
import { PortfolioManager } from "../domain/execution/PortfolioManager";
import { RiskManager } from "../domain/risk/RiskManager";
import { SignalBatchProcessor, SignalEvaluation } from "../domain/execution/SignalBatchProcessor";
import { intervalToMilliseconds } from "../utils/Helpers";

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
    pendingOrdersCreated: number;
}

export interface BotRunnerOptions {
    /** Candle interval for calculating next open times (e.g., "1h", "15m") */
    interval: KlineInterval;
}

export class BotRunner {
    private readonly pendingOrdersQueue: PendingOrdersQueue;
    private readonly batchProcessor: SignalBatchProcessor;

    // Batch buffering state for multi-symbol backtest (eliminates ordering bias)
    private currentBatchTimestamp: number | null = null;
    private pendingBatchEvents: Array<{ event: ClosedKlineEvent; candle: Candle; history: Candle[]; symbol: string }> = [];

    // DataProvider гарантирует отсутствие look-ahead bias
    private dataProvider: DataProviderContract | null = null;

    // Execution metadata для стратегии
    private isBacktestMode: boolean;

    constructor(
        private readonly strategy: StrategyContract,
        private readonly riskManager: RiskManager,
        private readonly executionPlanner: ExecutionPlanner,
        private readonly executionEngine: ExecutionEngineContract,
        private readonly portfolioManager: PortfolioManager,
        private readonly notifier: NotifierContract,
        options: BotRunnerOptions & { isBacktest?: boolean }
    ) {
        const intervalMs = intervalToMilliseconds(options.interval);
        this.pendingOrdersQueue = new PendingOrdersQueue({ intervalMs });
        this.batchProcessor = new SignalBatchProcessor(riskManager, executionPlanner);
        this.isBacktestMode = options.isBacktest ?? true;
    }

    /**
     * Устанавливает DataProvider для централизованного доступа к данным.
     * DataProvider гарантирует отсутствие look-ahead bias и корректный HTF alignment.
     */
    public setDataProvider(dataProvider: DataProviderContract): void {
        this.dataProvider = dataProvider;
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

        return this.runReplaySync(events);
    }

    public async runReplay(events: AsyncIterable<ClosedKlineEvent> | Iterable<ClosedKlineEvent>): Promise<BotRunResult> {
        // Reset batch state for fresh run
        this.resetBatchState();

        if (Symbol.asyncIterator in Object(events)) {
            const asyncHistoryBySymbol = new Map<string, Candle[]>();
            const result = this.createEmptyResult();

            for await (const event of events as AsyncIterable<ClosedKlineEvent>) {
                this.processEvent(event, asyncHistoryBySymbol, result);
            }

            // Flush final batch to ensure all events are processed
            this.flushBatch(asyncHistoryBySymbol, result);

            return result;
        }

        return this.runReplaySync(events as Iterable<ClosedKlineEvent>);
    }

    public runReplaySync(events: Iterable<ClosedKlineEvent>): BotRunResult {
        // Reset batch state for fresh run
        this.resetBatchState();

        const historyBySymbol = new Map<string, Candle[]>();
        const result = this.createEmptyResult();

        for (const event of events) {
            this.processEvent(event, historyBySymbol, result);
        }

        // Flush final batch to ensure all events are processed
        this.flushBatch(historyBySymbol, result);

        return result;
    }

    private resetBatchState(): void {
        this.currentBatchTimestamp = null;
        this.pendingBatchEvents = [];
    }

    private createEmptyResult(): BotRunResult {
        return {
            processedCandles: 0,
            entrySignals: 0,
            approvedEntries: 0,
            executedOrders: 0,
            rejectedSignals: 0,
            skippedSignals: 0,
            pendingOrdersCreated: 0
        };
    }

    private processEvent(
        event: ClosedKlineEvent,
        historyBySymbol: Map<string, Candle[]>,
        result: BotRunResult
    ): void {
        const candle: Candle = {
            timestamp: event.kline.openTime,
            open: event.kline.open,
            high: event.kline.high,
            low: event.kline.low,
            close: event.kline.close,
            volume: event.kline.volume,
            takerBuyBaseVolume: event.kline.takerBuyBaseVolume,
            openInterest: event.kline.openInterest
        };

        const eventTimestamp = event.kline.openTime;

        // If timestamp changed, flush the previous batch first
        if (this.currentBatchTimestamp !== null && this.currentBatchTimestamp !== eventTimestamp) {
            this.flushBatch(historyBySymbol, result);
        }

        // Update current batch state
        this.currentBatchTimestamp = eventTimestamp;

        // Update history for this symbol (fallback mode если DataProvider не установлен)
        const history = historyBySymbol.get(event.symbol) ?? [];
        history.push(candle);
        historyBySymbol.set(event.symbol, history);

        // Add to pending batch - history передается для fallback mode
        this.pendingBatchEvents.push({ event, candle, history: [...history], symbol: event.symbol });
    }

    /**
     * Flushes the current batch, processing all events at the same timestamp together.
     * This eliminates ordering bias between symbols.
     *
     * DataProvider (если установлен) гарантирует:
     * - Point-in-time данные без look-ahead bias
     * - Корректный HTF alignment если используется HTF
     * - Валидацию достаточности истории
     *
     * Fallback mode (если DataProvider не установлен) использует history из событий.
     */
    private flushBatch(
        _historyBySymbol: Map<string, Candle[]>, // Legacy parameter для совместимости
        result: BotRunResult
    ): void {
        if (this.pendingBatchEvents.length === 0) {
            return;
        }

        const timestamp = this.currentBatchTimestamp!;

        // STEP 1: Execute pending orders at this candle's open
        const firstCandle = this.pendingBatchEvents[0].candle;
        this.executePendingOrders(firstCandle, result);

        // STEP 2: Update market prices for ALL symbols in batch
        for (const { event, candle } of this.pendingBatchEvents) {
            this.portfolioManager.updateMarketPrice(event.symbol, candle.close, candle.timestamp);
            result.processedCandles += 1;
        }

        // STEP 3: Get SINGLE portfolio snapshot for ALL signals in this batch
        const portfolioSnapshot = this.portfolioManager.getSnapshot(timestamp);

        // STEP 4: Collect all entry signals from batch
        const signalEvaluations: SignalEvaluation[] = [];
        const exitSignals: Array<{ event: ClosedKlineEvent; candle: Candle }> = [];

        for (const { event, candle, history: fallbackHistory } of this.pendingBatchEvents) {
            const position = this.portfolioManager.getPosition(event.symbol);

            // Определяем историю: DataProvider приоритетнее fallback
            const hasDataProvider = this.dataProvider !== null;
            let history: Candle[];
            let htfContext: FullStrategyContext["htf"] = undefined;

            if (hasDataProvider) {
                // Проверка достаточности данных через DataProvider
                if (!this.dataProvider!.hasEnoughData(event.symbol, timestamp, this.strategy.minHistoryRequired())) {
                    result.skippedSignals += 1;
                    this.notifier.info(`[bot] ${event.symbol} signal skipped: insufficient history for strategy`);
                    continue;
                }

                const preparedData = this.dataProvider!.getDataForTimestamp(event.symbol, timestamp);
                if (preparedData) {
                    history = preparedData.primary.closedHistory;
                    if (preparedData.higherTimeframe) {
                        htfContext = {
                            interval: preparedData.higherTimeframe.interval,
                            currentCandle: preparedData.higherTimeframe.currentHTFCandle,
                            history: preparedData.higherTimeframe.closedHTFHistory,
                            currentIndex: preparedData.higherTimeframe.currentIndex
                        };
                    }
                } else {
                    history = [];
                }
            } else {
                // Fallback mode: используем history из события
                history = fallbackHistory;
            }

            const strategyContext: FullStrategyContext = {
                symbol: event.symbol,
                timeframe: event.interval as KlineInterval,
                candle: { ...candle },
                history: history.map(c => ({ ...c })),
                portfolio: portfolioSnapshot,
                position,
                execution: {
                    isBacktest: this.isBacktestMode,
                    defaultExecutionTiming: this.isBacktestMode ? "next_open" : "immediate",
                    currentTimestamp: timestamp
                },
                htf: htfContext
            };

            const signal = this.strategy.evaluate(strategyContext);

            if (signal.action === "exit") {
                exitSignals.push({ event, candle });
            } else if (signal.action === "enter") {
                // Для SignalEvaluation используем ту же историю
                signalEvaluations.push({ event, candle, history: strategyContext.history, signal });
            } else {
                result.skippedSignals += 1;
            }
        }

        // STEP 5: Process exit signals immediately (they don't compete for slots)
        for (const { event, candle } of exitSignals) {
            const position = this.portfolioManager.getPosition(event.symbol);
            this.handleExitSignal(event.symbol, position, candle, result);
        }

        // STEP 6: Batch process entry signals with fair portfolio limit allocation
        if (signalEvaluations.length > 0) {
            this.processEntrySignalsBatch(signalEvaluations, portfolioSnapshot, result);
        }

        // Clear the batch
        this.pendingBatchEvents = [];
    }


    /**
     * Processes entry signals in batch, ensuring fair allocation of portfolio limits.
     * All signals are evaluated against the same portfolio snapshot.
     */
    private processEntrySignalsBatch(
        evaluations: SignalEvaluation[],
        portfolioSnapshot: PortfolioSnapshot,
        result: BotRunResult
    ): void {
        // Import type locally to avoid circular dependency issues
        type ExecutionPlan = import("../core/types/trading").ExecutionPlan;
        // Use batch processor to evaluate all signals against same snapshot
        const batchResult = this.batchProcessor.processBatch(
            evaluations,
            portfolioSnapshot,
            this.riskManager.maxOpenTrades
        );

        // Handle approved signals
        for (const approved of batchResult.approvedEvaluations) {
            const { event, signal } = approved.evaluation;
            const position = this.portfolioManager.getPosition(event.symbol);

            result.entrySignals += 1;

            if (position) {
                // Should not happen due to portfolio limits, but safety check
                result.skippedSignals += 1;
                this.notifier.info(`[bot] ${event.symbol} entry signal ignored: position already open`);
                continue;
            }

            result.approvedEntries += 1;
            this.executeEntrySignal(event, signal, approved.executionPlan!, approved.evaluation.candle, result);
        }

        // Handle rejected signals
        for (const rejected of batchResult.rejectedEvaluations) {
            const { event, signal } = rejected.evaluation;
            result.entrySignals += 1;
            result.rejectedSignals += 1;
            this.notifier.warn(`[bot] ${event.symbol} signal rejected: ${rejected.riskDecision.reason}`);
        }
    }

    private executeEntrySignal(
        event: ClosedKlineEvent,
        signal: StrategySignal,
        executionPlan: import("../core/types/trading").ExecutionPlan,
        candle: Candle,
        result: BotRunResult
    ): void {
        // For "next_open" execution timing (backtest default), queue for next candle
        if (executionPlan.executionTiming === "next_open") {
            const pendingOrder = this.pendingOrdersQueue.queueForNextOpen(
                executionPlan,
                candle.timestamp // Current candle close time = next candle open time target
            );
            result.pendingOrdersCreated += 1;
            this.notifier.info(
                `[bot] ${event.symbol} ${executionPlan.side} entry queued ` +
                `qty=${executionPlan.quantity} for execution at next candle open ` +
                `(target: ${new Date(pendingOrder.targetCandleOpenTime).toISOString()})`
            );
            return;
        }

        // For "immediate" execution timing (live trading), execute right away
        const order = this.executionEngine.execute(executionPlan, candle);
        this.portfolioManager.applyExecution(order);

        result.executedOrders += 1;
        this.notifier.info(
            `[bot] ${event.symbol} ${executionPlan.side} entry executed ` +
            `qty=${executionPlan.quantity} price=${executionPlan.entryPrice} (immediate execution)`
        );
    }

    private executePendingOrders(candle: Candle, result: BotRunResult): void {
        const executableOrders = this.pendingOrdersQueue.getExecutableOrders(candle.timestamp);

        for (const executable of executableOrders) {
            // Execute at the open price of this candle (next candle from when order was queued)
            const order = this.executionEngine.executeAtOpen(executable.plan, candle);
            this.portfolioManager.applyExecution(order);
            this.pendingOrdersQueue.remove(executable.pendingOrderId);

            result.executedOrders += 1;
            this.notifier.info(
                `[bot] ${executable.plan.symbol} ${executable.plan.side} entry executed ` +
                `qty=${executable.plan.quantity} price=${order.price} (next-open execution, no look-ahead bias)`
            );
        }
    }

    private handleExitSignal(
        symbol: string,
        position: import("../core/types/trading").Position | undefined,
        candle: Candle,
        result: BotRunResult
    ): void {
        if (!position) {
            result.skippedSignals += 1;
            this.notifier.info(`[bot] ${symbol} exit signal ignored: no open position`);
            return;
        }

        const closeOrder = this.executionEngine.buildCloseOrder(position, candle);
        this.portfolioManager.applyExecution(closeOrder);
        result.executedOrders += 1;
        this.notifier.info(`[bot] ${symbol} exit executed at ${closeOrder.price}`);
    }
}
