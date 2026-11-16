import { describe, test, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { StudioData } from '../apps/backend/src/data';
import { StudioAgent } from '../apps/backend/src/agent';
import { normalizePhone, clientEventSchema } from '../packages/shared/index';
import { isPlaybackEcho } from '../apps/backend/src/echo';
const data = new StudioData(process.cwd());
const checksum = () =>
  readdirSync('data')
    .sort()
    .map((f) =>
      createHash('sha256')
        .update(readFileSync(join('data', f)))
        .digest('hex'),
    )
    .join('');
describe('verified prices and immutable sources', () => {
  test('actual visitor questions get hearing confirmation and all prices before choosing a service', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const message =
        request.tool_choice === 'required'
          ? {
              content: null,
              tool_calls: [
                {
                  id: 'ask',
                  type: 'function',
                  function: {
                    name: 'search_knowledge',
                    arguments: JSON.stringify({ query: 'price' }),
                  },
                },
              ],
            }
          : { content: 'Хотите посмотреть подробнее или выбрать?' };
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }));
    }) as typeof fetch;
    try {
      const a = new StudioAgent(data, () => {});
      expect(await a.respond('да здравствуйте мне слышно', AbortSignal.timeout(3000))).toContain(
        'слышу',
      );
      for (const line of [
        'смотреть я хочу узнать сколько это будет по стоимости',
        'нет нет я хочу что сориентировались меня по стоимость а',
      ]) {
        const answer = await a.respond(line, AbortSignal.timeout(3000));
        for (const price of ['3200', '2800', '5600']) expect(answer).toContain(price);
        expect(answer).not.toContain('посмотреть');
        expect(a.state.programId).toBeNull();
      }
    } finally {
      globalThis.fetch = original;
    }
  });
  test('zero, partial, cap and pair price', () => {
    expect(data.quote('wheel', 0).total).toBe(3200);
    expect(data.quote('wheel', 600)).toMatchObject({ total: 2600, applied: 600 });
    expect(data.quote('wheel', 2000)).toMatchObject({ total: 2560, applied: 640 });
    expect(data.quote('date', 2000)).toMatchObject({ basePrice: 5600, applied: 1120, total: 4480 });
    expect(data.quote('wheel', null).bonusesConfirmed).toBe(false);
  });
  test('telephone prefix and digit dictation never fill missing digits', () => {
    for (const value of [
      '+7 (900) 000-00-02',
      '89000000002',
      '9000000002',
      'семь девять ноль ноль ноль ноль ноль ноль ноль ноль два',
    ])
      expect(normalizePhone(value)).toBe('+79000000002');
    for (const value of [
      '9000000',
      '+700000000000',
      'семь сын ноль',
      '+79000000002 произвольный текст',
    ])
      expect(normalizePhone(value)).toBeNull();
  });
  test('unknown customer/skill, empty search and allowlist', async () => {
    expect(data.lookup('+79999999999')).toMatchObject({ found: false, balance: null });
    expect(() => data.skill('../bonuses')).toThrow();
    expect(data.search('')).toEqual([]);
    expect(data.search('qwertyzzzz')).toEqual([]);
    const a = new StudioAgent(data, () => {});
    expect(a.state.loaded.size).toBe(0);
    await expect(a.tool('shell', { command: 'whoami' })).rejects.toThrow();
    await expect(
      a.tool('calculate_quote', { programId: 'wheel', balance: 99999 }),
    ).rejects.toThrow();
  });
  test('customer confirmation, program/client changes and JSON immutability', async () => {
    const before = checksum();
    const a = new StudioAgent(data, () => {});
    await a.tool('load_skill', { id: 'wheel' });
    await a.tool('calculate_quote', { programId: 'wheel' });
    await expect(a.tool('lookup_customer', { phone: '+79000000002' })).rejects.toThrow();
    const confirmation = await a.respond('89000000002', new AbortController().signal);
    expect(confirmation).toContain('Всё верно');
    expect(a.state.lookup).toBeNull();
    expect(a.state.quote).toBeNull();
    const answer = await a.respond('да', new AbortController().signal);
    expect(answer).toContain('2600');
    expect(a.state.quote?.total).toBe(2600);
    await a.tool('load_skill', { id: 'date' });
    await a.tool('calculate_quote', { programId: 'date' });
    expect(a.state.quote?.total).toBe(5000);
    await a.respond('+79000000003', new AbortController().signal);
    expect(a.state.quote).toBeNull();
    await a.respond('да, верно', new AbortController().signal);
    expect(a.state.quote?.total).toBe(4480);
    expect(checksum()).toBe(before);
    expect(Object.isFrozen(data.programs[0])).toBe(true);
  });
  test('refused and unknown phones use base price', async () => {
    const a = new StudioAgent(data, () => {});
    await a.tool('load_skill', { id: 'wheel' });
    await a.tool('calculate_quote', { programId: 'wheel' });
    await a.respond('+79999999999', new AbortController().signal);
    expect(await a.respond('да', new AbortController().signal)).toContain('не найден');
    expect(a.state.quote).toMatchObject({ total: 3200, bonusesConfirmed: false });
    await a.respond('не хочу давать телефон', new AbortController().signal);
    expect(a.state.quote).toMatchObject({ total: 3200, bonusesConfirmed: false });
  });
  test('refusing bonuses and changing program together uses the new price', async () => {
    const a = new StudioAgent(data, () => {});
    await a.tool('load_skill', { id: 'wheel' });
    await a.tool('calculate_quote', { programId: 'wheel' });
    await a.respond('+79000000002', AbortSignal.timeout(3000));
    await a.respond('да', AbortSignal.timeout(3000));
    const answer = await a.respond(
      'Без бонусов сколько стоит свидание?',
      AbortSignal.timeout(3000),
    );
    expect(answer).toContain('5600');
    expect(answer).not.toContain('3200');
    expect(a.state.quote).toMatchObject({
      programId: 'date',
      total: 5600,
      bonusesConfirmed: false,
    });
    await a.respond('+79000000002', AbortSignal.timeout(3000));
    expect(await a.respond('Нет, не хочу давать телефон', AbortSignal.timeout(3000))).not.toContain(
      'Назовите номер заново',
    );
    expect(a.state.pendingPhone).toBeNull();
  });
  test('question-specific sources survive catalogue price matches', () => {
    expect(
      data
        .search('подготовка и цена индивидуальной ручной лепки')
        .some((s) => s.id === 'preparation'),
    ).toBe(true);
  });
  test('playback echo comparison tolerates ASR errors but preserves short human replies', () => {
    expect(
      isPlaybackEcho(
        'гончарная студия круги меня зовут светлана',
        'Здравствуйте, гончарная студия Круги, меня зовут Светлана, слушаю вас',
      ),
    ).toBe(true);
    expect(
      isPlaybackEcho(
        'хочу на гончарный круг',
        'Индивидуальное занятие на гончарном круге: 3200 рублей.',
      ),
    ).toBe(false);
    expect(isPlaybackEcho('да', 'Да, всё верно')).toBe(false);
    expect(isPlaybackEcho('всё верно', 'Я услышала номер семь девять. Всё верно?')).toBe(false);
    expect(
      isPlaybackEcho(
        'здравствуйте гончарное студия круге меня зовут с светлана слушаю вас',
        'Здравствуйте, гончарная студия Круги, меня зовут Светлана, слушаю вас',
      ),
    ).toBe(true);
  });
  test('untrusted model cannot introduce prices written in words', async () => {
    const original = globalThis.fetch;
    let searches = 0;
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const message =
        request.tool_choice === 'required'
          ? {
              content: null,
              tool_calls: [
                {
                  id: 'test_search',
                  type: 'function',
                  function: {
                    name: 'search_knowledge',
                    arguments: JSON.stringify({ query: 'программы' }),
                  },
                },
              ],
            }
          : {
              content:
                'Скидка за первый визит — пятьдесят процентов, а занятие стоит тысячу рублей.',
            };
      if (request.tool_choice === 'required') searches++;
      return new Response(JSON.stringify({ choices: [{ message, finish_reason: 'stop' }] }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    try {
      const a = new StudioAgent(data, () => {});
      const answer = await a.respond('Расскажите про занятия', AbortSignal.timeout(3000));
      expect(searches).toBe(1);
      expect(answer).not.toContain('пятьдесят');
      expect(answer).not.toContain('тысячу');
    } finally {
      globalThis.fetch = original;
    }
  });
  test('strict message validation', () => {
    for (const msg of [
      { type: 'text', text: '' },
      { type: 'text', text: 'a', shell: true },
      { type: 'pcm', audio: '<invalid>' },
      { type: 'unknown' },
    ])
      expect(clientEventSchema.safeParse(msg).success).toBe(false);
  });
});
