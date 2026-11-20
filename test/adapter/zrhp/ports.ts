/** Test transports for the ZRHP adapter: the Rust NCP simulator as a child process, and an in-memory pipe. */

import {type ChildProcessWithoutNullStreams, spawn} from "node:child_process";
import type {ZrhpPort} from "../../../src/adapter/zrhp/adapter/zrhpAdapter";

export const NCP_SIM = process.env.ZRHP_NCP_SIM;

/** Holds the simulator process across adapter instances (like an NCP that stays powered while the host restarts). */
export class SimHolder {
    proc: ChildProcessWithoutNullStreams | undefined;
    stderr = "";
    /** every byte the NCP wrote, for diagnostics */
    rxBytes = 0;

    alive(): boolean {
        return this.proc !== undefined && this.proc.exitCode === null && this.proc.signalCode === null;
    }

    spawn(): ChildProcessWithoutNullStreams {
        if (!NCP_SIM) {
            throw new Error("ZRHP_NCP_SIM not set");
        }

        const proc = spawn(NCP_SIM, [], {stdio: ["pipe", "pipe", "pipe"]});
        // writes racing a killed process (EPIPE) are expected in reboot tests
        proc.stdin.on("error", () => undefined);
        proc.stderr.on("data", (d: Buffer) => {
            this.stderr += d.toString();
        });
        this.proc = proc;

        return proc;
    }

    async kill(): Promise<void> {
        const proc = this.proc;

        if (proc && proc.exitCode === null && proc.signalCode === null) {
            await new Promise<void>((resolve) => {
                proc.once("exit", () => resolve());
                proc.kill("SIGKILL");
            });
        }

        this.proc = undefined;
    }
}

/** The Rust NCP as a child process; stdin/stdout carry the ZRHP bytes. */
export class ProcessPort implements ZrhpPort {
    readonly holder: SimHolder;
    onData: (data: Buffer) => void = () => undefined;
    onClose: (error?: Error) => void = () => undefined;
    mangle: ((data: Buffer) => Buffer) | undefined;
    readonly lines: [boolean, boolean][] = [];
    #proc: ChildProcessWithoutNullStreams | undefined;
    #listener: ((d: Buffer) => void) | undefined;
    #exit: (() => void) | undefined;

    constructor(holder: SimHolder, mangle?: (data: Buffer) => Buffer) {
        this.holder = holder;
        this.mangle = mangle;
    }

    async open(): Promise<void> {
        const proc = this.holder.alive() ? (this.holder.proc as ChildProcessWithoutNullStreams) : this.holder.spawn();
        this.detach();
        this.#proc = proc;
        this.#listener = (d: Buffer) => {
            this.holder.rxBytes += d.length;
            this.onData(d);
        };
        this.#exit = () => this.onClose(new Error("NCP process exited"));
        proc.stdout.on("data", this.#listener);
        proc.once("exit", this.#exit);
        await Promise.resolve();
    }

    private detach(): void {
        if (this.#proc && this.#listener) {
            this.#proc.stdout.off("data", this.#listener);
        }

        if (this.#proc && this.#exit) {
            this.#proc.off("exit", this.#exit);
        }

        this.#proc = undefined;
        this.#listener = undefined;
        this.#exit = undefined;
    }

    async close(): Promise<void> {
        this.detach();
        await Promise.resolve();
    }

    write(data: Buffer): void {
        const out = this.mangle ? this.mangle(data) : data;
        const stdin = this.#proc?.stdin;

        if (stdin && !stdin.destroyed && stdin.writable) {
            stdin.write(out);
        }
    }

    async setLines(dtr: boolean, rts: boolean): Promise<void> {
        this.lines.push([dtr, rts]);
        await Promise.resolve();
    }
}
