import { BotRunResult } from "./BotRunner";
import { ClosedTrade, TradeSide } from "../core/types/trading";
import { formatDisplaySymbol, formatUtcDateTime } from "../utils/Helpers";

export interface BacktestReportInput {
    startTime: number;
    endTime: number;
    symbols: string[];
    mainTimeframe: string;
    higherTimeframe?: string;
    initialBalance: number;
    finalBalance: number;
    finalEquity: number;
    totalFees: number;
    maxDrawdown: number;
    closedTrades: ClosedTrade[];
    runResult: BotRunResult;
}

interface MonthlySummary {
    month: string;
    trades: number;
    wins: number;
    netPnl: number;
}

interface SymbolSummary {
    symbol: string;
    trades: number;
    tp: number;
    sl: number;
    wins: number;
    netPnl: number;
}

interface SideSummary {
    side: TradeSide;
    total: number;
    wins: number;
    losses: number;
    netPnl: number;
}

export function renderBacktestReport(input: BacktestReportInput): string {
    const wins = input.closedTrades.filter((trade) => trade.netPnl > 0).length;
    const losses = input.closedTrades.filter((trade) => trade.netPnl < 0).length;
    const totalNetPnl = input.finalEquity - input.initialBalance;
    const winRate = input.closedTrades.length === 0 ? 0 : (wins / input.closedTrades.length) * 100;
    const profitFactor = calculateProfitFactor(input.closedTrades);
    const expectancy = input.closedTrades.length === 0 ? 0 : totalNetPnl / input.closedTrades.length;
    const sharpe = calculateTradeSharpe(input.closedTrades);
    const monthlyRows = buildMonthlySummaries(input.startTime, input.endTime, input.closedTrades);
    const symbolRows = buildSymbolSummaries(input.closedTrades);
    const sideRows = buildSideSummaries(input.closedTrades);

    const lines = [
        `Period: ${formatUtcDateTime(input.startTime)} -> ${formatUtcDateTime(input.endTime)}`,
        `Symbols: ${input.symbols.map((symbol) => formatDisplaySymbol(symbol)).join(", ")}`,
        `Main TF: ${input.mainTimeframe} | HTF: ${input.higherTimeframe ?? "n/a"}`,
        "",
        `📊 Trades: ${input.closedTrades.length} (W: ${wins} / L: ${losses})`,
        `   Win Rate: ${winRate.toFixed(2)}%`,
        "💰 Equity:",
        `   Start: ${formatSignedDollarPlain(input.initialBalance)}`,
        `   End:   ${formatSignedDollarPlain(input.finalEquity)}`,
        `   PnL:   ${formatSignedDollarPlain(totalNetPnl)} (${formatSignedPercent(percentOf(totalNetPnl, input.initialBalance))})`,
        `   Fees:  +$${input.totalFees.toFixed(2)}`,
        "📉 Risk:",
        `   Max DD: ${(input.maxDrawdown * 100).toFixed(2)}%`,
        `   Profit Factor: ${formatMetric(profitFactor)}`,
        `   Expectancy: ${formatSignedDollarPlain(expectancy)}`,
        `   Sharpe: ${formatMetric(sharpe)}`,
        "",
        "==================================================",
        "FINAL RESULTS",
        "==================================================",
        renderMonthlyTable(monthlyRows, input.initialBalance),
        "",
        "📊 Summary by Coin:",
        renderSymbolTable(symbolRows),
        "",
        "📈 Long / Short Summary:",
        renderSideTable(sideRows)
    ];

    return lines.join("\n");
}

