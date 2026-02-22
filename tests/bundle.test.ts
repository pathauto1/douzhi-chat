import { describe, expect, it } from 'vitest';
import { buildBundle } from '../src/core/bundle.js';

describe('buildBundle', () => {
  it('should create a bundle with just a prompt', async () => {
    const bundle = await buildBundle({ prompt: 'Hello world' });
    expect(bundle).toContain('# Prompt');
    expect(bundle).toContain('Hello world');
  });

  it('should include file paths header when files are specified but none match', async () => {
    const bundle = await buildBundle({
      prompt: 'Test prompt',
      files: ['nonexistent_pattern_xyz/**'],
    });
    expect(bundle).toContain('# Prompt');
    expect(bundle).toContain('Test prompt');
    expect(bundle).toContain('No files matched');
  });
});
