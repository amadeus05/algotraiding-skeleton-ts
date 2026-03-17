import { ExecutionPlan, PendingOrder } from "../../core/types/trading";

interface QueueOptions {
    /** Interval in milliseconds between candles */
    intervalMs: number;
}

export interface ExecutableOrder {
    pendingOrderId: string;
    plan: ExecutionPlan;
}

/**
 * Manages pending orders for backtest execution.
 * Ensures orders are executed at the open of the next candle to avoid look-ahead bias.
 */
export class PendingOrdersQueue {
    private readonly orders = new Map<string, PendingOrder>();
    private readonly intervalMs: number;
    private idCounter = 0;

    constructor(options: QueueOptions) {
        this.intervalMs = options.intervalMs;
    }

    /**
     * Adds an execution plan to the queue for execution on the next candle's open.
     * @param plan - The execution plan to queue
     * @param currentCandleCloseTime - The timestamp when the current candle closes (also when next opens)
     * @returns The created pending order
     */
    public queueForNextOpen(plan: ExecutionPlan, currentCandleCloseTime: number): PendingOrder {
        const id = this.generateId();
        const pendingOrder: PendingOrder = {
            id,
            plan,
            createdAt: currentCandleCloseTime,
            targetCandleOpenTime: currentCandleCloseTime + this.intervalMs
        };

        this.orders.set(id, pendingOrder);
        return pendingOrder;
    }

    /**
     * Gets all orders that should be executed at the given candle's open.
     * These are orders that were queued on the previous candle.
     * @param candleOpenTime - The open time of the current candle
     * @returns Array of executable orders
     */
    public getExecutableOrders(candleOpenTime: number): ExecutableOrder[] {
        const executable: ExecutableOrder[] = [];

        for (const [id, order] of this.orders) {
            if (order.targetCandleOpenTime === candleOpenTime) {
                executable.push({
                    pendingOrderId: id,
                    plan: order.plan
                });
            }
        }

        return executable;
    }

    /**
     * Removes a pending order from the queue after execution.
     * @param orderId - The ID of the pending order to remove
     */
    public remove(orderId: string): void {
        this.orders.delete(orderId);
    }

    /**
     * Clears all pending orders.
     */
    public clear(): void {
        this.orders.clear();
    }

    /**
     * Gets the count of pending orders.
     */
    public get pendingCount(): number {
        return this.orders.size;
    }

    /**
     * Gets all pending orders (for inspection/debugging).
     */
    public getPendingOrders(): PendingOrder[] {
        return Array.from(this.orders.values());
    }

    private generateId(): string {
        this.idCounter += 1;
        return `pending-${Date.now()}-${this.idCounter}`;
    }
}
