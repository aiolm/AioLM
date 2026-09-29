import { describe, expect, it } from 'vitest';
import { ValueType, Workbook, type Worksheet } from 'exceljs';
import type { BenchmarkReport } from './benchmarkReport';
import { benchmarkWorkbook } from './benchmarkWorkbook';

const LONG_MODEL = 'Synthetic-Instruct-70B-A8B-Preview-2507-UD-Q4_K_XL-Extra-Long-Model-Name-For-Wrapping';

const report: BenchmarkReport = {
  sheetName: 'Results',
  columns: [
    { label: 'Model', width: 30 },
    { label: 'Measured at', width: 22 },
    { label: 'Backend', width: 12 },
    { label: 'Prompt tokens', width: 14, numFmt: '#,##0' },
    { label: 'Speed (tokens/s)', width: 16, numFmt: '#,##0.0' },
    { label: 'Speed-up', width: 12, numFmt: '0.00"×"' },
    { label: 'Status', width: 12 },
  ],
  rows: [
    ['Small-7B-Q4', '2025-04-05 06:07:08', 'cpu', 1024, 1234.5678, 1.5, 'Complete'],
    [LONG_MODEL, '2025-04-05 06:08:09', 'cuda', 8192, 98.765, null, 'Complete'],
    ['예제 모델 이름이 길어서 여러 줄로 줄바꿈되는 경우 확인용 이름', '2025-04-05 06:09:10', 'vulkan', 2048, null, null, 'Failed'],
  ],
};

async function reopen(input: BenchmarkReport = report): Promise<{ bytes: Uint8Array; sheet: Worksheet; workbook: Workbook }> {
  const bytes = await benchmarkWorkbook(input);
  const workbook = new Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  return { bytes, sheet: workbook.worksheets[0], workbook };
}

