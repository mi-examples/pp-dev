import { describe, it, expect } from 'vitest';
import {
  buildPageVariablesExport,
  planPageVariablesImport,
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

describe('planPageVariablesImport', () => {
  it('skips a source variable with no matching name in the current schema', () => {
    const plan = planPageVariablesImport({ tags: [{ name: 'title' }] }, [{ name: 'legacy', value: 'x' }]);

    expect(plan.importable).toEqual([]);
    expect(plan.skipped).toEqual([
      { name: 'legacy', sourceValue: 'x', reason: "Not in the current page's schema." },
    ]);
  });

  it('imports a matched text variable regardless of content', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'title', tag_type: 'text' }] };
    const plan = planPageVariablesImport(schema, [{ name: 'title', value: 'Q1 Recap' }]);

    expect(plan.importable).toEqual([{ name: 'title', sourceValue: 'Q1 Recap', tagType: 'text' }]);
    expect(plan.skipped).toEqual([]);
  });

  it('imports a select/multiselect value even when it does not match any declared option', () => {
    const schema: TemplateVariablesSchema = {
      tags: [{ name: 'region', tag_type: 'select', additional_options: ['east', 'west'] }],
    };
    const plan = planPageVariablesImport(schema, [{ name: 'region', value: 'north' }]);

    expect(plan.importable).toEqual([{ name: 'region', sourceValue: 'north', tagType: 'select' }]);
    expect(plan.skipped).toEqual([]);
  });

  describe('boolean', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'flag', tag_type: 'boolean' }] };

    it('imports a recognized boolean encoding', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'flag', value: 'true' }]);

      expect(plan.importable).toEqual([{ name: 'flag', sourceValue: 'true', tagType: 'boolean' }]);
    });

    it('skips an unrecognized boolean value', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'flag', value: 'maybe' }]);

      expect(plan.importable).toEqual([]);
      expect(plan.skipped).toEqual([
        { name: 'flag', sourceValue: 'maybe', reason: 'Not a recognized boolean value ("maybe").' },
      ]);
    });
  });

  describe('color', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'accent', tag_type: 'color' }] };

    it('imports a valid hex color', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'accent', value: '#2563eb' }]);

      expect(plan.importable).toEqual([{ name: 'accent', sourceValue: '#2563eb', tagType: 'color' }]);
    });

    it('imports an empty value', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'accent', value: '' }]);

      expect(plan.importable).toEqual([{ name: 'accent', sourceValue: '', tagType: 'color' }]);
    });

    it('skips a value that is not a recognized color', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'accent', value: 'blue' }]);

      expect(plan.skipped).toEqual([
        { name: 'accent', sourceValue: 'blue', reason: 'Not a recognized color value ("blue").' },
      ]);
    });
  });

  describe('list', () => {
    const schema: TemplateVariablesSchema = { tags: [{ name: 'regions', tag_type: 'list' }] };

    it('imports a valid JSON array', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'regions', value: '["east","west"]' }]);

      expect(plan.importable).toEqual([{ name: 'regions', sourceValue: '["east","west"]', tagType: 'list' }]);
    });

    it('imports a JSON null as an empty list', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'regions', value: 'null' }]);

      expect(plan.importable).toEqual([{ name: 'regions', sourceValue: 'null', tagType: 'list' }]);
    });

    it('imports an empty string', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'regions', value: '' }]);

      expect(plan.importable).toEqual([{ name: 'regions', sourceValue: '', tagType: 'list' }]);
    });

    it('skips a JSON value that is not an array', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'regions', value: '{"a":1}' }]);

      expect(plan.skipped).toEqual([
        { name: 'regions', sourceValue: '{"a":1}', reason: 'Value is valid JSON but not an array.' },
      ]);
    });

    it('skips a value that is not valid JSON', () => {
      const plan = planPageVariablesImport(schema, [{ name: 'regions', value: 'not-json' }]);

      expect(plan.skipped).toEqual([
        { name: 'regions', sourceValue: 'not-json', reason: 'Value is not valid JSON.' },
      ]);
    });
  });

  it('degraded mode (schema === null) skips everything', () => {
    const plan = planPageVariablesImport(null, [{ name: 'title', value: 'x' }]);

    expect(plan.importable).toEqual([]);
    expect(plan.skipped).toEqual([{ name: 'title', sourceValue: 'x', reason: "Not in the current page's schema." }]);
  });
});
