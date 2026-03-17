const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export type ExitReason = "SL" | "TP" | "signal";

export interface TradeLogOpenParams {
    symbol: string;
    side: "long" | "short";
    price: number;
    sizeUsd: number;
    marginUsd: number;
    slippagePct: number;
    timestamp: number;
}

export interface TradeLogCloseParams {
    symbol: string;
    side: "long" | "short";
    pnlPct: number;
    commission: number;
    balance: number;
    reason: ExitReason;
    timestamp: number;
}

interface TradeRecord {
    pnlPct: number;
    pnlUsd: number;
    commission: number;
    symbol: string;
    timestamp: number;
    reason: ExitReason;
}

interface MonthlyStats {
    trades: number;
    wins: number;
    pnlUsd: number;
}

interface SymbolStats {
    trades: number;
    tp: number;
    sl: number;
    wins: number;
    pnlUsd: number;
}

export class BacktestTradeLogger {
    private startEquity = 0;
    private trades: TradeRecord[] = [];
    private peakEquity = 0;
    private maxDrawdownPct = 0;
    private monthlyStats = new Map<string, MonthlyStats>();
    private symbolStats = new Map<string, SymbolStats>();

    public setStartEquity(equity: number): void {
        this.startEquity = equity;
        this.peakEquity = equity;
    }

    public logOpen(params: TradeLogOpenParams): void {
        const ts = this.formatTimestamp(params.timestamp);
        const sym = this.formatSymbol(params.symbol);
        const slip = params.slippagePct.toFixed(3);
        console.log(
            `[${ts}] ${sym}: \u{1F525} OPEN ${params.side.toUpperCase()} at ${params.price.toFixed(4)} | Size: ${params.sizeUsd.toFixed(2)}$ Margin: ${params.marginUsd.toFixed(2)}$ (slip ${slip}%)`
        );
    }

    private lastCloseParams?: TradeLogCloseParams;

    public logClose(params: TradeLogCloseParams): void {
        this.lastCloseParams = params;
        const ts = this.formatTimestamp(params.timestamp);
        const sym = this.formatSymbol(params.symbol);
        const pnlStr = `${params.pnlPct.toFixed(2)}%`;
        const pnlColored = params.pnlPct >= 0 ? `${GREEN}${pnlStr}${RESET}` : `${RED}${pnlStr}${RESET}`;
        const icon = params.pnlPct >= 0 ? "\u2705" : "\u274C";
        const com = params.commission.toFixed(2);
        const reason = params.reason === "SL" ? "SL (or liquidation)" : params.reason === "TP" ? "TP" : "signal";
        console.log(
            `[${ts}] ${sym}: ${icon} | PnL: ${pnlColored} | Com: ${com}$ | Bal: ${params.balance.toFixed(2)} | Reason: ${reason}`
        );
    }

    public getLastCloseParams(): TradeLogCloseParams | undefined {
        return this.lastCloseParams;
    }

    public recordClose(
        pnlPct: number,
        pnlUsd: number,
        commission: number,
        equityAfter: number,
        symbol?: string,
        timestamp?: number,
        reason?: ExitReason
    ): void {
        const trade: TradeRecord = {
            pnlPct,
            pnlUsd,
            commission,
            symbol: symbol ?? "UNKNOWN",
            timestamp: timestamp ?? Date.now(),
            reason: reason ?? "signal"
        };
        this.trades.push(trade);
        this.peakEquity = Math.max(this.peakEquity, equityAfter);
        const dd = this.peakEquity > 0 ? ((this.peakEquity - equityAfter) / this.peakEquity) * 100 : 0;
        this.maxDrawdownPct = Math.max(this.maxDrawdownPct, dd);

        // Update monthly stats
        const monthKey = this.getMonthKey(trade.timestamp);
        const monthStat = this.monthlyStats.get(monthKey) ?? { trades: 0, wins: 0, pnlUsd: 0 };
        monthStat.trades++;
        if (trade.pnlUsd > 0) monthStat.wins++;
        monthStat.pnlUsd += trade.pnlUsd;
        this.monthlyStats.set(monthKey, monthStat);

        // Update symbol stats
        const symStat = this.symbolStats.get(trade.symbol) ?? { trades: 0, tp: 0, sl: 0, wins: 0, pnlUsd: 0 };
        symStat.trades++;
        if (trade.pnlUsd > 0) symStat.wins++;
        if (trade.reason === "TP") symStat.tp++;
        if (trade.reason === "SL") symStat.sl++;
        symStat.pnlUsd += trade.pnlUsd;
        this.symbolStats.set(trade.symbol, symStat);
    }

