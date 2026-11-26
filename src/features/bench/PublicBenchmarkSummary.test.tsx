import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { summarizeServingPoints } from '@aiolm/benchmark-contracts';
import { servingBenchmark } from '../../testing/servingBenchmark';
import { defined } from '../../testing/assertDefined';
import { benchmarkCopy } from './benchmarkCopy';
import { ServingResultTable } from './PublicBenchmarkSummary';

afterEach(cleanup);

describe('serving result metrics', () => {
  it('renders exactly eight metric columns in the method display order', () => {
    render(<ServingResultTable points={summarizeServingPoints(servingBenchmark().result.rows)} copy={benchmarkCopy('en')} />);
    const headers = within(screen.getByRole('table')).getAllByRole('columnheader');
    expect(headers.map(header => header.textContent)).toEqual([
      'Inputbytes', 'Conc.', 'Samples',
      'TTFTms', 'Prefilltok/s',
      'Decodetok/s', 'TPOTms',
      'Throughputtok/s', 'OutputB/s', 'E2Ems', 'Peak RAMbytes',
    ]);
    expect(headers[0]).toHaveAttribute('title', 'Input UTF-8 bytes');
    expect(headers[4]).toHaveAttribute('title', 'Prompt processing per request (Prefill)');
    expect(headers[5]).toHaveAttribute('title', 'Generation speed per request (Decode)');
  });

  it('renders null metrics as unavailable, including a completed stream without output', () => {
    const record = servingBenchmark();
    Object.assign(defined(record.result.rows[0]), { first_output_ms: null, output_bytes: 0 });
    render(<ServingResultTable points={summarizeServingPoints(record.result.rows)} copy={benchmarkCopy('en')} />);
    const row = defined(within(screen.getByRole('table')).getAllByRole('row')[1]);
    expect(within(row).getByRole('rowheader')).toHaveTextContent(/^4K$/);
    const cells = within(row).getAllByRole('cell');
    expect(cells).toHaveLength(10);
    for (const index of [2, 3, 4, 5, 6, 9]) expect(cells[index]).toHaveTextContent(/^N\/A$/);
    expect(cells[7]).toHaveTextContent(/^0\.0$/);
    expect(cells[8]).toHaveTextContent(/^200\.0$/);
  });

  it('sorts points by concurrency first and then input bytes without showing output token cap', () => {
    const base = defined(servingBenchmark().result.rows[0]);
    const rows = [
      { ...base, id: '16k-c1', input_bytes: 16384, concurrency: 1 },
      { ...base, id: '4k-c2', input_bytes: 4096, concurrency: 2, finish_reasons: ['stop', 'stop'], input_sha256_by_request: ['b'.repeat(64), 'c'.repeat(64)] },
      { ...base, id: '16k-c2', input_bytes: 16384, concurrency: 2, finish_reasons: ['stop', 'stop'], input_sha256_by_request: ['d'.repeat(64), 'e'.repeat(64)] },
      { ...base, id: '4k-c1', input_bytes: 4096, concurrency: 1 },
    ];
    render(<ServingResultTable points={summarizeServingPoints(rows)} copy={benchmarkCopy('en')} />);
    const table = screen.getByRole('table');
    const bodyRows = within(table).getAllByRole('row').slice(1);
    expect(bodyRows.map(tr => [
      within(tr).getByRole('rowheader').textContent,
      within(tr).getAllByRole('cell')[0]?.textContent,
    ])).toEqual([
      ['4K', '1×'],
      ['16K', '1×'],
      ['4K', '2×'],
      ['16K', '2×'],
    ]);
    expect(table).not.toHaveTextContent('/ 128');
  });

  it('renders localized Korean metric terminology without output cap or range/sample subtext', () => {
    render(<ServingResultTable points={summarizeServingPoints(servingBenchmark().result.rows)} copy={benchmarkCopy('ko')} />);
    const table = screen.getByRole('table');
    const headerElements = within(table).getAllByRole('columnheader');
    const headers = headerElements.map(header => header.textContent);
    expect(headers).toEqual([
      '입력bytes', '동시', '표본',
      'TTFT첫 출력ms', 'Prefill입력 처리tok/s',
      'Decode생성 속도tok/s', 'TPOT토큰당ms',
      'Throughput전체 토큰tok/s', '관측 출력B/s', 'E2E전체 시간ms', '최대 RAMbytes',
    ]);
    expect(headerElements[4]).toHaveAttribute('title', '요청당 입력 처리 속도 (Prefill)');
    expect(table).not.toHaveTextContent('출력 token 상한');
    expect(table).not.toHaveTextContent('n=');
  });
});
