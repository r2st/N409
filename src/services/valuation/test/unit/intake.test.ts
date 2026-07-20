import { describe, expect, it } from 'vitest';
import {
  computeCompletion,
  INTAKE_FIELD_KEYS,
  INTAKE_SECTIONS,
  isAnswered,
} from '../../src/domain/intake.js';

describe('intake', () => {
  describe('isAnswered', () => {
    it('treats null/undefined/blank as unanswered', () => {
      expect(isAnswered(null)).toBe(false);
      expect(isAnswered(undefined)).toBe(false);
      expect(isAnswered('')).toBe(false);
      expect(isAnswered('   ')).toBe(false);
    });
    it('treats 0 and false as valid answers', () => {
      expect(isAnswered(0)).toBe(true);
      expect(isAnswered(false)).toBe(true);
      expect(isAnswered('x')).toBe(true);
    });
  });

  describe('computeCompletion', () => {
    it('is 0% for an empty questionnaire', () => {
      const c = computeCompletion({});
      expect(c.requiredAnswered).toBe(0);
      expect(c.percentComplete).toBe(0);
      expect(c.ready).toBe(false);
      expect(c.sections.every((s) => !s.complete)).toBe(true);
    });

    it('counts required fields answered per section', () => {
      const c = computeCompletion({
        legal_name: 'Acme',
        state_of_incorporation: 'Delaware',
        incorporation_date: '2020-01-01',
        industry: 'SaaS',
        business_description: 'We do things.',
      });
      const company = c.sections.find((s) => s.key === 'company')!;
      expect(company.complete).toBe(true);
      expect(company.requiredAnswered).toBe(company.requiredTotal);
      expect(c.ready).toBe(false); // other sections still incomplete
    });

    it('reaches ready=100% when every required field is answered', () => {
      const answers: Record<string, unknown> = {};
      for (const section of INTAKE_SECTIONS) {
        for (const field of section.fields) {
          if (!field.required) continue;
          answers[field.key] = field.type === 'boolean' ? true : field.type === 'number' ? 1 : 'x';
        }
      }
      const c = computeCompletion(answers);
      expect(c.ready).toBe(true);
      expect(c.percentComplete).toBe(100);
      expect(c.requiredAnswered).toBe(c.requiredTotal);
    });
  });

  it('INTAKE_FIELD_KEYS covers every field', () => {
    const total = INTAKE_SECTIONS.reduce((n, s) => n + s.fields.length, 0);
    expect(INTAKE_FIELD_KEYS.size).toBe(total);
  });
});
