import { test, expect } from 'bun:test';
import { StudioData } from '../apps/backend/src/data';
import { dialogueScenarios } from './dialogue-scenarios';
import { runDialogueScenario } from './run-scenario';

const data = new StudioData(process.cwd());
for (const scenario of dialogueScenarios.filter(
  (s) => !['P17', 'P18', 'P19', 'A14', 'A25', 'A26', 'A27', 'A28', 'A30'].includes(s.id),
)) {
  test(`${scenario.id}: ${scenario.title}`, async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('Неожиданный вызов модели в детерминированном сценарии');
    }) as unknown as typeof fetch;
    try {
      const result = await runDialogueScenario(data, scenario);
      expect(result.errors).toEqual([]);
      expect(result.passed).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
}
