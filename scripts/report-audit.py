"""Build a self-contained scenario audit. No network or external report runtime."""
from pathlib import Path
from html import escape
import json

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'runtime/reports'
OUT.mkdir(exist_ok=True)
def read(name):return json.loads((ROOT/'runtime'/name).read_text(encoding='utf-8-sig'))
before=read('scenario-audit-before.json')
after=read('scenario-audit-after.json')
voice=read('e2e-voice-report.json')
visitor=read('visitor-voice-report.json')
oldvoice=read('e2e-voice-report-moss.json')
assert after['failed']==0 and after['jsonUnchanged']
assert not voice['failures'] and not visitor['failures']
old={s['id']:s for s in before['scenarios']}
planned=[s for s in after['scenarios'] if s['scope']=='planned']
additional=[s for s in after['scenarios'] if s['scope']=='additional']
calls=[c for s in after['scenarios'] for t in s['turns'] for c in t['calls']]
model_calls=sum(c['actor']=='model' for c in calls)
policy_calls=sum(c['actor']=='policy' for c in calls)
semantic_routes=[r for s in after['scenarios'] for t in s['turns'] for r in t.get('routes',[])]
sources=sorted({sid for c in calls for sid in c['sourceIds']})
requirements=[
 ('Точное приветствие и повторный старт','Выполнено','GREETING + API lifecycle + реальные голосовые повторы'),
 ('Три услуги и распознавание намерения','Выполнено на проверенном наборе','P01–P03, P17–P19, A04–A06, A19, A25–A28 (без названия услуги)'),
 ('Отдельные skills и загрузка по намерению','Выполнено','wheel, handbuilding, date, bonuses; загрузки P13/P17–P19'),
 ('Поиск именно в базе, фрагменты с ID','Выполнено','search_knowledge: '+', '.join(sources)),
 ('Первый визит, сохранение ответа','Выполнено на проверенном наборе','P01/P04, A07/A08/A19/A23/A24'),
 ('Проверка бонусов и итог после идентификации','Выполнено, данные моковые','P07–P11, A22; lookup_customer → calculate_quote после подтверждения'),
 ('Телефон: подтверждение, исправление, отказ','Выполнено на проверенном наборе','P15/P16, A09–A13/A21/A23'),
 ('Никакого угадывания неясного телефона','Выполнено; ASR остаётся ограничением','A21; при ошибках цифр повтор/текст, без lookup'),
 ('Цены/лимит/баланс из кода и JSON','Выполнено','0/600/2000; лимит20%; 640/1120; хеш JSON не изменился'),
 ('Бесплатные локальные мозги и голос','Выполнено','Qwen3-4B + Vosk RU + Piper RU, localhost, без API-ключей'),
 ('Непрерывный голос, отмена и stale turn','Программный тракт проверен','AudioWorklet + WebSocket + worker; ACK/echo в голосовом отчёте'),
 ('Реальная CRM/телефония/запись/платёж/списание','Не входит в согласованный прототип','A16/A17 не обещают эти действия'),
]
limits='Это конечный набор проверок, а не доказательство понимания всех возможных фраз. Свободная консультация Qwen может ошибиться и занимает больше времени, чем типовой FAQ. Vosk small ошибается на цифрах, особенно повторных нулях; неполный/неясный номер не исправляется догадкой. Бонусные клиенты и знания демонстрационные. Реальная запись, расписание, CRM, телефония и платежи не подключены.'
summary=f'''# Круги — аналитика и исправления агента

Проверено относительно сообщения пользователя и согласованного плана. Первичная расширенная проверка: **{before['passed']} из {before['total']} диалогов**, найдено **{before['failed']} сбоев**. После исправлений набор расширен до **{after['passed']} из {after['total']} успешных диалогов**: {len(planned)} плановых и {len(additional)} дополнительных. Исходные 36 сценариев также проходят. JSON знаний и клиентов не изменился.

Агент гибридный: Qwen формирует свободные консультации и настоящие function calls; программная политика обрабатывает проверяемые цены, подтверждения, типовые FAQ и обязательные переходы. Это обеспечивает корректную арифметику и быстрые ответы. В трассах этого набора: **{model_calls} вызовов по выбору модели**, **{policy_calls} по правилам сценария**, **{len(semantic_routes)} семантических классификаций Qwen**. Источник вызова теперь виден в диагностике; полные внутренние рассуждения не показываются.

## Найдено и исправлено

1. Общий вопрос о цене оставался без цен из-за фильтра денежных предложений. Теперь до выбора называются все три услуги.
2. При намерении проверить бонусы не всегда загружался bonuses skill. Теперь загружается сразу, запрашивается телефон, lookup выполняется только после подтверждения.
3. Сравнение «круг или лепка» могло выбрать чужую программу и зациклить функции. Теперь сравнение не является выбором, незапрошенные функции блокируются.
4. «Круг вместо лепки» трактовался по последнему упоминанию. Добавлено направление выбора и замены.
5. «Занятие на двоих» не выбирало парную программу. Добавлены разговорные обозначения.
6. «Второй раз» / «раньше не был» не учитывались. Контекст посещения теперь сохраняется и не спрашивается повторно.
7. «Да, всё правильно» и исправление «нет, правильный номер…» терялись. Теперь подтверждения и исправления распознаются без угадывания цифр.
8. При смене услуги вместе с отказом от бонусов возвращалась старая цена. Теперь пересчитывается новая программа без баланса.
9. Запись и команды к компьютеру могли приводить к уклончивому ответу/ошибке модели. Теперь есть ясные границы возможностей.
10. Ответ «да» на вопрос о первом визите мог подтвердить старый телефон. Подтверждение номера теперь зависит от последнего вопроса.
11. Встроенный endpoint Vosk мог разрезать диктовку. Его промежуточные сегменты собираются до решения общего детектора паузы.
12. Добавлен выбор по смыслу без названия услуги: творческий вечер с девушкой, фигурка руками, вращающаяся глина. Qwen возвращает проверяемый маршрут, после чего загружается skill и рассчитывается цена. Эти фразы проверены также при ожидании телефона.
13. «Не хочу доплат, сколько стоит круг с бонусами?» ошибочно сбрасывал подтверждённый баланс. Отрицание теперь связано с конкретным объектом отказа; бонусы сохраняются до явного отказа от них (A29).
14. При браузерной проверке близкая формулировка про вечер с девушкой дала противоречивые program=date и comparison=true. Вместо двух независимых признаков модель выбирает ровно один intent; комбинация больше невозможна (A30).

## Голос и скорость

По умолчанию установлен русский Piper Irina. MOSS/Bella сохранён как резерв. Синтез приветствия занимает около 0,2 с; скорость синтеза RTF 0,04–0,06. Измерение полной цепочки включает ASR, вычисления/модель и начало содержательного PCM; не включает аудиоустройство и очередь браузера.

- Было: FAQ-медиана **{oldvoice['warmedFaqMedianMs']/1000:.3f}с**.
- Сейчас: FAQ-медиана **{voice['warmedFaqMedianMs']/1000:.3f}с**.
- Ваши вопросы о стоимости: **{min(s['endSpeechToFirstContentAudioMs'] for s in visitor['samples'][1:])/1000:.2f}–{max(s['endSpeechToFirstContentAudioMs'] for s in visitor['samples'][1:])/1000:.2f}с**.
- Первый свободный выбор программы с Qwen: **{voice['samples'][0]['endSpeechToFirstContentAudioMs']/1000:.2f}с**, он медленнее типовых запросов.

Микрофон: убран обрыв ожидания разрешения через 12 с, добавлен уровень входящего звука и причина ошибки. Внутри Codex наблюдался живой захват пользовательских реплик. Акустическая устойчивость зависит от устройства и шума.

## Сверка плана

| Требование | Статус | Доказательство |
| --- | --- | --- |
'''
summary+='\n'.join('| '+' | '.join(row)+' |' for row in requirements)
summary+='\n\n## Существенные ограничения\n\n'+limits
summary+='\n\n## Матрица сценариев\n\n| ID | Сценарий | До | После |\n| --- | --- | --- | --- |\n'
for scenario in after['scenarios']:
    prior=old.get(scenario['id'])
    status='не проверялся' if prior is None else ('пройден' if prior['passed'] else 'сбой')
    summary+=f"| {scenario['id']} | {scenario['title']} | {status} | пройден |\n"
