import { StrategySignal, PortfolioSnapshot, RiskDecision, ExecutionPlan, ClosedKlineEvent } from "../../core/types/trading";
import { Candle } from "../../core/types/common";
import { RiskManager } from "../risk/RiskManager";
import { ExecutionPlanner } from "./ExecutionPlanner";

export interface SignalEvaluation {
    event: ClosedKlineEvent;
    candle: Candle;
    history: Candle[];
    signal: StrategySignal;
}

export interface EvaluatedSignal {
    evaluation: SignalEvaluation;
    riskDecision: RiskDecision;
    executionPlan?: ExecutionPlan;
    priorityScore: number;
}

export interface BatchProcessingResult {
    approvedEvaluations: EvaluatedSignal[];
    rejectedEvaluations: EvaluatedSignal[];
}

/**
 * Processes signals in batch to eliminate ordering bias between symbols
 * at the same timestamp. All signals are evaluated against the SAME portfolio
 * snapshot, and portfolio limits are applied fairly across all symbols.
 */
export class SignalBatchProcessor {
    constructor(
        private readonly riskManager: RiskManager,
        private readonly executionPlanner: ExecutionPlanner
    ) {}

    /**
     * Evaluates all signals against a single portfolio snapshot.
     * Applies portfolio limits (maxOpenTrades) fairly by prioritizing
     * signals based on their quality metrics.
     */
    public processBatch(
        evaluations: SignalEvaluation[],
        portfolioSnapshot: PortfolioSnapshot,
        maxOpenTrades: number
    ): BatchProcessingResult {
        if (evaluations.length === 0) {
            return { approvedEvaluations: [], rejectedEvaluations: [] };
        }

        // Phase 1: Evaluate all signals against the same portfolio snapshot
        const allEvaluated = evaluations.map(evaluation =>
            this.evaluateSingleSignal(evaluation, portfolioSnapshot)
        );

        // Phase 2: Separate approved and rejected
        const riskApproved = allEvaluated.filter(e => e.riskDecision.approved);
        const riskRejected = allEvaluated.filter(e => !e.riskDecision.approved);

        // Phase 3: Apply portfolio limits fairly
        const availableSlots = maxOpenTrades - portfolioSnapshot.openTradeCount;
        const { approved, rejected } = this.applyPortfolioLimits(
            riskApproved,
            availableSlots
        );

        return {
            approvedEvaluations: approved,
            rejectedEvaluations: [...riskRejected, ...rejected]
        };
    }

    private evaluateSingleSignal(
        evaluation: SignalEvaluation,
        portfolioSnapshot: PortfolioSnapshot
    ): EvaluatedSignal {
        const riskDecision = this.riskManager.assessSignal(
            evaluation.signal,
            portfolioSnapshot
        );

        let executionPlan: ExecutionPlan | undefined;
        let priorityScore = 0;

        if (riskDecision.approved) {
            executionPlan = this.executionPlanner.buildEntryPlan(
                evaluation.signal,
                riskDecision
            );
            priorityScore = this.calculatePriorityScore(riskDecision, evaluation.signal);
        }

        return {
            evaluation,
            riskDecision,
            executionPlan,
            priorityScore
        };
    }

    /**
     * Calculates priority score for signal ranking.
     * Higher score = higher priority for execution when slots are limited.
     * Uses R/R ratio and risk-adjusted metrics for fairness.
     */
    private calculatePriorityScore(
        riskDecision: RiskDecision,
        signal: StrategySignal
    ): number {
        // Base score from risk/reward ratio if available
        let score = 0;

        if (signal.takeProfitPrice !== undefined &&
            signal.entryPrice !== undefined &&
            signal.stopLossPrice !== undefined) {
            // R/R ratio is a strong quality indicator
            const risk = Math.abs(signal.entryPrice - signal.stopLossPrice);
            const reward = Math.abs(signal.takeProfitPrice - signal.entryPrice);
            if (risk > 0) {
                score += (reward / risk) * 100;
            }
        }

        // Bonus for higher conviction (could be extended with signal metadata)
        score += riskDecision.stopDistance > 0 ? 1 / riskDecision.stopDistance : 0;

        // Normalize by risk amount to prefer efficient trades
        score += riskDecision.riskAmount * 10;

        return score;
    }

    /**
     * Applies portfolio limits fairly by ranking signals and selecting top ones.
     * When available slots < approved signals, sorts by priority score.
     */
    private applyPortfolioLimits(
        approvedSignals: EvaluatedSignal[],
        availableSlots: number
    ): { approved: EvaluatedSignal[]; rejected: EvaluatedSignal[] } {
        if (availableSlots <= 0 || approvedSignals.length === 0) {
            return {
                approved: [],
                rejected: approvedSignals.map(e => ({
                    ...e,
                    riskDecision: {
                        ...e.riskDecision,
                        approved: false,
                        reason: "Maximum number of open trades reached (portfolio limit)"
                    }
                }))
            };
        }

        if (approvedSignals.length <= availableSlots) {
            return { approved: approvedSignals, rejected: [] };
        }

        // Sort by priority score descending (highest first)
        const sorted = [...approvedSignals].sort((a, b) => b.priorityScore - a.priorityScore);

        const approved = sorted.slice(0, availableSlots);
        const rejected = sorted.slice(availableSlots).map(e => ({
            ...e,
            riskDecision: {
                ...e.riskDecision,
                approved: false,
                reason: `Maximum number of open trades reached (${sorted.length} signals for ${availableSlots} slot(s), lower priority score)`
            }
        }));

        return { approved, rejected };
    }
}
