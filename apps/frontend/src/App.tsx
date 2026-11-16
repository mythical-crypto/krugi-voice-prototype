import { useEffect, useRef, useState, type FormEvent } from 'react';
import { AudioSession, pcmToBase64 } from './audio';
import {
  programIdSchema,
  serverEventSchema,
  type Program,
  type Quote,
  type Status,
} from '../../../packages/shared';

type Message = { id: number; role: 'user' | 'assistant'; text: string };
type Diagnostic = {
  id: number;
  kind: string;
  actor?: 'model' | 'policy';
  name?: string;
  args?: unknown;
  result?: unknown;
  durationMs?: number;
};

const statusLabels: Record<Status, string> = {
  listening: 'Слушаю',
  searching: 'Ищу информацию',
  speaking: 'Отвечаю',
  error: 'Ошибка',
};
const rubles = new Intl.NumberFormat('ru-RU', {
  style: 'currency',
  currency: 'RUB',
  maximumFractionDigits: 0,
});
const formatRubles = (value: number) => rubles.format(value);
let nextId = 1;

function diagnosticLabel(item: Diagnostic) {
  if (item.name) return item.name;
  if (item.kind === 'latency') return 'Время ответа';
  if (item.kind === 'tts') return 'Синтез речи';
  return item.kind;
}

