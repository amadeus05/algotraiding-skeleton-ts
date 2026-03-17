import { ExecutionEngineContract } from "../core/interfaces/ExecutionEngineContract";
import { NotifierContract } from "../core/interfaces/NotifierContract";
import { StrategyContract } from "../core/interfaces/StrategyContract";
import { Candle, KlineInterval } from "../core/types/common";
import { ClosedKlineEvent } from "../core/types/trading";
import { ExecutionPlanner } from "../domain/execution/ExecutionPlanner";
import { ExecutableOrder, PendingOrdersQueue } from "../domain/execution/PendingOrdersQueue";
import { PortfolioManager } from "../domain/execution/PortfolioManager";
import { RiskManager } from "../domain/risk/RiskManager";
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

    constructor(
        private readonly strategy: StrategyContract,
        private readonly riskManager: RiskManager,
        private readonly executionPlanner: ExecutionPlanner,
        private readonly executionEngine: ExecutionEngineContract,
        private readonly portfolioManager: PortfolioManager,
        private readonly notifier: NotifierContract,
        options: BotRunnerOptions
    ) {
        const intervalMs = intervalToMilliseconds(options.interval);
        this.pendingOrdersQueue = new PendingOrdersQueue({ intervalMs });
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

        // STEP 1: Execute any pending orders at this candle's open (avoids look-ahead bias)
        this.executePendingOrders(candle, result);

        // STEP 2: Update history and market prices
        const history = historyBySymbol.get(event.symbol) ?? [];
        result.processedCandles += 1;
        history.push(candle);
        historyBySymbol.set(event.symbol, history);
        this.portfolioManager.updateMarketPrice(event.symbol, candle.close, candle.timestamp);

        // STEP 3: Evaluate strategy on the closed candle
        const portfolioSnapshot = this.portfolioManager.getSnapshot(candle.timestamp);
        const position = this.portfolioManager.getPosition(event.symbol);
        const signal = this.strategy.evaluate({
            symbol: event.symbol,
            timeframe: event.interval,
            candle,
            history: [...history],
            portfolio: portfolioSnapshot,
            position
        });

        // STEP 4: Handle signals
        if (signal.action === "hold") {
            result.skippedSignals += 1;
            return;
        }

        if (signal.action === "exit") {
            this.handleExitSignal(event.symbol, position, candle, result);
            return;
        }

        this.handleEntrySignal(event, signal, portfolioSnapshot, position, candle, result);
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

    private handleEntrySignal(
        event: ClosedKlineEvent,
        signal: import("../core/types/trading").StrategySignal,
        portfolioSnapshot: import("../core/types/trading").PortfolioSnapshot,
        position: import("../core/types/trading").Position | undefined,
        candle: Candle,
        result: BotRunResult
    ): void {
        result.entrySignals += 1;

        if (position) {
            result.skippedSignals += 1;
            this.notifier.info(`[bot] ${event.symbol} entry signal ignored: position already open`);
            return;
        }

        const riskDecision = this.riskManager.assessSignal(signal, portfolioSnapshot);

        if (!riskDecision.approved) {
            result.rejectedSignals += 1;
            this.notifier.warn(`[bot] ${event.symbol} signal rejected: ${riskDecision.reason}`);
            return;
        }

        const executionPlan = this.executionPlanner.buildEntryPlan(signal, riskDecision);

        // For "next_open" execution timing (backtest default), queue for next candle
        if (executionPlan.executionTiming === "next_open") {
            const pendingOrder = this.pendingOrdersQueue.queueForNextOpen(
                executionPlan,
                candle.timestamp // Current candle close time = next candle open time target
            );
            result.approvedEntries += 1;
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

        result.approvedEntries += 1;
        result.executedOrders += 1;
        this.notifier.info(
            `[bot] ${event.symbol} ${executionPlan.side} entry executed ` +
            `qty=${executionPlan.quantity} price=${executionPlan.entryPrice} (immediate execution)`
        );
    }
}
