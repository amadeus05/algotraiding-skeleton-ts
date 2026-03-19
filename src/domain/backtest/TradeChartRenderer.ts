import { Resvg } from "@resvg/resvg-js";
import { Candle } from "../../core/types/common";
import { TradeExitReason } from "./BacktestTypes";

export type TradeChartDirection = "LONG" | "SHORT";

export interface TradeChartRenderInput {
    symbol: string;
    direction: TradeChartDirection;
    entryPrice: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    liquidationPrice?: number;
    entryTimestamp?: number;
    exitTimestamp?: number;
    exitPrice?: number;
    outcome?: TradeExitReason;
    candles: Candle[];
    width?: number;
    height?: number;
}

type MarkerPoint = { x: number; y: number };

const COLORS = {
    background: "#131722",
    panel: "#181c27",
    axis: "#10141d",
    grid: "#2a2e39",
    gridText: "#7b8191",
    text: "#dce1eb",
    bull: "#22ab94",
    bear: "#f7525f",
    entry: "#d1d4dc",
    take: "#22ab94",
    stop: "#f7525f",
    liq: "#ff9800",
    exit: "#4da3ff"
} as const;

export class TradeChartRenderer {
    public renderSvg(input: TradeChartRenderInput): string {
        const candles = [...input.candles]
            .filter((candle) => Number.isFinite(candle.timestamp))
            .sort((a, b) => a.timestamp - b.timestamp);
        const width = input.width ?? 1400;
        const height = input.height ?? 760;

        if (candles.length === 0) {
            return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${COLORS.background}" /><text x="${width / 2}" y="${height / 2}" fill="${COLORS.text}" text-anchor="middle" font-size="20" font-family="'Segoe UI', Arial, sans-serif">No candles for ${this.escape(input.symbol)}</text></svg>`;
        }

        const margin = { left: 16, right: 132, top: 60, bottom: 48 };
        const chartWidth = width - margin.left - margin.right;
        const chartHeight = height - margin.top - margin.bottom;
        const gap = chartWidth / candles.length;
        const candleWidth = Math.min(16, Math.max(4, gap * 0.64));
        const levels = [
            ...candles.map((candle) => candle.low),
            ...candles.map((candle) => candle.high),
            input.entryPrice,
            input.stopLossPrice,
            input.takeProfitPrice,
            input.liquidationPrice,
            input.exitPrice
        ].filter((value): value is number => value !== undefined && Number.isFinite(value));
        const min = Math.min(...levels);
        const max = Math.max(...levels);
        const padding = Math.max((max - min) * 0.12, input.entryPrice * 0.003);
        const scaleMin = min - padding;
        const scaleMax = max + padding;
        const entryMarker = this.resolveMarker(input.entryTimestamp, candles, margin.left, gap, input.entryPrice, margin.top, chartHeight, scaleMin, scaleMax);
        const exitMarker = input.exitPrice !== undefined
            ? this.resolveMarker(input.exitTimestamp, candles, margin.left, gap, input.exitPrice, margin.top, chartHeight, scaleMin, scaleMax)
            : undefined;
        const outcomeColor = this.getOutcomeColor(input.outcome);
        const zoneStartX = entryMarker?.x ?? margin.left;
        const zoneWidth = margin.left + chartWidth - zoneStartX;

        const priceTicks = this.buildPriceTicks(scaleMin, scaleMax, chartHeight);

        const candleSvg = candles.map((candle, index) => {
            const x = margin.left + index * gap + gap / 2;
            const openY = this.scale(candle.open, scaleMin, scaleMax, margin.top, chartHeight);
            const closeY = this.scale(candle.close, scaleMin, scaleMax, margin.top, chartHeight);
            const highY = this.scale(candle.high, scaleMin, scaleMax, margin.top, chartHeight);
            const lowY = this.scale(candle.low, scaleMin, scaleMax, margin.top, chartHeight);
            const rising = candle.close >= candle.open;
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(1, Math.abs(closeY - openY));

            return [
                `<line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="${rising ? COLORS.bull : COLORS.bear}" stroke-width="1.2" />`,
                `<rect x="${x - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" rx="1" fill="${rising ? COLORS.bull : COLORS.bear}" />`
            ].join("");
        }).join("");

        const gridSvg = this.renderGrid(margin.left, margin.top, chartWidth, chartHeight, priceTicks, scaleMin, scaleMax);
        const zonesSvg = [
            input.stopLossPrice !== undefined ? this.renderBand(zoneStartX, zoneWidth, input.entryPrice, input.stopLossPrice, COLORS.stop, 0.15, scaleMin, scaleMax, margin.top, chartHeight) : "",
            input.takeProfitPrice !== undefined ? this.renderBand(zoneStartX, zoneWidth, input.entryPrice, input.takeProfitPrice, COLORS.take, 0.16, scaleMin, scaleMax, margin.top, chartHeight) : "",
            this.renderLevelLine(zoneStartX, zoneWidth, input.entryPrice, COLORS.entry, "6 5", scaleMin, scaleMax, margin.top, chartHeight),
            input.stopLossPrice !== undefined ? this.renderLevelLine(zoneStartX, zoneWidth, input.stopLossPrice, COLORS.stop, "7 4", scaleMin, scaleMax, margin.top, chartHeight) : "",
            input.takeProfitPrice !== undefined ? this.renderLevelLine(zoneStartX, zoneWidth, input.takeProfitPrice, COLORS.take, "7 4", scaleMin, scaleMax, margin.top, chartHeight) : "",
            input.liquidationPrice !== undefined ? this.renderLevelLine(zoneStartX, zoneWidth, input.liquidationPrice, COLORS.liq, "3 4", scaleMin, scaleMax, margin.top, chartHeight) : ""
        ].join("");
        const markersSvg = [
            entryMarker ? this.renderMarker(entryMarker, "ENTRY", COLORS.entry, margin.top, chartHeight) : "",
            exitMarker ? this.renderMarker(exitMarker, this.exitMarkerLabel(input.outcome), outcomeColor, margin.top, chartHeight) : ""
        ].join("");

        return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="trade-panel"><rect x="${margin.left}" y="${margin.top}" width="${chartWidth}" height="${chartHeight}" rx="8" /></clipPath>
  </defs>
  <rect width="${width}" height="${height}" fill="${COLORS.background}" />
  <rect x="${margin.left}" y="${margin.top}" width="${chartWidth}" height="${chartHeight}" rx="8" fill="${COLORS.panel}" stroke="${COLORS.grid}" />
  <rect x="${width - margin.right}" y="${margin.top}" width="${margin.right}" height="${chartHeight}" fill="${COLORS.axis}" />
  <line x1="${width - margin.right}" y1="${margin.top}" x2="${width - margin.right}" y2="${margin.top + chartHeight}" stroke="${COLORS.grid}" />
  ${this.renderHeader(input, width)}
  ${gridSvg}
  <g clip-path="url(#trade-panel)">
    ${zonesSvg}
    ${candleSvg}
    ${markersSvg}
  </g>
  ${this.renderPriceAxis(priceTicks, margin.top, chartHeight, width - margin.right + 8, input.entryPrice, scaleMin, scaleMax)}
  ${this.renderLevelLabels(input, width - margin.right + 10, margin.top, chartHeight, scaleMin, scaleMax)}
  ${this.renderTimeAxis(candles, margin.left, height - 14, gap)}
</svg>`;
    }

    public renderSvgBuffer(input: TradeChartRenderInput): Buffer {
        return Buffer.from(this.renderSvg(input), "utf8");
    }

    public renderPngBuffer(input: TradeChartRenderInput): Buffer {
        const resvg = new Resvg(this.renderSvg(input), {
            fitTo: { mode: "width", value: input.width ?? 1400 }
        });
        return resvg.render().asPng();
    }

    private renderHeader(input: TradeChartRenderInput, width: number): string {
        const directionColor = input.direction === "LONG" ? COLORS.bull : COLORS.bear;
        const outcomeColor = this.getOutcomeColor(input.outcome);

        return [
            `<text x="16" y="28" fill="${COLORS.text}" font-size="24" font-family="'Segoe UI', Arial, sans-serif" font-weight="700">${this.escape(input.symbol)}</text>`,
            `<text x="164" y="28" fill="${directionColor}" font-size="16" font-family="'Segoe UI', Arial, sans-serif" font-weight="700">${input.direction}</text>`,
            `<rect x="${width - 158}" y="8" width="126" height="28" rx="14" fill="${outcomeColor}" opacity="0.92" />`,
            `<text x="${width - 95}" y="27" fill="#ffffff" font-size="13" font-family="'Segoe UI', Arial, sans-serif" font-weight="700" text-anchor="middle">${this.escape(this.outcomeLabel(input.outcome))}</text>`
        ].join("");
    }

    private renderGrid(
        left: number,
        top: number,
        width: number,
        height: number,
        priceTicks: number[],
        scaleMin: number,
        scaleMax: number
    ): string {
        let lines = "";

        for (const tick of priceTicks) {
            const y = this.scale(tick, scaleMin, scaleMax, top, height);
            lines += `<line x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" stroke="${COLORS.grid}" stroke-dasharray="3 4" opacity="0.75" />`;
        }

