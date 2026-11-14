export const PROMPT_BYTES = [1024, 4096, 16384, 65536, 262144, 1048576];
/** Input sizes read in K (1K = 1024); a size off that grid keeps its exact count. */
export const formatInputSize = (bytes: number) => bytes % 1024 === 0 ? `${bytes / 1024}K` : bytes.toLocaleString();
export const CONCURRENCIES = [1, 2, 4, 8];
/** Every new run measures this fixed-output preset once per input/concurrency point. */
export const OUTPUT_TOKENS = 128;
export const REPETITIONS = 1;
export const CORPORA = ["code_python", "code_mixed", "novel_ko", "novel_en", "novel_ja"] as const;
export const TASK_ID = "performance-benchmark-active";
