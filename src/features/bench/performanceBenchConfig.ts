import { FIXED_OUTPUT_TOKENS } from '@aiolm/benchmark-contracts';

export const PROMPT_BYTES = [256, 1024, 4096, 16384, 65536, 262144, 1048576];
export const CONCURRENCIES = [1, 2, 4, 8, 16, 32, 64];
export const OUTPUT_TOKEN_OPTIONS = FIXED_OUTPUT_TOKENS.map(value => ({ value, label: `${value / 1024}k` }));
export const REPETITIONS = [1, 3, 5, 10];
export const CORPORA = ["code_python", "code_mixed", "novel_ko", "novel_en", "novel_ja"] as const;
export const TASK_ID = "performance-benchmark-active";
