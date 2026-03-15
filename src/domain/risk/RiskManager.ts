import { RiskParameters } from "../../core/types/common";
import { PortfolioSnapshot, RiskDecision, StrategySignal, TradeSide } from "../../core/types/trading";

export class RiskManager {
    constructor(private readonly riskParameters: RiskParameters) {}

    public assessSignal(signal: StrategySignal, portfolio: PortfolioSnapshot): RiskDecision {
        if (signal.action !== "enter") {
            return this.reject("Only entry signals can be assessed for position risk.");
        }

        if (!signal.side) {
            return this.reject("Signal side is required for entry risk checks.");
        }

        if (!signal.entryPrice || signal.entryPrice <= 0) {
            return this.reject("Signal entry price must be a positive number.");
        }

        if (portfolio.openTradeCount >= this.riskParameters.maxOpenTrades) {
            return this.reject("Maximum number of open trades reached.");
        }

        if (portfolio.drawdown >= this.riskParameters.maxDrawdown) {
            return this.reject("Maximum drawdown limit reached.");
        }

        if (portfolio.dailyPnl <= -portfolio.equity * this.riskParameters.maxDailyLoss) {
            return this.reject("Maximum daily loss limit reached.");
        }

        const capitalToAllocate = portfolio.equity * this.riskParameters.capitalAllocation * this.riskParameters.leverage;
        const riskAmount = portfolio.equity * this.riskParameters.riskPerTrade;
        const quantity = capitalToAllocate / signal.entryPrice;

        if (!Number.isFinite(quantity) || quantity <= 0) {
            return this.reject("Calculated quantity must be positive.");
        }

        let stopDistance = riskAmount / quantity;

        if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
            return this.reject("Calculated stop distance must be positive.");
        }

        if (signal.stopLossPrice !== undefined) {
            const providedStopDistance = this.getStopDistance(signal.side, signal.entryPrice, signal.stopLossPrice);

            if (!Number.isFinite(providedStopDistance) || providedStopDistance <= 0) {
                return this.reject("Signal stop loss is invalid for the provided side.");
            }

            const estimatedLossAtStop = providedStopDistance * quantity;

            if (estimatedLossAtStop > riskAmount + 1e-8) {
                return this.reject("Signal stop loss exceeds configured risk per trade.");
            }

            stopDistance = providedStopDistance;
        }

        const suggestedStopLossPrice = signal.stopLossPrice ?? this.buildStopLossPrice(signal.side, signal.entryPrice, stopDistance);
        const estimatedLossAtStop = stopDistance * quantity;

        if (signal.takeProfitPrice !== undefined) {
            const reward = this.getRewardDistance(signal.side, signal.entryPrice, signal.takeProfitPrice);
            const rr = reward / stopDistance;

            if (!Number.isFinite(rr) || rr < this.riskParameters.minRR) {
                return this.reject("Signal take profit does not meet minimum risk-reward ratio.");
            }
        }

        return {
            approved: true,
            riskAmount,
            capitalToAllocate,
            quantity,
            entryPrice: signal.entryPrice,
            leverage: this.riskParameters.leverage,
            stopDistance,
            suggestedStopLossPrice,
            estimatedLossAtStop
        };
    }

    private buildStopLossPrice(side: TradeSide, entryPrice: number, stopDistance: number): number {
        return side === "long"
            ? entryPrice - stopDistance
            : entryPrice + stopDistance;
    }

    private getStopDistance(side: TradeSide, entryPrice: number, stopLossPrice: number): number {
        return side === "long"
            ? entryPrice - stopLossPrice
            : stopLossPrice - entryPrice;
    }

    private getRewardDistance(side: TradeSide, entryPrice: number, takeProfitPrice: number): number {
        return side === "long"
            ? takeProfitPrice - entryPrice
            : entryPrice - takeProfitPrice;
    }

    private reject(reason: string): RiskDecision {
        return {
            approved: false,
            reason,
            riskAmount: 0,
            capitalToAllocate: 0,
            quantity: 0,
            entryPrice: 0,
            leverage: this.riskParameters.leverage,
            stopDistance: 0,
            estimatedLossAtStop: 0
        };
    }
}
