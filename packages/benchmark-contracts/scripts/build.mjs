import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const configPath = join(packageRoot, 'tsconfig.json');
const config = ts.readConfigFile(configPath, ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
const program = ts.createProgram(parsed.fileNames, parsed.options);
const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
  getCanonicalFileName: name => name, getCurrentDirectory: () => packageRoot, getNewLine: () => '\n',
}));
const outputRoot = join(packageRoot, 'dist');
const generated = new Set();
// Avoid invalidating a running app's workspace imports when a rebuild emits
// identical modules. Retired modules must also stop shipping in npm packs.
function writeGeneratedFile(name, text) {
  generated.add(resolve(name));
  if (existsSync(name) && readFileSync(name, 'utf8') === text) return;
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, text);
}
const emitted = program.emit(undefined, writeGeneratedFile);
if (emitted.emitSkipped) throw new Error('Benchmark contract declarations could not be built.');

// Native ESM imports need no JSON module attributes or filesystem access at runtime.
const schema = JSON.parse(readFileSync(join(packageRoot, 'schema/public-benchmark.schema.json'), 'utf8'));
const openapi = JSON.parse(readFileSync(join(packageRoot, 'schema/openapi.json'), 'utf8'));
const receipt = openapi.paths['/v1/benchmark-runs'].post.responses['201'].content['application/json'].schema;
const publication = JSON.parse(readFileSync(join(packageRoot, 'schema/publication.schema.json'), 'utf8'));
const freeze = 'const freeze = value => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === "object" && !Object.isFrozen(child)) freeze(child); return value; };';
writeGeneratedFile(join(outputRoot, 'schema.js'), `${freeze}\nexport const publicBenchmarkSchema = freeze(${JSON.stringify(schema)});\nexport const benchmarkReceiptSchema = freeze(${JSON.stringify(receipt)});\nexport const publicationSchema = freeze(${JSON.stringify(publication)});\n`);
writeGeneratedFile(join(outputRoot, 'schema.d.ts'), readFileSync(join(packageRoot, 'src/schema.d.ts'), 'utf8'));
for (const entry of readdirSync(outputRoot, { withFileTypes: true })) {
  const name = join(outputRoot, entry.name);
  if (entry.isFile() && /\.(?:js|d\.ts)$/.test(entry.name) && !generated.has(resolve(name))) unlinkSync(name);
}
