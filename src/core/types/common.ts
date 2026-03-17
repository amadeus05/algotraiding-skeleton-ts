export type ExchangeId = "binance" | (string & {});

export type KlineInterval =
    | "1m"
    | "3m"
    | "5m"
    | "15m"
    | "30m"
    | "1h"
    | "2h"
    | "4h"
    | "6h"
    | "8h"
    | "12h"
    | "1d"
    | "3d"
    | "1w"
    | "1M"
    | (string & {});

export interface Kline {
    exchange: ExchangeId;
    symbol: string;
    interval: KlineInterval;
    openTime: number;
    closeTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    quoteVolume?: number;
    trades?: number;
    takerBuyBaseVolume?: number;
    takerBuyQuoteVolume?: number;
    openInterest?: number;
    isClosed: boolean;
    raw?: unknown;
}

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    takerBuyBaseVolume?: number;
    openInterest?: number;
}

export interface TimeRange {
    startTime: number;
    endTime: number;
}

export interface HistoricalKlineRequest {
    symbol: string;
    interval: KlineInterval;
    startTime?: number;
    endTime?: number;
    limit?: number;
}

export interface BacktestConfig {
    symbol: string;
    interval: KlineInterval;
    useTestnet: boolean;
    startTime: number;
    endTime: number;
    rangeDays: number;
    /** True when running in backtest mode to enable look-ahead bias protection */
    isBacktest: boolean;
}

export interface StrategyConfig {
    emaFast: number;
    emaSlow: number;
    minTrendStrength: number;
    rsiPeriod: number;
    rsiOverbought: number;
    rsiOversold: number;
    volumeSpikeMultiplier: number;
    pullbackToEMA: boolean;
    maxPullbackDistance: number;
    cvdThreshold: number;
    oiChangeMin: number;
    checkLiquidations: boolean;
    stopLossATRMultiplier: number;
    takeProfitRatio: number;
    trailingStop: boolean;
    minVolume: number;
    maxSpread: number;
    btcSyncRequired: boolean;
}

export interface RiskParameters {
    accountBalance: number;
    riskPerTrade: number;
    capitalAllocation: number;
    maxOpenTrades: number;
    leverage: number;
    maxDailyLoss: number;
    maxDrawdown: number;
    minRR: number;
}
