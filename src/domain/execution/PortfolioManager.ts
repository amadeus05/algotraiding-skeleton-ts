import { ClosedTrade, ExecutedOrder, PortfolioSnapshot, Position } from "../../core/types/trading";

interface RealizedChangeEvent {
    timestamp: number;
    amount: number;
}

export class PortfolioManager {
    private balance: number;
    private realizedPnl = 0;
    private totalFeesPaid = 0;
    private readonly positions = new Map<string, Position>();
    private readonly closedTrades: ClosedTrade[] = [];
    private readonly realizedChanges: RealizedChangeEvent[] = [];
    private peakEquity: number;
    private maxDrawdown = 0;

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

        return { ...position };
    }

    public updateMarketPrice(symbol: string, price: number, timestamp = Date.now()): void {
        const position = this.positions.get(symbol);

        if (!position) {
            return;
        }

        position.currentPrice = price;
        position.updatedAt = timestamp;
    }

    public getClosedTrades(): ClosedTrade[] {
        return this.closedTrades.map((trade) => ({ ...trade }));
    }

    public getTotalFeesPaid(): number {
        return this.totalFeesPaid;
    }

    public getMaxDrawdown(): number {
        return this.maxDrawdown;
    }

    public applyExecution(order: ExecutedOrder): void {
        const fees = order.fees ?? 0;

        if (order.action === "open") {
            this.openPosition(order, fees);
            return;
        }

        this.closePosition(order, fees);
    }

    public getSnapshot(now = Date.now()): PortfolioSnapshot {
        const positions = Array.from(this.positions.values()).map((position) => ({ ...position }));
        const unrealizedPnl = positions.reduce((sum, position) => sum + this.calculateUnrealizedPnl(position), 0);
        const equity = this.balance + unrealizedPnl;

        this.peakEquity = Math.max(this.peakEquity, equity);
        const drawdown = this.peakEquity === 0 ? 0 : (this.peakEquity - equity) / this.peakEquity;
        this.maxDrawdown = Math.max(this.maxDrawdown, drawdown);

        return {
            balance: this.balance,
            equity,
            realizedPnl: this.realizedPnl,
            unrealizedPnl,
            dailyPnl: this.getDailyPnl(now),
            drawdown,
            openTradeCount: positions.length,
            positions
        };
    }

    private openPosition(order: ExecutedOrder, fees: number): void {
        if (this.positions.has(order.symbol)) {
            throw new Error(`Position for ${order.symbol} is already open.`);
        }

        this.totalFeesPaid += fees;
        this.balance -= fees;
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
            feesPaid: fees
        });
    }

    private closePosition(order: ExecutedOrder, fees: number): void {
        const position = this.positions.get(order.symbol);

        if (!position) {
            throw new Error(`Position for ${order.symbol} is not open.`);
        }

        const grossPnl = position.side === "long"
            ? (order.price - position.entryPrice) * position.quantity
            : (position.entryPrice - order.price) * position.quantity;
        const realizedChange = grossPnl - fees;
        const entryFees = position.feesPaid;
        const totalFees = entryFees + fees;
        const netPnl = grossPnl - totalFees;
        const notional = position.entryPrice * position.quantity;
        const margin = position.leverage > 0 ? notional / position.leverage : notional;
        const pnlPercent = margin > 0 ? (netPnl / margin) * 100 : 0;
        const closeReason = typeof order.metadata?.closeReason === "string"
            ? order.metadata.closeReason
            : "Signal exit";

        this.totalFeesPaid += fees;
        this.balance += realizedChange;
        this.realizedPnl += realizedChange;
        this.realizedChanges.push({ timestamp: order.timestamp, amount: realizedChange });
        this.closedTrades.push({
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity,
            leverage: position.leverage,
            entryPrice: position.entryPrice,
            exitPrice: order.price,
            openedAt: position.openedAt,
            closedAt: order.timestamp,
            notional,
            margin,
            grossPnl,
            netPnl,
            pnlPercent,
            entryFees,
            exitFees: fees,
            totalFees,
            closeReason
        });
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
