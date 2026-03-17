import { Candle, KlineInterval } from "../types/common";

/**
 * Контракт для DataProvider - централизованного источника данных с защитой
 * от look-ahead bias и корректным alignment мульти-таймфреймовых данных.
 */

/** Контекст данных для основного таймфрейма */
export interface PrimaryTimeframeContext {
    symbol: string;
    interval: KlineInterval;
    currentCandle: Candle;
    /** История закрытых свечей, доступных на текущий момент (point-in-time) */
    closedHistory: Candle[];
    /** Полная история включая текущую (незакрытую) свечу */
    fullHistory: Candle[];
}

/** Контекст данных для HTF (Higher Time Frame) */
export interface HigherTimeframeContext {
    symbol: string;
    interval: KlineInterval;
    /** Текущая HTF свеча - может быть незакрытой */
    currentHTFCandle: Candle | null;
    /** Закрытые HTF свечи, доступные на текущий момент */
    closedHTFHistory: Candle[];
    /** Индекс текущей свечи в HTF истории */
    currentIndex: number;
}

/**
 * Результат подготовки данных для стратегии.
 * Гарантирует отсутствие look-ahead bias.
 */
export interface PreparedData {
    primary: PrimaryTimeframeContext;
    /** HTF данные, если запрошены */
    higherTimeframe?: HigherTimeframeContext;
    /** Метаданные для отладки */
    metadata: {
        /** Timestamp, на который подготовлены данные */
        pointInTime: number;
        /** Количество свечей в истории основного TF */
        primaryHistoryLength: number;
        /** Количество закрытых HTF свечей */
        htfClosedCount?: number;
        /** Признак наличия незакрытой HTF свечи */
        htfHasUnclosedCandle?: boolean;
    };
}

/**
 * Опции для HTF alignment
 */
export interface HTFAlignmentOptions {
    /** HTF интервал (например, "1h" для основного "15m") */
    htfInterval: KlineInterval;
    /** Сколько закрытых HTF свечей минимально требуется для валидации */
    minRequiredHistory?: number;
}

/**
 * Контракт DataProvider
 */
export interface DataProviderContract {
    /**
     * Регистрирует символ и таймфрейм для отслеживания.
     * Загружает данные из репозитория.
     */
    registerSymbol(symbol: string, interval: KlineInterval): Promise<void>;

    /**
     * Регистрирует HTF для указанного символа.
     * HTF данные будут автоматически синхронизироваться с основным таймфреймом.
     */
    registerHigherTimeframe(symbol: string, options: HTFAlignmentOptions): Promise<void>;

    /**
     * Получает данные для стратегии на указанный timestamp.
     * ГАРАНТИРУЕТ: стратегия видит только данные, доступные на момент timestamp.
     *
     * @param symbol - символ
     * @param timestamp - текущий timestamp (close time свечи)
     * @returns Подготовленные данные или null если данных недостаточно
     */
    getDataForTimestamp(symbol: string, timestamp: number): PreparedData | null;

    /**
     * Получает историю для расчета индикаторов.
     * ГАРАНТИРУЕТ: возвращает ровно limit свечей, доступных на timestamp.
     */
    getIndicatorHistory(symbol: string, timestamp: number, limit: number): Candle[];

    /**
     * Проверяет, достаточно ли данных для валидации стратегии.
     */
    hasEnoughData(symbol: string, timestamp: number, minHistoryRequired: number): boolean;

    /**
     * Получает все зарегистрированные символы.
     */
    getRegisteredSymbols(): string[];

    /**
     * Получает зарегистрированный таймфрейм для символа.
     */
    getSymbolInterval(symbol: string): KlineInterval | undefined;

    /**
     * Возвращает диапазон доступных данных для символа.
     */
    getAvailableRange(symbol: string): { startTime: number; endTime: number } | null;
}
