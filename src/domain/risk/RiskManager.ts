import { RiskParameters } from "../../core/types/common";
import { PortfolioSnapshot, RiskDecision, StrategySignal, TradeSide } from "../../core/types/trading";

export class RiskManager {
    constructor(private readonly riskParameters: RiskParameters) {}

    public assessSignal(signal: StrategySignal, portfolio: PortfolioSnapshot): RiskDecision {
        if (signal.action !== "enter") {
            return this.reject("Only entry signals can be assessed for position risk.");
        }

        if (signal.side !== "long" && signal.side !== "short") {
            return this.reject("Signal side must be 'long' or 'short'.");
        }

        if (
            signal.entryPrice === undefined ||
            signal.entryPrice === null ||
            !Number.isFinite(signal.entryPrice) ||
            signal.entryPrice <= 0
        ) {
            return this.reject("Signal entry price must be a positive finite number.");
        }

        if (portfolio.openTradeCount >= this.riskParameters.maxOpenTrades) {
            return this.reject("Maximum number of open trades reached.");
        }

        if (portfolio.drawdown >= this.riskParameters.maxDrawdown) {
            return this.reject("Maximum drawdown limit reached.");
        }

        const maxDailyLossAmount = portfolio.equity * this.riskParameters.maxDailyLoss;
        if (portfolio.dailyPnl <= -maxDailyLossAmount - 1e-10) {
            return this.reject("Maximum daily loss limit reached.");
        }

        const availableBalance = portfolio.availableBalance;
        if (!Number.isFinite(availableBalance) || availableBalance <= 0) {
            return this.reject("No available capital for a new position.");
        }

        const leverage = Math.max(this.riskParameters.leverage, 1);
        const capitalAllocation = this.riskParameters.capitalAllocation;
        if (!Number.isFinite(capitalAllocation) || capitalAllocation <= 0) {
            return this.reject("Capital allocation must be positive.");
        }

        const riskPerTrade = this.riskParameters.riskPerTrade;
        if (!Number.isFinite(riskPerTrade) || riskPerTrade <= 0) {
            return this.reject("Risk per trade must be positive.");
        }

        const maxMarginToAllocate = availableBalance * capitalAllocation;
        const maxNotional = maxMarginToAllocate * leverage;
        const quantity = maxNotional / signal.entryPrice;

        if (!Number.isFinite(quantity) || quantity <= 0) {
            return this.reject("Calculated quantity must be positive.");
        }

        const riskAmount = portfolio.equity * riskPerTrade;
        let stopDistance = riskAmount / quantity;

        if (!Number.isFinite(stopDistance) || stopDistance <= 0) {
            return this.reject("Calculated stop distance must be positive.");
        }

        if (signal.stopLossPrice !== undefined) {
            const stopDistanceFromSignal = this.getStopDistance(
                signal.side,
                signal.entryPrice,
                signal.stopLossPrice
            );

            if (!Number.isFinite(stopDistanceFromSignal) || stopDistanceFromSignal <= 0) {
                return this.reject("Signal stop loss is invalid for the provided side.");
            }

            const lossAtStop = stopDistanceFromSignal * quantity;
            if (lossAtStop > riskAmount + 1e-8) {
                return this.reject("Signal stop loss exceeds configured risk per trade.");
            }

            stopDistance = stopDistanceFromSignal;
        }

        const suggestedStopLossPrice =
            signal.stopLossPrice ?? this.buildStopLossPrice(signal.side, signal.entryPrice, stopDistance);
        const estimatedLossAtStop = stopDistance * quantity;

        if (!Number.isFinite(suggestedStopLossPrice) || suggestedStopLossPrice <= 0) {
            return this.reject("Calculated stop loss price is invalid.");
        }

        if (signal.takeProfitPrice !== undefined) {
            const rewardDistance = this.getRewardDistance(
                signal.side,
                signal.entryPrice,
                signal.takeProfitPrice
            );

            if (!Number.isFinite(rewardDistance) || rewardDistance <= 0) {
                return this.reject("Signal take profit is invalid for the provided side.");
            }

            const rr = rewardDistance / stopDistance;
            if (rr < this.riskParameters.minRR - 1e-10) {
                return this.reject("Signal take profit does not meet minimum risk-reward ratio.");
            }
        }

        const requiredMargin = (quantity * signal.entryPrice) / leverage;
        if (requiredMargin > availableBalance + 1e-8) {
            return this.reject("Insufficient available balance for required margin.");
        }

        return {
            approved: true,
            riskAmount,
            capitalToAllocate: requiredMargin,
            quantity,
            entryPrice: signal.entryPrice,
            leverage,
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
            leverage: Math.max(this.riskParameters.leverage, 1),
            stopDistance: 0,
            estimatedLossAtStop: 0
        };
    }
}
