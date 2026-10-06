import { describe, expect, it } from 'vitest';
import { firstShard, groupHfFiles, markInstalled, shardTotal } from './discoverUtils';

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