summary+='\nПодробные реплики, состояния, вызовы и ID источников — в HTML-версии отчёта и scenario-audit-after.json. Проверка повторяется командой `tools/bun/bun.exe run test:scenarios:real` при работающем llama-server. 40 сценариев выполняются без модели в `bun run verify`.\n'
(ROOT/'ANALYSIS.md').write_text(summary,encoding='utf-8')
(OUT/'krugi-agent-analysis.md').write_text(summary,encoding='utf-8')

cards=[]
for scenario in after['scenarios']:
    prior=old.get(scenario['id']);fixed=bool(prior and not prior['passed'])
    parts=[]
    if fixed:parts.append('<div class="prior"><b>Раньше:</b> '+escape('; '.join(prior['errors']))+'</div>')
    for turn in scenario['turns']:
        trace=''.join('<li><b>'+escape(call['name'])+'</b> · '+('модель' if call['actor']=='model' else 'правило сценария')+'<code>'+escape(json.dumps(call['args'],ensure_ascii=False))+'</code><small>Источники: '+escape(', '.join(call['sourceIds']) or '—')+'</small></li>' for call in turn['calls'])
        for route in turn.get('routes',[]):
            trace+='<li><b>semantic_intent</b> · модель<code>'+escape(json.dumps(route['result'],ensure_ascii=False))+'</code><small>Распознавание смысла без полного названия услуги</small></li>'
        parts.append('<div class="turn"><p><span>Посетитель</span>'+escape(turn['user'])+'</p><p class="reply"><span>Светлана · '+str(turn['durationMs'])+' мс логика</span>'+escape(turn['answer'])+'</p><details><summary>Состояние и функции</summary><pre>'+escape(json.dumps(turn['state'],ensure_ascii=False,indent=2))+'</pre><p>Skills: '+escape(', '.join(turn['loaded']) or '—')+'</p><ul>'+trace+'</ul></details></div>')
    searchable=escape((scenario['id']+' '+scenario['title']+' '+ ' '.join(t['user']+' '+t['answer'] for t in scenario['turns'])).lower(),quote=True)
    cards.append(f'<details class="scenario" data-scope="{scenario["scope"]}" data-fixed="{int(fixed)}" data-search="{searchable}"><summary><b>{scenario["id"]}</b> {escape(scenario["title"])} <em>{"исправлен" if fixed else "пройден"}</em></summary>'+''.join(parts)+'</details>')
