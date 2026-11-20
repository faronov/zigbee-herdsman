import path from "node:path";
import {defineConfig} from "vitest/config";

export default defineConfig({
    plugins: [],
    test: {
        root: path.join(import.meta.dirname, ".."),
        setupFiles: ["test/vitest.ts"],
        onConsoleLog(_log: string, _type: "stdout" | "stderr"): boolean | undefined {
            return false;
        },
        coverage: {
            enabled: false,
            provider: "v8",
            include: ["src/**"],
            extension: [".ts"],
            // exclude: [],
            clean: true,
            cleanOnRerun: true,
            reportsDirectory: "coverage",
            reporter: ["text", "html"],
            reportOnFailure: false,
            thresholds: {
                100: true,
                // ZRHP adapter (fork): the Rust NCP simulator tests only run where ZRHP_NCP_SIM is set (zrhp workflow)
                "src/adapter/zrhp/**": {lines: 85, statements: 85, functions: 85, branches: 70},
            },
        },
    },
});
