import { Candle, KlineInterval } from "../types/common";
import { PortfolioSnapshot, Position, StrategySignal } from "../types/trading";

/**
 * Базовый контекст стратегии - минимально необходимые данные.
 * DataProvider гарантирует отсутствие look-ahead bias в этих данных.
 */
export interface StrategyContext {
    symbol: string;
    /** Основной таймфрейм стратегии */
    timeframe: KlineInterval;
    /** Текущая свеча - может быть незакрытой в реальном времени */
    candle: Candle;
    /** История закрытых свечей - гарантированно доступна на текущий момент */
    history: Candle[];
    /** Снапшот портфеля на текущий момент */
    portfolio: PortfolioSnapshot;
    /** Открытая позиция для этого символа, если есть */
    position?: Position;
}

/**
 * Расширенный контекст для мульти-таймфреймовых стратегий.
 * HTF данные синхронизированы и без look-ahead bias.
 */
export interface MultiTimeframeContext extends StrategyContext {
    /** HTF данные, если стратегия их запрашивает */
    htf?: {
        interval: KlineInterval;
        /** Текущая HTF свеча - может быть незакрытой */
        currentCandle: Candle | null;
        /** История закрытых HTF свечей */
        history: Candle[];
        /** Индекс текущей свечи в HTF истории */
        currentIndex: number;
    };
}

/**
 * Метаданные execution для стратегии.
 * Помогают стратегии адаптироваться к условиям исполнения.
 */
export interface ExecutionMetadata {
    /** true для бэктеста, false для live trading */
    isBacktest: boolean;
    /** Execution timing для новых позиций */
    defaultExecutionTiming: "immediate" | "next_open";
    /** Временная метка текущего события */
    currentTimestamp: number;
}

/**
 * Полный контекст стратегии с метаданными.
 * Используется при вызове strategy.evaluate().
 */
export interface FullStrategyContext extends MultiTimeframeContext {
    execution: ExecutionMetadata;
}

/**
 * Контракт стратегии.
 * Стратегия должна быть чистой функцией без side effects.
 */
export interface StrategyContract {
    /**
     * Оценивает рыночные условия и возвращает сигнал.
     *
     * ГАРАНТИИ от DataProvider:
     * - history содержит только данные, доступные на currentTimestamp
     * - htf.history содержит только закрытые HTF свечи
     * - currentCandle может быть незакрытой (в live) или закрытой (в бэктесте)
     *
     * @param context - полный контекст с данными и метаданными
     * @returns Signal с action: "enter" | "exit" | "hold"
     */
    evaluate(context: FullStrategyContext): StrategySignal;

    /**
     * Минимальное количество свечей в истории, необходимое для работы.
     * DataProvider использует это для валидации перед вызовом evaluate().
     */
    minHistoryRequired(): number;

    /**
     * HTF интервал, если стратегия использует мульти-таймфрейм.
     * DataProvider автоматически подготовит HTF данные.
     */
    higherTimeframeInterval?(): KlineInterval | undefined;

    /**
     * Минимальное количество HTF свечей, необходимое для работы индикаторов.
     * Должно быть не меньше максимального окна HTF-индикаторов с запасом.
     * Например, если HTF использует EMA20, то вернуть хотя бы 30-50.
     * Если не указано, используется значение по умолчанию.
     */
    higherTimeframeMinHistory?(): number;
}
