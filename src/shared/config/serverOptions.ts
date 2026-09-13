import catalog from './serverOptionsCatalog.json';
import { canonicalServerOptionName, parseServerArgs } from './tuningValidation';

export interface ServerOption {
  id: string;
  signature: string;
  description: string;
  group: string;
  flags: string[];
  arity: number;
  choices: string[];
}

export const SERVER_OPTIONS_SOURCE = catalog.source;
const FLAG = /^--?[a-zA-Z][\w.-]*/;

export function describeServerOption(signature: string, description = '', group = ''): ServerOption | null {
  // Only the signature is scanned: flags mentioned in prose are not options.
  const parts = signature.split(/,\s+(?=-)/);
  const flags = parts.map(part => part.match(FLAG)?.[0]).filter((flag): flag is string => !!flag);
  if (!flags.length) return null;
  const argument = parts.at(-1)!.replace(FLAG, '').trim().replace(/^=/, '');
  const enumeration = argument.match(/^[[<{]([\w+.,| -]+)[\]}>]$/)?.[1];
  const choices = enumeration && /[,|]/.test(enumeration) && !enumeration.includes('...')
    ? enumeration.split(/[,|]/).map(value => value.trim()) : [];
  const arity = !argument ? 0 : argument === 'START END' || argument === 'FNAME SCALE' ? 2 : 1;
  return { id: flags.find(flag => flag.startsWith('--')) ?? flags[0], signature, description, group, flags, arity, choices };
}

/** llama.cpp help aligns the description after two or more spaces. */
export function parseRuntimeHelp(help: string): ServerOption[] {
  const rows: { signature: string; description: string; group: string }[] = [];
  let group = 'Runtime';
  const lines = help.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const indent = Math.min(...lines.filter(line => /^\s*--?[a-zA-Z]/.test(line)).map(line => line.length - line.trimStart().length));
  for (const raw of lines) {
    const line = raw.trim();
    if (/^-{3,}.*-{3,}$/.test(line)) { group = line.replace(/^-+|-+$/g, '').trim(); continue; }
    if (raw.length - raw.trimStart().length === indent && /^--?[a-zA-Z]/.test(line)) {
      const [signature, ...description] = line.replace(/,\s+(?=-)/g, ', ').split(/\s{2,}/);
      rows.push({ signature, description: description.join(' '), group });
    } else if (rows.length && line) {
      rows[rows.length - 1].description += `\n${line}`;
    }
  }
  return rows.flatMap(row => {
    const option = describeServerOption(row.signature, row.description, row.group);
    return option ? [option] : [];
  });
}

// Older supported builds predate --load-mode. Keep these discoverable offline.
const legacy = [
  { signature: '--mmap, --no-mmap', description: 'Memory-map model weights. Newer builds use --load-mode mmap or none.', group: 'Memory' },
  { signature: '--mlock', description: 'Keep model weights in RAM. Newer builds use --load-mode mlock or mmap+mlock.', group: 'Memory' },
  { signature: '--direct-io, --no-direct-io', description: 'Use DirectIO where supported. Newer builds use --load-mode dio.', group: 'Memory' },
];
export const SERVER_OPTIONS: ServerOption[] = [...catalog.options, ...legacy].flatMap(row => {
  const option = describeServerOption(row.signature, row.description, row.group);
  return option ? [option] : [];
});

/** A successful help read is authoritative, including PR/custom build options. */
export function runtimeServerOptions(help?: string): ServerOption[] {
  const parsed = parseRuntimeHelp(help ?? '');
  return parsed.length ? parsed : SERVER_OPTIONS;
}

export function serverOptionMatches(option: ServerOption, query: string): boolean {
  const normalize = (value: string) => value.toLocaleLowerCase().replace(/[\s_-]+/g, '');
  return normalize(`${option.signature} ${option.description} ${option.group}`).includes(normalize(query));
}

export function managedServerOption(option: ServerOption): string | null {
  return option.flags.map(canonicalServerOptionName).find(Boolean) ?? null;
}

export interface OptionOccurrence { flag: string; values: string[] }
interface LocatedOccurrence extends OptionOccurrence { start: number; end: number }

function locateOccurrences(args: readonly string[], option: ServerOption): LocatedOccurrence[] {
  const result: LocatedOccurrence[] = [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    const equals = token.indexOf('=');
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (!option.flags.includes(flag)) continue;
    const values = equals < 0 ? [] : [token.slice(equals + 1)];
    const start = index;
    while (values.length < option.arity && index + 1 < args.length) {
      // Negative numbers are values, while a following switch starts another option.
      if (FLAG.test(args[index + 1])) break;
      values.push(args[++index]);
    }
    result.push({ start, end: index + 1, flag, values });
  }
  return result;
}

export function getOptionOccurrences(args: readonly string[], option: ServerOption): OptionOccurrence[] {
  return locateOccurrences(args, option).map(({ flag, values }) => ({ flag, values }));
}

/** Replace only this option; keep unrelated arguments, repeated flags and paths intact. */
export function replaceServerOption(args: readonly string[], option: ServerOption, occurrences: OptionOccurrence[]): string[] {
  if (managedServerOption(option)) throw new Error('Use the dedicated setting for this app-managed option.');
  const existing = locateOccurrences(args, option);
  const remove = new Set(existing.flatMap(item => Array.from({ length: item.end - item.start }, (_, index) => item.start + index)));
  const insertAt = existing[0]?.start ?? args.length;
  const replacement = occurrences.flatMap(item => {
    if (!option.flags.includes(item.flag) || item.values.length !== option.arity || item.values.some(value => !value.trim() || /[\r\n\0]/.test(value))) {
      throw new Error(`Invalid arguments for ${option.id}`);
    }
    return [item.flag, ...item.values];
  });
  const next: string[] = [];
  for (let index = 0; index <= args.length; index++) {
    if (index === insertAt) next.push(...replacement);
    if (index < args.length && !remove.has(index)) next.push(args[index]);
  }
  return parseServerArgs(next.join('\n'));
}
