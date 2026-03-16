import axios, { AxiosInstance, AxiosResponse } from "axios";
import { injectable } from "inversify";
import { HistoricalKlineRequest } from "../../../core/types/common";
import { BinanceRawKline } from "./BinanceMapper";

type BinanceMarketType = "spot" | "usdm";

// Оптимизировано для скорости: 500 свечей = вес 2 (экономия 60% rate limit vs 1000)
const OPTIMAL_CHUNK_SIZE = 500;
const MAX_CONCURRENT_REQUESTS = 4; // Параллельность для максимальной скорости
const PARALLEL_DELAY_MS = 50; // Минимальная задержка между batch запросами

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;
const DEFAULT_RETRY_MAX_DELAY_MS = 10_000;

// Rate limit защита
const RATE_LIMIT_WARNING_THRESHOLD = 1000; // Начинаем замедляться
const RATE_LIMIT_CRITICAL_THRESHOLD = 1400; // Сильное замедление
const RATE_LIMIT_MAX = 1800; // Максимальный лимит
const RATE_LIMIT_RESET_BUFFER_MS = 2000; // Запас до сброса

const RETRYABLE_STATUS_CODES = new Set([408, 418, 429, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
    "ECONNABORTED",
    "ECONNRESET",
    "EAI_AGAIN",
    "ENETDOWN",
    "ENETRESET",
    "ENETUNREACH",
    "ENOTFOUND",
    "ETIMEDOUT"
]);

const BINANCE_ENDPOINTS: Record<BinanceMarketType, { productionBaseUrl: string; testnetBaseUrl: string; klinesPath: string }> = {
    spot: {
        productionBaseUrl: "https://api.binance.com",
        testnetBaseUrl: "https://testnet.binance.vision",
        klinesPath: "/api/v3/klines"
    },
    usdm: {
        productionBaseUrl: "https://fapi.binance.com",
        testnetBaseUrl: "https://testnet.binancefuture.com",
        klinesPath: "/fapi/v1/klines"
    }
};

export interface BinanceServiceOptions {
    apiKey?: string;
    useTestnet?: boolean;
    timeoutMs?: number;
    marketType?: BinanceMarketType;
    maxRetries?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    maxConcurrentRequests?: number;
    chunkSize?: number;
}

interface NormalizedHistoricalKlineRequest extends HistoricalKlineRequest {
    symbol: string;
    interval: string;
    limit?: number;
}

interface BinanceRequestErrorDetails {
    symbol: string;
    interval: string;
    attempts: number;
    statusCode?: number;
    errorCode?: string;
    retryable: boolean;
    responseBody?: unknown;
}

interface RetryDecision {
    shouldRetry: boolean;
    delayMs: number;
    statusCode?: number;
    errorCode?: string;
    responseBody?: unknown;
}

interface RateLimitState {
    usedWeight: number;
    resetTime: number; // timestamp when limit resets
    lastUpdate: number;
    consecutiveErrors: number;
}

interface ChunkRequest {
    startTime: number;
    endTime?: number;
    limit: number;
    chunkIndex: number;
}

export class BinanceRequestError extends Error {
    constructor(message: string, public readonly details: BinanceRequestErrorDetails) {
        super(message);
        this.name = "BinanceRequestError";
    }
}

@injectable()
export class BinanceService {
    private httpClient: AxiosInstance;
    private readonly klinesPath: string;
    private readonly maxRetries: number;
    private readonly retryBaseDelayMs: number;
    private readonly retryMaxDelayMs: number;
    private readonly maxConcurrentRequests: number;
    private readonly chunkSize: number;
    private readonly httpClientConfig: {
        baseURL: string;
        timeout: number;
        headers?: Record<string, string>;
    };

    // Rate limit state
    private rateLimit: RateLimitState = {
        usedWeight: 0,
        resetTime: 0,
        lastUpdate: 0,
        consecutiveErrors: 0
    };

