export const TYPES = {
    ConfigManager: Symbol.for("ConfigManager"),
    Exchange: Symbol.for("Exchange"),
    BinanceService: Symbol.for("BinanceService"),
    BinanceAdapter: Symbol.for("BinanceAdapter"),
    DatabaseConnection: Symbol.for("DatabaseConnection"),
    MigrationService: Symbol.for("MigrationService"),
    MarketDataRepository: Symbol.for("MarketDataRepository"),
    HistoricalMarketDataService: Symbol.for("HistoricalMarketDataService"),
    SimulationExchange: Symbol.for("SimulationExchange"),
    /** DataProvider - централизованный источник данных с защитой от look-ahead bias */
    DataProvider: Symbol.for("DataProvider"),
    Strategy: Symbol.for("Strategy"),
    RiskManager: Symbol.for("RiskManager"),
    ExecutionPlanner: Symbol.for("ExecutionPlanner"),
    ExecutionEngine: Symbol.for("ExecutionEngine"),
    PortfolioManager: Symbol.for("PortfolioManager"),
    Notifier: Symbol.for("Notifier"),
    BotRunner: Symbol.for("BotRunner")
} as const;
