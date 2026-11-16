import { z } from 'zod';

export const programIds = ['wheel', 'handbuilding', 'date'] as const;
export const programIdSchema = z.enum(programIds);
export type ProgramId = z.infer<typeof programIdSchema>;
export interface Program {
  id: ProgramId;
  name: string;
  participants: number;
  durationMinutes: number;
  price: number;
}
export interface KnowledgeSource {
  id: string;
  title: string;
  text: string;
  tags: string[];
}
export type Knowledge = KnowledgeSource;
export type KnowledgeSearchResult = KnowledgeSource;
export type KnowledgeSourceId = string;
export interface Quote {
  programId: ProgramId;
  programName: string;
  basePrice: number;
  bonusBalance: number | null;
  applied: number;
  total: number;
  bonusesConfirmed: boolean;
  sourceIds: string[];
}
export interface BonusLookupResult {
  found: boolean;
  balance: number | null;
  phone: string;
  sourceId: string;
}
export interface Customer {
  phone: string;
  balance: number;
}
export const GREETING = 'Здравствуйте, гончарная студия Круги, меня зовут Светлана, слушаю вас';
const digitWords: Record<string, string> = {
  ноль: '0',
  нуль: '0',
  один: '1',
  одна: '1',
  два: '2',
  две: '2',
  три: '3',
  четыре: '4',
  пять: '5',
  шесть: '6',
  семь: '7',
  восемь: '8',
  девять: '9',
};
export function normalizePhone(value: string): string | null {
  const replaced = value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(
      /^(?:нет[,\s]*)?(?:(?:правильный|верный|новый)\s+)?(?:(?:мой\s+)?(?:номер|телефон)\s*(?:будет\s*)?[:—-]?\s*)/,
      '',
    )
    .replace(/[а-я]+/g, (word) => digitWords[word] ?? word);
  if (/[а-яa-z]/i.test(replaced.replace(/(?:мой|телефон|номер|плюс)/g, ''))) return null;
  let digits = replaced.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('9')) digits = '7' + digits;
  if (digits.length !== 11 || !/^[78]\d{10}$/.test(digits)) return null;
  return '+7' + digits.slice(1);
}
export function spokenPhone(phone: string): string {
  return phone.replace('+', '').split('').join(' ');
}
export function calculateQuote(
  program: Program,
  balance: number | null,
  maxCoveragePercent: number,
): Quote {
  if (
    !Number.isInteger(program.price) ||
    program.price <= 0 ||
    (balance !== null && (!Number.isInteger(balance) || balance < 0)) ||
    !Number.isInteger(maxCoveragePercent) ||
    maxCoveragePercent < 0 ||
    maxCoveragePercent > 100
  )
    throw new Error('Некорректные данные расчёта');
  const applied =
    balance === null
      ? 0
      : Math.min(balance, Math.floor((program.price * maxCoveragePercent) / 100));
  return {
    programId: program.id,
    programName: program.name,
    basePrice: program.price,
    bonusBalance: balance,
    applied,
    total: program.price - applied,
    bonusesConfirmed: balance !== null,
    sourceIds: ['catalog:' + program.id, 'bonus-policy'],
  };
}
export const clientEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('stop') }).strict(),
  z.object({ type: z.literal('interrupt') }).strict(),
  z.object({ type: z.literal('text'), text: z.string().trim().min(1).max(2000) }).strict(),
  z
    .object({
      type: z.literal('pcm'),
      audio: z
        .string()
        .min(2)
        .max(24000)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    })
    .strict(),
]);
export type ClientEvent = z.infer<typeof clientEventSchema>;
export type Status = 'listening' | 'searching' | 'speaking' | 'error';
export type ServerEvent =
  | { type: 'ready' }
  | { type: 'status'; status: Status }
  | { type: 'transcript'; text: string; final: boolean }
  | { type: 'assistant'; text: string; turnId: number }
  | { type: 'audio'; audio: string; sampleRate: number; channels: 1; turnId: number }
  | { type: 'audio_end'; turnId: number }
  | { type: 'interrupted'; turnId: number }
  | { type: 'quote'; quote: Quote | null }
  | {
      type: 'diagnostic';
      kind: string;
      actor?: 'model' | 'policy';
      name?: string;
      args?: unknown;
      result?: unknown;
      durationMs?: number;
    }
  | { type: 'error'; message: string };
export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({
    type: z.literal('status'),
    status: z.enum(['listening', 'searching', 'speaking', 'error']),
  }),
  z.object({ type: z.literal('transcript'), text: z.string(), final: z.boolean() }),
  z.object({ type: z.literal('assistant'), text: z.string(), turnId: z.number().int() }),
  z.object({
    type: z.literal('audio'),
    audio: z.string(),
    sampleRate: z.number().int().min(8000).max(96000),
    channels: z.literal(1),
    turnId: z.number().int(),
  }),
  z.object({ type: z.literal('audio_end'), turnId: z.number().int() }),
  z.object({ type: z.literal('interrupted'), turnId: z.number().int() }),
  z.object({ type: z.literal('quote'), quote: z.unknown().nullable() }),
  z.object({
    type: z.literal('diagnostic'),
    kind: z.string(),
    actor: z.enum(['model', 'policy']).optional(),
    name: z.string().optional(),
    args: z.unknown().optional(),
    result: z.unknown().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
