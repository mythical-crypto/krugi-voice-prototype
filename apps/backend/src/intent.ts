import type { ProgramId } from '../../../packages/shared/index';

const aliases: [RegExp, ProgramId][] = [
  [/круг|гончар/g, 'wheel'],
  [/леп[кить]|ручн.{0,12}форм/g, 'handbuilding'],
  [/свидани|парно|вдво[её]м|(?:для|на) (?:двоих|двух|2)|нас (?:двое|два)/g, 'date'],
];
function mentions(text: string) {
  return aliases
    .flatMap(([pattern, id]) =>
      [...text.matchAll(pattern)].map((match) => ({ id, index: match.index })),
    )
    .sort((a, b) => a.index - b.index);
}
export function programIntent(text: string, previous: ProgramId | null) {
  const all = mentions(text);
  const distinct = [...new Set(all.map((m) => m.id))];
  const comparison =
    /разниц|отлич|сравн/.test(text) ||
    (distinct.length > 1 && /или|что лучше|что выбрать|какое.*подой/.test(text));
  if (comparison)
    return { target: null, comparison: true, ambiguous: false, mentioned: all.length > 0 };
  const choice = [...text.matchAll(/хочу|выбираю|предпочитаю|давайте|лучше|теперь/g)].at(-1);
  if (choice) {
    const segment = text.slice(choice.index! + choice[0].length).split('вместо')[0]!;
    const chosen = mentions(segment);
    if (chosen.length)
      return {
        target: chosen.at(-1)!.id,
        comparison: false,
        ambiguous: false,
        mentioned: all.length > 0,
      };
  }
  if (/не .*,? а /.test(text)) {
    const after = text.split(/,? а /).at(-1)!;
    const chosen = mentions(after);
    if (chosen.length)
      return {
        target: chosen.at(-1)!.id,
        comparison: false,
        ambiguous: false,
        mentioned: all.length > 0,
      };
  }
  return {
    target: distinct.length === 1 ? distinct[0]! : all.length ? null : previous,
    comparison: false,
    ambiguous: distinct.length > 1,
    mentioned: all.length > 0,
  };
}
export function isAffirmation(text: string) {
  const value = text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[.,!?;:—-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [
    'да',
    'верно',
    'правильно',
    'все верно',
    'все правильно',
    'да все верно',
    'да все правильно',
    'да верно',
    'да правильно',
    'да конечно',
    'конечно',
    'подтверждаю',
    'ага',
    'угу',
    'точно',
    'абсолютно верно',
    'совершенно верно',
    'номер верный',
    'номер правильный',
    'да это мой номер',
  ].includes(value);
}
export function explicitVisit(text: string): 'да' | 'нет' | null {
  if (/не впервые|не первый|(?:второй|третий|четвертый) раз/.test(text)) return 'нет';
  if (
    /впервые|первый раз|первое посещение|ни разу.*не|никогда.*не|раньше.*не (?:был|была|ходил|занимал)/.test(
      text,
    )
  )
    return 'да';
  if (
    /уже (?:у вас )?(?:был|были|была|бывал|занимал)|(?:был|была|бывали|занимал).*раньше/.test(text)
  )
    return 'нет';
  return null;
}