    constructor(options: BinanceServiceOptions = {}) {
        const marketType = options.marketType ?? "spot";
        const endpoints = BINANCE_ENDPOINTS[marketType];

        this.httpClientConfig = {
            baseURL: options.useTestnet ? endpoints.testnetBaseUrl : endpoints.productionBaseUrl,
            timeout: options.timeoutMs ?? 10000,
            headers: options.apiKey ? { "X-MBX-APIKEY": options.apiKey } : undefined
        };

        this.httpClient = this.createHttpClient();
        this.klinesPath = endpoints.klinesPath;
        this.maxRetries = Math.max(options.maxRetries ?? DEFAULT_MAX_RETRIES, 0);
        this.retryBaseDelayMs = Math.max(options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS, 0);
        this.retryMaxDelayMs = Math.max(options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS, this.retryBaseDelayMs);
        this.maxConcurrentRequests = Math.min(
            Math.max(options.maxConcurrentRequests ?? MAX_CONCURRENT_REQUESTS, 1),
            10
        );
        this.chunkSize = Math.min(
            Math.max(options.chunkSize ?? OPTIMAL_CHUNK_SIZE, 100),
            1000
        );
    }

    /**
     * Загрузка исторических данных с параллельной загрузкой чанков
     * Оптимизировано для максимальной скорости с защитой от rate limit
     */
    public async fetchHistoricalKlines(params: HistoricalKlineRequest): Promise<BinanceRawKline[]> {
        const normalizedRequest = this.normalizeRequest(params);

        // Для малых запросов — простая загрузка
        if (normalizedRequest.limit && normalizedRequest.limit <= this.chunkSize) {
            const klines = await this.fetchKlinesPage(normalizedRequest);
            return this.sortAndDeduplicate(klines);
        }

        // Для больших диапазонов — параллельная загрузка
        if (normalizedRequest.startTime !== undefined) {
            return this.fetchParallelForward(normalizedRequest);
        }

        // Обратная загрузка (без startTime)
        if ((normalizedRequest.limit ?? 0) > this.chunkSize) {
            return this.fetchParallelBackward(normalizedRequest);
        }

        return this.fetchKlinesPage(normalizedRequest);
    }

    /**
     * Получить текущее состояние rate limit
     */
    public getRateLimitStatus(): { used: number; remaining: number; resetInMs: number } {
        const now = Date.now();
        const resetInMs = Math.max(0, this.rateLimit.resetTime - now);
        const remaining = Math.max(0, RATE_LIMIT_MAX - this.rateLimit.usedWeight);

        return {
            used: this.rateLimit.usedWeight,
            remaining,
            resetInMs
        };
    }

    public async fetchKlinesPage(params: HistoricalKlineRequest): Promise<BinanceRawKline[]> {
        const normalizedRequest = this.normalizeRequest(params);

        return this.executeWithRetry(
            () => this.requestKlinesPage(normalizedRequest),
            normalizedRequest
        );
    }

    /**
     * Параллельная загрузка вперед по времени (от startTime)
     */
    private async fetchParallelForward(params: NormalizedHistoricalKlineRequest): Promise<BinanceRawKline[]> {
        const chunks = this.createForwardChunks(params);

        if (chunks.length === 0) {
            return [];
        }

        if (chunks.length === 1) {
            const klines = await this.fetchChunk(params, chunks[0]);
            return this.sortAndDeduplicate(klines);
        }

        this.logParallelDownloadStart(params, chunks.length);

        const allKlines: BinanceRawKline[] = [];
        let completedChunks = 0;

        // Загружаем чанки батчами с защитой от rate limit
        for (let i = 0; i < chunks.length; i += this.maxConcurrentRequests) {
            const batch = chunks.slice(i, i + this.maxConcurrentRequests);

            // Проверяем rate limit перед батчем
            await this.applyDynamicDelay();

            const batchResults = await Promise.all(
                batch.map(chunk =>
                    this.fetchChunk(params, chunk).catch(error => {
                        // Если rate limit — ждем и ретраим
                        if (this.isRateLimitError(error)) {
                            return this.retryWithBackoff(params, chunk, 0);
                        }
                        throw error;
                    })
                )
            );

            for (const klines of batchResults) {
                allKlines.push(...klines);
                completedChunks++;
            }

            // Лог прогресса
            this.logProgress(params, completedChunks, chunks.length, allKlines.length);

            // Минимальная задержка между батчами
            if (i + this.maxConcurrentRequests < chunks.length) {
                await this.sleep(PARALLEL_DELAY_MS);
            }
        }

        return this.sortAndDeduplicate(allKlines);
    }

