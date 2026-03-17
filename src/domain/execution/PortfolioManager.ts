import { ExecutedOrder, PortfolioSnapshot, Position } from "../../core/types/trading";

interface RealizedChangeEvent {
    timestamp: number;
    amount: number;
}

interface InternalPosition extends Position {
    reservedMargin: number;
}

export class PortfolioManager {
    /** Free cash: не зарезервировано под margin. */
    private balance: number;
    private realizedPnl = 0;
    private readonly positions = new Map<string, InternalPosition>();
    private readonly realizedChanges: RealizedChangeEvent[] = [];
    private peakEquity: number;

    constructor(initialBalance: number) {
        if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
            throw new Error("Initial balance must be a positive number.");
        }

        this.balance = initialBalance;
        this.peakEquity = initialBalance;
    }

    public hasOpenPosition(symbol: string): boolean {
        return this.positions.has(symbol);
    }

    public getPosition(symbol: string): Position | undefined {
        const position = this.positions.get(symbol);

        if (!position) {
            return undefined;
        }

        const { reservedMargin: _, ...publicPosition } = position;
        return { ...publicPosition };
    }

    public updateMarketPrice(symbol: string, price: number, timestamp = Date.now()): void {
        const position = this.positions.get(symbol);

        if (!position) {
            return;
        }

        position.currentPrice = price;
        position.updatedAt = timestamp;
    }

    public applyExecution(order: ExecutedOrder): void {
        this.validateOrder(order);

        const fees = order.fees ?? 0;

        if (order.action === "open") {
            this.openPosition(order, fees);
            return;
        }

        this.closePosition(order, fees);
    }

    public getSnapshot(now = Date.now()): PortfolioSnapshot {
        const positions = Array.from(this.positions.values()).map((p) => {
            const { reservedMargin: _, ...pub } = p;
            return { ...pub };
        });
        const unrealizedPnl = positions.reduce((sum, position) => sum + this.calculateUnrealizedPnl(position), 0);
        const usedMargin = Array.from(this.positions.values()).reduce((sum, p) => sum + p.reservedMargin, 0);
        const equity = this.balance + usedMargin + unrealizedPnl;
        const availableBalance = this.balance;

        this.peakEquity = Math.max(this.peakEquity, equity);

        return {
            balance: this.balance,
            equity,
            usedMargin,
            availableBalance,
            realizedPnl: this.realizedPnl,
            unrealizedPnl,
            dailyPnl: this.getDailyPnl(now),
            drawdown: this.peakEquity === 0 ? 0 : (this.peakEquity - equity) / this.peakEquity,
            openTradeCount: positions.length,
            positions
        };
    }

    private validateOrder(order: ExecutedOrder): void {
        if (!Number.isFinite(order.price) || order.price <= 0) {
            throw new Error(`Invalid order price: ${order.price}`);
        }

        if (!Number.isFinite(order.quantity) || order.quantity <= 0) {
            throw new Error(`Invalid order quantity: ${order.quantity}`);
        }

        if (order.action === "open") {
            if (this.positions.has(order.symbol)) {
                throw new Error(`Position for ${order.symbol} is already open.`);
            }
        } else {
            if (!this.positions.has(order.symbol)) {
                throw new Error(`Position for ${order.symbol} is not open.`);
            }
        }
    }

    private openPosition(order: ExecutedOrder, fees: number): void {
        const leverage = Math.max(order.leverage, 1);
        const requiredMargin = (order.quantity * order.price) / leverage;

        const epsilon = 10.0; // Допуск на проскальзывание и округление
        if (this.balance + epsilon < requiredMargin + fees) {
            throw new Error(
                `Insufficient balance: required margin ${requiredMargin} + fees ${fees}, available ${this.balance}`
            );
        }

        this.balance -= requiredMargin + fees;
        this.realizedPnl -= fees;
        this.realizedChanges.push({ timestamp: order.timestamp, amount: -fees });

        this.positions.set(order.symbol, {
            symbol: order.symbol,
            side: order.side,
            quantity: order.quantity,
            entryPrice: order.price,
            currentPrice: order.price,
            leverage: order.leverage,
            stopLossPrice: order.stopLossPrice,
            takeProfitPrice: order.takeProfitPrice,
            openedAt: order.timestamp,
            updatedAt: order.timestamp,
            feesPaid: fees,
            reservedMargin: requiredMargin
        });
    }

    private closePosition(order: ExecutedOrder, fees: number): void {
        const position = this.positions.get(order.symbol)!;

        if (order.quantity !== position.quantity) {
            throw new Error(
                `Close quantity mismatch: order ${order.quantity}, position ${position.quantity}`
            );
        }

        const grossPnl =
            position.side === "long"
                ? (order.price - position.entryPrice) * position.quantity
                : (position.entryPrice - order.price) * position.quantity;
        const realizedChange = grossPnl - fees;

        this.balance += position.reservedMargin + realizedChange;
        this.realizedPnl += realizedChange;
        this.realizedChanges.push({ timestamp: order.timestamp, amount: realizedChange });
        this.positions.delete(order.symbol);
    }

    private calculateUnrealizedPnl(position: Position): number {
        return position.side === "long"
            ? (position.currentPrice - position.entryPrice) * position.quantity
            : (position.entryPrice - position.currentPrice) * position.quantity;
    }

    private getDailyPnl(now: number): number {
        const targetDay = new Date(now).toISOString().slice(0, 10);

        return this.realizedChanges
            .filter((change) => new Date(change.timestamp).toISOString().slice(0, 10) === targetDay)
            .reduce((sum, change) => sum + change.amount, 0);
    }
}