    public printSummary(endEquity: number): void {
        const wins = this.trades.filter((t) => t.pnlUsd > 0).length;
        const losses = this.trades.filter((t) => t.pnlUsd <= 0).length;
        const totalTrades = this.trades.length;
        const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;
        const totalPnl = endEquity - this.startEquity;
        const totalPnlPct = this.startEquity > 0 ? (totalPnl / this.startEquity) * 100 : 0;
        const totalFees = this.trades.reduce((s, t) => s + t.commission, 0);
        const grossProfit = this.trades.filter((t) => t.pnlUsd > 0).reduce((s, t) => s + t.pnlUsd, 0);
        const grossLoss = Math.abs(this.trades.filter((t) => t.pnlUsd <= 0).reduce((s, t) => s + t.pnlUsd, 0));
        const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
        const expectancy = totalTrades > 0 ? totalPnl / totalTrades : 0;
        const meanReturn = totalTrades > 0 ? this.trades.reduce((s, t) => s + t.pnlPct, 0) / totalTrades : 0;
        const variance =
            totalTrades > 1
                ? this.trades.reduce((s, t) => s + Math.pow(t.pnlPct - meanReturn, 2), 0) / (totalTrades - 1)
                : 0;
        const stdReturn = Math.sqrt(variance);
        const sharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(totalTrades) : 0;

        const pnlSign = totalPnl >= 0 ? "+" : "";
        const pnlPctSign = totalPnlPct >= 0 ? "+" : "";

        console.log("");
        console.log(`\u{1F4CA} Trades: ${totalTrades} (W: ${wins} / L: ${losses})`);
        console.log(`   Win Rate: ${winRate.toFixed(2)}%`);
        console.log(`\u{1F4B0} Equity:`);
        console.log(`   Start: $${this.startEquity.toFixed(2)}`);
        console.log(`   End:   $${endEquity.toFixed(2)}`);
        console.log(`   PnL:   ${pnlSign}$${totalPnl.toFixed(2)} (${pnlPctSign}${totalPnlPct.toFixed(2)}%)`);
        console.log(`   Fees:  $${totalFees.toFixed(2)}`);
        console.log(`\u{1F4C9} Risk:`);
        console.log(`   Max DD: ${this.maxDrawdownPct.toFixed(2)}%`);
        console.log(`   Profit Factor: ${profitFactor === Infinity ? "-" : profitFactor.toFixed(2)}`);
        console.log(`   Expectancy: ${expectancy >= 0 ? "+" : ""}$${expectancy.toFixed(2)}`);
        console.log(`   Sharpe: ${sharpe.toFixed(2)}`);

        this.printMonthlyReport();
        this.printSymbolReport();
    }

    private printMonthlyReport(): void {
        if (this.monthlyStats.size === 0) return;

        console.log("");
        console.log("==================================================");
        console.log("FINAL RESULTS");
        console.log("==================================================");
        console.log("Month      | Trades   | WinRate  | Profit");
        console.log("------------------------------------------------------------");

        const sortedMonths = Array.from(this.monthlyStats.keys()).sort();
        let totalTrades = 0;
        let totalWins = 0;
        let totalPnl = 0;

        for (const month of sortedMonths) {
            const stat = this.monthlyStats.get(month)!;
            const winRate = stat.trades > 0 ? (stat.wins / stat.trades) * 100 : 0;
            const pnlPct = this.startEquity > 0 ? (stat.pnlUsd / this.startEquity) * 100 : 0;
            const pnlSign = stat.pnlUsd >= 0 ? "+" : "";
            console.log(
                `${month}    | ${stat.trades.toString().padEnd(8)} | ${winRate.toFixed(1).padStart(5)}% | ${pnlSign}${pnlPct.toFixed(2)}% (${pnlSign}${stat.pnlUsd.toFixed(2)}$)`
            );
            totalTrades += stat.trades;
            totalWins += stat.wins;
            totalPnl += stat.pnlUsd;
        }

        console.log("------------------------------------------------------------");
        const totalWinRate = totalTrades > 0 ? (totalWins / totalTrades) * 100 : 0;
        const totalPnlPct = this.startEquity > 0 ? (totalPnl / this.startEquity) * 100 : 0;
        const totalPnlSign = totalPnl >= 0 ? "+" : "";
        console.log(
            `TOTAL      | ${totalTrades.toString().padEnd(8)} | ${totalWinRate.toFixed(1)}%   | ${totalPnlSign}${totalPnlPct.toFixed(2)}% (${totalPnlSign}${totalPnl.toFixed(2)}$)`
        );
    }

    private printSymbolReport(): void {
        if (this.symbolStats.size === 0) return;

        console.log("");
        console.log("\u{1F4CA} Summary by Coin:");
        console.log("\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u252C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510");
        console.log("\u2502 Symbol       \u2502 Trades \u2502 TP     \u2502 SL     \u2502 Winrate  \u2502 PnL         \u2502");
        console.log("\u251C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u253C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2524");

        const sortedSymbols = Array.from(this.symbolStats.keys()).sort();
        for (const symbol of sortedSymbols) {
            const stat = this.symbolStats.get(symbol)!;
            const winRate = stat.trades > 0 ? (stat.wins / stat.trades) * 100 : 0;
            const pnlSign = stat.pnlUsd >= 0 ? "+" : "";
            const pnlStr = `${pnlSign}$${stat.pnlUsd.toFixed(2)}`;
            console.log(
                `\u2502 ${symbol.padEnd(12)} \u2502 ${stat.trades.toString().padStart(6)} \u2502 ${stat.tp.toString().padStart(6)} \u2502 ${stat.sl.toString().padStart(6)} \u2502 ${winRate.toFixed(1).padStart(6)}% \u2502 ${pnlStr.padStart(11)} \u2502`
            );
        }

        console.log("\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2534\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518");
    }

    private getMonthKey(timestamp: number): string {
        const date = new Date(timestamp);
        const year = date.getFullYear();
        const month = (date.getMonth() + 1).toString().padStart(2, "0");
        return `${year}-${month}`;
    }

    private formatTimestamp(ts: number): string {
        return new Date(ts).toISOString().replace("T", " ").slice(0, 19);
    }

    private formatSymbol(symbol: string): string {
        return symbol.replace("USDT", "/USDT");
    }
}
