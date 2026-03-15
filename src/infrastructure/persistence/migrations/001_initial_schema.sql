-- Кеш исторических свечей (для ускорения бэктестов и старта)
CREATE TABLE IF NOT EXISTS historical_candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    takerBuyBaseVolume REAL DEFAULT 0,
    openInterest REAL DEFAULT 0,
    UNIQUE(symbol, timeframe, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_candles_lookup ON historical_candles(symbol, timeframe, timestamp);