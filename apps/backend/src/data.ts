import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  calculateQuote,
  normalizePhone,
  programIdSchema,
  type Program,
  type ProgramId,
  type KnowledgeSource,
  type BonusLookupResult,
} from '../../../packages/shared/index';

export const skillCatalog = {
  wheel: 'Консультация по гончарному кругу',
  handbuilding: 'Консультация по ручной лепке',
  date: 'Свидание для двоих',
  bonuses: 'Проверка бонусов по подтверждённому телефону',
} as const;
export type SkillId = keyof typeof skillCatalog;
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}
const programSchema = z
  .object({
    id: programIdSchema,
    name: z.string(),
    participants: z.number().int().positive(),
    durationMinutes: z.number().int().positive(),
    price: z.number().int().positive(),
  })
  .strict();
export class StudioData {
  readonly programs: Program[];
  readonly knowledge: KnowledgeSource[];
  readonly customers: ReadonlyArray<{ phone: string; balance: number }>;
  readonly policy: {
    sourceId: string;
    rublesPerBonus: number;
    maxCoveragePercent: number;
    firstVisitDiscountPercent: number;
  };
  constructor(readonly root: string) {
    const json = (name: string) =>
      JSON.parse(readFileSync(join(root, 'data', name + '.json'), 'utf8').replace(/^\uFEFF/, ''));
    this.programs = freeze(
      z.object({ demo: z.literal(true), programs: z.array(programSchema) }).parse(json('catalog'))
        .programs,
    );
    this.knowledge = freeze(
      z
        .object({
          demo: z.literal(true),
          sources: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              text: z.string(),
              tags: z.array(z.string()),
            }),
          ),
        })
        .parse(json('knowledge')).sources,
    );
    this.customers = freeze(
      z
        .object({
          demo: z.literal(true),
          customers: z.array(
            z.object({ phone: z.string(), balance: z.number().int().nonnegative() }),
          ),
        })
        .parse(json('customers')).customers,
    );
    this.policy = freeze(
      z
        .object({
          demo: z.literal(true),
          sourceId: z.string(),
          rublesPerBonus: z.literal(1),
          maxCoveragePercent: z.number().int().min(0).max(100),
          firstVisitDiscountPercent: z.literal(0),
        })
        .parse(json('bonus-policy')),
    );
  }
  skill(id: string): string {
    if (!(id in skillCatalog) || !Object.hasOwn(skillCatalog, id))
      throw new Error('Неизвестный сценарий');
    return readFileSync(join(this.root, 'skills', id, 'SKILL.md'), 'utf8');
  }
  program(id: ProgramId): Program {
    const result = this.programs.find((p) => p.id === id);
    if (!result) throw new Error('Неизвестная программа');
    return result;
  }
  lookup(phone: string): BonusLookupResult {
    const normalized = normalizePhone(phone);
    if (!normalized) throw new Error('Неполный телефон');
    const c = this.customers.find((c) => c.phone === normalized);
    return {
      found: !!c,
      balance: c?.balance ?? null,
      phone: normalized,
      sourceId: 'demo-customers',
    };
  }
  quote(id: ProgramId, balance: number | null) {
    return calculateQuote(this.program(id), balance, this.policy.maxCoveragePercent);
  }
  search(query: string): KnowledgeSource[] {
    const normalized = query.toLowerCase().replace(/ё/g, 'е');
    const words = normalized.match(/[а-яa-z0-9]{3,}/g) ?? [];
    const synonym: Record<string, string> = {
      леп: 'лепка',
      круг: 'wheel',
      гончар: 'wheel',
      пар: 'date',
      свидан: 'date',
      вдво: 'date',
      дво: 'date',
      ручн: 'handbuilding',
      бонус: 'bonus',
      скид: 'bonus',
      баланс: 'bonus',
      цен: 'price',
      сто: 'price',
      стоим: 'price',
      материал: 'включено',
      обжиг: 'включено',
      нович: 'опыт',
      перв: 'впервые',
      забра: 'готовность',
    };
    const terms = new Set(
      words.flatMap((w) => [
        w,
        ...Object.entries(synonym)
          .filter(([k]) => w.startsWith(k))
          .map(([, v]) => v),
      ]),
    );
    if (!terms.size) return [];
    const catalog = this.programs.map((p) => ({
      id: 'catalog:' + p.id,
      title: p.name,
      text: `${p.name}: ${p.participants} чел., ${p.durationMinutes} минут, ${p.price} рублей ${p.id === 'date' ? 'за пару' : 'за человека'}.`,
      tags: [p.id, 'price', 'программа', 'цена'],
    }));
    const policy = {
      id: this.policy.sourceId,
      title: 'Бонусные правила',
      text: `1 бонус = ${this.policy.rublesPerBonus} рубль. Максимум ${this.policy.maxCoveragePercent}% цены программы. За первый визит отдельной скидки нет. Бонусы не списываются. Для проверки нужен подтверждённый телефон.`,
      tags: ['bonus', 'бонус', 'скидка', 'первый'],
    };
    const facets: [RegExp, string][] = [
      [/подготов|одежд|ногт|фартук/, 'preparation'],
      [/включ|материал|обжиг/, 'included'],
      [/забра|срок|готовност/, 'ready-time'],
      [/вперв|опыт|нович/, 'beginners'],
      [/разниц|отлич|сравн/, 'techniques'],
      [/бонус|скидк|баланс/, 'bonus-policy'],
      [/адрес|лицензи|расписан|запис|брон/, 'scope'],
    ];
    return [...this.knowledge, ...catalog, policy]
      .map((source) => ({
        source,
        score:
          facets.reduce(
            (n, [pattern, id]) => n + (source.id === id && pattern.test(normalized) ? 10 : 0),
            0,
          ) +
          [...terms].reduce(
            (score, term) =>
              score +
              Number(
                (source.title + ' ' + source.text + ' ' + source.tags.join(' '))
                  .toLowerCase()
                  .replace(/ё/g, 'е')
                  .includes(term),
              ),
            0,
          ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
      .map((x) => x.source);
  }
}