    /**
     * Последовательная загрузка назад по времени (к endTime).
     * Каждый следующий чанк зависит от earliest openTime предыдущего — параллелизация невозможна.
     */
    private async fetchParallelBackward(params: NormalizedHistoricalKlineRequest): Promise<BinanceRawKline[]> {
        const allKlines: BinanceRawKline[] = [];
        let currentEndTime: number | undefined = params.endTime;
        let remainingLimit = params.limit ?? this.chunkSize;

        while (remainingLimit > 0) {
            const chunkLimit = Math.min(remainingLimit, this.chunkSize);

            await this.applyDynamicDelay();

            const chunk = await this.fetchChunk(params, {
                startTime: undefined,
                endTime: currentEndTime,
                limit: chunkLimit,
                chunkIndex: allKlines.length
            }).catch((error) => {
                if (this.isRateLimitError(error)) {
                    return this.retryWithBackoff(params, {
                        startTime: undefined,
                        endTime: currentEndTime,
                        limit: chunkLimit,
                        chunkIndex: allKlines.length
                    }, 0);
                }
                throw error;
            });

            if (chunk.length === 0) {
                break;
            }

            allKlines.push(...chunk);
            remainingLimit -= chunk.length;

            if (chunk.length < chunkLimit) {
                break;
            }

            const earliestTime = chunk[0][0];
            currentEndTime = earliestTime - 1;

            if (currentEndTime <= 0) {
                break;
            }
        }

        const sorted = this.sortAndDeduplicate(allKlines);
        return params.limit ? sorted.slice(0, params.limit) : sorted;
    }

    private createForwardChunks(params: NormalizedHistoricalKlineRequest): ChunkRequest[] {
        if (params.startTime === undefined) {
            return [];
        }

        const chunks: ChunkRequest[] = [];
        const intervalMs = this.estimateIntervalMs(params.interval);

        // Вычисляем сколько свечей нужно загрузить
        let totalLimit: number;
        if (params.limit) {
            totalLimit = params.limit;
        } else if (params.endTime) {
            // Вычисляем на основе временного диапазона
            const timeRangeMs = params.endTime - params.startTime;
            totalLimit = Math.ceil(timeRangeMs / intervalMs) + 1;
        } else {
            totalLimit = 10000; // Дефолт если ничего не указано
        }

        let currentStartTime = params.startTime;
        let remainingLimit = totalLimit;
        let chunkIndex = 0;

        while (remainingLimit > 0) {
            const chunkLimit = Math.min(remainingLimit, this.chunkSize);
            // Вычисляем конкретный endTime для этого чанка
            const chunkEndTime = currentStartTime + (chunkLimit * intervalMs) - 1;

            // Если задан общий endTime — не выходим за него
            const effectiveEndTime = params.endTime
                ? Math.min(chunkEndTime, params.endTime)
                : chunkEndTime;

            chunks.push({
                startTime: currentStartTime,
                endTime: effectiveEndTime,
                limit: chunkLimit,
                chunkIndex: chunkIndex++
            });

            remainingLimit -= chunkLimit;
            currentStartTime = effectiveEndTime + 1;

            // Предотвращаем бесконечный цикл
            if (chunkIndex > 1000) break;

            // Если достигли endTime — останавливаемся
            if (params.endTime && currentStartTime > params.endTime) {
                break;
            }
        }

        return chunks;
    }

