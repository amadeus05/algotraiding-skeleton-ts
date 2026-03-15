import { ExecutionEngineContract } from "../core/interfaces/ExecutionEngineContract";
import { NotifierContract } from "../core/interfaces/NotifierContract";
import { StrategyContract } from "../core/interfaces/StrategyContract";
import { Candle } from "../core/types/common";
import { ClosedKlineEvent, StrategySignal, TradeSide } from "../core/types/trading";
import { ExecutionPlanner } from "../domain/execution/ExecutionPlanner";
import { PortfolioManager } from "../domain/execution/PortfolioManager";
import { RiskManager } from "../domain/risk/RiskManager";
import { formatDisplaySymbol, formatUtcDateTime } from "../utils/Helpers";

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
    constructor(
        private readonly strategy: StrategyContract,
        private readonly riskManager: RiskManager,
        private readonly executionPlanner: ExecutionPlanner,
        private readonly executionEngine: ExecutionEngineContract,
        private readonly portfolioManager: PortfolioManager,
        private readonly notifier: NotifierContract
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
        history.push(candle);
        historyBySymbol.set(event.symbol, history);
        this.portfolioManager.updateMarketPrice(event.symbol, candle.close, candle.timestamp);

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
            closeOrder.metadata = {
                ...closeOrder.metadata,
                closeReason: this.resolveCloseReason(signal)
            };
            this.portfolioManager.applyExecution(closeOrder);
            result.executedOrders += 1;
            const snapshot = this.portfolioManager.getSnapshot(candle.timestamp);
            this.notifier.info(this.formatExitLog(event.symbol, signal, closeOrder.fees ?? 0, snapshot.balance));
            return;
        }

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
        const order = this.executionEngine.execute(executionPlan, candle);
        this.portfolioManager.applyExecution(order);

        result.approvedEntries += 1;
        result.executedOrders += 1;
        this.notifier.info(
            this.formatEntryLog(
                event.symbol,
                executionPlan.side,
                executionPlan.entryPrice,
                executionPlan.notional,
                executionPlan.leverage,
                order.price,
                candle.timestamp
            )
        );
    }

    private formatEntryLog(
        symbol: string,
        side: TradeSide,
        entryPrice: number,
        notional: number,
        leverage: number,
        executedPrice: number,
        timestamp: number
    ): string {
        const sideLabel = side === "long" ? "OPEN LONG" : "OPEN SHORT";
        const sideIcon = side === "long" ? "\u{1F680}" : "\u{1F525}";
        const margin = leverage > 0 ? notional / leverage : notional;
        const slippage = entryPrice === 0 ? 0 : Math.abs((executedPrice - entryPrice) / entryPrice) * 100;

        return `[${formatUtcDateTime(timestamp)}] ${formatDisplaySymbol(symbol)}: ${sideIcon} ${sideLabel} at ${entryPrice.toFixed(4)} | Size: ${notional.toFixed(2)}$ Margin: ${margin.toFixed(2)}$ (slip ${slippage.toFixed(3)}%)`;
    }

    private formatExitLog(
        symbol: string,
        signal: StrategySignal,
        fees: number,
        balance: number
    ): string {
        const closedTrades = this.portfolioManager.getClosedTrades();
        const closedTrade = closedTrades[closedTrades.length - 1];
        const pnlPercent = closedTrade?.pnlPercent ?? 0;
        const pnlLabel = `${pnlPercent >= 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`;
        const coloredPnl = this.colorizePnl(pnlPercent, pnlLabel);
        const successIcon = pnlPercent >= 0 ? "\u2705" : "\u274C";
        const reason = this.resolveCloseReason(signal);

        return `[${formatUtcDateTime(signal.timestamp ?? Date.now())}] ${formatDisplaySymbol(symbol)}: ${successIcon} | PnL: ${coloredPnl} | Com: ${fees.toFixed(2)}$ | Bal: ${balance.toFixed(2)}$ | Reason: ${reason}`;
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
