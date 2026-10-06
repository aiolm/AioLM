import fs from 'node:fs';
import process from 'node:process';
import { URL } from 'node:url';
// Browser-only benchmark imports cannot call native IPC. Keep their flag/key
// projection synchronized with the authoritative launch schema.
const source = fs.readFileSync(new URL('../src-tauri/src/providers/options.rs', import.meta.url), 'utf8');
const output = {};
const requestOutput = {};
for (const [provider, name] of [['vllm', 'VLLM_OPTIONS'], ['mlx-vlm', 'MLX_VLM_OPTIONS']]) {
  const section = source.slice(source.indexOf(`pub const ${name}`));
  const end = section.indexOf('\n];');
  if (end < 0) throw new Error(`Missing option schema ${name}`);
  output[provider] = [...section.slice(0, end).matchAll(/launch\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*OptionKind::(\w+)/g)]
    .filter(([, , , kind]) => !['Path', 'Json'].includes(kind))
    .map(([, key, flag, kind]) => ({key, flag, kind: kind.toLowerCase()}));
  if (!output[provider].length) throw new Error(`Empty option schema ${name}`);
  requestOutput[provider] = [...section.slice(0, end).matchAll(/request\(\s*"([^"]+)"\s*,/g)].map(([, key]) => key);
  if (!requestOutput[provider].length) throw new Error(`Empty request schema ${name}`);
}
const check = process.argv.includes('--check');
for (const [name, projection] of [['providerLaunchOptions', output], ['providerRequestOptions', requestOutput]]) {
  const path = new URL(`../src/shared/config/${name}.json`, import.meta.url);
  const generated = JSON.stringify(projection, null, 2) + '\n';
  if (check) {
    if (fs.readFileSync(path, 'utf8') !== generated) throw new Error(`${name}.json differs from the runtime schema; run node scripts/sync-provider-launch-options.mjs`);
  } else fs.writeFileSync(path, generated);
}