        for (let index = 0; index <= 6; index += 1) {
            const x = left + (width / 6) * index;
            lines += `<line x1="${x}" y1="${top}" x2="${x}" y2="${top + height}" stroke="${COLORS.grid}" stroke-dasharray="3 4" opacity="0.45" />`;
        }
        return lines;
    }

    private renderBand(
        left: number,
        width: number,
        firstPrice: number,
        secondPrice: number,
        color: string,
        opacity: number,
        scaleMin: number,
        scaleMax: number,
        top: number,
        height: number
    ): string {
        const y1 = this.scale(firstPrice, scaleMin, scaleMax, top, height);
        const y2 = this.scale(secondPrice, scaleMin, scaleMax, top, height);
        return `<rect x="${left}" y="${Math.min(y1, y2)}" width="${width}" height="${Math.max(1, Math.abs(y2 - y1))}" fill="${color}" opacity="${opacity}" />`;
    }

    private renderLevelLine(
        left: number,
        width: number,
        price: number,
        color: string,
        dashArray: string,
        scaleMin: number,
        scaleMax: number,
        top: number,
        height: number
    ): string {
        const y = this.scale(price, scaleMin, scaleMax, top, height);
        return `<line x1="${left}" y1="${y}" x2="${left + width}" y2="${y}" stroke="${color}" stroke-width="1.6" stroke-dasharray="${dashArray}" opacity="0.95" />`;
    }

    private renderMarker(marker: MarkerPoint, label: string, color: string, top: number, height: number): string {
        const labelWidth = Math.max(46, label.length * 8.2);
        const labelX = Math.max(8, marker.x - labelWidth / 2);
        const labelY = Math.max(top + 8, marker.y - 34);

        return [
            `<line x1="${marker.x}" y1="${top + 6}" x2="${marker.x}" y2="${top + height - 6}" stroke="${color}" stroke-dasharray="4 5" opacity="0.45" />`,
            `<circle cx="${marker.x}" cy="${marker.y}" r="5.5" fill="${color}" stroke="#ffffff" stroke-width="1.5" />`,
            `<rect x="${labelX}" y="${labelY}" width="${labelWidth}" height="20" rx="10" fill="${color}" opacity="0.95" />`,
            `<text x="${labelX + labelWidth / 2}" y="${labelY + 14}" fill="#ffffff" font-size="11" font-family="'Segoe UI', Arial, sans-serif" font-weight="700" text-anchor="middle">${this.escape(label)}</text>`
        ].join("");
    }

    private renderPriceAxis(
        priceTicks: number[],
        top: number,
        height: number,
        x: number,
        anchorPrice: number,
        scaleMin: number,
        scaleMax: number
    ): string {
        const step = priceTicks.length > 1 ? Math.abs(priceTicks[1] - priceTicks[0]) : Math.abs(scaleMax - scaleMin);
        const decimals = Math.max(this.inferDecimals(anchorPrice), this.inferStepDecimals(step));

        return priceTicks
            .map((value) => {
                const y = this.scale(value, scaleMin, scaleMax, top, height);
                return `<text x="${x}" y="${y + 4}" fill="${COLORS.gridText}" font-size="12" font-family="'Segoe UI', Arial, sans-serif">${value.toFixed(decimals)}</text>`;
            })
            .join("");
    }

    private renderLevelLabels(
        input: TradeChartRenderInput,
        x: number,
        top: number,
        height: number,
        scaleMin: number,
        scaleMax: number
    ): string {
        const decimals = this.inferDecimals(input.entryPrice);
        const labels = [
            { text: "ENTRY", value: input.entryPrice, color: COLORS.entry },
            input.takeProfitPrice !== undefined ? { text: input.outcome === "tp" ? "TP HIT" : "TAKE", value: input.takeProfitPrice, color: COLORS.take } : undefined,
            input.stopLossPrice !== undefined ? { text: input.outcome === "sl" ? "SL HIT" : "STOP", value: input.stopLossPrice, color: COLORS.stop } : undefined,
            input.liquidationPrice !== undefined ? { text: input.outcome === "liq" ? "LIQ HIT" : "LIQ", value: input.liquidationPrice, color: COLORS.liq } : undefined,
            input.exitPrice !== undefined && !["tp", "sl", "liq"].includes(input.outcome ?? "") ? { text: "EXIT", value: input.exitPrice, color: this.getOutcomeColor(input.outcome) } : undefined
        ].filter((item): item is { text: string; value: number; color: string } => item !== undefined);

        return labels.map((label) => {
            const y = this.scale(label.value, scaleMin, scaleMax, top, height);
            return [
                `<rect x="${x}" y="${y - 11}" width="102" height="22" rx="11" fill="${label.color}" opacity="0.92" />`,
                `<text x="${x + 51}" y="${y}" fill="#ffffff" font-size="11" font-family="'Segoe UI', Arial, sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="middle">${this.escape(`${label.text} ${label.value.toFixed(decimals)}`)}</text>`
            ].join("");
        }).join("");
    }

    private renderTimeAxis(candles: Candle[], left: number, y: number, gap: number): string {
        const minSpacing = 110;
        const labels: Array<{ x: number; text: string }> = [];

        candles.forEach((candle, index) => {
            const isLast = index === candles.length - 1;
            if (!isLast && index !== 0) {
                const previousLabel = labels[labels.length - 1];
                const candidateX = left + index * gap + gap / 2;

                if (previousLabel && candidateX - previousLabel.x < minSpacing) {
                    return;
                }
            }

            labels.push({
                x: left + index * gap + gap / 2,
                text: this.formatTimeLabel(candle.timestamp)
            });
        });

        if (labels.length >= 2) {
            const last = labels[labels.length - 1];
            const previous = labels[labels.length - 2];

            if (last.x - previous.x < minSpacing) {
                labels.splice(labels.length - 2, 1);
            }
        }

        return labels
            .map((label) =>
                `<text x="${label.x}" y="${y}" fill="${COLORS.gridText}" font-size="12" font-family="'Segoe UI', Arial, sans-serif" text-anchor="middle">${label.text}</text>`
            )
            .join("");
    }

    private resolveMarker(
        timestamp: number | undefined,
        candles: Candle[],
        left: number,
        gap: number,
        price: number,
        top: number,
        height: number,
        scaleMin: number,
        scaleMax: number
    ): MarkerPoint | undefined {
        if (candles.length === 0) {
            return undefined;
        }

        let index = candles.length - 1;
        if (timestamp !== undefined) {
            const exact = candles.findIndex((candle) => candle.timestamp === timestamp);
            if (exact >= 0) {
                index = exact;
            } else {
                const next = candles.findIndex((candle) => candle.timestamp > timestamp);
                if (next >= 0) {
                    index = next;
                }
            }
        }

        return {
            x: left + index * gap + gap / 2,
            y: this.scale(price, scaleMin, scaleMax, top, height)
        };
    }

    private scale(value: number, min: number, max: number, top: number, height: number): number {
        if (max === min) {
            return top + height / 2;
        }
        return top + height - ((value - min) / (max - min)) * height;
    }

    private inferDecimals(price: number): number {
        if (price >= 10000) return 1;
        if (price >= 1000) return 2;
        if (price >= 10) return 3;
        if (price >= 1) return 4;
        return 6;
    }

    private inferStepDecimals(step: number): number {
        if (!Number.isFinite(step) || step <= 0) {
            return 0;
        }

        let decimals = 0;
        while (decimals < 8) {
            const rounded = Number(step.toFixed(decimals));
            if (Math.abs(rounded - step) < 1e-8) {
                return decimals;
            }
            decimals += 1;
        }

        return 8;
    }

    private buildPriceTicks(min: number, max: number, chartHeight: number): number[] {
        const range = max - min;

        if (!Number.isFinite(range) || range <= 0) {
            return [min];
        }

        const targetTickCount = Math.max(8, Math.min(20, Math.floor(chartHeight / 34)));
        const rawStep = range / targetTickCount;
        const step = this.niceStep(rawStep);
        const precision = Math.max(0, this.inferStepDecimals(step));
        const firstTick = Math.ceil(min / step) * step;
        const ticks: number[] = [];

        for (let value = firstTick; value <= max + step * 0.5; value += step) {
            ticks.push(Number(value.toFixed(precision)));
        }

        if (ticks.length < 2) {
            const midpoint = Number(((min + max) / 2).toFixed(precision));
            return [Number(min.toFixed(precision)), midpoint, Number(max.toFixed(precision))];
        }

        return ticks;
    }

    private niceStep(rawStep: number): number {
        if (!Number.isFinite(rawStep) || rawStep <= 0) {
            return 1;
        }

        const exponent = Math.floor(Math.log10(rawStep));
        const fraction = rawStep / (10 ** exponent);
        let niceFraction: number;

        if (fraction <= 1) {
            niceFraction = 1;
        } else if (fraction <= 2) {
            niceFraction = 2;
        } else if (fraction <= 2.5) {
            niceFraction = 2.5;
        } else if (fraction <= 5) {
            niceFraction = 5;
        } else {
            niceFraction = 10;
        }

        return niceFraction * (10 ** exponent);
    }

    private formatTimeLabel(timestamp: number): string {
        const date = new Date(timestamp);
        const month = String(date.getUTCMonth() + 1).padStart(2, "0");
        const day = String(date.getUTCDate()).padStart(2, "0");
        const hours = String(date.getUTCHours()).padStart(2, "0");
        const minutes = String(date.getUTCMinutes()).padStart(2, "0");
        return `${day}.${month} ${hours}:${minutes}`;
    }

    private outcomeLabel(outcome: TradeExitReason | undefined): string {
        switch (outcome) {
            case "tp":
                return "Take Profit";
            case "sl":
                return "Stop Loss";
            case "liq":
                return "Liquidation";
            case "signal":
                return "Signal Exit";
            case "manual":
                return "Manual Exit";
            default:
                return "Trade Closed";
        }
    }

    private exitMarkerLabel(outcome: TradeExitReason | undefined): string {
        switch (outcome) {
            case "tp":
                return "TP";
            case "sl":
                return "SL";
            case "liq":
                return "LIQ";
            case "manual":
                return "MANUAL";
            default:
                return "EXIT";
        }
    }

    private getOutcomeColor(outcome: TradeExitReason | undefined): string {
        switch (outcome) {
            case "tp":
                return COLORS.take;
            case "sl":
                return COLORS.stop;
            case "liq":
                return COLORS.liq;
            default:
                return COLORS.exit;
        }
    }

    private escape(value: string): string {
        return value
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}