reqrows=''.join('<tr>'+''.join('<td>'+escape(cell)+'</td>' for cell in row)+'</tr>' for row in requirements)
html='''<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Круги — проверка ИИ-агента</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f3ee;color:#232620;font:16px/1.6 system-ui,sans-serif}main{max-width:1120px;margin:auto;padding:40px 24px}h1{font-size:clamp(28px,4vw,44px);line-height:1.15}h2{margin-top:40px}p{max-width:950px}.eyebrow{color:#71523b;letter-spacing:.12em;text-transform:uppercase;font-size:12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px}.card,.scenario,table{background:#fffdf9;border:1px solid #ddd5ca;border-radius:10px}.card{padding:18px}.card b{display:block;font-size:32px;color:#326246}.card small{display:block;color:#696257}.filters{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin:24px 0}input,select{padding:10px;border:1px solid #aaa;border-radius:6px;font:inherit}input[type=search]{min-width:280px}.scenario{margin:10px 0;padding:14px 18px}.scenario>summary{cursor:pointer;display:list-item;list-style-position:inside}.scenario em{float:right;color:#326246;font-size:13px}summary b{color:#71523b;margin-right:10px}.turn{padding:12px 0;border-top:1px solid #ddd}.turn span{display:block;color:#766d61;font-size:12px}.reply{border-left:3px solid #9ab39e;padding-left:15px}.prior{background:#fff0df;padding:12px;border-radius:6px;margin:12px 0}pre,code{white-space:pre-wrap;word-break:break-word;background:#f4f2ed;font:12px/1.5 ui-monospace,monospace;padding:9px;display:block}li small{display:block;color:#666}table{border-collapse:collapse;width:100%;font-size:14px}td,th{padding:12px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top}.scroll{overflow:auto}.note{color:#696257;font-size:14px}footer{padding:30px 0;color:#666;font-size:13px}[hidden]{display:none!important}</style><main><div class="eyebrow">Круги · локальный прототип · проверяемые диалоги</div><h1>Как работает агент и что исправлено</h1>'''
html+=f'<p>Проверка по исходному сообщению пользователя и согласованному плану. До улучшений: {before["passed"]}/{before["total"]}; после: {after["passed"]}/{after["total"]}. Дополнительные новые сценарии выделены отдельно, все исходные 36 проходят.</p><div class="cards"><div class="card"><b>{len(planned)}/{len(planned)}</b>Плановые сценарии</div><div class="card"><b>{len(additional)}/{len(additional)}</b>Дополнительные сценарии</div><div class="card"><b>{voice["warmedFaqMedianMs"]/1000:.2f}с</b>FAQ-медиана<small>Ранее {oldvoice["warmedFaqMedianMs"]/1000:.2f}с</small></div><div class="card"><b>{model_calls} / {policy_calls}</b>Вызовы функций<small>Модель / правила сценария</small></div></div>'
html+='<h2>Что соответствует плану</h2><p>Qwen выполняет свободные консультации, распознаёт смысл непрямых запросов и формирует function calls. Цены, подтверждение телефона и короткие FAQ обрабатываются проверяемыми правилами. Это гибридный агент: происхождение каждого вызова показано ниже, функции действительно исполняются. Семантических классификаций в этой проверке: '+str(len(semantic_routes))+'.</p><div class="scroll"><table><thead><tr><th>Требование</th><th>Статус</th><th>Проверка</th></tr></thead><tbody>'+reqrows+'</tbody></table></div>'
html+='<h2>Матрица диалогов</h2><p class="note">Раскройте строку, чтобы увидеть реальные ответы, состояние, загруженные skills и функции. Время в реплике — работа логики; полная голосовая задержка измеряется отдельно.</p><div class="filters"><input id="search" type="search" aria-label="Поиск сценария" placeholder="Найти вопрос или сценарий"><select id="scope" aria-label="Тип сценария"><option value="">Все сценарии</option value="planned">Из плана</option value="additional">Дополнительные</option></select><label><input id="fixed" type="checkbox"> Только найденные ранее сбои</label><span id="count"></span></div>'+''.join(cards)
html+='<h2>Границы результата</h2><p>'+escape(limits)+'</p><p>Контрольные JSON остались неизменными. Подготовка и работа используют локальные модели без API-ключей. 56 TS/API/аудио/сценарных тестов и 9 Python-тестов входят в verify; настоящая модель проверена отдельно.</p><footer>Доказательства: scenario-audit-before.json, scenario-audit-after.json, visitor-voice-report.json, e2e-voice-report.json. Все цифры относятся к текущей машине и зафиксированному набору фраз.</footer></main><script>const s=document.querySelector("#search"),t=document.querySelector("#scope"),f=document.querySelector("#fixed"),rows=[...document.querySelectorAll(".scenario")];function filter(){let n=0;for(const r of rows){r.hidden=!!((t.value&&r.dataset.scope!==t.value)||(f.checked&&r.dataset.fixed!=="1")||!r.dataset.search.includes(s.value.toLowerCase()));if(!r.hidden)n++}document.querySelector("#count").textContent=n+" сценариев"}for(const e of [s,t,f])e.addEventListener("input",filter);filter();</script></html>'
(OUT/'krugi-agent-analysis.html').write_text(html,encoding='utf-8')
print(json.dumps({'report':str(OUT),'total':after['total'],'passed':after['passed'],'modelCalls':model_calls,'policyCalls':policy_calls,'sources':sources},ensure_ascii=True))
