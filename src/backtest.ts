import "reflect-metadata";
process.env.BACKTEST_VERBOSE = "1";

import { ConfigManager } from "./config/ConfigManager";
import { KlineInterval } from "./core/types/common";
import { DatabaseConnection } from "./infrastructure/persistence/DatabaseConnection";
import { SQLiteKlineRepository } from "./infrastructure/persistence/repositories/SQLiteKlineRepository";
import { createContainer } from "./inversify.config";
import { BotRunner } from "./application/BotRunner";
import { BacktestTradeLogger } from "./application/BacktestTradeLogger";
import { HistoricalMarketDataService } from "./core/services/HistoricalMarketDataService";
import { TYPES } from "./core/types/di.types";
import { MigrationService } from "./infrastructure/persistence/MigrationService";
import { SimulationExchange } from "./infrastructure/exchanges/simulation/SimulationExchange";

async function main(): Promise<void> {
    const container = createContainer();
    const configManager = container.get<ConfigManager>(TYPES.ConfigManager);
    const config = configManager.getConfig();
    const backtestConfig = configManager.getBacktestConfig();
    const dbConnection = container.get<DatabaseConnection>(TYPES.DatabaseConnection);

    try {
        const migrationService = container.get<MigrationService>(TYPES.MigrationService);
        migrationService.runMigrations();

        const symbols = process.env.BACKTEST_SYMBOL ? [backtestConfig.symbol] : config.symbols;
        const interval = backtestConfig.interval as KlineInterval;
        const startTime = backtestConfig.startTime;
        const endTime = backtestConfig.endTime;
        const marketDataRepository = container.get<SQLiteKlineRepository>(TYPES.MarketDataRepository);
        const historicalMarketDataService = container.get<HistoricalMarketDataService>(TYPES.HistoricalMarketDataService);
        let totalDownloadedCandles = 0;
        let totalCachedCandles = 0;

        for (const symbol of symbols) {
            const result = await historicalMarketDataService.ensureHistoricalRange({
                symbol,
                interval,
                startTime,
                endTime
            });

            totalDownloadedCandles += result.downloadedCandles;
            totalCachedCandles += result.cachedCandles;
            console.log(`[backtest] ${result.symbol} ${result.interval}`);
            console.log(`[backtest] range ${new Date(result.startTime).toISOString()} -> ${new Date(result.endTime).toISOString()}`);
            console.log(`[backtest] missing ranges: ${result.missingRanges.length}`);
            console.log(`[backtest] downloaded candles: ${result.downloadedCandles}`);
            console.log(`[backtest] cached candles in range: ${result.cachedCandles}`);
        }

        const simulationExchange = container.get<SimulationExchange>(TYPES.SimulationExchange);
        const strategy = container.get<import("./core/interfaces/StrategyContract").StrategyContract>(TYPES.Strategy);
        const portfolioManager = container.get<import("./domain/execution/PortfolioManager").PortfolioManager>(TYPES.PortfolioManager);

        const symbolsList = process.env.BACKTEST_SYMBOL ? [backtestConfig.symbol] : config.symbols;
        const symbolsStr = symbolsList.map((s) => s.replace("USDT", "/USDT")).join(", ");
        const htf = process.env.HTF_TIMEFRAME || "";
        console.log(`\nPeriod: ${new Date(startTime).toISOString().replace("T", " ").slice(0, 19)} -> ${new Date(endTime).toISOString().replace("T", " ").slice(0, 19)}`);
        console.log(`Symbols: ${symbolsStr}`);
        console.log(`Main TF: ${interval}${htf ? ` | HTF: ${htf}` : ""}`);
        console.log(`Strategy: ${strategy.constructor.name}\n`);

        const tradeLogger = container.get<BacktestTradeLogger>(TYPES.BacktestTradeLogger);
        tradeLogger.setStartEquity(portfolioManager.getSnapshot(startTime).equity);

        const botRunner = container.get<BotRunner>(TYPES.BotRunner);
        const runResult = await botRunner.runReplay(
            simulationExchange.streamHistoricalKlines({
                symbols,
                interval,
                startTime,
                endTime
            })
        );
        const snapshot = portfolioManager.getSnapshot(endTime);

        const strat = container.get<{ diagnostics?: Record<string, number> }>(TYPES.Strategy);
        if (strat.diagnostics && process.env.DEBUG_STRATEGY === "1") {
            console.log(`[backtest] strategy diagnostics:`, strat.diagnostics);
        }

        tradeLogger.printSummary(snapshot.equity);

        console.log(`\n[backtest] pipeline candles processed: ${runResult.processedCandles}`);
        console.log(`[backtest] pipeline orders executed: ${runResult.executedOrders}`);
    } finally {
        dbConnection.close();
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
