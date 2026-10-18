/**
 * Личный кабинет — «Контроль допусков и проверок» (сетка 3×2 + bottom sheets).
 */
(function () {
    'use strict';

    const STORAGE_PREFIX = 'da_profile_compliance_v1_';
    const PANEL_OPEN_KEY = 'da_profile_plan_panel_open';

    const PMO_MEMO = [
        'Терапевт, невролог, офтальмолог, отоларинголог',
        'Флюорография (или заключение не старше 1 года)',
        'Психиатр и нарколог — по направлению / в диспансерах по записи',
        'ЭКГ — при необходимости по возрасту и показаниям',
        'Возьмите паспорт, СНИЛС, полис ОМС и направление от работодателя'
    ];

    const BUILTIN_IDS = ['ot_eb', 'prmo', 'quarter'];

    const DEFAULT_VISIBLE = {
        ot_eb: true,
        prmo: true,
        quarter: true
    };

    const BADGE_COLOR_OPTIONS = [
        { value: 'badge-ot', label: 'Бирюзовый (ОТ)' },
        { value: 'badge-prmo', label: 'Розовый (ПРМО)' },
        { value: 'badge-quarter', label: 'Оранжевый (Квартал)' },
        { value: 'badge-exam', label: 'Лазурный (Экзамен)' },
        { value: 'badge-trans', label: 'Красный (прочее)' }
    ];

    let uiReady = false;
    let detailSheetReady = false;
    let settingsSheetReady = false;

    function escapeHtml(s) {
        return String(s ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function parseIsoDate(iso) {
        if (!iso || typeof iso !== 'string') return null;
        const parts = iso.split('-').map(Number);
        if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
        const d = new Date(parts[0], parts[1] - 1, parts[2]);
        return Number.isNaN(d.getTime()) ? null : d;
    }

    function startOfDay(d) {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }

    function daysUntil(targetDate, fromDate = new Date()) {
        const t = parseIsoDate(targetDate);
        if (!t) return null;
        return Math.round((startOfDay(t).getTime() - startOfDay(fromDate).getTime()) / 86400000);
    }

    function formatDateDots(iso) {
        const d = parseIsoDate(iso);
        if (!d) return '—';
        return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
    }

    function countdownShort(days) {
        if (days === null) return '—';
        if (days < 0) return 'Проср.';
        return `${days} дн`;
    }

    function countdownFoot(days) {
        if (days === null) return '—';
        if (days < 0) return 'Просрочено';
        const n = days;
        const mod10 = n % 10;
        const mod100 = n % 100;
        let word = 'дней';
        if (mod10 === 1 && mod100 !== 11) word = 'день';
        else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) word = 'дня';
        return `Осталось ${n} ${word}`;
    }

    function pillClassForDays(days) {
        if (days === null) return 'pill-counter';
        if (days < 0) return 'pill-counter-danger';
        if (days <= 30) return 'pill-counter-warn';
        return 'pill-counter';
    }

    function ebGroupShort(groupText) {
        const s = String(groupText || '');
        const romanMap = { I: '1', II: '2', III: '3', IV: '4', V: '5' };
        const m = s.match(/\b([IV]+)\s*групп/i);
        if (m && romanMap[m[1]]) return romanMap[m[1]];
        const d = s.match(/(\d)/);
        return d ? d[1] : '—';
    }

    function getQuarterInfo(date = new Date()) {
        const y = date.getFullYear();
        const m = date.getMonth();
        const quarter = Math.floor(m / 3) + 1;
        const closeMonth = quarter * 3 - 1;
        const roman = ['I', 'II', 'III', 'IV'][quarter - 1];
        const windowEnd = new Date(y, closeMonth, 30);
        const monthName = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'][closeMonth];
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return {
            year: y,
            quarter,
            roman,
            key: `${y}-Q${quarter}`,
            periodLabel: `${roman} квартал ${y}`,
            periodShort: `${roman} кв. ${y}`,
            windowLabel: `Окно: 20–30 ${['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'][closeMonth]}`,
            windowText: `с 20 по 30 ${monthName}`,
            windowEndIso: iso(windowEnd)
        };
    }

    function examAdmissionLabel(code) {
        if (code === 'allowed') return 'Допущен';
        if (code === 'denied') return 'Не допущен';
        return 'На согласовании';
    }

    function defaultComplianceData() {
        const today = startOfDay(new Date());
        const nextOt = new Date(today);
        nextOt.setMonth(nextOt.getMonth() + 4);
        const nextPmo = new Date(today);
        nextPmo.setMonth(nextPmo.getMonth() + 10);
        const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

        return {
            cardVisible: { ...DEFAULT_VISIBLE },
            customCards: [],
            otEb: {
                passed: true,
                ebGroup: 'IV группа до и выше 1000 В',
                passedDate: '2025-11-08',
                protocol: 'П-214/25',
                nextCheck: iso(nextOt),
                note: 'Проверка знаний по охране труда и электробезопасности. Протокол комиссии.'
            },
            pmo: {
                lastDate: '2025-10-02',
                nextDeadline: iso(nextPmo),
                note: 'Периодический медосмотр и предрейсовый контроль. Направление и флюорография.'
            },
            quarter: {
                passedKey: '',
                theme: 'ОТ: Действия ЧС',
                note: 'Квартальный зачёт по теме действий локомотивной бригады в нестандартных ситуациях.'
            },
            exam: {
                kind: 'ПТЭ — комиссия депо',
                scheduled: '2026-11-18',
                orderRef: 'Приказ № 142-к',
                commission: 'Комиссия депо',
                admission: 'allowed',
                note: 'Периодическая проверка знаний ПТЭ, ИСИ и ИДП в комиссии депо.'
            },
            other: {
                title: 'Тр. Безоп.',
                subBadge: 'Аттестация',
                label: 'Аттестация по транспортной безопасности',
                deadline: '2026-06-15',
                done: false,
                note: 'Свидетельство / аттестация по ФЗ-16 (ОТБ).'
            }
        };
    }

    function migrateData(data) {
        if (!data.cardVisible) data.cardVisible = { ...DEFAULT_VISIBLE };
        BUILTIN_IDS.forEach((id) => {
            if (data.cardVisible[id] === undefined) data.cardVisible[id] = DEFAULT_VISIBLE[id];
        });
        if (!Array.isArray(data.customCards)) data.customCards = [];
        if (Array.isArray(data.other) && data.other[0] && !data.other.title) {
            data.other = {
                title: data.other[0].title || 'Тр. Безоп.',
                subBadge: 'Аттестация',
                label: data.other[0].title || 'Транспортная безопасность',
                deadline: data.other[0].deadline,
                done: Boolean(data.other[0].done),
                note: 'Разовый допуск / аттестация.'
            };
        }
        if (!data.other || Array.isArray(data.other)) {
            data.other = defaultComplianceData().other;
        }
        data.customCards.forEach((c) => {
            if (data.cardVisible[c.id] === undefined) data.cardVisible[c.id] = true;
        });
        if (!data.flags?.builtinCardsExpanded) {
            BUILTIN_IDS.forEach((id) => {
                data.cardVisible[id] = true;
            });
            data.flags = { ...(data.flags || {}), builtinCardsExpanded: true };
            data._needsPersist = true;
        }
        if (data.cardVisible.exam !== false || data.cardVisible.trans_sec !== false) {
            data.cardVisible.exam = false;
            data.cardVisible.trans_sec = false;
            data._needsPersist = true;
        }
        if (data.quarter && typeof data.quarter.theme === 'string' && data.quarter.theme.length > 22) {
            data.quarter.themeFull = data.quarter.theme;
            data.quarter.theme = 'ОТ: Действия ЧС';
            data._needsPersist = true;
        }
        if (data.exam && typeof data.exam.orderRef === 'string' && /\s+от\s+\d/.test(data.exam.orderRef)) {
            data.exam.orderRefFull = data.exam.orderRef;
            data.exam.orderRef = data.exam.orderRef.replace(/\s+от\s+.*$/, '');
            data._needsPersist = true;
        }
        return data;
    }

    function loadCompliance(tab) {
        const key = STORAGE_PREFIX + String(tab || 'default');
        try {
            const raw = localStorage.getItem(key);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') {
                    const migrated = migrateData(parsed);
                    if (migrated._needsPersist) {
                        delete migrated._needsPersist;
                        try {
                            localStorage.setItem(key, JSON.stringify(migrated));
                        } catch (_) { /* */ }
                    }
                    return migrated;
                }
            }
        } catch (_) { /* seed */ }
        const seed = defaultComplianceData();
        try {
            localStorage.setItem(key, JSON.stringify(seed));
        } catch (_) { /* quota */ }
        return seed;
    }

    function saveCompliance(tab, data) {
        try {
            localStorage.setItem(STORAGE_PREFIX + String(tab || 'default'), JSON.stringify(data));
        } catch (_) { /* ignore */ }
    }

    function isPanelOpen() {
        try {
            if (localStorage.getItem(PANEL_OPEN_KEY) === '0') return false;
        } catch (_) { /* */ }
        return true;
    }

    function setPanelOpen(open) {
        try {
            localStorage.setItem(PANEL_OPEN_KEY, open ? '1' : '0');
        } catch (_) { /* */ }
    }

    function otStatusText(data) {
        const days = daysUntil(data.otEb?.nextCheck);
        if (days !== null && days < 0) return 'Требуется сдача';
        return data.otEb?.passed ? 'Сдано' : 'Требуется сдача';
    }

    function quarterStatusText(data, q) {
        return data.quarter?.passedKey === q.key ? 'Сдан' : 'Не сдан';
    }

    function buildBuiltinCatalog(data) {
        const q = getQuarterInfo();

        return [
            {
                id: 'ot_eb',
                kind: 'ot_eb',
                badgeClass: 'badge-ot',
                title: 'ОТ/ЭБ',
                subBadge: `Группа: ${ebGroupShort(data.otEb?.ebGroup)}`,
                passedLabel: `Сдано: ${formatDateDots(data.otEb?.passedDate)}`,
                nextIso: data.otEb?.nextCheck,
                nextLabel: `Дата сл: ${formatDateDots(data.otEb?.nextCheck)}`,
                note: data.otEb?.note,
                sheetTitle: 'ОТ / ЭБ',
                sheetSub: otStatusText(data),
                dateField: 'otEb.nextCheck'
            },
            {
                id: 'prmo',
                kind: 'prmo',
                badgeClass: 'badge-prmo',
                title: 'ПРМО',
                subBadge: 'Допущен',
                passedLabel: `Сдано: ${formatDateDots(data.pmo?.lastDate)}`,
                nextIso: data.pmo?.nextDeadline,
                nextLabel: `Дата сл: ${formatDateDots(data.pmo?.nextDeadline)}`,
                note: data.pmo?.note,
                sheetTitle: 'ПРМО',
                sheetSub: 'Допущен',
                dateField: 'pmo.nextDeadline',
                pmoMemo: true
            },
            {
                id: 'quarter',
                kind: 'quarter',
                badgeClass: 'badge-quarter',
                title: 'Квартал',
                subBadge: q.periodShort,
                passedLabel: q.windowLabel,
                nextIso: q.windowEndIso,
                nextLabel: data.quarter?.theme || 'Квартальный зачёт',
                note: data.quarter?.note,
                sheetTitle: 'Квартальный зачёт',
                sheetSub: quarterStatusText(data, q),
                dateField: 'quarter.windowEnd'
            }
        ];
    }

    function buildCustomCatalogItem(c) {
        return {
            id: c.id,
            kind: 'custom',
            badgeClass: c.badgeClass || 'badge-exam',
            title: c.title,
            subBadge: c.subBadge || 'Допуск',
            passedLabel: c.passedLabel || 'Назначено',
            nextIso: c.nextIso,
            nextLabel: c.nextLabel || `Дата сл: ${formatDateDots(c.nextIso)}`,
            note: c.note || 'Добавлено вручную.',
            sheetTitle: c.title,
            sheetSub: c.subBadge || '',
            dateField: `custom:${c.id}`
        };
    }

    function getAllCatalogItems(data) {
        const builtins = buildBuiltinCatalog(data);
        const customs = (data.customCards || []).map(buildCustomCatalogItem);
        return [...builtins, ...customs];
    }

    function planEventRowHtml(item) {
        const days = daysUntil(item.nextIso);
        const pillClass = pillClassForDays(days);
        return `<button type="button" class="plan-events-row" data-compliance-action="open-card" data-card-id="${escapeHtml(item.id)}">
  <span class="plan-events-row__event ${escapeHtml(item.badgeClass)}">
    <span class="plan-events-row__title">${escapeHtml(item.title)}</span>
    <span class="plan-events-row__sub">${escapeHtml(item.subBadge)}</span>
  </span>
  <span class="plan-events-row__meta">
    <span class="plan-events-row__next">${escapeHtml(item.nextLabel)}</span>
    <span class="plan-events-row__pass">${escapeHtml(item.passedLabel)}</span>
  </span>
  <span class="plan-events-row__pill ${pillClass}">${escapeHtml(countdownShort(days))}</span>
</button>`;
    }

    function planEventsAddRowHtml() {
        return `<button type="button" class="plan-events-row plan-events-row--add" data-compliance-action="settings">
  <span class="plan-events-row__event plan-events-row__event--add">
    <span class="plan-events-row__title">Добавить событие</span>
    <span class="plan-events-row__sub">Свои допуски</span>
  </span>
  <span class="plan-events-row__meta" aria-hidden="true">
    <span class="plan-events-row__next">Настройка списка</span>
    <span class="plan-events-row__pass">—</span>
  </span>
  <span class="plan-events-row__pill pill-counter" aria-hidden="true">+</span>
</button>`;
    }

    function buildTableHtml(data) {
        const visible = data.cardVisible || DEFAULT_VISIBLE;
        const active = getAllCatalogItems(data).filter((c) => visible[c.id]);
        const head = `
            <div class="plan-events-table-head" aria-hidden="true">
                <span class="plan-events-table-head__event">Событие</span>
                <span class="plan-events-table-head__meta">Срок</span>
                <span class="plan-events-table-head__pill">Ост.</span>
            </div>`;
        const rows = active.map(planEventRowHtml).join('') + planEventsAddRowHtml();
        return head + rows;
    }

    function buildHtml(data, panelOpen) {
        const expanded = panelOpen ? 'true' : 'false';
        const wrapClass = panelOpen ? 'grid-collapse-wrapper' : 'grid-collapse-wrapper collapsed';
        const chevRot = panelOpen ? '' : ' style="transform: rotate(-180deg)"';
        return `
            <div class="profile-events-panel-head">
                <button type="button" class="panel-pill-header" id="profilePlanPanelToggle" aria-expanded="${expanded}" aria-controls="profilePlanGridWrapper" title="Свернуть / развернуть блок">
                    <span class="panel-pill-header__text">Плановые события</span>
                    <svg class="panel-pill-header__chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"${chevRot}>
                        <path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
                    </svg>
                </button>
            </div>
            <div class="${wrapClass}" id="profilePlanGridWrapper">
                <div class="plan-events-table" id="profilePlanGrid" data-compliance-layout="table">${buildTableHtml(data)}</div>
            </div>
            <button type="button" class="panel-drag-handle" data-compliance-panel-toggle title="Свернуть / развернуть" aria-label="Свернуть или развернуть блок"></button>
        `;
    }

    function findCatalogItem(data, cardId) {
        return getAllCatalogItems(data).find((c) => c.id === cardId) || null;
    }

    function setDateOnData(data, dateField, iso) {
        if (!dateField || !iso) return;
        if (dateField === 'otEb.nextCheck') data.otEb.nextCheck = iso;
        else if (dateField === 'pmo.nextDeadline') data.pmo.nextDeadline = iso;
        else if (dateField === 'exam.scheduled') data.exam.scheduled = iso;
        else if (dateField === 'other.deadline') data.other.deadline = iso;
        else if (dateField === 'quarter.windowEnd') { /* derived from calendar */ }
        else if (dateField.startsWith('custom:')) {
            const id = dateField.slice(7);
            const card = (data.customCards || []).find((c) => c.id === id);
            if (card) {
                card.nextIso = iso;
                card.nextLabel = `Дата сл: ${formatDateDots(iso)}`;
            }
        }
    }

    function getDateIsoFromData(data, item) {
        if (item.dateField === 'quarter.windowEnd') return getQuarterInfo().windowEndIso;
        if (item.dateField === 'otEb.nextCheck') return data.otEb?.nextCheck;
        if (item.dateField === 'pmo.nextDeadline') return data.pmo?.nextDeadline;
        if (item.dateField === 'exam.scheduled') return data.exam?.scheduled;
        if (item.dateField === 'other.deadline') return data.other?.deadline;
        if (item.dateField?.startsWith('custom:')) {
            const id = item.dateField.slice(7);
            return (data.customCards || []).find((c) => c.id === id)?.nextIso;
        }
        return item.nextIso;
    }

    function buildDetailExtraRows(item, data) {
        const q = getQuarterInfo();
        const rows = [];
        if (item.kind === 'ot_eb') {
            rows.push(['Статус', otStatusText(data)]);
            rows.push(['Группа ЭБ', data.otEb?.ebGroup || '—']);
            rows.push(['Протокол', data.otEb?.protocol || '—']);
        }
        if (item.kind === 'prmo') {
            rows.push(['Крайнее ПМО', formatDateDots(data.pmo?.lastDate)]);
            rows.push(['Следующая комиссия', formatDateDots(data.pmo?.nextDeadline)]);
        }
        if (item.kind === 'quarter') {
            rows.push(['Период', q.periodLabel]);
            rows.push(['Окно сдачи', q.windowText]);
            rows.push(['Статус', quarterStatusText(data, q)]);
            rows.push(['Тематика', data.quarter?.themeFull || data.quarter?.theme || '—']);
        }
        if (item.kind === 'exam') {
            rows.push(['Вид экзамена', data.exam?.kind || '—']);
            rows.push(['Дата', formatDateDots(data.exam?.scheduled)]);
            rows.push(['Приказ / комиссия', `${data.exam?.orderRefFull || data.exam?.orderRef || '—'} · ${data.exam?.commission || '—'}`]);
            rows.push(['Допуск', examAdmissionLabel(data.exam?.admission)]);
        }
        if (item.kind === 'trans_sec') {
            rows.push(['Событие', data.other?.label || '—']);
            rows.push(['Статус', data.other?.done ? 'Выполнено' : (daysUntil(data.other?.deadline) < 0 ? 'Просрочено' : 'В работе')]);
        }
        return rows;
    }

    function buildDetailSheetContent(tab, cardId) {
        const data = loadCompliance(tab);
        const item = findCatalogItem(data, cardId);
        if (!item) return '';
        const days = daysUntil(item.nextIso);
        const pillClass = pillClassForDays(days);
        const foot = countdownFoot(days);
        const dateIso = getDateIsoFromData(data, item) || '';
        const extraRows = buildDetailExtraRows(item, data);
        const extraHtml = extraRows.map(([l, v]) => `
            <div class="plan-detail-row">
                <span class="plan-detail-row__label">${escapeHtml(l)}</span>
                <span class="plan-detail-row__value">${escapeHtml(v)}</span>
            </div>`).join('');

        const memoHtml = item.pmoMemo
            ? `<div class="plan-detail-memo"><p class="plan-detail-memo__title">Памятка к медкомиссии</p><ul>${PMO_MEMO.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul></div>`
            : '';

        return `
            <div class="plan-detail-grab" aria-hidden="true"></div>
            <div class="plan-detail-head">
                <div>
                    <p class="plan-detail-kicker">Плановое событие</p>
                    <h2 class="plan-detail-title">${escapeHtml(item.sheetTitle || item.title)}${item.sheetSub ? ` <small>(${escapeHtml(item.sheetSub)})</small>` : ''}</h2>
                </div>
                <button type="button" class="plan-detail-close" data-plan-detail-close aria-label="Закрыть">✕</button>
            </div>
            <div class="plan-detail-card">
                <div class="plan-detail-row">
                    <span class="plan-detail-row__label">Предыдущая фиксация:</span>
                    <span class="plan-detail-row__value plan-detail-row__value--strong">${escapeHtml(item.passedLabel)}</span>
                </div>
                <div class="plan-detail-row">
                    <span class="plan-detail-row__label">Срок следующей сдачи:</span>
                    <span class="plan-detail-row__value plan-detail-row__value--accent">${escapeHtml(item.nextLabel)}</span>
                </div>
                <div class="plan-detail-row plan-detail-row--status">
                    <span class="plan-detail-row__label">Статус дедлайна:</span>
                    <span class="${pillClass} plan-detail-pill-inline">${escapeHtml(foot)}</span>
                </div>
                ${extraHtml}
            </div>
            <p class="plan-detail-note">${escapeHtml(item.note || '')}</p>
            ${memoHtml}
            <div class="plan-detail-edit">
                <label class="plan-detail-edit__label" for="planDetailDateInput">Указать новую дату сдачи</label>
                <div class="plan-detail-edit__row">
                    <input type="date" id="planDetailDateInput" name="planDetailDate" class="plan-detail-edit__input" value="${escapeHtml(dateIso)}">
                    <button type="button" class="plan-detail-edit__save" data-plan-save-date="${escapeHtml(cardId)}">Сохранить</button>
                </div>
            </div>
            <div class="plan-detail-actions">
                <button type="button" class="plan-detail-btn plan-detail-btn--danger" data-plan-hide-card="${escapeHtml(cardId)}">Скрыть из сетки</button>
                <button type="button" class="plan-detail-btn plan-detail-btn--muted" data-plan-detail-close>Закрыть</button>
            </div>
        `;
    }

    function ensureDetailSheet() {
        if (detailSheetReady) return;
        detailSheetReady = true;
        const overlay = document.createElement('div');
        overlay.id = 'profilePlanDetailSheet';
        overlay.className = 'plan-sheet-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('role', 'dialog');
        overlay.innerHTML = `
            <div class="plan-sheet-backdrop" data-plan-detail-close></div>
            <div class="plan-sheet-body profile-plan-detail-sheet">
                <div id="profilePlanDetailContent" class="plan-sheet-scroll"></div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    function bindDetailSheetEvents(tab) {
        const overlay = document.getElementById('profilePlanDetailSheet');
        const content = document.getElementById('profilePlanDetailContent');
        if (!overlay || !content) return;

        content.querySelectorAll('[data-plan-detail-close]').forEach((el) => {
            el.addEventListener('click', closeDetailSheet);
        });
        overlay.querySelector('.plan-sheet-backdrop')?.addEventListener('click', closeDetailSheet);

        content.querySelector('[data-plan-save-date]')?.addEventListener('click', () => {
            const cardId = content.querySelector('[data-plan-save-date]')?.getAttribute('data-plan-save-date');
            const input = document.getElementById('planDetailDateInput');
            if (!cardId || !input?.value) return;
            const data = loadCompliance(tab);
            const item = findCatalogItem(data, cardId);
            if (!item) return;
            setDateOnData(data, item.dateField, input.value);
            if (item.kind === 'ot_eb') data.otEb.passed = true;
            if (item.kind === 'trans_sec') data.other.done = false;
            saveCompliance(tab, data);
            renderProfileCompliance(tab);
            openCardDetail(tab, cardId);
        });

        content.querySelector('[data-plan-hide-card]')?.addEventListener('click', () => {
            const cardId = content.querySelector('[data-plan-hide-card]')?.getAttribute('data-plan-hide-card');
            if (!cardId) return;
            const data = loadCompliance(tab);
            if (!data.cardVisible) data.cardVisible = { ...DEFAULT_VISIBLE };
            data.cardVisible[cardId] = false;
            saveCompliance(tab, data);
            closeDetailSheet();
            renderProfileCompliance(tab);
        });
    }

    function openCardDetail(tab, cardId) {
        ensureDetailSheet();
        const overlay = document.getElementById('profilePlanDetailSheet');
        const content = document.getElementById('profilePlanDetailContent');
        if (!overlay || !content) return;
        content.innerHTML = buildDetailSheetContent(tab, cardId);
        bindDetailSheetEvents(tab);
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('plan-sheet-open');
    }

    function closeDetailSheet() {
        const overlay = document.getElementById('profilePlanDetailSheet');
        if (!overlay) return;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('plan-sheet-open');
    }

    function ensureSettingsSheet() {
        if (settingsSheetReady) return;
        settingsSheetReady = true;
        const overlay = document.createElement('div');
        overlay.id = 'profilePlanSettingsSheet';
        overlay.className = 'plan-sheet-overlay';
        overlay.setAttribute('aria-hidden', 'true');
        overlay.setAttribute('role', 'dialog');
        const colorOpts = BADGE_COLOR_OPTIONS.map((o) => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.label)}</option>`).join('');
        overlay.innerHTML = `
            <div class="plan-sheet-backdrop" data-plan-settings-close></div>
            <div class="plan-sheet-body profile-plan-settings-sheet">
                <div class="plan-sheet-scroll">
                    <div class="plan-detail-grab" aria-hidden="true"></div>
                    <div class="plan-settings-head">
                        <div>
                            <h2 class="plan-settings-title">Выбор карточек под себя</h2>
                            <p class="plan-settings-sub">Скройте ненужные проверки или настройте даты</p>
                        </div>
                        <button type="button" class="plan-detail-close" data-plan-settings-close aria-label="Закрыть">✕</button>
                    </div>
                    <div id="profilePlanSettingsList" class="profile-plan-settings-list"></div>
                    <div class="plan-settings-add">
                        <p class="plan-settings-add__title">+ Добавить новый допуск</p>
                        <input type="text" id="planCustomName" name="planCustomName" class="plan-settings-input" placeholder="Заголовок (например: ПТМ)" autocomplete="off">
                        <input type="text" id="planCustomTag" name="planCustomTag" class="plan-settings-input" placeholder="Подзаголовок (например: Пожарный минимум)" autocomplete="off">
                        <div class="plan-settings-add__grid">
                            <label class="plan-settings-field">
                                <span>Дата след. сдачи</span>
                                <input type="date" id="planCustomDate" name="planCustomDate" class="plan-settings-input">
                            </label>
                            <label class="plan-settings-field">
                                <span>Цвет плашки</span>
                                <select id="planCustomColor" class="plan-settings-input">${colorOpts}</select>
                            </label>
                        </div>
                        <button type="button" id="planCustomAddBtn" class="plan-settings-add__btn" disabled>Добавить в сетку</button>
                        <p id="planCustomError" class="plan-settings-error" aria-live="polite"></p>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelectorAll('[data-plan-settings-close]').forEach((el) => {
            el.addEventListener('click', closeSettingsSheet);
        });
    }

    function renderSettingsList(tab) {
        const data = loadCompliance(tab);
        const list = document.getElementById('profilePlanSettingsList');
        if (!list) return;
        const visible = data.cardVisible || DEFAULT_VISIBLE;
        list.innerHTML = getAllCatalogItems(data).map((item) => `
            <label class="profile-plan-settings-row">
                <span class="profile-plan-settings-row__main">
                    <span class="profile-plan-settings-row__text">${escapeHtml(item.title)} <span class="profile-plan-settings-row__muted">(${escapeHtml(item.subBadge)})</span></span>
                    <span class="profile-plan-settings-row__sub">${escapeHtml(item.nextLabel)}</span>
                </span>
                <span class="plan-switch">
                    <input type="checkbox" class="profile-plan-settings-toggle" id="planCardVisible-${escapeHtml(item.id)}" name="planCardVisible-${escapeHtml(item.id)}" data-card-visible="${escapeHtml(item.id)}" ${visible[item.id] ? 'checked' : ''} aria-label="Показывать ${escapeHtml(item.title)}">
                    <span class="plan-switch__track"><span class="plan-switch__dot"></span></span>
                </span>
            </label>
        `).join('');
        list.querySelectorAll('.profile-plan-settings-toggle').forEach((input) => {
            input.addEventListener('change', () => {
                const id = input.getAttribute('data-card-visible');
                const d = loadCompliance(tab);
                if (!d.cardVisible) d.cardVisible = { ...DEFAULT_VISIBLE };
                d.cardVisible[id] = input.checked;
                saveCompliance(tab, d);
                renderProfileCompliance(tab);
                renderSettingsList(tab);
            });
        });
    }

    function openSettingsSheet(tab) {
        ensureSettingsSheet();
        renderSettingsList(tab);
        const data = loadCompliance(tab);
        const dateInput = document.getElementById('planCustomDate');
        if (dateInput && !dateInput.value) {
            const q = getQuarterInfo();
            dateInput.value = data.exam?.scheduled || q.windowEndIso || '';
        }
        const addBtn = document.getElementById('planCustomAddBtn');
        const nameInput = document.getElementById('planCustomName');
        if (addBtn && !addBtn.dataset.bound) {
            addBtn.dataset.bound = '1';
            addBtn.addEventListener('click', () => createCustomCard(tab));
            nameInput?.addEventListener('input', () => {
                addBtn.disabled = !nameInput.value.trim();
                const err = document.getElementById('planCustomError');
                if (err) err.textContent = '';
            });
            nameInput?.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && nameInput.value.trim()) createCustomCard(tab);
            });
        }
        if (addBtn && nameInput) addBtn.disabled = !nameInput.value.trim();
        const overlay = document.getElementById('profilePlanSettingsSheet');
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('plan-sheet-open');
    }

    function createCustomCard(tab) {
        const name = document.getElementById('planCustomName')?.value?.trim();
        const tag = document.getElementById('planCustomTag')?.value?.trim() || 'Зачёт';
        const iso = document.getElementById('planCustomDate')?.value;
        const badgeClass = document.getElementById('planCustomColor')?.value || 'badge-exam';
        const err = document.getElementById('planCustomError');
        if (!name) {
            if (err) err.textContent = 'Введите заголовок карточки';
            return;
        }
        if (name.length > 14) {
            if (err) err.textContent = 'Заголовок до 14 символов — иначе не влезет в плашку';
            return;
        }
        if (err) err.textContent = '';
        const data = loadCompliance(tab);
        if (!data.customCards) data.customCards = [];
        const id = `custom_${Date.now()}`;
        data.customCards.push({
            id,
            title: name,
            subBadge: tag,
            badgeClass,
            passedLabel: 'Назначено',
            nextIso: iso || '',
            nextLabel: `Дата сл: ${formatDateDots(iso)}`,
            note: 'Добавлено сотрудником вручную.'
        });
        if (!data.cardVisible) data.cardVisible = { ...DEFAULT_VISIBLE };
        data.cardVisible[id] = true;
        saveCompliance(tab, data);
        document.getElementById('planCustomName').value = '';
        document.getElementById('planCustomTag').value = '';
        const addBtn = document.getElementById('planCustomAddBtn');
        if (addBtn) addBtn.disabled = true;
        renderProfileCompliance(tab);
        renderSettingsList(tab);
    }

    function closeSettingsSheet() {
        const overlay = document.getElementById('profilePlanSettingsSheet');
        if (!overlay) return;
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('plan-sheet-open');
    }

    function handleCardAction(tab, action, cardId) {
        if (action === 'settings') {
            openSettingsSheet(tab);
            return;
        }
        if (action === 'open-card' && cardId) {
            openCardDetail(tab, cardId);
        }
    }

    function togglePanel(root) {
        const btn = root.querySelector('#profilePlanPanelToggle');
        const wrap = root.querySelector('#profilePlanGridWrapper');
        const chev = root.querySelector('.panel-pill-header__chev');
        if (!btn || !wrap) return;
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        wrap.classList.toggle('collapsed', !open);
        if (chev) chev.style.transform = open ? '' : 'rotate(-180deg)';
        setPanelOpen(open);
    }

    function syncPanelToggleUi(root) {
        const btn = root.querySelector('#profilePlanPanelToggle');
        const wrap = root.querySelector('#profilePlanGridWrapper');
        const chev = root.querySelector('.panel-pill-header__chev');
        if (!btn || !wrap) return;
        const open = btn.getAttribute('aria-expanded') === 'true';
        wrap.classList.toggle('collapsed', !open);
        if (chev) chev.style.transform = open ? '' : 'rotate(-180deg)';
    }

    function bindComplianceRootOnce() {
        const root = document.getElementById('profileComplianceRoot');
        if (!root || root.dataset.bound === '1') return;
        root.dataset.bound = '1';
        root.addEventListener('click', (e) => {
            const tab = root.dataset.complianceTab || 'default';
            if (e.target.closest('[data-compliance-panel-toggle]') || e.target.closest('#profilePlanPanelToggle')) {
                togglePanel(root);
                return;
            }
            const card = e.target.closest('[data-compliance-action]');
            if (!card) return;
            handleCardAction(tab, card.getAttribute('data-compliance-action'), card.getAttribute('data-card-id'));
        });
    }

    window.initProfileComplianceUi = function initProfileComplianceUi() {
        if (uiReady) return;
        uiReady = true;
        ensureDetailSheet();
        ensureSettingsSheet();
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const detail = document.getElementById('profilePlanDetailSheet');
            const settings = document.getElementById('profilePlanSettingsSheet');
            if (detail?.classList.contains('is-open')) {
                e.preventDefault();
                closeDetailSheet();
            } else if (settings?.classList.contains('is-open')) {
                e.preventDefault();
                closeSettingsSheet();
            }
        });
    };

    window.renderProfileCompliance = function renderProfileCompliance(tab) {
        const root = document.getElementById('profileComplianceRoot');
        if (!root) return;
        const data = loadCompliance(tab);
        const panelOpen = isPanelOpen();
        root.dataset.complianceTab = String(tab || 'default');
        root.className = 'events-panel';
        root.innerHTML = buildHtml(data, panelOpen);
        bindComplianceRootOnce();
        syncPanelToggleUi(root);
    };
})();
