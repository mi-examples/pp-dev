import { describe, it, expect } from 'vitest';
import {
  buildPageVariablesExport,
  validateValueAgainstTag,
  type TemplateVariablesSchema,
  type TemplateVariableTag,
} from '../../../src/lib/page-variables-diff.js';

describe('validateValueAgainstTag', () => {
  it('is callable directly and returns warnings for a bad value', () => {
    const issues = validateValueAgainstTag({ name: 'flag', tag_type: 'boolean' }, 'maybe');

    expect(issues).toContainEqual(expect.objectContaining({ name: 'flag', severity: 'warning' }));
  });

  it('returns no issues for a good value', () => {
    expect(validateValueAgainstTag({ name: 'flag', tag_type: 'boolean' }, 'Y')).toEqual([]);
  });

  it('warns when a list value is not valid JSON', () => {
    const issues = validateValueAgainstTag({ name: 'items', tag_type: 'list' }, 'not-json');

    expect(issues).toContainEqual(expect.objectContaining({ name: 'items' }));
  });

  it('accepts a valid JSON array for a list value', () => {
    expect(validateValueAgainstTag({ name: 'items', tag_type: 'list' }, '["a","b"]')).toEqual([]);
  });

  describe('list-of-objects (additional_options as ListItemFieldConfig[])', () => {
    const rowsTag: TemplateVariableTag = {
      name: 'rows',
      tag_type: 'list',
      additional_options: [
        { name: 'id', type: 'textarea' },
        { name: 'shade', type: 'color' },
        { name: 'kind', type: 'select', options: ['a', 'b'] },
        { name: 'tags', type: 'multi-select', options: ['x', 'y', 'z'] },
        'plain-string-field',
      ],
    };

    it('accepts well-formed items with no warnings', () => {
      const value = JSON.stringify([
        { id: '1', shade: '#075b7e', kind: 'a', tags: 'x,y', 'plain-string-field': 'hi' },
      ]);

      expect(validateValueAgainstTag(rowsTag, value)).toEqual([]);
    });

    it('warns when an item is not an object', () => {
      const value = JSON.stringify(['just-a-string']);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ name: 'rows', message: expect.stringContaining('should be an object') }),
      );
    });

    it('warns about a missing declared field', () => {
      const value = JSON.stringify([{ id: '1' }]);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('missing field "shade"') }),
      );
    });

    it('warns about an unexpected field not declared in additional_options', () => {
      const value = JSON.stringify([
        { id: '1', shade: '#000', kind: 'a', tags: 'x', 'plain-string-field': 'hi', extra: 'nope' },
      ]);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('unexpected field(s)') }),
      );
    });

    it('warns on an invalid color field value', () => {
      const value = JSON.stringify([
        { id: '1', shade: 'not-a-color', kind: 'a', tags: 'x', 'plain-string-field': 'hi' },
      ]);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('field "shade"') }),
      );
    });

    it('warns on a select field value outside the declared options', () => {
      const value = JSON.stringify([
        { id: '1', shade: '#000', kind: 'nope', tags: 'x', 'plain-string-field': 'hi' },
      ]);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('field "kind"') }),
      );
    });

    it('warns on a multi-select field with a token outside the declared options', () => {
      const value = JSON.stringify([
        { id: '1', shade: '#000', kind: 'a', tags: 'x,nope', 'plain-string-field': 'hi' },
      ]);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('field "tags"') }),
      );
    });

    it('warns when a field value is not a string', () => {
      const value = JSON.stringify([{ id: 1, shade: '#000', kind: 'a', tags: 'x', 'plain-string-field': 'hi' }]);

      expect(validateValueAgainstTag(rowsTag, value)).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('should be a string') }),
      );
    });

    it('skips per-item validation for a flat list (empty additional_options)', () => {
      const flatTag: TemplateVariableTag = { name: 'items', tag_type: 'list', additional_options: '' };

      expect(validateValueAgainstTag(flatTag, '["a","b"]')).toEqual([]);
    });
  });

  it('warns when a select value does not match a declared option id/text', () => {
    const tag: TemplateVariableTag = {
      name: 'color',
      tag_type: 'select',
      additional_options: [{ id: '1', text: 'Red' }],
    };

    expect(validateValueAgainstTag(tag, 'Blue')).toContainEqual(expect.objectContaining({ name: 'color' }));
  });

  it('accepts a select value matching a declared option id or text', () => {
    const tag: TemplateVariableTag = {
      name: 'color',
      tag_type: 'select',
      additional_options: [{ id: '1', text: 'Red' }],
    };

    expect(validateValueAgainstTag(tag, '1')).toEqual([]);
    expect(validateValueAgainstTag(tag, 'Red')).toEqual([]);
  });

  it('checks every comma-separated token for a multiselect value', () => {
    const tag: TemplateVariableTag = {
      name: 'colors',
      tag_type: 'multiselect',
      additional_options: [{ id: '1', text: 'Red' }],
    };

    expect(validateValueAgainstTag(tag, '1, Red')).toEqual([]);
    expect(validateValueAgainstTag(tag, '1, Blue')).toContainEqual(expect.objectContaining({ name: 'colors' }));
  });

  it('skips the enum check for dataset-driven additional_options ({source,name} shape)', () => {
    const tag: TemplateVariableTag = {
      name: 'segment',
      tag_type: 'select',
      additional_options: { source: 'dataset', name: 'segments' },
    };

    expect(validateValueAgainstTag(tag, 'anything')).toEqual([]);
  });
});

describe('buildPageVariablesExport', () => {
  it('uses the live value when the variable is already set on the page', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'title', default_value: 'Default title' }] };

    expect(buildPageVariablesExport(schema, [{ name: 'title', value: 'Live title' }])).toEqual([
      { name: 'title', value: 'Live title' },
    ]);
  });

  it('backfills the schema default when the variable is not set on the page', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'greeting', default_value: 'hello' }] };

    expect(buildPageVariablesExport(schema, [])).toEqual([{ name: 'greeting', value: 'hello' }]);
  });

  it('exports an empty string when neither a live value nor a schema default exists', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'no_default' }] };

    expect(buildPageVariablesExport(schema, [])).toEqual([{ name: 'no_default', value: '' }]);
  });

  it('includes live-only variables absent from the schema', () => {
    expect(buildPageVariablesExport({ tags: [] }, [{ name: 'legacy', value: 'x' }])).toEqual([
      { name: 'legacy', value: 'x' },
    ]);
  });

  it('degraded mode (schema === null) exports the live values as-is', () => {
    expect(buildPageVariablesExport(null, [{ name: 'title', value: 'Live' }])).toEqual([
      { name: 'title', value: 'Live' },
    ]);
  });
});
