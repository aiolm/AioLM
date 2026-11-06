// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { firstShard, groupHfFiles, groupSafetensorsFiles, markInstalled, selectedBundleContains, shardTotal } from './discoverUtils';

describe('GGUF download choices', () => {
  const file = (path: string, size_bytes = 10) => ({ path, size_bytes, is_mmproj: false, download_url: '' });

  it('groups all 33 shards into one choice with the first entrypoint and total size', () => {
    const parts = Array.from({ length: 33 }, (_, i) => file(`Q4/model-${String(i + 1).padStart(5, '0')}-of-00033.gguf`, i + 1)).reverse();
    const groups = groupHfFiles(parts);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ displayPath: 'Q4/model.gguf', sizeBytes: 561, file: { path: 'Q4/model-00001-of-00033.gguf' } });
    expect(groups[0].files).toHaveLength(33);
    expect(groups[0].files[0].path).toBe(groups[0].file.path);
    expect(parts[0].path).toContain('00033-of-00033');
  });

  it('keeps directories, quantizations, shard totals and single files separate', () => {
    expect(groupHfFiles([
      file('Q4/model-00001-of-00002.gguf'), file('Q4/model-00002-of-00002.gguf'),
      file('Q8/model-00001-of-00002.gguf'), file('Q4/model-00001-of-00003.gguf'),
      file('model-Q8-00001-of-00002.gguf'), file('mmproj.gguf'), file('model.gguf'),
    ])).toHaveLength(6);
  });

  it('does not group invalid shard indices or double-count duplicate tree entries', () => {
    expect(shardTotal('model-00000-of-00033.gguf')).toBeNull();
    expect(shardTotal('model-00034-of-00033.gguf')).toBeNull();
    const part = file('model-00002-of-00002.gguf');
    expect(groupHfFiles([part, part])[0]).toMatchObject({ sizeBytes: 10, file: { path: 'model-00001-of-00002.gguf' } });
  });
});

describe('downloaded GGUF shard installation marks', () => {
  it('marks the first downloaded shard as incomplete and isolates same-named files in other folders', () => {
    const first = markInstalled({}, 'Q4/model-00001-of-00002.gguf', 'models/Q4/model-00001-of-00002.gguf', 10);
    expect(first['Q4/model-00001-of-00002.gguf'].missing_shards).toEqual(['model-00002-of-00002.gguf']);
    const other = markInstalled(first, 'Q8/model-00002-of-00002.gguf', 'models/Q8/model-00002-of-00002.gguf', 10);
    expect(other['Q4/model-00001-of-00002.gguf'].missing_shards).toEqual(['model-00002-of-00002.gguf']);
    const complete = markInstalled(other, 'Q4/model-00002-of-00002.gguf', 'models/Q4/model-00002-of-00002.gguf', 10);
    expect(complete['Q4/model-00001-of-00002.gguf'].missing_shards).toEqual([]);
    expect(complete['Q4/model-00002-of-00002.gguf'].missing_shards).toEqual([]);
    expect(complete['Q8/model-00002-of-00002.gguf'].missing_shards).toEqual(['model-00001-of-00002.gguf']);
    expect(firstShard('Q4/model-00002-of-00002.gguf')).toBe('Q4/model-00001-of-00002.gguf');
  });
});

describe('Safetensors download choices', () => {
  const file = (path: string, size_bytes = 1024) => ({ path, size_bytes });

  it('groups standard split weights and counts only distinct parts in the displayed weight size', () => {
    const second = file('4bit/model-00002-of-00002.safetensors', 2048);
    expect(groupSafetensorsFiles([second, file('4bit/model-00001-of-00002.safetensors'), second])).toEqual([{
      file: file('4bit/model-00001-of-00002.safetensors'),
      files: [file('4bit/model-00001-of-00002.safetensors'), second],
      displayPath: '4bit/model.safetensors', sizeBytes: 3072, shardCount: 2, missingParts: 0,
    }]);
  });
  it('uses exact indexed membership across installed, incomplete and immediate completion metadata', () => {
    const bundle = { selected_file: 'q4/model-b.safetensors',
      selected_weight_files: ['q4/model-a.safetensors', 'q4/model-b.safetensors'] };
    const groups = groupSafetensorsFiles([
      file('q4/model-b.safetensors', 2048), file('q4/model-a.safetensors'),
      file('q8/model-a.safetensors'), file('q4/other.safetensors'),
    ], [bundle]);
    expect(groups.map(group => [group.file.path, group.sizeBytes, group.shardCount, group.missingParts])).toEqual([
      ['q4/model-a.safetensors', 3072, 2, 0], ['q8/model-a.safetensors', 1024, 1, 0],
      ['q4/other.safetensors', 1024, 1, 0],
    ]);
    expect(selectedBundleContains(bundle, 'q4/model-a.safetensors')).toBe(true);
    expect(selectedBundleContains(bundle, 'q4/model-b.safetensors')).toBe(true);
    expect(selectedBundleContains(bundle, 'q8/model-a.safetensors')).toBe(false);
    expect(selectedBundleContains({ selected_weight_files: bundle.selected_weight_files }, 'q4/model-a.safetensors')).toBe(false);
    expect(groupSafetensorsFiles([file('q4/model-b.safetensors')], [bundle])[0]).toMatchObject({
      file: { path: 'q4/model-a.safetensors' }, sizeBytes: 1024, shardCount: 2, missingParts: 1,
    });
  });


  it('keeps standalone variants, directories and different split totals independent', () => {
    const groups = groupSafetensorsFiles([
      file('model.safetensors'), file('model-fp16.safetensors'),
      file('4bit/model-00001-of-00002.safetensors'), file('8bit/model-00001-of-00002.safetensors'),
      file('4bit/model-00001-of-00003.safetensors'),
      file('model-00000-of-00002.safetensors'), file('model-00003-of-00002.safetensors'),
    ]);
    expect(groups).toHaveLength(7);
    expect(groups[2]).toMatchObject({ file: { path: '4bit/model-00001-of-00002.safetensors' }, missingParts: 1 });
    expect(groups[4]).toMatchObject({ missingParts: 2 });
    expect(groups[5].shardCount).toBe(1);
    expect(groups[6].shardCount).toBe(1);
  });

  it('keeps nonstandard separator case as distinct exact repository paths', () => {
    const groups = groupSafetensorsFiles([
      file('model-00001-OF-00002.safetensors'),
      file('model-00001-of-00002.safetensors'),
      file('model-00002-OF-00002.safetensors', 2048),
      file('model-00002-of-00002.safetensors', 2048),
    ]);
    expect(groups.map(group => [group.file.path, group.shardCount, group.missingParts, group.sizeBytes])).toEqual([
      ['model-00001-OF-00002.safetensors', 1, 0, 1024],
      ['model-00001-of-00002.safetensors', 2, 0, 3072],
      ['model-00002-OF-00002.safetensors', 1, 0, 2048],
    ]);
  });

  it('reports a missing first shard instead of presenting a partial model as complete', () => {
    expect(groupSafetensorsFiles([file('model-00002-of-00002.safetensors')])[0]).toMatchObject({
      file: { path: 'model-00001-of-00002.safetensors' }, shardCount: 2, missingParts: 1,
    });
  });
});
