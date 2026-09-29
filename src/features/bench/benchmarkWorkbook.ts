import { Workbook } from 'exceljs';
import type { BenchmarkReport } from './benchmarkReport';

const HEADER_FILL = 'FF1F3A5F';
const HEADER_TEXT = 'FFFFFFFF';
const ROW_DIVIDER = 'FFD9D9D9';
// Default Excel font (Calibri 11) draws 15pt lines. Rows carry an explicit height so the wrapped
// text is visible even in viewers that do not auto-fit; Excel refuses anything above 409pt.
const LINE_HEIGHT = 15;
const ROW_PADDING = 5;
const MIN_ROW_HEIGHT = 20;
const MIN_HEADER_HEIGHT = 30;
const MAX_ROW_HEIGHT = 409;
// Keep frozen columns narrow enough that the remaining columns stay scrollable on a laptop screen.
const MAX_FROZEN_COLUMNS = 2;
const MAX_FROZEN_WIDTH = 70;

const FULL_WIDTH = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/u;

/** Column width is measured in digit widths, and Hangul, kana and Han characters take about two. */
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) width += FULL_WIDTH.test(char) ? 2 : 1;
  return width;
}

/** Estimate how many lines a wrapped cell needs, breaking at spaces and hyphens like Excel does. */
function lineCount(text: string, columnWidth: number): number {
  // Cell padding and bold headers make a column fit slightly less text than its nominal width.
  const usable = Math.max(1, columnWidth - 2);
  let lines = 0;
  for (const paragraph of text.split(/\r?\n/)) {
    let count = 1;
    let used = 0;
    for (const token of paragraph.match(/[^\s-]+[\s-]*|[\s-]+/g) ?? []) {
      const width = textWidth(token.trimEnd());
      if (used > 0 && used + width > usable) { count += 1; used = 0; }
      // A token wider than a whole line is broken mid-word.
      const overflow = Math.max(0, Math.ceil(width / usable) - 1);
      count += overflow;
      used += textWidth(token) - overflow * usable;
    }
    lines += count;
  }
  return lines;
}

function rowHeight(cells: Array<string | number | null>, columns: BenchmarkReport['columns'], minHeight: number): number {
  const lines = cells.reduce<number>((most, cell, index) => (
    typeof cell === 'string' && columns[index] ? Math.max(most, lineCount(cell, columns[index].width)) : most
  ), 1);
  return Math.min(MAX_ROW_HEIGHT, Math.max(minHeight, lines * LINE_HEIGHT + ROW_PADDING));
}

function frozenColumnCount(columns: BenchmarkReport['columns']): number {
  let count = 0;
  let width = 0;
  // Always leave at least one scrolling column.
  while (count < Math.min(MAX_FROZEN_COLUMNS, columns.length - 1)) {
    width += columns[count].width;
    if (width > MAX_FROZEN_WIDTH) break;
    count += 1;
  }
  return count;
}

/** Build an XLSX file with one plain, filterable table. Works in both Node and the browser bundle of ExcelJS. */
export async function benchmarkWorkbook(report: BenchmarkReport): Promise<Uint8Array> {
  const { columns, rows } = report;
  const workbook = new Workbook();
  workbook.creator = 'AioLM';
  workbook.lastModifiedBy = 'AioLM';
  const sheet = workbook.addWorksheet(report.sheetName);
  columns.forEach((column, index) => { sheet.getColumn(index + 1).width = column.width; });

  const labels = columns.map((column) => column.label);
  const header = sheet.addRow(labels);
  header.height = rowHeight(labels, columns, MIN_HEADER_HEIGHT);
  columns.forEach((_, index) => {
    const cell = header.getCell(index + 1);
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });

  for (const values of rows) {
    const row = sheet.addRow(values.map((value) => (typeof value === 'number' && !Number.isFinite(value) ? null : value)));
    row.height = rowHeight(values, columns, MIN_ROW_HEIGHT);
    columns.forEach((column, index) => {
      const cell = row.getCell(index + 1);
      // Text and numbers stay separate: numFmt only applies to real numeric cells.
      if (typeof cell.value === 'number' && column.numFmt) cell.numFmt = column.numFmt;
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.border = { bottom: { style: 'thin', color: { argb: ROW_DIVIDER } } };
    });
  }

  sheet.views = [{ state: 'frozen', xSplit: frozenColumnCount(columns), ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: rows.length + 1, column: columns.length } };

  // Copy into a plain Uint8Array: the browser bundle returns a polyfilled Buffer.
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}
