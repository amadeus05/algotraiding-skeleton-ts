import "reflect-metadata";
import { renderBacktestReport } from "./application/BacktestReporter";
import { BotRunner } from "./application/BotRunner";
import { ConfigManager } from "./config/ConfigManager";
import { KlineInterval } from "./core/types/common";
import { HistoricalMarketDataService } from "./core/services/HistoricalMarketDataService";
import { TYPES } from "./core/types/di.types";
import { PortfolioManager } from "./domain/execution/PortfolioManager";
import { DatabaseConnection } from "./infrastructure/persistence/DatabaseConnection";
import { SimulationExchange } from "./infrastructure/exchanges/simulation/SimulationExchange";
import { MigrationService } from "./infrastructure/persistence/MigrationService";
import { createContainer } from "./inversify.config";

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
        const historicalMarketDataService = container.get<HistoricalMarketDataService>(TYPES.HistoricalMarketDataService);

        const htfTimeframe = backtestConfig.htfTimeframe;

        for (const symbol of symbols) {
            await historicalMarketDataService.ensureHistoricalRange({
                symbol,
                interval,
                startTime,
                endTime
            });
            if (htfTimeframe && htfTimeframe !== interval) {
                await historicalMarketDataService.ensureHistoricalRange({
                    symbol,
                    interval: htfTimeframe,
                    startTime,
                    endTime
                });
            }
        }

        const simulationExchange = container.get<SimulationExchange>(TYPES.SimulationExchange);
        const botRunner = container.get<BotRunner>(TYPES.BotRunner);
        const portfolioManager = container.get<PortfolioManager>(TYPES.PortfolioManager);
        const runResult = await botRunner.runReplay(
            simulationExchange.streamHistoricalKlines({
                symbols,
                interval,
                startTime,
                endTime
            })
        );
        const snapshot = portfolioManager.getSnapshot(endTime);
        const higherTimeframe = backtestConfig.htfTimeframe;

        console.log("");
        console.log(renderBacktestReport({
            startTime,
            endTime,
            symbols,
            mainTimeframe: interval,
            higherTimeframe,
            initialBalance: config.risk.accountBalance,
            finalBalance: snapshot.balance,
            finalEquity: snapshot.equity,
            totalFees: portfolioManager.getTotalFeesPaid(),
            maxDrawdown: portfolioManager.getMaxDrawdown(),
            closedTrades: portfolioManager.getClosedTrades(),
            runResult
        }));
    } finally {
        dbConnection.close();
    }
}

main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
});
