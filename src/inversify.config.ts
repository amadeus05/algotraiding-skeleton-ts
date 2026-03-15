import "reflect-metadata";
import { Container } from "inversify";
import { BotRunner } from "./application/BotRunner";
import { ConfigManager } from "./config/ConfigManager";
import { StrategyContract } from "./core/interfaces/StrategyContract";
import { HistoricalMarketDataService } from "./core/services/HistoricalMarketDataService";
import { TYPES } from "./core/types/di.types";
import { ExecutionPlanner } from "./domain/execution/ExecutionPlanner";
import { PortfolioManager } from "./domain/execution/PortfolioManager";
import { RiskManager } from "./domain/risk/RiskManager";
import { DualStrategy } from "./domain/strategy/DualStrategy";
import { BinanceAdapter } from "./infrastructure/exchanges/binance/BinanceAdapter";
import { BinanceService } from "./infrastructure/exchanges/binance/BinanceService";
import { SimulationExchange } from "./infrastructure/exchanges/simulation/SimulationExchange";
import { SimulatedExecutionEngine } from "./infrastructure/execution/SimulatedExecutionEngine";
import { ConsoleNotifier } from "./infrastructure/notifiers/ConsoleNotifier";
import { DatabaseConnection } from "./infrastructure/persistence/DatabaseConnection";
import { MigrationService } from "./infrastructure/persistence/MigrationService";
import { SQLiteKlineRepository } from "./infrastructure/persistence/repositories/SQLiteKlineRepository";

export function createContainer(): Container {
    const container = new Container({ defaultScope: "Singleton" });

    container.bind<ConfigManager>(TYPES.ConfigManager).to(ConfigManager).inSingletonScope();
    container.bind<DatabaseConnection>(TYPES.DatabaseConnection).to(DatabaseConnection).inSingletonScope();

    container.bind<MigrationService>(TYPES.MigrationService).toDynamicValue(() =>
        new MigrationService(container.get<DatabaseConnection>(TYPES.DatabaseConnection))
    ).inSingletonScope();

    container.bind<BinanceService>(TYPES.BinanceService).toDynamicValue(() => {
        const configManager = container.get<ConfigManager>(TYPES.ConfigManager);
        const config = configManager.getConfig();
        const backtestConfig = configManager.getBacktestConfig();

        return new BinanceService({
            apiKey: config.apiKey,
            useTestnet: backtestConfig.useTestnet
        });
    }).inSingletonScope();

    container.bind<BinanceAdapter>(TYPES.BinanceAdapter).toDynamicValue(() =>
        new BinanceAdapter(container.get<BinanceService>(TYPES.BinanceService))
    ).inSingletonScope();

    container.bind<SQLiteKlineRepository>(TYPES.MarketDataRepository).toDynamicValue(() =>
        new SQLiteKlineRepository(container.get<DatabaseConnection>(TYPES.DatabaseConnection))
    ).inSingletonScope();

    container.bind<HistoricalMarketDataService>(TYPES.HistoricalMarketDataService).toDynamicValue(() =>
        new HistoricalMarketDataService(
            container.get<BinanceAdapter>(TYPES.BinanceAdapter),
            container.get<SQLiteKlineRepository>(TYPES.MarketDataRepository)
        )
    ).inSingletonScope();

    container.bind<SimulationExchange>(TYPES.SimulationExchange).toDynamicValue(() =>
        new SimulationExchange(container.get<SQLiteKlineRepository>(TYPES.MarketDataRepository))
    ).inSingletonScope();

    container.bind<StrategyContract>(TYPES.Strategy).toDynamicValue(() => {
        const configManager = container.get<ConfigManager>(TYPES.ConfigManager);
        const strategyConfig = configManager.getStrategyConfig();
        return new DualStrategy(strategyConfig);
    }).inSingletonScope();

    container.bind<RiskManager>(TYPES.RiskManager).toDynamicValue(() => {
        const configManager = container.get<ConfigManager>(TYPES.ConfigManager);
        return new RiskManager(configManager.getRiskConfig());
    }).inSingletonScope();

    container.bind<ExecutionPlanner>(TYPES.ExecutionPlanner).toDynamicValue(() => {
        const configManager = container.get<ConfigManager>(TYPES.ConfigManager);
        const strategyConfig = configManager.getStrategyConfig();
        // Use long takeProfitRR as default (strategies now compute their own take-profit)
        const defaultTakeProfitRatio = strategyConfig.long?.takeProfitRR ?? 2.0;
        return new ExecutionPlanner({
            defaultTakeProfitRatio
        });
    }).inSingletonScope();

    container.bind<SimulatedExecutionEngine>(TYPES.ExecutionEngine).toDynamicValue(() =>
        new SimulatedExecutionEngine()
    ).inSingletonScope();

    container.bind<PortfolioManager>(TYPES.PortfolioManager).toDynamicValue(() => {
        const configManager = container.get<ConfigManager>(TYPES.ConfigManager);
        return new PortfolioManager(configManager.getRiskConfig().accountBalance);
    }).inSingletonScope();

    container.bind<ConsoleNotifier>(TYPES.Notifier).toDynamicValue(() =>
        new ConsoleNotifier()
    ).inSingletonScope();

    container.bind<BotRunner>(TYPES.BotRunner).toDynamicValue(() =>
        new BotRunner(
            container.get<StrategyContract>(TYPES.Strategy),
            container.get<RiskManager>(TYPES.RiskManager),
            container.get<ExecutionPlanner>(TYPES.ExecutionPlanner),
            container.get<SimulatedExecutionEngine>(TYPES.ExecutionEngine),
            container.get<PortfolioManager>(TYPES.PortfolioManager),
            container.get<ConsoleNotifier>(TYPES.Notifier)
        )
    ).inTransientScope();

    return container;
}