function parseQuote(value: unknown): Quote | null {
  if (!value || typeof value !== 'object') return null;
  const quote = value as Record<string, unknown>;
  const programId = programIdSchema.safeParse(quote.programId);
  if (
    typeof quote.programId !== 'string' ||
    typeof quote.programName !== 'string' ||
    typeof quote.basePrice !== 'number' ||
    typeof quote.total !== 'number' ||
    typeof quote.applied !== 'number' ||
    typeof quote.bonusesConfirmed !== 'boolean' ||
    !(quote.bonusBalance === null || typeof quote.bonusBalance === 'number') ||
    !Array.isArray(quote.sourceIds) ||
    !quote.sourceIds.every((id) => typeof id === 'string') ||
    !programId.success
  )
    return null;
  return {
    programId: programId.data,
    programName: quote.programName,
    basePrice: quote.basePrice,
    bonusBalance: quote.bonusBalance,
    applied: quote.applied,
    total: quote.total,
    bonusesConfirmed: quote.bonusesConfirmed,
    sourceIds: quote.sourceIds,
  };
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [starting, setStarting] = useState(false);
  const [status, setStatus] = useState<Status>('listening');
  const [muted, setMuted] = useState(false);
  const [microphone, setMicrophone] = useState(false);
  const [microphoneLevel, setMicrophoneLevel] = useState(0);
  const meterAtRef = useRef(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [partial, setPartial] = useState('');
  const [text, setText] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [health, setHealth] = useState('Проверяю локальные модели…');
  const socketRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<AudioSession | null>(null);
  const maxTurnRef = useRef(-1);
  const blockedTurnRef = useRef(-1);
  const statusRef = useRef<Status>('listening');
  const generationRef = useRef(0);
  const speechFramesRef = useRef(0);
  const noiseRef = useRef(0.008);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 6000);
    void Promise.all([
      fetch('/api/catalog', { signal: controller.signal }).then(async (response) => {
        if (!response.ok) throw new Error('Каталог недоступен.');
        const data = (await response.json()) as { programs?: Program[] };
        if (Array.isArray(data.programs)) setPrograms(data.programs);
      }),
      fetch('/api/health', { signal: controller.signal }).then(async (response) => {
        const data = (await response.json()) as { llm?: boolean; voice?: boolean };
        setHealth(data.llm && data.voice ? 'Все модели работают локально' : 'Модели ещё не готовы');
      }),
    ])
      .catch(() => {
        if (!controller.signal.aborted) setHealth('Нет связи с локальным сервером');
        else setHealth('Сервер не ответил вовремя');
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, partial]);

  useEffect(
    () => () => {
      generationRef.current++;
      socketRef.current?.close();
      audioRef.current?.close();
    },
    [],
  );

  function send(data: unknown) {
    if (socketRef.current?.readyState === WebSocket.OPEN)
      socketRef.current.send(JSON.stringify(data));
  }

  function interrupt() {
    blockedTurnRef.current = Math.max(blockedTurnRef.current, maxTurnRef.current);
    audioRef.current?.interrupt();
    speechFramesRef.current = 0;
    send({ type: 'interrupt' });
    setStatus('listening');
    statusRef.current = 'listening';
  }

  function receive(raw: string) {
    let event;
    try {
      const parsed: unknown = JSON.parse(raw);
      event = serverEventSchema.parse(parsed);
    } catch {
      setError('Сервер прислал непонятное сообщение. Завершите разговор и запустите снова.');
      return;
    }
    if ('turnId' in event) maxTurnRef.current = Math.max(maxTurnRef.current, event.turnId);
    switch (event.type) {
      case 'status':
        if (typeof event.status === 'string' && event.status in statusLabels) {
          statusRef.current = event.status as Status;
          setStatus(
            audioRef.current?.playing && event.status === 'listening'
              ? 'speaking'
              : (event.status as Status),
          );
        }
        break;
      case 'transcript':
        if (typeof event.text !== 'string') break;
        if (event.final === true) {
          setPartial('');
          if (event.text.trim())
            setMessages((old) => [
              ...old.slice(-99),
              { id: nextId++, role: 'user', text: event.text as string },
            ]);
        } else setPartial(event.text);
        break;
      case 'assistant':
        if (
          typeof event.text !== 'string' ||
          typeof event.turnId !== 'number' ||
          event.turnId <= blockedTurnRef.current
        )
          break;
        setMessages((old) => [
          ...old.slice(-99),
          { id: nextId++, role: 'assistant', text: event.text as string },
        ]);
        break;
      case 'audio':
        if (
          typeof event.audio !== 'string' ||
          event.audio.length > 600_000 ||
          typeof event.turnId !== 'number' ||
          event.turnId <= blockedTurnRef.current ||
          event.turnId < maxTurnRef.current ||
          typeof event.sampleRate !== 'number' ||
          event.sampleRate < 8000 ||
          event.sampleRate > 96000 ||
          event.channels !== 1
        )
          break;
        try {
          audioRef.current?.play(event.audio, event.sampleRate, () => setStatus(statusRef.current));
          setStatus('speaking');
        } catch {
          setError('Не удалось воспроизвести ответ. Текст остаётся в расшифровке.');
        }
        break;
      case 'interrupted':
        if (typeof event.turnId === 'number')
          blockedTurnRef.current = Math.max(blockedTurnRef.current, event.turnId);
        audioRef.current?.interrupt();
        setStatus('listening');
        break;
      case 'quote':
        setQuote(parseQuote(event.quote));
        break;
      case 'diagnostic':
        if (typeof event.kind === 'string')
          setDiagnostics((old) => [
            ...old.slice(-99),
            {
              id: nextId++,
              kind: event.kind as string,
              ...(event.actor ? { actor: event.actor } : {}),
              ...(typeof event.name === 'string' ? { name: event.name } : {}),
              ...(event.args !== undefined ? { args: event.args } : {}),
              ...(event.result !== undefined ? { result: event.result } : {}),
              ...(typeof event.durationMs === 'number' ? { durationMs: event.durationMs } : {}),
            },
          ]);
        break;
      case 'error':
        setError(
          typeof event.message === 'string' ? event.message : 'Произошла ошибка локальной модели.',
        );
        setStatus('error');
        break;
    }
  }

  async function start(withMicrophone: boolean) {
    if (starting || socketRef.current) return;
    const generation = ++generationRef.current;
    setStarting(true);
    setError('');
    setNotice('');
    setMessages([]);
    setDiagnostics([]);
    setQuote(null);
    setPartial('');
    setMuted(false);
    setMicrophone(false);
    maxTurnRef.current = -1;
    blockedTurnRef.current = -1;
    speechFramesRef.current = 0;
    const audio = new AudioSession();
    audioRef.current = audio;
    try {
      await audio.resume();
      if (withMicrophone) {
        try {
          setNotice(
            'Разрешите микрофон в запросе браузера. Ожидание можно отменить кнопкой «Завершить разговор».',
          );
          await audio.openMicrophone(({ pcm, rms }) => {
            if (performance.now() - meterAtRef.current > 160) {
              meterAtRef.current = performance.now();
              setMicrophoneLevel(Math.min(1, rms * 10));
            }
            const ws = socketRef.current;
            if (ws?.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 256_000) return;
            if (audio.playing || statusRef.current === 'speaking') {
              const threshold = Math.max(0.045, noiseRef.current * 4);
              speechFramesRef.current = rms > threshold ? speechFramesRef.current + 1 : 0;
              if (speechFramesRef.current >= 3) interrupt();
            } else {
              speechFramesRef.current = 0;
              if (rms < 0.03) noiseRef.current = noiseRef.current * 0.95 + rms * 0.05;
            }
            ws.send(JSON.stringify({ type: 'pcm', audio: pcmToBase64(pcm) }));
          });
          if (generation !== generationRef.current) {
            audio.close();
            return;
          }
          setMicrophone(true);
          setNotice('');
        } catch (cause) {
          if (generation !== generationRef.current) return;
          const detail = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
          setNotice(`Не удалось подключить микрофон. ${detail}`);
          setDiagnostics((old) => [
            ...old,
            { id: nextId++, kind: 'microphone', name: 'capture_error', result: detail },
          ]);
          audio.close();
          audioRef.current = null;
          return;
        }
      } else setNotice('Текстовый режим: вводите реплики, Светлана отвечает голосом.');
      const response = await fetch('/api/sessions', {
        method: 'POST',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error('Не удалось создать разговор. Проверьте запуск локальных моделей.');
      const session = (await response.json()) as { id?: string };
      if (typeof session.id !== 'string') throw new Error('Сервер не вернул номер разговора.');
      if (generation !== generationRef.current) return;
      const socket = new WebSocket(
        `ws://127.0.0.1:3150/ws?session=${encodeURIComponent(session.id)}`,
      );
      socketRef.current = socket;
      const openTimer = window.setTimeout(() => {
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.close();
          setError('Не удалось подключиться к локальному серверу.');
        }
      }, 10_000);
      socket.onopen = () => {
        window.clearTimeout(openTimer);
        if (generation !== generationRef.current) {
          socket.close();
          return;
        }
        setConnected(true);
        setStatus('listening');
        statusRef.current = 'listening';
        setStarting(false);
        socket.send(JSON.stringify({ type: 'start' }));
      };
      socket.onmessage = (event) => {
        if (generation === generationRef.current && typeof event.data === 'string')
          receive(event.data);
      };
      socket.onerror = () => {
        if (generation === generationRef.current)
          setError('Связь с локальным сервером прервана. Проверьте окно запуска.');
      };
      socket.onclose = () => {
        window.clearTimeout(openTimer);
        if (generation !== generationRef.current) return;
        audio.close();
        audioRef.current = null;
        socketRef.current = null;
        setConnected(false);
        setStarting(false);
        setMicrophone(false);
        setPartial('');
        setNotice('Соединение закрыто. Можно начать новый разговор.');
      };
    } catch (cause) {
      if (generation === generationRef.current) {
        setError(cause instanceof Error ? cause.message : 'Не удалось начать разговор.');
        audio.close();
        audioRef.current = null;
      }
    } finally {
      if (generation === generationRef.current && !socketRef.current) setStarting(false);
    }
  }

  function stop() {
    generationRef.current++;
    send({ type: 'stop' });
    socketRef.current?.close();
    socketRef.current = null;
    audioRef.current?.close();
    audioRef.current = null;
    setConnected(false);
    setStarting(false);
    setMicrophone(false);
    setPartial('');
    setNotice('Разговор завершён. Спасибо, что заглянули в «Круги».');
  }

  function toggleMute() {
    const value = !muted;
    audioRef.current?.mute(value);
    setMuted(value);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value || !connected) return;
    if (audioRef.current?.playing || statusRef.current !== 'listening') interrupt();
    send({ type: 'text', text: value });
    setText('');
  }

  return (
    <main className="page">
      <header className="header">
        <a className="brand" href="/" aria-label="Круги, главная">
          <span className="brand-mark" aria-hidden="true">
            ◎
          </span>
          <span>
            круги<span className="brand-caption">гончарная студия</span>
          </span>
        </a>
        <span className="local-badge">
          <span aria-hidden="true" />
          Локальный прототип
        </span>
      </header>
      <section className="intro" aria-labelledby="page-title">
        <p className="eyebrow">МЕСТО ДЛЯ ВАШЕГО ПЕРВОГО ИЗДЕЛИЯ</p>
        <h1 id="page-title">Давайте познакомимся.</h1>
        <p>Светлана поможет выбрать занятие, расскажет о студии и проверит ваши бонусы.</p>
      </section>
      <div className="layout">
        <section className="conversation panel" aria-label="Разговор со Светланой">
          <div className="conversation-heading">
            <div className="avatar" aria-hidden="true">
              С
            </div>
            <div>
              <h2>Светлана</h2>
              <p>Администратор студии «Круги»</p>
            </div>
            <span className={`status ${connected ? status : 'offline'}`} role="status">
              <span aria-hidden="true" />
              {starting ? 'Подключаюсь' : connected ? statusLabels[status] : 'Готова к разговору'}
            </span>
          </div>
          <div
            className="transcript"
            ref={transcriptRef}
            role="log"
            aria-live="polite"
            aria-label="Расшифровка разговора"
          >
            {messages.length === 0 ? (
              <div className="empty-state">
                <span className="clay-circle" aria-hidden="true">
                  ◎
                </span>
                <h3>Всё начинается с разговора</h3>
                <p>
                  Нажмите «Начать разговор» и разрешите микрофон.
                  <br />
                  Можно задавать вопросы голосом или текстом.
                </p>
              </div>
            ) : (
              messages.map((message) => (
                <article className={`message ${message.role}`} key={message.id}>
                  <span className="message-name">
                    {message.role === 'assistant' ? 'Светлана' : 'Вы'}
                  </span>
                  <p>{message.text}</p>
                </article>
              ))
            )}
            {partial ? (
              <div className="partial">
                <span>Вы говорите…</span>
                <p>{partial}</p>
              </div>
            ) : null}
          </div>
          {error ? (
            <p className="alert" role="alert">
              {error}
            </p>
          ) : null}
          {notice ? (
            <p className="notice" role="status">
              {notice}
            </p>
          ) : null}
          <div className="controls">
            {connected || starting ? (
              <>
                <button className="button primary" onClick={stop}>
                  Завершить разговор
                </button>
                {microphone ? (
                  <button
                    className={`button secondary ${muted ? 'is-muted' : ''}`}
                    aria-pressed={muted}
                    onClick={toggleMute}
                  >
                    {muted ? 'Включить микрофон' : 'Выключить микрофон'}
                  </button>
                ) : null}
                {connected ? (
                  <button className="button quiet" onClick={interrupt}>
                    Прервать ответ
                  </button>
                ) : null}
              </>
            ) : (
              <>
                <button className="button primary" onClick={() => void start(true)}>
                  Начать разговор <span aria-hidden="true">↗</span>
                </button>
                <button className="button quiet" onClick={() => void start(false)}>
                  Начать текстом
                </button>
              </>
            )}
          </div>
          <form className="text-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="message">
              Сообщение или номер телефона
            </label>
            <input
              id="message"
              autoComplete="off"
              maxLength={2000}
              placeholder={
                connected ? 'Напишите сообщение или номер телефона…' : 'Сначала начните разговор'
              }
              value={text}
              onChange={(event) => setText(event.target.value)}
              disabled={!connected}
            />
            <button
              type="submit"
              aria-label="Отправить сообщение"
              disabled={!connected || !text.trim()}
            >
              ↑
            </button>
          </form>
          <p className="privacy-note">
            {microphone && connected
              ? muted
                ? 'Микрофон выключен. '
                : 'Микрофон включён. Можно перебивать. '
              : ''}
            Речь обрабатывается на этом компьютере.
          </p>
          {microphone && connected && (
            <div className="privacy-note">
              <label>
                Уровень микрофона{' '}
                <meter
                  aria-label="Уровень микрофона"
                  min={0}
                  max={1}
                  value={muted ? 0 : microphoneLevel}
                />
              </label>
              {!muted && microphoneLevel > 0.02 ? ' Звук поступает.' : ''}
            </div>
          )}
        </section>
        <aside className="sidebar">
          <section className="panel programme-panel" aria-labelledby="programme-title">
            <p className="eyebrow">ВАШЕ ЗАНЯТИЕ</p>
            <h2 id="programme-title">{quote?.programName ?? 'Найдём что-то ваше'}</h2>
            {quote ? (
              <>
                <dl className="quote">
                  <div>
                    <dt>Стоимость занятия</dt>
                    <dd>{formatRubles(quote.basePrice)}</dd>
                  </div>
                  <div>
                    <dt>Подтверждённый баланс</dt>
                    <dd>
                      {quote.bonusesConfirmed
                        ? formatRubles(quote.bonusBalance ?? 0)
                        : 'Не проверен'}
                    </dd>
                  </div>
                  <div>
                    <dt>Применяемые бонусы</dt>
                    <dd>{quote.applied ? `−${formatRubles(quote.applied)}` : '0 ₽'}</dd>
                  </div>
                  <div className="total">
                    <dt>К оплате</dt>
                    <dd>{formatRubles(quote.total)}</dd>
                  </div>
                </dl>
                <p className="small-print">
                  {quote.bonusesConfirmed
                    ? 'Предварительный расчёт. Бонусы не списываются.'
                    : 'Базовая цена. Для проверки бонусов сообщите телефон Светлане.'}
                </p>
              </>
            ) : (
              <p className="sidebar-description">
                Расскажите Светлане, какое занятие вам интересно. Здесь появится расчёт.
              </p>
            )}
          </section>
          <section className="panel catalogue-panel" aria-labelledby="catalogue-title">
            <p className="eyebrow">ПОПРОБУЙТЕ СВОИМИ РУКАМИ</p>
            <h2 id="catalogue-title">Три способа начать</h2>
            <ul className="catalogue">
              {programs.map((program) => (
                <li key={program.id}>
                  <h3>{program.name}</h3>
                  <p>
                    {program.participants === 2 ? 'Для двоих' : 'Индивидуально'} ·{' '}
                    {program.durationMinutes} минут
                  </p>
                  <strong>
                    {formatRubles(program.price)}
                    {program.participants === 2 ? ' за пару' : ''}
                  </strong>
                </li>
              ))}
            </ul>
            <p className="small-print">Демонстрационные цены и данные студии.</p>
          </section>
          <p className="model-health">
            <span aria-hidden="true">◉</span> {health}
          </p>
        </aside>
      </div>
      <details className="diagnostics panel">
        <summary>
          Диагностика разговора <span>{diagnostics.length} событий</span>
        </summary>
        <p className="diagnostics-note">
          Фактические вызовы инструментов, загруженные сценарии, источники и длительности. Без
          внутренних рассуждений модели.
        </p>
        {diagnostics.length ? (
          <ol>
            {diagnostics.map((item) => (
              <li key={item.id}>
                <div className="diagnostic-heading">
                  <strong>{diagnosticLabel(item)}</strong>
                  {item.actor ? (
                    <span>{item.actor === 'model' ? 'Выбрала модель' : 'Правило сценария'}</span>
                  ) : null}
                  {item.durationMs !== undefined ? (
                    <span>{Math.round(item.durationMs)} мс</span>
                  ) : null}
                </div>
                {item.args !== undefined ? (
                  <pre>{JSON.stringify(item.args, null, 2).slice(0, 8000)}</pre>
                ) : null}
                {item.result !== undefined ? (
                  <pre>{JSON.stringify(item.result, null, 2).slice(0, 12000)}</pre>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="small-print">События появятся после начала разговора.</p>
        )}
      </details>
      <footer>Учебный прототип · Без записи на занятия и оплаты · Все модели локальные</footer>
    </main>
  );
}
