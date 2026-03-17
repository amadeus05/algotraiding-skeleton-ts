import { injectable } from "inversify";
import * as dotenv from 'dotenv';
import { BacktestConfig, KlineInterval, StrategyConfig, RiskParameters } from "../core/types/common";
import { parseTimeInput } from "../utils/Helpers";
dotenv.config();

@injectable()
export class ConfigManager {
    private config: any;

    constructor() {
        this.config = this.loadConfig();
    }

    public getConfig() { return this.config; }
    public getStrategyConfig(): StrategyConfig { return this.config.strategy; }
    public getRiskConfig(): RiskParameters { return this.config.risk; }
    public getBacktestConfig(): BacktestConfig { return this.config.backtest; }

    private loadConfig() {
        const timeframe = (process.env.TIMEFRAME || '5m') as KlineInterval;
        const symbols = this.parseSymbols(process.env.SYMBOLS, ['ETHUSDT', 'SOLUSDT']);
        const backtest = this.buildBacktestConfig(timeframe, symbols);

        return {
            apiKey: process.env.BINANCE_API_KEY || '',
            apiSecret: process.env.BINANCE_API_SECRET || '',
            testnet: process.env.BINANCE_USE_TESTNET === 'true',
            exchangeMode: process.env.EXCHANGE_MODE || 'PAPER', // REAL or PAPER
            telegram: {
                token: process.env.TELEGRAM_TOKEN,
                chatId: process.env.TELEGRAM_CHAT_ID
            },
            symbols,
            timeframe,
            backtest,
            strategy: {
                emaFast: 50,
                emaSlow: 200,
                minTrendStrength: 0.02,
                rsiPeriod: 14,
                rsiOverbought: 70,
                rsiOversold: 30,
                volumeSpikeMultiplier: 1.5,
                pullbackToEMA: true,
                maxPullbackDistance: 0.03,
                cvdThreshold: 0.5,
                oiChangeMin: 0.1,
                checkLiquidations: true,
                stopLossATRMultiplier: 1.5,
                takeProfitRatio: 2.5,
                trailingStop: false,
                minVolume: 1000000,
                maxSpread: 0.01,
                btcSyncRequired: false
            } as StrategyConfig,
            risk: {
                accountBalance: parseFloat(process.env.INITIAL_BALANCE || '1000'),
                riskPerTrade: parseFloat(process.env.RISK_PER_TRADE || '0.01'),
                capitalAllocation: parseFloat(process.env.CAPITAL_ALLOCATION || '1'),
                maxOpenTrades: this.parsePositiveInteger(process.env.MAX_OPEN_TRADES, 3),
                leverage: 2,
                maxDailyLoss: 0.05,
                maxDrawdown: 0.35,
                minRR: 1.5
            } as RiskParameters
        };
    }

    private buildBacktestConfig(defaultTimeframe: KlineInterval, symbols: string[]): BacktestConfig {
        const defaultRangeDays = this.parsePositiveNumber(process.env.BACKTEST_RANGE_DAYS, 7);
        const now = Date.now();
        const endTime = process.env.BACKTEST_END
            ? parseTimeInput(process.env.BACKTEST_END)
            : now;
        const startTime = process.env.BACKTEST_START
            ? parseTimeInput(process.env.BACKTEST_START)
            : endTime - defaultRangeDays * 24 * 60 * 60 * 1000;

        if (startTime > endTime) {
            throw new Error("BACKTEST_START cannot be greater than BACKTEST_END.");
        }

        return {
            symbol: process.env.BACKTEST_SYMBOL || symbols[0],
            interval: (process.env.BACKTEST_INTERVAL || defaultTimeframe) as BacktestConfig["interval"],
            useTestnet: process.env.BACKTEST_USE_TESTNET === 'true',
            startTime,
            endTime,
            rangeDays: defaultRangeDays
        };
    }

    private parsePositiveNumber(value: string | undefined, fallback: number): number {
        if (!value) {
            return fallback;
        }

        const parsedValue = Number(value);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
            throw new Error(`Expected a positive number, received: ${value}`);
        }

        return parsedValue;
    }

    private parsePositiveInteger(value: string | undefined, fallback: number): number {
        if (!value) {
            return fallback;
        }

        const parsedValue = Number.parseInt(value, 10);

        if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
            throw new Error(`Expected a positive integer, received: ${value}`);
        }

        return parsedValue;
    }

    private parseSymbols(value: string | undefined, fallback: string[]): string[] {
        if (!value) {
            return fallback;
        }

        const symbols = value
            .split(",")
            .map((symbol) => symbol.trim().toUpperCase())
            .filter(Boolean);

        if (symbols.length === 0) {
            throw new Error("SYMBOLS must contain at least one symbol.");
        }

        return symbols;
    }
}
