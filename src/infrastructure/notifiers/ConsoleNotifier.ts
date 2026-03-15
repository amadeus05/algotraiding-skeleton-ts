import { NotifierContract } from "../../core/interfaces/NotifierContract";

export class ConsoleNotifier implements NotifierContract {
    public info(message: string): void {
        console.info(message);
    }

    public warn(message: string): void {
        console.warn(message);
    }
}
