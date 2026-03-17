import "reflect-metadata";
import { ConfigManager } from "./config/ConfigManager";
import { KlineInterval } from "./core/types/common";
import { DatabaseConnection } from "./infrastructure/persistence/DatabaseConnection";
import { SQLiteKlineRepository } from "./infrastructure/persistence/repositories/SQLiteKlineRepository";
import { createContainer } from "./inversify.config";
import { BotRunner } from "./application/BotRunner";
import { HistoricalMarketDataService } from "./core/services/HistoricalMarketDataService";
import { TYPES } from "./core/types/di.types";
import { MigrationService } from "./infrastructure/persistence/MigrationService";
import { SimulationExchange } from "./infrastructure/exchanges/simulation/SimulationExchange";
import { DataProvider } from "./infrastructure/data/DataProvider";

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

        // Инициализация DataProvider для защиты от look-ahead bias
        const dataProvider = container.get<DataProvider>(TYPES.DataProvider);
        const strategy = container.get<import("./core/interfaces/StrategyContract").StrategyContract>(TYPES.Strategy);

        for (const symbol of symbols) {
            // Регистрируем основной таймфрейм
            await dataProvider.registerSymbol(symbol, interval);

            // Регистрируем HTF если стратегия его требует
            const htfInterval = strategy.higherTimeframeInterval?.();
            if (htfInterval) {
                await dataProvider.registerHigherTimeframe(symbol, {
                    htfInterval,
                    minRequiredHistory: 10
                });
            }
        }

        // Передаем DataProvider в BotRunner
        const simulationExchange = container.get<SimulationExchange>(TYPES.SimulationExchange);
        const botRunner = container.get<BotRunner>(TYPES.BotRunner);
        botRunner.setDataProvider(dataProvider);

        const portfolioManager = container.get<import("./domain/execution/PortfolioManager").PortfolioManager>(TYPES.PortfolioManager);
        const runResult = await botRunner.runReplay(
            simulationExchange.streamHistoricalKlines({
                symbols,
                interval,
                startTime,
                endTime
            })
        );
        const snapshot = portfolioManager.getSnapshot(endTime);

        console.log(`[backtest] symbols replayed: ${symbols.join(", ")}`);
        console.log(`[backtest] total cached candles: ${totalCachedCandles}`);
        console.log(`[backtest] total downloaded candles: ${totalDownloadedCandles}`);
        console.log(`[backtest] pipeline candles processed: ${runResult.processedCandles}`);
        console.log(`[backtest] pipeline orders executed: ${runResult.executedOrders}`);
        console.log(`[backtest] ending balance: ${snapshot.balance}`);
        console.log(`[backtest] ending equity: ${snapshot.equity}`);
    } finally {
        dbConnection.close();
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
