import { Kline } from "./common";

export type TradeSide = "long" | "short";
export type SignalAction = "enter" | "exit" | "hold";
export type OrderType = "market" | "limit";
export type ExecutionAction = "open" | "close";

export interface StrategySignal {
    symbol: string;
    action: SignalAction;
    side?: TradeSide;
    entryPrice?: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    timestamp?: number;
    metadata?: Record<string, unknown>;
    /** Execution timing - "immediate" for live trading, "next_open" for backtest to avoid look-ahead bias */
    executionTiming?: ExecutionTiming;
}

export interface Position {
    symbol: string;
    side: TradeSide;
    quantity: number;
    entryPrice: number;
    currentPrice: number;
    leverage: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    openedAt: number;
    updatedAt: number;
    feesPaid: number;
}

export interface PortfolioSnapshot {
    balance: number;
    equity: number;
    realizedPnl: number;
    unrealizedPnl: number;
    dailyPnl: number;
    drawdown: number;
    openTradeCount: number;
    positions: Position[];
}

export interface RiskDecision {
    approved: boolean;
    reason?: string;
    riskAmount: number;
    capitalToAllocate: number;
    quantity: number;
    entryPrice: number;
    leverage: number;
    stopDistance: number;
    suggestedStopLossPrice?: number;
    estimatedLossAtStop: number;
}

export type ExecutionTiming = "immediate" | "next_open";

export interface ExecutionPlan {
    action: ExecutionAction;
    symbol: string;
    side: TradeSide;
    orderType: OrderType;
    quantity: number;
    entryPrice: number;
    notional: number;
    leverage: number;
    stopLossPrice: number;
    takeProfitPrice?: number;
    reduceOnly: boolean;
    estimatedLossAtStop: number;
    executionTiming: ExecutionTiming;
}

export interface PendingOrder {
    id: string;
    plan: ExecutionPlan;
    createdAt: number;
    targetCandleOpenTime: number;
}

export interface ExecutedOrder {
    action: ExecutionAction;
    symbol: string;
    side: TradeSide;
    quantity: number;
    price: number;
    leverage: number;
    timestamp: number;
    fees?: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
}

export interface ClosedKlineEvent {
    exchange: string;
    symbol: string;
    interval: string;
    kline: Kline;
}
