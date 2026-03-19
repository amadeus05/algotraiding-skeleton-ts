import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { TradeExitReason } from "./BacktestTypes";
import { TradeChartDirection, TradeChartRenderInput, TradeChartRenderer } from "./TradeChartRenderer";

export interface BacktestTradeChartRequest {
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
    candles: TradeChartRenderInput["candles"];
    outputPath: string;
    width?: number;
    height?: number;
}

export class BacktestTradeChartGenerator {
    constructor(private readonly renderer = new TradeChartRenderer()) {}

    public async generate(request: BacktestTradeChartRequest): Promise<string> {
        const outputPath = this.resolveOutputPath(request.outputPath);
        await mkdir(path.dirname(outputPath), { recursive: true });

        const renderInput: TradeChartRenderInput = {
            symbol: request.symbol,
            direction: request.direction,
            entryPrice: request.entryPrice,
            stopLossPrice: request.stopLossPrice,
            takeProfitPrice: request.takeProfitPrice,
            liquidationPrice: request.liquidationPrice,
            entryTimestamp: request.entryTimestamp,
            exitTimestamp: request.exitTimestamp,
            exitPrice: request.exitPrice,
            outcome: request.outcome,
            candles: request.candles,
            width: request.width,
            height: request.height
        };

        const extension = path.extname(outputPath).toLowerCase();
        const payload = extension === ".svg"
            ? this.renderer.renderSvgBuffer(renderInput)
            : this.renderer.renderPngBuffer(renderInput);

        await writeFile(outputPath, payload);
        return outputPath;
    }

    private resolveOutputPath(outputPath: string): string {
        const extension = path.extname(outputPath).toLowerCase();

        if (!extension) {
            return `${outputPath}.png`;
        }

        if (extension !== ".png" && extension !== ".svg") {
            throw new Error(`Unsupported chart file extension: ${extension}. Use .png or .svg.`);
        }

        return outputPath;
    }
}
