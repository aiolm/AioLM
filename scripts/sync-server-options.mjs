/* global process, fetch, URL, console */
// Refresh the offline catalog from the same generated help table used by upstream.
// Usage: node scripts/sync-server-options.mjs [commit or tag]
import { writeFile } from 'node:fs/promises';
const ref = process.argv[2] || 'master';
const base = 'https://api.github.com/repos/ggml-org/llama.cpp';
const commitResponse = await fetch(`${base}/commits/${encodeURIComponent(ref)}`);
if (!commitResponse.ok) throw new Error(`Commit lookup failed: ${commitResponse.status}`);
const { sha } = await commitResponse.json();
const source = `https://raw.githubusercontent.com/ggml-org/llama.cpp/${sha}/tools/server/README.md`;
const response = await fetch(source);
if (!response.ok) throw new Error(`Help download failed: ${response.status}`);
const help = (await response.text()).split('<!-- HELP_START -->')[1]?.split('<!-- HELP_END -->')[0];
if (!help) throw new Error('Upstream help table was not found');
let group = '';
const options = [];
for (const line of help.split('\n')) {
  if (line.startsWith('### ')) group = line.slice(4).trim();
  const row = line.match(/^\| `(.+?)` \| (.*) \|$/);
  if (!row) continue;
  options.push({
    signature: row[1].replaceAll('\\|', '|'),
    description: row[2].replaceAll(/<br\s*\/?\s*>/g, '\n').replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1').replaceAll('\\|', '|'),
    group,
  });
}
if (options.length < 150) throw new Error(`Unexpectedly small catalog: ${options.length}`);
await writeFile(new URL('../src/shared/config/serverOptionsCatalog.json', import.meta.url), JSON.stringify({ source, commit: sha, options }, null, 2) + '\n');
console.log(`Saved ${options.length} server options from ${sha}`);