describe('benchmark workbook', () => {
  it('returns a zipped XLSX as a plain Uint8Array with a single worksheet', async () => {
    const { bytes, workbook } = await reopen();
    expect(Object.getPrototypeOf(bytes)).toBe(Uint8Array.prototype);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.worksheets[0].name).toBe('Results');
  });

  it('writes the header and rows without extra title, identifier, formula or link cells', async () => {
    const { sheet } = await reopen();
    expect(sheet.rowCount).toBe(report.rows.length + 1);
    expect(sheet.columnCount).toBe(report.columns.length);
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(report.columns.map((column) => column.label));
    report.rows.forEach((values, rowIndex) => {
      values.forEach((value, columnIndex) => {
        const cell = sheet.getCell(rowIndex + 2, columnIndex + 1);
        expect(cell.value).toBe(value);
        expect([ValueType.String, ValueType.Number, ValueType.Null]).toContain(cell.type);
      });
    });
    expect(sheet.getCell(2, 1).formula).toBeUndefined();
    expect(sheet.getCell(2, 1).hyperlink).toBeUndefined();
  });

  it('keeps measurements numeric with their column number format, and leaves gaps empty', async () => {
    const { sheet } = await reopen();
    const first = sheet.getRow(2);
    expect(first.getCell(4).type).toBe(ValueType.Number);
    expect(first.getCell(4).numFmt).toBe('#,##0');
    expect(first.getCell(5).value).toBeCloseTo(1234.5678, 10);
    expect(first.getCell(5).numFmt).toBe('#,##0.0');
    expect(first.getCell(6).numFmt).toBe('0.00"×"');
    expect(sheet.getCell(3, 6).type).toBe(ValueType.Null);
    expect(sheet.getCell(4, 5).type).toBe(ValueType.Null);
    // Text columns keep the general format instead of inheriting a numeric one.
    expect(first.getCell(1).numFmt).toBeUndefined();
    expect(first.getCell(7).numFmt).toBeUndefined();
  });

  it('keeps text that looks like a formula, link or number as literal text', async () => {
    const hostile = ['=1+1', '=HYPERLINK("https://example.invalid","x")', '+SUM(A1)', '-2+3', '@SUM(A1)', '0012', 'https://example.invalid/model'];
    const { sheet } = await reopen({
      sheetName: 'Results',
      columns: [{ label: 'Model', width: 30 }, { label: 'Tokens', width: 12, numFmt: '0' }],
      rows: hostile.map((text) => [text, 5]),
    });
    hostile.forEach((text, index) => {
      const cell = sheet.getCell(index + 2, 1);
      expect(cell.type).toBe(ValueType.String);
      expect(cell.value).toBe(text);
      expect(cell.formula).toBeUndefined();
      expect(sheet.getCell(index + 2, 2).type).toBe(ValueType.Number);
    });
  });

  it('never writes non-finite numbers, which would make Excel report a corrupt file', async () => {
    const { sheet } = await reopen({
      sheetName: 'Results',
      columns: [{ label: 'Speed', width: 12, numFmt: '0.0' }],
      rows: [[Number.NaN], [Number.POSITIVE_INFINITY], [7]],
    });
    expect(sheet.getCell(2, 1).type).toBe(ValueType.Null);
    expect(sheet.getCell(3, 1).type).toBe(ValueType.Null);
    expect(sheet.getCell(4, 1).value).toBe(7);
  });

  it('uses the widths from the report', async () => {
    const { sheet } = await reopen();
    report.columns.forEach((column, index) => {
      expect(sheet.getColumn(index + 1).width).toBeCloseTo(column.width, 2);
    });
  });

  it('wraps every cell, vertically centres them, and gives the header a contrasting fill', async () => {
    const { sheet } = await reopen();
    for (let column = 1; column <= report.columns.length; column += 1) {
      const header = sheet.getCell(1, column);
      expect(header.alignment).toMatchObject({ wrapText: true, vertical: 'middle', horizontal: 'center' });
      expect(header.font).toMatchObject({ bold: true, color: { argb: 'FFFFFFFF' } });
      expect(header.fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } });
      for (let row = 2; row <= report.rows.length + 1; row += 1) {
        const cell = sheet.getCell(row, column);
        expect(cell.alignment).toMatchObject({ wrapText: true, vertical: 'middle' });
        expect(cell.fill).not.toMatchObject({ pattern: 'solid' });
      }
    }
  });

  it('sizes rows so wrapped model names stay visible', async () => {
    const { sheet } = await reopen();
    const height = (row: number) => sheet.getRow(row).height;
    expect(height(1)).toBeGreaterThanOrEqual(30);
    expect(height(2)).toBe(20);
    // An 84-character hyphenated name and a Korean name about 60 columns wide, both in a 30-wide column.
    expect(height(3)).toBeGreaterThanOrEqual(3 * 15);
    expect(height(4)).toBeGreaterThanOrEqual(3 * 15);
    for (let row = 1; row <= report.rows.length + 1; row += 1) expect(height(row)).toBeLessThanOrEqual(409);
  });

  it('grows a header that needs two lines and caps absurdly long text at the Excel row limit', async () => {
    const { sheet } = await reopen({
      sheetName: 'Results',
      columns: [{ label: 'Generation speed standard deviation (tokens/s)', width: 12 }, { label: 'Notes', width: 10 }],
      rows: [['a', 'word '.repeat(2000)]],
    });
    expect(sheet.getRow(1).height).toBeGreaterThan(30);
    expect(sheet.getRow(2).height).toBe(409);
  });

  it('freezes the header row and the leading identifying columns', async () => {
    const { sheet } = await reopen();
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 1 });
  });

  it('does not freeze columns that would leave little room to scroll', async () => {
    const columns = (widths: number[]) => widths.map((width, index) => ({ label: `C${index}`, width }));
    const wide = await reopen({ sheetName: 'Results', columns: columns([50, 30, 12]), rows: [['a', 'b', 'c']] });
    expect(wide.sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 });
    const tooWide = await reopen({ sheetName: 'Results', columns: columns([80, 12, 12]), rows: [['a', 'b', 'c']] });
    expect(tooWide.sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 0, ySplit: 1 });
    const narrow = await reopen({ sheetName: 'Results', columns: columns([20, 12]), rows: [['a', 'b']] });
    expect(narrow.sheet.views[0]).toMatchObject({ state: 'frozen', xSplit: 1, ySplit: 1 });
  });

  it('adds an auto filter over the header and all data rows', async () => {
    const { sheet } = await reopen();
    expect(sheet.autoFilter).toBe('A1:G4');
  });

  it('exports a header-only sheet when there are no measurements', async () => {
    const { sheet } = await reopen({ ...report, rows: [] });
    expect(sheet.rowCount).toBe(1);
    expect(sheet.autoFilter).toBe('A1:G1');
  });

  it('keeps generic document properties', async () => {
    const { workbook } = await reopen();
    expect(workbook.creator).toBe('AioLM');
    expect(workbook.lastModifiedBy).toBe('AioLM');
    expect([workbook.title, workbook.subject, workbook.company, workbook.manager, workbook.description, workbook.keywords, workbook.category]
      .every((value) => !value)).toBe(true);
  });
});
