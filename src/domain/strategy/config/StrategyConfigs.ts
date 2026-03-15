export interface LongStrategyConfig {
    aggressiveMode?: boolean;
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
    /** Min unrealized PnL % для reversal exit; exit по bearish reversal блокируется при pnl < порога */
    minProfitForReversalExitPercent: number;
    /** Min свечей после входа до разрешения reversal-based exit */
    minHoldingCandlesBeforeReversalExit: number;
    /** Reversal должен подтвердиться N свечей подряд */
    reversalConfirmationCandles: number;
}

export interface ShortStrategyConfig {
    aggressiveMode?: boolean;
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
    maxFundingRate: number; // Don't short if funding too negative (crowded short)
    /** Min unrealized PnL % для reversal exit; exit по bullish reversal блокируется при pnl < порога */
    minProfitForReversalExitPercent: number;
    /** Min свечей после входа до разрешения reversal-based exit */
    minHoldingCandlesBeforeReversalExit: number;
    /** Reversal должен подтвердиться N свечей подряд */
    reversalConfirmationCandles: number;
}

export const DefaultLongConfig: LongStrategyConfig = {
    emaFastPeriod: 20,
    emaSlowPeriod: 50,
    rsiPeriod: 14,
    rsiMin: 30,
    rsiMax: 70,
    volumeSpikeMultiplier: 1.0,
    minTrendStrength: 0.15,
    pullbackMaxDistance: 0.06,
    pullbackMinDistance: 0.001,
    stopLossATRMultiplier: 0.8,
    takeProfitRR: 1.5,
    requireTrendConfirmation: true,
    requireHigherHighsHigherLows: false,
    minProfitForReversalExitPercent: 1.0,
    minHoldingCandlesBeforeReversalExit: 3,
    reversalConfirmationCandles: 2
};

export const DefaultShortConfig: ShortStrategyConfig = {
    emaFastPeriod: 50,
    emaSlowPeriod: 200,
    rsiPeriod: 14,
    rsiMin: 45,
    rsiMax: 85,
    volumeSpikeMultiplier: 1.0,
    minTrendStrength: 0.2,
    bounceMaxDistance: 0.05,
    bounceMinDistance: 0.001,
    stopLossATRMultiplier: 1.0,
    takeProfitRR: 1.5,
    requireTrendConfirmation: true,
    requireLowerHighsLowerLows: false,
    requireDistribution: false,
    maxFundingRate: -0.01,
    minProfitForReversalExitPercent: 1.0,
    minHoldingCandlesBeforeReversalExit: 3,
    reversalConfirmationCandles: 2
};
