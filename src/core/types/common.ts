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
}

export interface LongStrategyConfig {
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsiPeriod: number;
    rsiMin: number;
    rsiMax: number;
    volumeSpikeMultiplier: number;
    minTrendStrength: number;
    pullbackMaxDistance: number;
    pullbackMinDistance: number;
    stopLossATRMultiplier: number;
    takeProfitRR: number;
    requireTrendConfirmation: boolean;
    requireHigherHighsHigherLows: boolean;
}

export interface ShortStrategyConfig {
    emaFastPeriod: number;
    emaSlowPeriod: number;
    rsiPeriod: number;
    rsiMin: number;
    rsiMax: number;
    volumeSpikeMultiplier: number;
    minTrendStrength: number;
    bounceMaxDistance: number;
    bounceMinDistance: number;
    stopLossATRMultiplier: number;
    takeProfitRR: number;
    requireTrendConfirmation: boolean;
    requireLowerHighsLowerLows: boolean;
    requireDistribution: boolean;
    maxFundingRate: number;
}

export interface DualStrategyConfig {
    long: LongStrategyConfig;
    short: ShortStrategyConfig;
    priorityMode: "balanced" | "trend_following" | "contrarian";
    minConfidenceThreshold: number;
    maxActivePositionsPerSide: number;
}

export interface LegacyStrategyConfig {
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

export type StrategyConfig = DualStrategyConfig | LegacyStrategyConfig;

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