    private async fetchChunk(
        params: NormalizedHistoricalKlineRequest,
        chunk: ChunkRequest
    ): Promise<BinanceRawKline[]> {
        return this.fetchKlinesPage({
            ...params,
            startTime: chunk.startTime,
            endTime: chunk.endTime,
            limit: chunk.limit
        });
    }

    private async retryWithBackoff(
        params: NormalizedHistoricalKlineRequest,
        chunk: ChunkRequest,
        attempt: number
    ): Promise<BinanceRawKline[]> {
        const maxBackoffAttempts = 3;

        if (attempt >= maxBackoffAttempts) {
            throw new Error(`Failed to fetch chunk ${chunk.chunkIndex} after ${maxBackoffAttempts} backoff attempts`);
        }

        // Экспоненциальный backoff для rate limit
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        console.warn(`[binance] Rate limit hit on chunk ${chunk.chunkIndex}, waiting ${delay}ms...`);

        await this.sleep(delay);

        // Сбрасываем rate limit счетчик
        this.rateLimit.consecutiveErrors++;
        this.rateLimit.usedWeight = Math.max(0, this.rateLimit.usedWeight - 10);

        try {
            return await this.fetchChunk(params, chunk);
        } catch (error) {
            return this.retryWithBackoff(params, chunk, attempt + 1);
        }
    }

    /**
     * Динамическая задержка на основе текущего rate limit
     */
    private async applyDynamicDelay(): Promise<void> {
        const status = this.getRateLimitStatus();

        // Если лимит близок — замедляемся
        if (status.remaining < 100) {
            const waitTime = Math.max(status.resetInMs + RATE_LIMIT_RESET_BUFFER_MS, 1000);
            console.warn(`[binance] Rate limit critical (${status.used}/${RATE_LIMIT_MAX}), waiting ${waitTime}ms...`);
            await this.sleep(waitTime);
            this.resetRateLimit();
            return;
        }

        if (status.remaining < 400) {
            // Предупреждение — умеренное замедление
            const delay = 200 + Math.random() * 100;
            await this.sleep(delay);
            return;
        }

        if (this.rateLimit.consecutiveErrors > 2) {
            // После нескольких ошибок — осторожность
            await this.sleep(500);
            this.rateLimit.consecutiveErrors = 0;
        }
    }

    private isRateLimitError(error: unknown): boolean {
        if (!axios.isAxiosError(error)) return false;
        return error.response?.status === 429 || error.response?.status === 418;
    }

    private resetRateLimit(): void {
        this.rateLimit = {
            usedWeight: 0,
            resetTime: Date.now() + 60000,
            lastUpdate: Date.now(),
            consecutiveErrors: 0
        };
    }

    private sortAndDeduplicate(klines: BinanceRawKline[]): BinanceRawKline[] {
        // Сортируем по openTime
        const sorted = klines.sort((a, b) => a[0] - b[0]);

        // Удаляем дубликаты
        const unique: BinanceRawKline[] = [];
        for (const kline of sorted) {
            if (unique.length === 0 || kline[0] > unique[unique.length - 1][0]) {
                unique.push(kline);
            }
        }

        return unique;
    }

    private estimateIntervalMs(interval: string): number {
        const match = interval.match(/^(\d+)([mhdwM])$/);
        if (!match) return 60000; // default 1m

        const [, amount, unit] = match;
        const multipliers: Record<string, number> = {
            m: 60 * 1000,
            h: 60 * 60 * 1000,
            d: 24 * 60 * 60 * 1000,
            w: 7 * 24 * 60 * 60 * 1000,
            M: 30 * 24 * 60 * 60 * 1000
        };

        return parseInt(amount) * (multipliers[unit] || 60000);
    }

