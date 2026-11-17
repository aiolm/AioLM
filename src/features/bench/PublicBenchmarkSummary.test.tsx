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
      'Input bytes / output token cap', 'Concurrent requests', 'Samples',
      'First observed outputms', 'Prompt processing per requesttok/s',
      'Generation speed per requesttok/s', 'Time per output tokenms',
      'Total token throughputtok/s', 'Observed outputB/s', 'Total timems', 'Peak process RAMbytes',
    ]);
  });

  it('renders null metrics as unavailable, including a completed stream without output', () => {
    const record = servingBenchmark();
    Object.assign(defined(record.result.rows[0]), { first_output_ms: null, output_bytes: 0 });
    render(<ServingResultTable points={summarizeServingPoints(record.result.rows)} copy={benchmarkCopy('en')} />);
    const cells = within(defined(within(screen.getByRole('table')).getAllByRole('row')[1])).getAllByRole('cell');
    expect(cells).toHaveLength(10);
    for (const index of [2, 3, 4, 5, 6, 9]) expect(cells[index]).toHaveTextContent('N/A');
    expect(cells[7]).toHaveTextContent('0.0 – 0.0 · n=1');
    expect(cells[8]).toHaveTextContent('200.0 – 200.0 · n=1');
  });
});