function buildMonthlySummaries(startTime: number, endTime: number, trades: ClosedTrade[]): MonthlySummary[] {
    const rows: MonthlySummary[] = [];
    const cursor = new Date(Date.UTC(new Date(startTime).getUTCFullYear(), new Date(startTime).getUTCMonth(), 1));
    const end = new Date(Date.UTC(new Date(endTime).getUTCFullYear(), new Date(endTime).getUTCMonth(), 1));

    while (cursor.getTime() <= end.getTime()) {
        const month = `${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, "0")}`;
        const monthTrades = trades.filter((trade) => getMonthKey(trade.closedAt) === month);
        const wins = monthTrades.filter((trade) => trade.netPnl > 0).length;
        const netPnl = monthTrades.reduce((sum, trade) => sum + trade.netPnl, 0);

        rows.push({
            month,
            trades: monthTrades.length,
            wins,
            netPnl
        });

        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return rows;
}

function buildSymbolSummaries(trades: ClosedTrade[]): SymbolSummary[] {
    const map = new Map<string, SymbolSummary>();

    for (const trade of trades) {
        const existing = map.get(trade.symbol) ?? {
            symbol: trade.symbol,
            trades: 0,
            tp: 0,
            sl: 0,
            wins: 0,
            netPnl: 0
        };

        existing.trades += 1;
        existing.netPnl += trade.netPnl;

        if (trade.netPnl > 0) {
            existing.wins += 1;
        }

        if (trade.closeReason === "TP") {
            existing.tp += 1;
        } else if (trade.closeReason.startsWith("SL")) {
            existing.sl += 1;
        }

        map.set(trade.symbol, existing);
    }

    return Array.from(map.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}

function buildSideSummaries(trades: ClosedTrade[]): SideSummary[] {
    return (["long", "short"] as const).map((side) => {
        const sideTrades = trades.filter((trade) => trade.side === side);
        const wins = sideTrades.filter((trade) => trade.netPnl > 0).length;
        const losses = sideTrades.filter((trade) => trade.netPnl < 0).length;
        const netPnl = sideTrades.reduce((sum, trade) => sum + trade.netPnl, 0);

        return {
            side,
            total: sideTrades.length,
            wins,
            losses,
            netPnl
        };
    });
}

function renderMonthlyTable(rows: MonthlySummary[], initialBalance: number): string {
    const header = [
        "Month".padEnd(10),
        "Trades".padEnd(8),
        "WinRate".padEnd(8),
        "Profit"
    ].join(" | ");

    const body = rows.map((row) => {
        const winRate = row.trades === 0 ? 0 : (row.wins / row.trades) * 100;
        const percent = percentOf(row.netPnl, initialBalance);
        const profit = `${formatSignedPercent(percent)} (${formatSignedDollarPlain(row.netPnl)})`;

        return [
            row.month.padEnd(10),
            String(row.trades).padEnd(8),
            `${winRate.toFixed(1).padStart(5)}%`.padEnd(8),
            profit
        ].join(" | ");
    });

    const totalTrades = rows.reduce((sum, row) => sum + row.trades, 0);
    const totalWins = rows.reduce((sum, row) => sum + row.wins, 0);
    const totalNetPnl = rows.reduce((sum, row) => sum + row.netPnl, 0);
    const totalWinRate = totalTrades === 0 ? 0 : (totalWins / totalTrades) * 100;
    const totalProfit = `${formatSignedPercent(percentOf(totalNetPnl, initialBalance))} (${formatSignedDollarPlain(totalNetPnl)})`;

    return [
        header,
        "-".repeat(60),
        ...body,
        "-".repeat(60),
        [
            "TOTAL".padEnd(10),
            String(totalTrades).padEnd(8),
            `${totalWinRate.toFixed(1).padStart(5)}%`.padEnd(8),
            totalProfit
        ].join(" | ")
    ].join("\n");
}

function renderSymbolTable(rows: SymbolSummary[]): string {
    const top = "┌──────────────┬────────┬────────┬────────┬──────────┬─────────────┐";
    const mid = "├──────────────┼────────┼────────┼────────┼──────────┼─────────────┤";
    const bottom = "└──────────────┴────────┴────────┴────────┴──────────┴─────────────┘";
    const header = "│ Symbol       │ Trades │ TP     │ SL     │ Winrate  │ PnL         │";
    const body = rows.map((row) => {
        const winRate = row.trades === 0 ? 0 : (row.wins / row.trades) * 100;

        return [
            "│",
            ` ${formatDisplaySymbol(row.symbol).padEnd(12)} `,
            "│",
            ` ${String(row.trades).padStart(6)} `,
            "│",
            ` ${String(row.tp).padStart(6)} `,
            "│",
            ` ${String(row.sl).padStart(6)} `,
            "│",
            ` ${`${winRate.toFixed(1)}%`.padStart(8)} `,
            "│",
            ` ${formatSignedDollarPlain(row.netPnl).padStart(11)} `,
            "│"
        ].join("");
    });

    if (body.length === 0) {
        body.push(`│ ${"No trades recorded".padEnd(60)} │`);
    }

    return [top, header, mid, ...body, bottom].join("\n");
}

function renderSideTable(rows: SideSummary[]): string {
    const top = "┌─────────────┬────────┬────────┬────────┬─────────────┐";
    const mid = "├─────────────┼────────┼────────┼────────┼─────────────┤";
    const bottom = "└─────────────┴────────┴────────┴────────┴─────────────┘";
    const header = "│ Direction   │ Total  │ Wins   │ Losses │ PnL         │";
    const body = rows.map((row) => [
        "│",
        ` ${row.side.toUpperCase().padEnd(11)} `,
        "│",
        ` ${String(row.total).padStart(6)} `,
        "│",
        ` ${String(row.wins).padStart(6)} `,
        "│",
        ` ${String(row.losses).padStart(6)} `,
        "│",
        ` ${formatSignedDollarPlain(row.netPnl).padStart(11)} `,
        "│"
    ].join(""));

    return [top, header, mid, ...body, bottom].join("\n");
}

function calculateProfitFactor(trades: ClosedTrade[]): number {
    const grossProfit = trades.filter((trade) => trade.netPnl > 0).reduce((sum, trade) => sum + trade.netPnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.netPnl < 0).reduce((sum, trade) => sum + trade.netPnl, 0));

    if (grossLoss === 0) {
        return grossProfit === 0 ? 0 : grossProfit;
    }

    return grossProfit / grossLoss;
}

function calculateTradeSharpe(trades: ClosedTrade[]): number {
    const returns = trades.map((trade) => trade.margin > 0 ? trade.netPnl / trade.margin : 0);

    if (returns.length < 2) {
        return 0;
    }

    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const deviation = Math.sqrt(variance);

    if (deviation === 0) {
        return 0;
    }

    return (mean / deviation) * Math.sqrt(returns.length);
}

function getMonthKey(timestamp: number): string {
    const date = new Date(timestamp);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function percentOf(value: number, base: number): number {
    return base === 0 ? 0 : (value / base) * 100;
}

function formatSignedDollarPlain(value: number): string {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function formatSignedPercent(value: number): string {
    const sign = value >= 0 ? "+" : "-";
    return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function formatMetric(value: number): string {
    return Number.isFinite(value) ? value.toFixed(2) : "0.00";
}