    private normalizeRequest(params: HistoricalKlineRequest): NormalizedHistoricalKlineRequest {
        const symbol = params.symbol?.trim().toUpperCase();
        const interval = params.interval?.trim();
        const limit = params.limit !== undefined ? Math.floor(params.limit) : undefined;

        if (!symbol) {
            throw new Error("Binance historical kline request requires a symbol.");
        }

        if (!interval) {
            throw new Error("Binance historical kline request requires an interval.");
        }

        if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
            throw new Error("Binance historical kline request limit must be a positive integer.");
        }

        if (params.startTime !== undefined && params.endTime !== undefined && params.startTime > params.endTime) {
            throw new Error("Binance historical kline request startTime cannot be greater than endTime.");
        }

        return {
            ...params,
            symbol,
            interval,
            limit
        };
    }

    private async requestKlinesPage(params: NormalizedHistoricalKlineRequest): Promise<BinanceRawKline[]> {
        const response: AxiosResponse<BinanceRawKline[]> = await this.httpClient.get(this.klinesPath, {
            params: {
                symbol: params.symbol,
                interval: params.interval,
                startTime: params.startTime,
                endTime: params.endTime,
                limit: Math.min(params.limit ?? this.chunkSize, this.chunkSize)
            }
        });

        // Обновляем rate limit из заголовков
        this.updateRateLimitFromHeaders(response);

        return response.data;
    }

    private updateRateLimitFromHeaders(response: AxiosResponse): void {
        const weightHeader = response.headers['x-mbx-used-weight'];
        const weightHeaderV1 = response.headers['x-mbx-used-weight-1m'];

        if (weightHeader) {
            const weight = parseInt(weightHeader as string, 10);
            if (!isNaN(weight)) {
                this.rateLimit.usedWeight = weight;
                this.rateLimit.lastUpdate = Date.now();
            }
        }

        if (weightHeaderV1) {
            const weight = parseInt(weightHeaderV1 as string, 10);
            if (!isNaN(weight)) {
                this.rateLimit.usedWeight = Math.max(this.rateLimit.usedWeight, weight);
            }
        }

        // Если reset time не установлен или прошел — обновляем
        const now = Date.now();
        if (this.rateLimit.resetTime < now) {
            this.rateLimit.resetTime = now + 60000; // Предполагаем минутный окно
        }
    }

    private async executeWithRetry<T>(
        operation: () => Promise<T>,
        context: NormalizedHistoricalKlineRequest
    ): Promise<T> {
        let retriesUsed = 0;

        while (true) {
            try {
                return await operation();
            } catch (error) {
                const decision = this.getRetryDecision(error, retriesUsed);

                if (!decision.shouldRetry || retriesUsed >= this.maxRetries) {
                    throw this.createRequestError(error, context, retriesUsed + 1, decision);
                }

                retriesUsed += 1;
                await this.sleep(decision.delayMs);
                this.httpClient = this.createHttpClient();
            }
        }
    }

    private getRetryDecision(error: unknown, retriesUsed: number): RetryDecision {
        if (!axios.isAxiosError(error)) {
            return { shouldRetry: false, delayMs: 0 };
        }

        const statusCode = error.response?.status;
        const errorCode = error.code;
        const responseBody = error.response?.data;

        // Особая обработка rate limit
        if (statusCode === 429 || statusCode === 418) {
            const retryAfter = this.getRetryAfterDelayMs(error);
            return {
                shouldRetry: true,
                delayMs: retryAfter ?? Math.min(2000 * Math.pow(2, retriesUsed), 30000),
                statusCode,
                errorCode,
                responseBody
            };
        }

        const retryAfterMs = this.getRetryAfterDelayMs(error);
        const retryable =
            (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) ||
            (errorCode !== undefined && RETRYABLE_NETWORK_ERROR_CODES.has(errorCode));

        if (!retryable) {
            return {
                shouldRetry: false,
                delayMs: 0,
                statusCode,
                errorCode,
                responseBody
            };
        }

        return {
            shouldRetry: true,
            delayMs: retryAfterMs ?? this.getExponentialBackoffDelayMs(retriesUsed),
            statusCode,
            errorCode,
            responseBody
        };
    }

    private getRetryAfterDelayMs(error: unknown): number | undefined {
        if (!axios.isAxiosError(error)) {
            return undefined;
        }

        const retryAfterHeader = error.response?.headers?.["retry-after"];

        if (retryAfterHeader === undefined) {
            return undefined;
        }

        const retryAfterValue = Array.isArray(retryAfterHeader) ? retryAfterHeader[0] : retryAfterHeader;
        const retryAfterSeconds = Number(retryAfterValue);

        if (Number.isFinite(retryAfterSeconds)) {
            return Math.max(retryAfterSeconds * 1000, 0);
        }

        const retryAfterTimestamp = Date.parse(retryAfterValue);

        if (Number.isNaN(retryAfterTimestamp)) {
            return undefined;
        }

        return Math.max(retryAfterTimestamp - Date.now(), 0);
    }

    private getExponentialBackoffDelayMs(retriesUsed: number): number {
        const exponentialDelay = this.retryBaseDelayMs * 2 ** retriesUsed;
        const cappedDelay = Math.min(exponentialDelay, this.retryMaxDelayMs);
        const jitter = Math.floor(cappedDelay * 0.2 * Math.random());

        return cappedDelay + jitter;
    }

    private async sleep(delayMs: number): Promise<void> {
        if (delayMs <= 0) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    private createHttpClient(): AxiosInstance {
        return axios.create(this.httpClientConfig);
    }

    private logParallelDownloadStart(params: NormalizedHistoricalKlineRequest, totalChunks: number): void {
        console.info(
            `[binance] Параллельная загрузка ${params.symbol} ${params.interval}: ${totalChunks} чанков по ${this.chunkSize} свечей (параллелизм: ${this.maxConcurrentRequests})`
        );
    }

    private logProgress(
        params: NormalizedHistoricalKlineRequest,
        completed: number,
        total: number,
        totalKlines: number
    ): void {
        const percent = Math.round((completed / total) * 100);
        const rateStatus = this.getRateLimitStatus();
        console.info(
            `[binance] ${params.symbol} ${params.interval}: ${completed}/${total} чанков (${percent}%) | ${totalKlines} свечей | rate: ${rateStatus.used}/${RATE_LIMIT_MAX}`
        );
    }

    private createRequestError(
        error: unknown,
        context: NormalizedHistoricalKlineRequest,
        attempts: number,
        decision?: RetryDecision
    ): Error {
        if (axios.isAxiosError(error)) {
            const statusCode = decision?.statusCode ?? error.response?.status;
            const errorCode = decision?.errorCode ?? error.code;
            const retryable = decision?.shouldRetry ?? false;
            const responseBody = decision?.responseBody ?? error.response?.data;
            const statusLabel = statusCode !== undefined
                ? `${statusCode}${error.response?.statusText ? ` ${error.response.statusText}` : ""}`
                : errorCode ?? "network error";
            const formattedResponseBody = responseBody !== undefined ? JSON.stringify(responseBody) : "no response body";

            return new BinanceRequestError(
                `Binance request failed for ${context.symbol} ${context.interval} (${statusLabel}) after ${attempts} attempt(s): ${formattedResponseBody}`,
                {
                    symbol: context.symbol,
                    interval: context.interval,
                    attempts,
                    statusCode,
                    errorCode,
                    retryable,
                    responseBody
                }
            );
        }

        if (error instanceof Error) {
            return new BinanceRequestError(
                `Binance request failed for ${context.symbol} ${context.interval} after ${attempts} attempt(s): ${error.message}`,
                {
                    symbol: context.symbol,
                    interval: context.interval,
                    attempts,
                    retryable: false
                }
            );
        }

        return new BinanceRequestError(
            `Binance request failed for ${context.symbol} ${context.interval} after ${attempts} attempt(s): unknown error`,
            {
                symbol: context.symbol,
                interval: context.interval,
                attempts,
                retryable: false
            }
        );
    }
}
