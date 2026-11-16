import { z } from 'zod';
import { type ProgramId } from '../../../packages/shared/index';
const schema = z
  .object({ intent: z.enum(['wheel', 'handbuilding', 'date', 'comparison', 'unknown']) })
  .strict();
export async function semanticIntent(
  text: string,
  previous: ProgramId | null,
  llmUrl: string,
  signal: AbortSignal,
) {
  const response = await fetch(llmUrl + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
    body: JSON.stringify({
      model: 'qwen3',
      temperature: 0,
      max_tokens: 80,
      chat_template_kwargs: { enable_thinking: false },
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'studio_intent', strict: true, schema: z.toJSONSchema(schema) },
      },
      messages: [
        {
          role: 'system',
          content: `Определи намерение посетителя гончарной студии. Верни JSON с единственным intent без объяснений. Выбери ровно одно значение: wheel — индивидуальный гончарный круг; handbuilding — индивидуальная ручная лепка; date — совместное свидание для двоих; comparison — посетитель явно просит сравнить программы; unknown — программу нельзя определить или вопрос посторонний. Творческий вечер с партнёром или девушкой означает date. Фигурки руками — handbuilding, вращение глины — wheel. Вопрос о цене одной услуги не является сравнением. Ранее выбранная программа: ${previous ?? 'нет'}. Если посетитель просто уточняет изделие для прежней программы, сохраняй её; при явном изменении пожеланий учитывай новый запрос. Это только классификация, факты и цены будут получены отдельно через функции.`,
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!response.ok) throw new Error('Не удалось уточнить намерение локальной моделью');
  const body = (await response.json()) as any;
  signal.throwIfAborted();
  const { intent } = schema.parse(JSON.parse(body.choices?.[0]?.message?.content ?? '{}'));
  return {
    program: intent === 'comparison' || intent === 'unknown' ? null : intent,
    comparison: intent === 'comparison',
  };
}
