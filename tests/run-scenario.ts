import { StudioAgent } from '../apps/backend/src/agent';
import { StudioData } from '../apps/backend/src/data';
import type { ServerEvent } from '../packages/shared/index';
import type { Scenario } from './dialogue-scenarios';
export async function runDialogueScenario(data: StudioData, scenario: Scenario) {
  const events: ServerEvent[] = [];
  const agent = new StudioAgent(data, (e) => events.push(e));
  const turns = [];
  const errors: string[] = [];
  for (const turn of scenario.turns) {
    const start = performance.now();
    const from = events.length;
    let answer = '';
    try {
      answer = await agent.respond(turn.say, AbortSignal.timeout(45000));
    } catch (e) {
      errors.push(String(e));
    }
    const state = {
      programId: agent.state.programId,
      firstVisit: agent.state.firstVisit,
      total: agent.state.quote?.total ?? null,
      applied: agent.state.quote?.applied ?? null,
      bonusBalance: agent.state.lookup?.balance ?? null,
      bonusesConfirmed: agent.state.quote?.bonusesConfirmed ?? false,
      confirmedPhone: agent.state.confirmedPhone,
      pendingPhone: agent.state.pendingPhone,
    };
    const calls = events
      .slice(from)
      .filter((e) => e.type === 'diagnostic' && e.kind === 'tool') as any[];
    const expected = turn.expect ?? {};
    const routes = events
      .slice(from)
      .filter((e) => e.type === 'diagnostic' && e.kind === 'routing');
    const mismatches: string[] = [];
    for (const value of expected.contains ?? [])
      if (!answer.toLowerCase().includes(value.toLowerCase()))
        mismatches.push('Ответ не содержит: ' + value);
    for (const value of expected.excludes ?? [])
      if (answer.toLowerCase().includes(value.toLowerCase()))
        mismatches.push('Недопустимая фраза: ' + value);
    if (expected.pattern && !new RegExp(expected.pattern, 'i').test(answer))
      mismatches.push('Ответ не соответствует: ' + expected.pattern);
    for (const [key, value] of Object.entries(expected.state ?? {}))
      if ((state as any)[key] !== value)
        mismatches.push(
          `Состояние ${key}: ожидалось ${JSON.stringify(value)}, получено ${JSON.stringify((state as any)[key])}`,
        );
    for (const skill of expected.skills ?? [])
      if (!agent.state.loaded.has(skill as any)) mismatches.push('Не загружен skill ' + skill);
    for (const tool of expected.tools ?? [])
      if (!calls.some((c) => c.name === tool)) mismatches.push('Не вызвана функция ' + tool);
    if (expected.modelCalls && !calls.some((c) => c.actor === 'model'))
      mismatches.push('Не было фактических function calls модели');
    if (expected.modelRouting && !routes.length)
      mismatches.push('Не было семантического распознавания намерения моделью');
    if (expected.noVisitQuestion && /впервые.*\?|первый раз.*\?/i.test(answer))
      mismatches.push('Повторный вопрос о первом посещении');
    errors.push(...mismatches.map((m) => turn.say + ': ' + m));
    turns.push({
      user: turn.say,
      answer,
      durationMs: Math.round(performance.now() - start),
      state,
      loaded: [...agent.state.loaded.keys()],
      routes,
      calls: calls.map((c) => ({
        name: c.name,
        args: c.args,
        actor: c.actor ?? 'unmarked',
        durationMs: c.durationMs,
        sourceIds: c.result?.sources?.map((s: any) => s.id) ?? c.result?.sourceIds ?? [],
      })),
      mismatches,
    });
  }
  return { ...scenario, turns, passed: errors.length === 0, errors };
}
