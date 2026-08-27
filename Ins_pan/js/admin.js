import { sanitizeOcrText } from './sanitize-ocr.mjs';

/**
 * Админ-панель: линия/станции, тормоза, операции, регламенты.
 */
const TYPE_LABEL = { PT_1: 'ПТ-1', PT_2: 'ПТ-2', EPT_1: 'ЭПТ-1', EPT_2: 'ЭПТ-2' };
const DIR_LABEL = { from_moscow: 'Из Москвы', to_moscow: 'На Москву' };
const KIND_LABEL = { station: 'Станция', halt: 'Ост. пункт' };
const OP_TYPE_LABEL = { TO: 'ТО', WAIT: 'Ожидание', OTHER: 'Другое' };
const TYPE_OPTS = [['PT_1', 'ПТ-1'], ['PT_2', 'ПТ-2'], ['EPT_1', 'ЭПТ-1'], ['EPT_2', 'ЭПТ-2']];
const DIR_OPTS = [['from_moscow', 'Из Москвы'], ['to_moscow', 'На Москву']];
const OP_TYPE_OPTS = [['TO', 'ТО'], ['WAIT', 'Ожидание'], ['OTHER', 'Другое']];

const state = {
    spr: null,
    sections: null,
    catalog: null,
    sectionId: null,
    selectedStation: null,
    accOpen: { brakes: true, passage: false, hints: false, ops: false },
    editBrake: null,
    editOp: null,
    editPassage: null,
    editHint: null,
    brakeForm: { type: 'PT_1', direction: 'from_moscow', km: '', piket: '' },
    opForm: { type: 'TO', direction: 'from_moscow', dwellMinGte: 60, label: '' },
    tagDraft: '',
    hintDraft: '',
    passageDraft: '',
    regsFolderId: null,
    regsDocId: null,
    desktopOpen: true,
    openFolderIds: {},
    uploadTargetFolderId: null,
    ocr: {
        jobId: null,
        docId: null,
        page: 1,
        pageCount: 1,
        pages: [],
        poll: null,
        device: null,
        wait: null,
        committing: false
    },
    indexingIds: new Set(),
    indexingLock: false,
    selectedDocIds: new Set(),
    selectedFolderIds: new Set(),
    chunkQuery: ''
};

const $ = (id) => document.getElementById(id);

function toast(msg, ok = true) {
    const el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.className = `toast show ${ok ? 'ok' : 'err'}`;
    window.clearTimeout(toast._t);
    toast._t = window.setTimeout(() => { el.className = 'toast'; }, 3200);
}

async function runExclusiveIndex(fn) {
    if (state.indexingLock) {
        toast('Дождитесь окончания индексации', false);
        return;
    }
    state.indexingLock = true;
    try {
        return await fn();
    } finally {
        state.indexingLock = false;
    }
}

function normalizeKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[«»"'()]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function parseSmartQuery(query) {
    const raw = String(query || '').trim();
    if (!raw) return { phrases: [], words: [], sentence: '' };
    const phrases = [];
    const rest = raw
        .replace(/[«»„“”]/g, '"')
        .replace(/"([^"]+)"/g, (_, p) => {
            const t = String(p || '').trim();
            if (t) phrases.push(t);
            return ' ';
        });
    const leftover = rest.replace(/\s+/g, ' ').trim();
    const words = leftover.split(/\s+/).map((w) => w.trim()).filter(Boolean);
    return {
        phrases,
        words,
        sentence: words.length >= 2 ? leftover : ''
    };
}

function wordsInOrder(hay, words) {
    let pos = 0;
    for (const w of words) {
        const needle = normalizeKey(w);
        if (!needle) continue;
        const i = hay.indexOf(needle, pos);
        if (i < 0) return false;
        pos = i + needle.length;
    }
    return true;
}

function matchSmartQuery(text, query) {
    const q = String(query || '').trim();
    if (!q) return true;
    const { phrases, words, sentence } = parseSmartQuery(q);
    const hay = normalizeKey(text);
    if (phrases.some((p) => !hay.includes(normalizeKey(p)))) return false;
    if (sentence && hay.includes(normalizeKey(sentence))) return true;
    if (words.length && wordsInOrder(hay, words)) return true;
    if (words.length && words.every((w) => hay.includes(normalizeKey(w)))) return true;
    return phrases.length > 0 && !words.length;
}

function foldSearchText(str) {
    const src = String(str || '');
    let folded = '';
    const map = [];
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        const n = (ch === 'ё' || ch === 'Ё') ? 'е' : ch.toLowerCase();
        if (/[«»"'()[\].,;:!?—–-]/.test(n)) {
            if (folded.slice(-1) !== ' ') {
                folded += ' ';
                map.push(i);
            }
            continue;
        }
        folded += n;
        map.push(i);
    }
    return { folded, map, src };
}

function highlightSmart(text, query) {
    const src = String(text || '');
    const q = String(query || '').trim();
    if (!src || !q) return escapeHtml(src);
    const { phrases, words, sentence } = parseSmartQuery(q);
    const needles = [...phrases, sentence, ...words]
        .map((t) => normalizeKey(t))
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    if (!needles.length) return escapeHtml(src);
    const { folded, map } = foldSearchText(src);
    const ranges = [];
    needles.forEach((needle) => {
        let from = 0;
        while (from <= folded.length - needle.length) {
            const i = folded.indexOf(needle, from);
            if (i < 0) break;
            const start = map[i];
            const end = map[i + needle.length - 1] + 1;
            ranges.push([start, end]);
            from = i + Math.max(1, needle.length);
        }
    });
    if (!ranges.length) return escapeHtml(src);
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    ranges.forEach(([a, b]) => {
        const last = merged[merged.length - 1];
        if (last && a <= last[1]) last[1] = Math.max(last[1], b);
        else merged.push([a, b]);
    });
    let html = '';
    let cursor = 0;
    merged.forEach(([a, b]) => {
        html += escapeHtml(src.slice(cursor, a));
        html += `<mark class="hl">${escapeHtml(src.slice(a, b))}</mark>`;
        cursor = b;
    });
    html += escapeHtml(src.slice(cursor));
    return html;
}

function selectHtml(id, options, selected) {
    return `<select id="${escapeHtml(id)}" class="select">${
        options.map(([value, label]) => (
            `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
        )).join('')
    }</select>`;
}

async function apiGetJson(relPath) {
    const res = await fetch(`/api/app-file?path=${encodeURIComponent(relPath)}`, { cache: 'no-store' });
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
}

async function apiPutJson(relPath, data) {
    const body = JSON.stringify(data, null, 2);
    const res = await fetch(`/api/app-file?path=${encodeURIComponent(relPath)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    return out;
}

function ensureStationOps() {
    if (!state.spr.station_ops || typeof state.spr.station_ops !== 'object') {
        state.spr.station_ops = {};
    }
}

function getOpsEntry(stationName) {
    ensureStationOps();
    if (!state.spr.station_ops[stationName]) {
        state.spr.station_ops[stationName] = {
            ops: [],
            tags: { from_moscow: [], to_moscow: [] },
            hints: { from_moscow: '', to_moscow: '' },
            passage: { from_moscow: '', to_moscow: '' }
        };
    }
    const e = state.spr.station_ops[stationName];
    e.ops = Array.isArray(e.ops) ? e.ops : [];
    e.tags = e.tags || { from_moscow: [], to_moscow: [] };
    e.tags.from_moscow = Array.isArray(e.tags.from_moscow) ? e.tags.from_moscow : [];
    e.tags.to_moscow = Array.isArray(e.tags.to_moscow) ? e.tags.to_moscow : [];
    e.hints = e.hints || { from_moscow: '', to_moscow: '' };
    e.passage = e.passage || { from_moscow: '', to_moscow: '' };
    return e;
}

function uid(prefix) {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function validateBrake(item) {
    if (!item.station) throw new Error('Нужна станция');
    if (!['PT_1', 'PT_2', 'EPT_1', 'EPT_2'].includes(item.type)) throw new Error('Неверный тип пробы');
    const km = Number(item.km);
    const piket = Number(item.piket);
    if (!Number.isFinite(km) || km < 0) throw new Error('Километр некорректен');
    if (!Number.isFinite(piket) || piket < 0 || piket > 9) throw new Error('Пикет: 0–9');
    return { station: item.station, km, piket, type: item.type };
}

async function saveSpr() {
    await apiPutJson('spr.json', state.spr);
    toast('spr.json сохранён');
}

function stationsForSection(sectionId) {
    const path = state.spr?.stations_path || [];
    if (!sectionId) return path.slice();
    return path.filter((s) => Array.isArray(s.sections) && s.sections.includes(sectionId));
}

function brakesForStation(stationName) {
    const out = [];
    for (const dir of ['from_moscow', 'to_moscow']) {
        const list = state.spr?.brakes?.[dir] || [];
        list.forEach((b, idx) => {
            if (normalizeKey(b.station) === normalizeKey(stationName)) {
                out.push({ ...b, direction: dir, _idx: idx });
            }
        });
    }
    return out.sort((a, b) => (a.km - b.km) || (a.piket - b.piket));
}

function renderTimeline() {
    const host = $('timeline');
    const q = $('stationSearch')?.value || '';
    let list = stationsForSection(state.sectionId);
    if (String(q).trim()) {
        list = list.filter((s) => matchSmartQuery(`${s.station} ${s.km} пк ${s.piket}`, q));
    }
    if (!list.length) {
        host.innerHTML = '<p class="empty">Нет станций</p>';
        return;
    }
    host.innerHTML = list.map((s) => {
        const active = state.selectedStation === s.station ? ' active' : '';
        const kind = s.kind === 'station' ? 'is-station' : 'is-halt';
        const piket = s.piket != null ? s.piket : '—';
        return `
          <button type="button" class="timeline-item ${kind}${active}" data-station="${escapeHtml(s.station)}" role="option">
            <span class="dot"></span>
            <span class="timeline-item__name">${highlightSmart(s.station, q)}</span>
            <span class="timeline-item__km">${Number(s.km) || 0} км · пк ${escapeHtml(String(piket))}</span>
          </button>`;
    }).join('');
}

function captureStationDrafts() {
    if ($('brakeTypeSel')) state.brakeForm.type = $('brakeTypeSel').value;
    if ($('brakeDirSel')) state.brakeForm.direction = $('brakeDirSel').value;
    if ($('brakeKm')) state.brakeForm.km = $('brakeKm').value;
    if ($('brakePiket')) state.brakeForm.piket = $('brakePiket').value;
    if ($('opTypeSel')) state.opForm.type = $('opTypeSel').value;
    if ($('opDirSel')) state.opForm.direction = $('opDirSel').value;
    if ($('opDwell')) state.opForm.dwellMinGte = $('opDwell').value;
    if ($('opLabel')) state.opForm.label = $('opLabel').value;
}

function previewRow(items, extra = 0) {
    if (!items.length && extra <= 0) return '<span class="muted">пусто</span>';
    const more = extra > 0 ? `<span class="preview-more">+${extra}</span>` : '';
    return `${items.join('')}${more}`;
}

function brakeChipHtml(b, opts = {}) {
    const key = `${b.direction}:${b._idx}`;
    const editing = opts.editing || state.editBrake === key;
    if (editing) {
        return `<div class="data-chip is-edit" data-brake-chip="${escapeHtml(key)}">
            ${selectHtml('editBrakeType', TYPE_OPTS, b.type)}
            ${selectHtml('editBrakeDir', DIR_OPTS, b.direction)}
            <input id="editBrakeKm" class="input input--mono" type="number" min="0" step="1" value="${escapeHtml(b.km)}">
            <input id="editBrakePk" class="input input--mono" type="number" min="0" max="9" step="1" value="${escapeHtml(b.piket)}">
            <button type="button" class="btn-save" data-save-brake="${escapeHtml(key)}">Сохранить</button>
            <button type="button" class="btn-secondary" data-cancel-edit="brake">Отмена</button>
        </div>`;
    }
    if (opts.preview) {
        return `<span class="preview-chip"><span class="badge ${String(b.type).startsWith('EPT') ? 'badge-ept' : 'badge-pt'}">${TYPE_LABEL[b.type] || b.type}</span> ${b.km}/${b.piket}</span>`;
    }
    return `<div class="data-chip" data-brake-chip="${escapeHtml(key)}">
        <span class="badge ${String(b.type).startsWith('EPT') ? 'badge-ept' : 'badge-pt'}">${TYPE_LABEL[b.type] || b.type}</span>
        <strong class="mono">Км ${b.km} пк ${b.piket}</strong>
        <span class="badge badge-dir">${DIR_LABEL[b.direction] || b.direction}</span>
        <button type="button" class="data-chip__icon" data-edit-brake="${escapeHtml(key)}" aria-label="Изменить">✎</button>
        <button type="button" class="data-chip__icon is-danger" data-del-brake="${escapeHtml(key)}" aria-label="Удалить">×</button>
    </div>`;
}

function textChipHtml(kind, dir, text, opts = {}) {
    const key = `${kind}:${dir}`;
    const editing = (kind === 'passage' ? state.editPassage : state.editHint) === dir;
    if (editing) {
        return `<div class="data-chip is-edit">
            <textarea id="edit${kind}Text" class="textarea" maxlength="${kind === 'passage' ? 160 : 200}">${escapeHtml(text)}</textarea>
            <button type="button" class="btn-save" data-save-text="${escapeHtml(key)}">Сохранить</button>
            <button type="button" class="btn-secondary" data-cancel-edit="${escapeHtml(kind)}">Отмена</button>
        </div>`;
    }
    if (opts.preview) {
        if (!text) return '';
        return `<span class="preview-chip">${DIR_LABEL[dir]}: ${escapeHtml(text)}</span>`;
    }
    if (!text && !opts.force) return '';
    return `<div class="data-chip" data-text-chip="${escapeHtml(key)}">
        <span class="badge badge-dir">${DIR_LABEL[dir]}</span>
        <span class="data-chip__text">${escapeHtml(text || '—')}</span>
        <button type="button" class="data-chip__icon" data-edit-text="${escapeHtml(key)}" aria-label="Изменить">✎</button>
        <button type="button" class="data-chip__icon is-danger" data-del-text="${escapeHtml(key)}" aria-label="Удалить">×</button>
    </div>`;
}

function opChipHtml(op, idx, opts = {}) {
    const editing = state.editOp === idx;
    if (editing) {
        return `<div class="data-chip is-edit" data-op-chip="${idx}">
            ${selectHtml('editOpType', OP_TYPE_OPTS, op.type || 'TO')}
            ${selectHtml('editOpDir', DIR_OPTS, op.direction || 'from_moscow')}
            <input id="editOpDwell" class="input input--mono" type="number" min="1" value="${escapeHtml(op.when?.dwellMinGte ?? 60)}">
            <input id="editOpLabel" class="input" type="text" maxlength="80" value="${escapeHtml(op.label || '')}">
            <button type="button" class="btn-save" data-save-op="${idx}">Сохранить</button>
            <button type="button" class="btn-secondary" data-cancel-edit="op">Отмена</button>
        </div>`;
    }
    if (opts.preview) {
        return `<span class="preview-chip">${escapeHtml(OP_TYPE_LABEL[op.type] || op.type)} · ${op.when?.dwellMinGte != null ? `≥${op.when.dwellMinGte}` : ''}</span>`;
    }
    return `<div class="data-chip" data-op-chip="${idx}">
        <span class="badge badge-op">${escapeHtml(OP_TYPE_LABEL[op.type] || op.type || 'OP')}</span>
        <strong>${escapeHtml(op.label || 'Операция')}</strong>
        <span class="badge badge-dir">${DIR_LABEL[op.direction] || op.direction || '—'}</span>
        ${op.when?.dwellMinGte != null ? `<span class="muted mono">≥ ${op.when.dwellMinGte} мин</span>` : ''}
        <button type="button" class="data-chip__icon" data-edit-op="${idx}" aria-label="Изменить">✎</button>
        <button type="button" class="data-chip__icon is-danger" data-del-op="${idx}" aria-label="Удалить">×</button>
    </div>`;
}

function accordionHtml(id, title, previewHtml, bodyHtml) {
    const open = !!state.accOpen[id];
    return `<section class="acc${open ? ' is-open' : ''}" data-acc="${id}">
        <button type="button" class="acc__head" data-acc-toggle="${id}">
            <span class="acc__title">${escapeHtml(title)}</span>
            <span class="acc__previews">${previewHtml}</span>
            <span class="acc__arrow" aria-hidden="true">▾</span>
        </button>
        <div class="acc__body">${bodyHtml}</div>
    </section>`;
}

function renderStationCard() {
    const host = $('stationCard');
    const name = state.selectedStation;
    if (!name) {
        host.innerHTML = '<p class="empty">Выберите станцию слева</p>';
        return;
    }
    captureStationDrafts();
    const meta = (state.spr.stations_path || []).find((s) => s.station === name) || { kind: 'halt', km: '—', piket: '—' };
    const kindLabel = KIND_LABEL[meta.kind] || meta.kind || '—';
    const brakes = brakesForStation(name);
    const opsEntry = getOpsEntry(name);
    const ops = [...(opsEntry.ops || [])]
        .map((op, idx) => ({ op, idx }))
        .sort((a, b) => (a.op.when?.dwellMinGte || 0) - (b.op.when?.dwellMinGte || 0));

    const brakePrev = previewRow(
        brakes.slice(0, 4).map((b) => brakeChipHtml(b, { preview: true })),
        Math.max(0, brakes.length - 4)
    );
    const passageItems = DIR_OPTS.map(([dir]) => textChipHtml('passage', dir, opsEntry.passage[dir] || '', { preview: true })).filter(Boolean);
    const hintItems = [
        ...DIR_OPTS.map(([dir]) => textChipHtml('hint', dir, opsEntry.hints[dir] || '', { preview: true })).filter(Boolean),
        ...(opsEntry.tags.from_moscow || []).slice(0, 2).map((t) => `<span class="preview-chip">${escapeHtml(t)}</span>`),
        ...(opsEntry.tags.to_moscow || []).slice(0, 2).map((t) => `<span class="preview-chip">${escapeHtml(t)}</span>`)
    ];
    const opPrev = previewRow(
        ops.slice(0, 4).map(({ op }) => opChipHtml(op, 0, { preview: true })),
        Math.max(0, ops.length - 4)
    );

    const brakesBody = `
        <div class="data-chips">
            ${brakes.length ? brakes.map((b) => brakeChipHtml(b)).join('') : '<p class="empty">Пробы не заданы</p>'}
        </div>
        <div class="quick-add">
            ${selectHtml('brakeTypeSel', TYPE_OPTS, state.brakeForm.type)}
            ${selectHtml('brakeDirSel', DIR_OPTS, state.brakeForm.direction)}
            <input id="brakeKm" class="input input--mono" type="number" min="0" step="1" placeholder="Км" value="${escapeHtml(state.brakeForm.km)}">
            <input id="brakePiket" class="input input--mono" type="number" min="0" max="9" step="1" placeholder="Пк" value="${escapeHtml(state.brakeForm.piket)}">
            <button type="button" class="btn-save" id="addBrakeBtn">+ Добавить чип</button>
        </div>`;

    const passageBody = `
        <div class="data-chips">
            ${DIR_OPTS.map(([dir]) => textChipHtml('passage', dir, opsEntry.passage[dir] || '', { force: true })).join('')}
        </div>
        <div class="quick-add">
            ${selectHtml('passageDirSel', DIR_OPTS, state.opForm.direction)}
            <input id="passageQuick" class="input" type="text" maxlength="160" placeholder="Текст прохода…">
            <button type="button" class="btn-save" id="addPassageBtn">+ Добавить чип</button>
        </div>`;

    const allTags = [
        ...(opsEntry.tags.from_moscow || []).map((t) => ({ t, dir: 'from_moscow' })),
        ...(opsEntry.tags.to_moscow || []).map((t) => ({ t, dir: 'to_moscow' }))
    ];
    const hintsBody = `
        <div class="data-chips">
            ${DIR_OPTS.map(([dir]) => textChipHtml('hint', dir, opsEntry.hints[dir] || '', { force: true })).join('')}
            ${allTags.map(({ t, dir }) => `
                <div class="data-chip">
                    <span class="badge badge-tag">${escapeHtml(t)}</span>
                    <span class="badge badge-dir">${DIR_LABEL[dir]}</span>
                    <button type="button" class="data-chip__icon is-danger" data-remove-tag="${escapeHtml(dir)}:${escapeHtml(t)}" aria-label="Удалить">×</button>
                </div>`).join('')}
        </div>
        <div class="quick-add">
            ${selectHtml('hintDirSel', DIR_OPTS, state.opForm.direction)}
            <input id="hintQuick" class="input" type="text" maxlength="200" placeholder="Подсказка или тег…">
            <button type="button" class="btn-save" id="addHintBtn">+ Подсказка</button>
            <button type="button" class="btn-secondary" id="addTagBtn">+ Тег</button>
        </div>`;

    const opsBody = `
        <div class="data-chips">
            ${ops.length ? ops.map(({ op, idx }) => opChipHtml(op, idx)).join('') : '<p class="empty">Правил нет</p>'}
        </div>
        <div class="quick-add">
            ${selectHtml('opTypeSel', OP_TYPE_OPTS, state.opForm.type)}
            ${selectHtml('opDirSel', DIR_OPTS, state.opForm.direction)}
            <input id="opDwell" class="input input--mono" type="number" min="1" step="1" placeholder="мин" value="${escapeHtml(state.opForm.dwellMinGte)}">
            <input id="opLabel" class="input" type="text" maxlength="80" placeholder="Подпись" value="${escapeHtml(state.opForm.label)}">
            <button type="button" class="btn-save" id="addOpBtn">+ Добавить чип</button>
        </div>`;

    host.innerHTML = `
      <div class="station-title-plate">
        <div>
          <h2>${escapeHtml(kindLabel)} ${escapeHtml(name)}</h2>
        </div>
        <div class="station-meta">
          <span class="meta-chip">Ось: ${escapeHtml(String(meta.km))} км</span>
          <span class="meta-chip">пк ${escapeHtml(String(meta.piket ?? '—'))}</span>
          <span class="meta-chip">Участки: ${(meta.sections || []).join(', ') || '—'}</span>
        </div>
      </div>
      <div class="acc-stack">
        ${accordionHtml('brakes', 'Пробы тормозов', brakePrev, brakesBody)}
        ${accordionHtml('passage', 'Проход по станции', previewRow(passageItems), passageBody)}
        ${accordionHtml('hints', 'Подсказки и ограничения', previewRow(hintItems.slice(0, 5), Math.max(0, hintItems.length - 5)), hintsBody)}
        ${accordionHtml('ops', 'Операции', opPrev, opsBody)}
      </div>
    `;
}

function renderSectionSelect() {
    const sel = $('sectionSelect');
    const sections = state.sections?.sections || state.spr?.line_sections?.sections || [];
    const opts = [
        `<option value="">Все точки stations_path</option>`,
        ...sections.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.shortName || s.name || s.id)}</option>`)
    ];
    sel.innerHTML = opts.join('');
    if (state.sectionId) sel.value = state.sectionId;
    else if (sections[0]?.id) {
        state.sectionId = sections[0].id;
        sel.value = state.sectionId;
    }
}

/* ===== Regulations ===== */

async function loadCatalog() {
    state.catalog = await apiGetJson('data/instructions/catalog.json');
    ensureCatalog();
}

async function saveCatalog() {
    state.catalog.updatedAt = new Date().toISOString().slice(0, 10);
    await apiPutJson('data/instructions/catalog.json', state.catalog);
}

function ensureCatalog() {
    if (!state.catalog || typeof state.catalog !== 'object') {
        state.catalog = { version: 1, folders: [], documents: [] };
    }
    if (!Array.isArray(state.catalog.folders)) state.catalog.folders = [];
    if (!Array.isArray(state.catalog.documents)) state.catalog.documents = [];
}

function folderNameById(folderId) {
    if (!folderId) return 'Рабочий стол';
    const f = (state.catalog?.folders || []).find((x) => x.id === folderId);
    return f?.name || folderId;
}

function docKind(doc) {
    if (doc?.kind) return doc.kind;
    const p = String(doc?.filePath || doc?.pdfPath || doc?.title || '').toLowerCase();
    if (p.endsWith('.xlsx') || p.endsWith('.xls')) return 'xlsx';
    if (p.endsWith('.docx') || p.endsWith('.doc')) return 'docx';
    if (p.endsWith('.png')) return 'png';
    if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'jpg';
    if (p.endsWith('.tif') || p.endsWith('.tiff')) return 'tiff';
    return 'pdf';
}

function kindLabel(kind) {
    if (kind === 'xlsx') return 'XLS';
    if (kind === 'docx') return 'DOC';
    if (kind === 'png' || kind === 'jpg' || kind === 'tiff') return 'IMG';
    return 'PDF';
}

function docFilePath(doc) {
    return doc?.filePath || doc?.pdfPath || '';
}

function isDocIndexing(docId) {
    return !!(docId && state.indexingIds.has(docId));
}

function patchFileMeta(docId) {
    const doc = (state.catalog?.documents || []).find((d) => d.id === docId);
    document.querySelectorAll('.fs-row.is-file[data-regs-doc]').forEach((btn) => {
        if (btn.getAttribute('data-regs-doc') !== docId) return;
        const meta = btn.querySelector('.fs-meta');
        if (meta) meta.innerHTML = fileMetaInner(doc);
    });
}

function setDocIndexing(docId, on) {
    if (!docId) return;
    if (on) state.indexingIds.add(docId);
    else state.indexingIds.delete(docId);
    patchFileMeta(docId);
}

function fileMetaInner(doc) {
    if (!doc) return '';
    if (isDocIndexing(doc.id)) {
        return '<span class="fs-spin" title="Индексация" aria-label="Индексация"></span>';
    }
    return String(Number(doc.pageCount) || 0);
}

function folderSvg(id) {
    const gid = `fsGrad_${String(id).replace(/[^A-Za-z0-9_-]/g, '')}`;
    return `<svg class="fs-folder-svg" viewBox="0 0 68 54" aria-hidden="true">
        <defs>
            <linearGradient id="${gid}" x1="8%" y1="0%" x2="92%" y2="100%">
                <stop offset="0%" stop-color="#06C785"/>
                <stop offset="100%" stop-color="#024C4E"/>
            </linearGradient>
        </defs>
        <path fill="url(#${gid})" d="M4 18c0-2.8 2.2-5 5-5h15.8c.8 0 1.5.3 2.1.8l3.6 3.4c.5.5 1.3.8 2.1.8H59c2.8 0 5 2.2 5 5v23c0 2.8-2.2 5-5 5H9c-2.8 0-5-2.2-5-5V18z"/>
    </svg>`;
}

function docsInFolder(folderId) {
    const id = folderId || null;
    return (state.catalog.documents || []).filter((d) => (d.folderId || null) === id);
}

function folderParentId(folder) {
    return folder?.parentId || null;
}

function childFolders(parentId) {
    const pid = parentId || null;
    return (state.catalog.folders || [])
        .filter((f) => folderParentId(f) === pid)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name), 'ru'));
}

function isFolderDescendant(folderId, ancestorId) {
    if (!folderId || !ancestorId) return false;
    if (folderId === ancestorId) return true;
    const seen = new Set();
    let cur = (state.catalog.folders || []).find((f) => f.id === folderId);
    while (cur?.parentId) {
        if (seen.has(cur.id)) return false;
        seen.add(cur.id);
        if (cur.parentId === ancestorId) return true;
        cur = (state.catalog.folders || []).find((f) => f.id === cur.parentId);
    }
    return false;
}

function fileRowHtml(doc) {
    const kind = docKind(doc);
    const active = state.regsDocId === doc.id ? ' is-active' : '';
    const sel = state.selectedDocIds.has(doc.id) ? ' is-selected' : '';
    return `<button type="button" class="fs-row is-file${active}${sel}" draggable="true" data-regs-doc="${escapeHtml(doc.id)}" data-parent-folder="${escapeHtml(doc.folderId || '')}">
        <span class="fs-file-badge">${kindLabel(kind)}</span>
        <span class="fs-name">${escapeHtml(doc.title)}</span>
        <span class="fs-meta">${fileMetaInner(doc)}</span>
    </button>`;
}

function folderBlockHtml(f) {
    const open = state.openFolderIds[f.id] !== false;
    const active = state.regsFolderId === f.id && !state.regsDocId ? ' is-active' : '';
    const sel = state.selectedFolderIds.has(f.id) ? ' is-selected' : '';
    const nested = childFolders(f.id);
    const kids = docsInFolder(f.id);
    const inner = [
        ...nested.map((ch) => folderBlockHtml(ch)),
        ...kids.map((d) => fileRowHtml(d))
    ].join('');
    return `
        <div class="fs-node" data-regs-folder="${escapeHtml(f.id)}">
            <button type="button" class="fs-row${active}${sel}" draggable="true" data-regs-folder="${escapeHtml(f.id)}">
                <span class="fs-caret">${open ? '▾' : '▸'}</span>
                ${folderSvg(f.id)}
                <span class="fs-name">${escapeHtml(f.name)}</span>
                <span class="fs-meta">${nested.length + kids.length}</span>
            </button>
            ${open ? `<div class="fs-children">${inner || '<p class="muted" style="padding:4px 8px;">пусто</p>'}</div>` : ''}
        </div>
    `;
}

function renderRegsFolders() {
    const host = $('regsFolders');
    if (!host) return;
    ensureCatalog();
    const deskActive = !state.regsFolderId && !state.regsDocId ? ' is-active' : '';
    const deskOpen = state.desktopOpen !== false;
    const rootFolders = childFolders(null);
    const rootDocs = docsInFolder(null);

    host.innerHTML = `
        <div class="fs-node" data-regs-folder="">
            <button type="button" class="fs-row${deskActive}" data-regs-folder="">
                <span class="fs-caret">${deskOpen ? '▾' : '▸'}</span>
                ${folderSvg('desktop')}
                <span class="fs-name">Рабочий стол</span>
                <span class="fs-meta">${rootFolders.length + rootDocs.length}</span>
            </button>
            ${deskOpen ? `<div class="fs-children">
                ${rootFolders.map((f) => folderBlockHtml(f)).join('')}
                ${rootDocs.map((d) => fileRowHtml(d)).join('')}
            </div>` : ''}
        </div>
    `;
}

async function renderRegsDocs() {
    const host = $('regsDocs');
    const title = $('regsChunksTitle');
    if (!host) return;
    ensureCatalog();

    let docs = [];
    const q = state.chunkQuery;
    if (q) {
        docs = state.catalog.documents || [];
        if (title) title.textContent = 'Поиск';
    } else if (state.regsDocId) {
        const one = state.catalog.documents.find((d) => d.id === state.regsDocId);
        if (one) docs = [one];
        if (title) title.textContent = one ? one.title : 'Чанки';
    } else {
        docs = docsInFolder(state.regsFolderId);
        if (title) title.textContent = folderNameById(state.regsFolderId);
    }

    if (!docs.length) {
        host.innerHTML = '<p class="empty">Выберите файл слева.</p>';
        return;
    }

    const blocks = [];
    for (const doc of docs) {
        let pack = { chunks: [] };
        try {
            pack = await apiGetJson(`data/instructions/chunks/${doc.id}.json`);
        } catch (_) { /* нет индекса */ }
        const chunks = (pack.chunks || []).filter((ch) =>
            matchSmartQuery(`${doc.title} ${ch.section || ''} ${ch.cleanText || ch.text || ''}`, q)
        );
        if (!chunks.length) {
            if (!q) {
                blocks.push(`<div class="chunk-card"><div class="chunk-card__head">${escapeHtml(doc.title)} · индекс пуст</div></div>`);
            }
            continue;
        }
        chunks.forEach((ch) => {
            blocks.push(`<article class="chunk-card">
                <div class="chunk-card__head">
                    <span>${highlightSmart(doc.title, q)}</span>
                    <span>стр. ${ch.page || '—'}</span>
                    ${ch.section ? `<span>п. ${highlightSmart(ch.section, q)}</span>` : ''}
                </div>
                <div class="chunk-card__text">${highlightSmart(ch.cleanText || ch.text || '', q)}</div>
            </article>`);
        });
    }
    host.innerHTML = blocks.join('') || '<p class="empty">Ничего не найдено</p>';
}

function hideCtxMenu() {
    const menu = $('regsCtxMenu');
    if (menu) menu.hidden = true;
}

function showCtxMenu(e, kind, payload = {}) {
    e.preventDefault();
    e.stopPropagation();
    const menu = $('regsCtxMenu');
    if (!menu) return;
    const items = kind === 'empty'
        ? [
            { id: 'new-folder', label: 'Создать папку' },
            { id: 'add-doc', label: 'Добавить документ' }
        ]
        : payload.docId
            ? [
                { id: 'index', label: 'Индексация' },
                { id: 'delete', label: 'Удалить', danger: true }
            ]
            : [
                { id: 'new-folder', label: 'Создать папку внутри' },
                { id: 'add-doc', label: 'Добавить документ' },
                { id: 'index', label: 'Индексация' },
                { id: 'delete', label: 'Удалить', danger: true }
            ];
    menu.innerHTML = items.map((i) =>
        `<li><button type="button" data-ctx="${i.id}" class="${i.danger ? 'is-danger' : ''}">${escapeHtml(i.label)}</button></li>`
    ).join('');
    menu.dataset.kind = kind;
    menu.dataset.folderId = payload.folderId || '';
    menu.dataset.docId = payload.docId || '';
    menu.hidden = false;
    const pad = 8;
    const w = menu.offsetWidth || 200;
    const h = menu.offsetHeight || 80;
    menu.style.left = `${Math.min(e.clientX, window.innerWidth - w - pad)}px`;
    menu.style.top = `${Math.min(e.clientY, window.innerHeight - h - pad)}px`;
}

function askName({ title, value = '', okLabel = 'Создать' }) {
    return new Promise((resolve) => {
        const modal = $('regsNameModal');
        const input = $('regsNameInput');
        const ok = $('regsNameOk');
        const cancel = $('regsNameCancel');
        if (!modal || !input || !ok) {
            resolve(window.prompt(title, value));
            return;
        }
        $('regsNameTitle').textContent = title;
        ok.textContent = okLabel;
        input.value = value;
        modal.hidden = false;
        window.setTimeout(() => input.focus(), 30);
        const done = (val) => {
            modal.hidden = true;
            ok.onclick = null;
            cancel.onclick = null;
            input.onkeydown = null;
            resolve(val);
        };
        ok.onclick = () => done(String(input.value || '').trim() || null);
        cancel.onclick = () => done(null);
        input.onkeydown = (ev) => {
            if (ev.key === 'Enter') done(String(input.value || '').trim() || null);
            if (ev.key === 'Escape') done(null);
        };
    });
}

async function createRegsFolder() {
    ensureCatalog();
    const name = await askName({ title: 'Новая папка', okLabel: 'Создать' });
    if (!name) return;
    const folder = {
        id: uid('fld'),
        name: name.slice(0, 80),
        parentId: state.regsFolderId || null,
        order: childFolders(state.regsFolderId || null).length
    };
    state.catalog.folders.push(folder);
    state.openFolderIds[folder.id] = true;
    state.desktopOpen = true;
    state.regsFolderId = folder.id;
    state.regsDocId = null;
    await saveCatalog();
    await rebuildInstructionsIndex();
    renderRegsFolders();
    await renderRegsDocs();
    toast(`Папка «${folder.name}» → Цифровой помощник`);
}

async function deleteRegsFolder(folderId) {
    if (!folderId) {
        toast('Рабочий стол нельзя удалить', false);
        return;
    }
    const folder = state.catalog.folders.find((f) => f.id === folderId);
    if (!folder) return;
    const ok = window.confirm(`Удалить папку «${folder.name}»? Документы перейдут на рабочий стол.`);
    if (!ok) return;
    const parentId = folder.parentId || null;
    state.catalog.folders = state.catalog.folders.filter((f) => f.id !== folderId);
    state.catalog.folders.forEach((f) => {
        if (f.parentId === folderId) f.parentId = parentId;
    });
    state.catalog.documents.forEach((d) => {
        if (d.folderId === folderId) d.folderId = parentId;
    });
    if (state.regsFolderId === folderId) state.regsFolderId = null;
    await saveCatalog();
    await rebuildInstructionsIndex();
    renderRegsFolders();
    await renderRegsDocs();
    toast('Папка удалена');
}

async function deleteRegsDocument(docId) {
    const doc = state.catalog.documents.find((d) => d.id === docId);
    if (!doc) return;
    if (!window.confirm(`Удалить «${doc.title}» из каталога?`)) return;
    state.catalog.documents = state.catalog.documents.filter((d) => d.id !== docId);
    if (state.regsDocId === docId) state.regsDocId = null;
    await saveCatalog();
    await rebuildInstructionsIndex();
    renderRegsFolders();
    await renderRegsDocs();
    toast('Документ удалён из каталога');
}

function pickFiles(folderId) {
    state.uploadTargetFolderId = folderId || null;
    $('regsFileInput')?.click();
}

function detectKind(file) {
    const n = String(file?.name || '').toLowerCase();
    if (n.endsWith('.pdf') || file.type === 'application/pdf') return 'pdf';
    if (n.endsWith('.docx')) return 'docx';
    if (n.endsWith('.xlsx')) return 'xlsx';
    if (n.endsWith('.png') || file.type === 'image/png') return 'png';
    if (n.endsWith('.jpg') || n.endsWith('.jpeg') || file.type === 'image/jpeg') return 'jpg';
    if (n.endsWith('.tif') || n.endsWith('.tiff') || file.type === 'image/tiff') return 'tiff';
    return null;
}

function mimeForKind(kind) {
    if (kind === 'pdf') return 'application/pdf';
    if (kind === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (kind === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    if (kind === 'png') return 'image/png';
    if (kind === 'tiff') return 'image/tiff';
    if (kind === 'jpg') return 'image/jpeg';
    return 'application/octet-stream';
}

function isScanKind(kind) {
    return kind === 'png' || kind === 'jpg' || kind === 'tiff';
}

async function persistExtracted(doc, extracted) {
    const totalChars = (extracted.pageTexts || []).reduce((s, t) => s + cleanPdfText(t).length, 0);
    const avg = extracted.pageCount ? totalChars / extracted.pageCount : 0;
    const hasText = avg >= 20 && extracted.chunks.length > 0;
    const chunks = hasText ? extracted.chunks.map((c) => ({ ...c, docId: doc.id })) : [];
    await apiPutJson(`data/instructions/chunks/${doc.id}.json`, {
        docId: doc.id,
        title: doc.title,
        chunks
    });
    doc.pageCount = extracted.pageCount;
    doc.chunkCount = chunks.length;
    doc.hasText = hasText;
    doc.needsDigitize = !hasText;
    doc.usedOcr = !!extracted.usedOcr;
    doc.updatedAt = Date.now();
    return hasText;
}

async function extractOfficeOnServer(filePath) {
    const res = await fetch(`/api/extract-office?path=${encodeURIComponent(filePath)}`, { method: 'POST' });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `extract HTTP ${res.status}`);
    const pageTexts = out.pageTexts || [];
    return {
        pageCount: out.pageCount || pageTexts.length,
        pageTexts,
        chunks: chunksFromPageTexts(pageTexts, null),
        usedOcr: false
    };
}

async function indexDocument(docId, { forceOcr = false, alreadyLocked = false } = {}) {
    const run = async () => {
        const doc = state.catalog.documents.find((d) => d.id === docId);
        if (!doc) throw new Error('Документ не найден');
        const kind = docKind(doc);
        const filePath = docFilePath(doc);
        if (!filePath) throw new Error('Файл не сохранён');

        let ocrStarted = false;
        setDocIndexing(docId, true);
        try {
            if (isScanKind(kind) || (kind === 'pdf' && forceOcr)) {
                await startLocalOcr(doc);
                ocrStarted = true;
                return;
            }

            toast(`Индексация: ${doc.title}…`);
            let extracted;
            if (kind === 'pdf') {
                const res = await fetch(`/api/app-file?path=${encodeURIComponent(filePath)}`, { cache: 'no-store' });
                if (!res.ok) throw new Error(`Не удалось скачать файл (HTTP ${res.status})`);
                const buf = await res.arrayBuffer();
                extracted = await extractChunksFromPdf(buf, { docId });
                if (extracted.needOcr) {
                    await startLocalOcr(doc);
                    ocrStarted = true;
                    return;
                }
            } else if (isScanKind(kind)) {
                await startLocalOcr(doc);
                ocrStarted = true;
                return;
            } else {
                extracted = await extractOfficeOnServer(filePath);
                extracted.chunks = extracted.chunks.map((c) => ({ ...c, docId }));
            }
            const hasText = await persistExtracted(doc, extracted);
            await saveCatalog();
            await rebuildInstructionsIndex();
            renderRegsFolders();
            await renderRegsDocs();
            if (hasText) toast(`${doc.title}: ${doc.chunkCount} чанков`);
            else toast('Текст не распознан', false);
        } finally {
            if (!ocrStarted) setDocIndexing(docId, false);
        }
    };
    if (alreadyLocked) return run();
    return runExclusiveIndex(run);
}

async function indexFolder(folderId) {
    return runExclusiveIndex(async () => {
        const docs = folderId === undefined ? state.catalog.documents : docsInFolder(folderId || null);
        if (!docs.length) {
            toast('В папке нет документов', false);
            return;
        }
        for (const doc of docs) {
            try {
                await indexDocument(doc.id, { forceOcr: false, alreadyLocked: true });
            } catch (err) {
                toast(`${doc.title}: ${err.message || err}`, false);
            }
        }
    });
}

async function reOcrDocument(docId) {
    await indexDocument(docId, { forceOcr: true });
}

async function rebuildInstructionsIndex() {
    const docs = state.catalog.documents || [];
    const folders = state.catalog.folders || [];
    let chunkCount = 0;
    const indexDocs = [];
    for (const doc of docs) {
        indexDocs.push({
            id: doc.id,
            title: doc.title,
            folderId: doc.folderId || null,
            pageCount: doc.pageCount || 0,
            hasText: !!doc.hasText,
            sourcePdf: doc.filePath || doc.pdfPath || null,
            kind: doc.kind || 'pdf'
        });
        chunkCount += doc.chunkCount || 0;
    }
    await apiPutJson('data/instructions/index.json', {
        version: 1,
        updatedAt: new Date().toISOString().slice(0, 10),
        folders: folders.map((f) => ({
            id: f.id,
            name: f.name,
            parentId: f.parentId || null,
            order: f.order ?? 0
        })),
        docs: indexDocs,
        chunkCount
    });
}

async function loadPdfJs() {
    if (loadPdfJs._lib) return loadPdfJs._lib;
    try {
        const mod = await import('/vendor/pdfjs/pdf.min.mjs');
        const lib = mod.default || mod;
        const gwo = lib.GlobalWorkerOptions;
        if (gwo) {
            // .mjs worker; рядом лежит pdf.worker.mjs — fallback, если Worker не стартует
            gwo.workerSrc = `${window.location.origin}/vendor/pdfjs/pdf.worker.min.mjs`;
        }
        loadPdfJs._lib = lib;
        return lib;
    } catch (err) {
        console.error('[admin] pdf.js load failed', err);
        throw new Error(`pdf.js не загрузился: ${err.message || err}. Откройте админку через http://127.0.0.1:8790 (не file://)`);
    }
}

function cleanPdfText(raw) {
    return String(raw || '')
        .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractSection(text) {
    const t = String(text || '').replace(/^#+\s+/gm, '');
    const m = t.match(/^\s*(\d+(?:\.\d+){0,4})\.?\s+([^\n]+)/m);
    if (!m) return '';
    const title = m[2]
        .replace(/[.\-_·•…∙]{2,}/g, ' ')
        .replace(/\s+\d{1,4}\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return title ? `${m[1]} ${title}` : m[1];
}

async function openPdfDocument(arrayBuffer) {
    const lib = await loadPdfJs();
    const data = new Uint8Array(arrayBuffer.slice(0));
    try {
        return await lib.getDocument({ data, useSystemFonts: true }).promise;
    } catch (err) {
        console.warn('[admin] pdf worker failed, retry disableWorker', err);
        return lib.getDocument({
            data: new Uint8Array(arrayBuffer.slice(0)),
            disableWorker: true,
            useSystemFonts: true
        }).promise;
    }
}

function pageTextFromContent(content) {
    let text = '';
    for (const item of content.items || []) {
        if (!item?.str) continue;
        text += (text && !/\s$/.test(text) ? ' ' : '') + item.str;
    }
    return cleanPdfText(text);
}

function splitPageIntoParts(cleaned) {
    const byHead = cleaned.split(/(?=^##\s)/m).map((s) => s.replace(/^#+\s+/, '').trim()).filter(Boolean);
    if (byHead.length > 1) return byHead;
    const byNum = cleaned.split(/(?=^\d+(?:\.\d+){0,4}\.?\s+\S)/m).map((s) => s.trim()).filter(Boolean);
    if (byNum.length > 1) return byNum;
    const paras = cleaned.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    if (paras.length > 1) return paras;
    return [cleaned];
}

function chunksFromPageTexts(pageTexts, docId) {
    const chunks = [];
    pageTexts.forEach((text, idx) => {
        const page = idx + 1;
        const cleaned = sanitizeOcrText(text);
        if (!cleaned || cleaned.length < 12) return;
        splitPageIntoParts(cleaned).forEach((part) => {
            if (part.length < 12) return;
            chunks.push({
                id: uid('chk'),
                docId,
                page,
                section: extractSection(part),
                text: part,
                cleanText: part
            });
        });
    });
    return chunks;
}

async function extractChunksFromPdf(arrayBuffer, { docId = null } = {}) {
    const pdf = await openPdfDocument(arrayBuffer);
    const pageCount = pdf.numPages;
    const pageTexts = [];
    for (let i = 1; i <= pageCount; i += 1) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        pageTexts.push(pageTextFromContent(content));
    }
    try { pdf.destroy(); } catch (_) { /* ignore */ }
    const totalChars = pageTexts.reduce((s, t) => s + t.length, 0);
    const avg = pageCount ? totalChars / pageCount : 0;
    const chunks = chunksFromPageTexts(pageTexts, docId);
    return { pageCount, chunks, pageTexts, usedOcr: false, needOcr: avg < 40 };
}

function showOcrStudio(on) {
    const studio = $('ocrStudio');
    const chunks = $('regsChunksWrap');
    if (studio) studio.hidden = !on;
    if (chunks) chunks.hidden = !!on;
}

function stopOcrPoll() {
    if (state.ocr.poll) {
        window.clearInterval(state.ocr.poll);
        state.ocr.poll = null;
    }
}

function flushOcrPage() {
    const ta = $('ocrPageText');
    if (!ta || !state.ocr.pages.length) return;
    const rec = state.ocr.pages[state.ocr.page - 1];
    if (rec) rec.text = ta.value;
}

function renderOcrPage() {
    const o = state.ocr;
    const img = $('ocrPageImg');
    const ta = $('ocrPageText');
    const label = $('ocrPageLabel');
    if (label) label.textContent = `${o.page} / ${Math.max(1, o.pageCount)}`;
    if (img && o.jobId) {
        img.src = `/api/ocr/jobs/${encodeURIComponent(o.jobId)}/page/${o.page}?t=${Date.now()}`;
    }
    if (ta) ta.value = o.pages[o.page - 1]?.text || '';
}

async function pollOcrJob() {
    if (!state.ocr.jobId) return;
    const res = await fetch(`/api/ocr/jobs/${encodeURIComponent(state.ocr.jobId)}`);
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || `OCR HTTP ${res.status}`);
    const fill = $('ocrProgressFill');
    const status = $('ocrStudioStatus');
    const pct = job.pageCount ? Math.round((job.page / job.pageCount) * 100) : 0;
    if (fill) fill.style.width = `${job.status === 'done' ? 100 : pct}%`;
    const device = job.device || state.ocr.device;
    if (job.device) state.ocr.device = job.device;
    const pill = $('ocrDevicePill');
    if (pill) {
        const label = device === 'cuda' ? 'CUDA' : (device === 'cpu' ? 'CPU' : '…');
        pill.textContent = label;
        pill.hidden = !device;
        pill.dataset.device = device || '';
    }
    if (status) {
        if (job.status === 'error') status.textContent = job.error || 'ошибка';
        else if (job.status === 'queued') status.textContent = 'Запуск…';
        else if (job.status === 'ocr') status.textContent = `${job.page}/${job.pageCount || '?'}`;
        else if (job.status === 'done') status.textContent = 'Готово';
        else status.textContent = job.status || '';
    }
    if (job.pageCount) {
        state.ocr.pageCount = job.pageCount;
        const live = (state.catalog.documents || []).find((d) => d.id === state.ocr.docId);
        if (live) live.pageCount = job.pageCount;
    }
    if (Array.isArray(job.pages) && job.pages.length) {
        state.ocr.pages = job.pages.map((p) => ({ page: p.page, text: p.text || '', raw: p.raw || '' }));
        renderOcrPage();
    }
    if (job.status === 'error') {
        stopOcrPoll();
        setDocIndexing(state.ocr.docId, false);
        toast(job.error || 'ошибка распознавания', false);
        state.ocr.wait?.reject(new Error(job.error || 'OCR'));
        state.ocr.wait = null;
    }
    if (job.status === 'done') {
        stopOcrPoll();
        setDocIndexing(state.ocr.docId, false);
        try {
            await commitOcrToIndex({ keepStudio: true });
            state.ocr.wait?.resolve();
        } catch (err) {
            state.ocr.wait?.reject(err);
        }
        state.ocr.wait = null;
    }
}

async function startLocalOcr(doc) {
    setDocIndexing(doc.id, true);
    renderRegsFolders();
    const probe = await fetch('/api/ocr/probe').then((r) => r.json());
    if (!probe.ok) throw new Error(probe.error || 'OCR недоступен');
    const res = await fetch('/api/ocr/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: docFilePath(doc), docId: doc.id })
    });
    const job = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(job.error || `OCR HTTP ${res.status}`);
    stopOcrPoll();
    const done = new Promise((resolve, reject) => {
        state.ocr.wait = { resolve, reject };
    });
    state.ocr.jobId = job.id;
    state.ocr.docId = doc.id;
    state.ocr.page = 1;
    state.ocr.pageCount = job.pageCount || 1;
    state.ocr.pages = job.pages || [];
    state.ocr.poll = null;
    state.ocr.device = probe.device || job.device || null;
    if ($('ocrStudioTitle')) $('ocrStudioTitle').textContent = doc.title;
    showOcrStudio(true);
    renderOcrPage();
    await pollOcrJob();
    if (state.ocr.wait) {
        state.ocr.poll = window.setInterval(() => {
            pollOcrJob().catch((err) => {
                stopOcrPoll();
                setDocIndexing(state.ocr.docId, false);
                state.ocr.wait?.reject(err);
                state.ocr.wait = null;
                toast(err.message || String(err), false);
            });
        }, 900);
        await done;
    }
}

async function commitOcrToIndex({ keepStudio = false } = {}) {
    if (state.ocr.committing) return;
    state.ocr.committing = true;
    try {
        flushOcrPage();
        const doc = state.catalog.documents.find((d) => d.id === state.ocr.docId);
        if (!doc) throw new Error('Документ не найден');
        const pageTexts = state.ocr.pages.map((p) => sanitizeOcrText(p.text || ''));
        const extracted = {
            pageCount: pageTexts.length,
            pageTexts,
            chunks: chunksFromPageTexts(pageTexts, doc.id),
            usedOcr: true
        };
        const hasText = await persistExtracted(doc, extracted);
        await saveCatalog();
        await rebuildInstructionsIndex();
        if (!keepStudio) showOcrStudio(false);
        stopOcrPoll();
        renderRegsFolders();
        await renderRegsDocs();
        if (hasText) toast(`${doc.title}: ${doc.chunkCount} чанков`);
        else toast('После очистки текста недостаточно для чанков', false);
    } finally {
        state.ocr.committing = false;
    }
}

async function handleFileUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    try {
    return await runExclusiveIndex(async () => {
        ensureCatalog();
        const folderId = state.uploadTargetFolderId !== undefined && state.uploadTargetFolderId !== null
            ? state.uploadTargetFolderId
            : (state.regsFolderId || null);

        for (const file of files) {
            const kind = detectKind(file);
            if (!kind) {
                toast(`${file.name}: PDF, Word (docx), Excel (xlsx) или скан PNG/JPG/TIFF`, false);
                continue;
            }
            const docId = uid('doc');
            toast(`Загрузка: ${file.name}…`);
            try {
                const buf = await file.arrayBuffer();
                const mime = mimeForKind(kind);
                const uploadRes = await fetch(`/api/upload-doc?docId=${encodeURIComponent(docId)}&ext=${kind === 'jpg' ? 'jpg' : kind}`, {
                    method: 'POST',
                    headers: { 'Content-Type': mime },
                    body: new Blob([buf.slice(0)], { type: mime })
                });
                const uploadOut = await uploadRes.json().catch(() => ({}));
                if (!uploadRes.ok) throw new Error(uploadOut.error || `upload HTTP ${uploadRes.status}`);

                const doc = {
                    id: docId,
                    title: file.name,
                    folderId,
                    kind,
                    mime,
                    pageCount: 0,
                    chunkCount: 0,
                    hasText: false,
                    needsDigitize: true,
                    usedOcr: false,
                    filePath: uploadOut.path,
                    pdfPath: kind === 'pdf' ? uploadOut.path : null,
                    updatedAt: Date.now()
                };
                state.catalog.documents.push(doc);
                state.regsDocId = docId;
                state.regsFolderId = folderId;
                if (folderId) state.openFolderIds[folderId] = true;
                state.desktopOpen = true;
                setDocIndexing(docId, true);
                renderRegsFolders();

                if (kind === 'pdf') {
                    const extracted = await extractChunksFromPdf(buf.slice(0), { docId });
                    if (extracted.needOcr) {
                        await saveCatalog();
                        await startLocalOcr(doc);
                    } else {
                        await persistExtracted(doc, extracted);
                        setDocIndexing(docId, false);
                    }
                } else if (isScanKind(kind)) {
                    await saveCatalog();
                    await startLocalOcr(doc);
                } else {
                    const extracted = await extractOfficeOnServer(uploadOut.path);
                    extracted.chunks = extracted.chunks.map((c) => ({ ...c, docId }));
                    await persistExtracted(doc, extracted);
                    setDocIndexing(docId, false);
                }
            } catch (err) {
                console.error('[admin] upload', err);
                setDocIndexing(docId, false);
                toast(`${file.name}: ${err.message || err}`, false);
            }
        }
        await saveCatalog();
        await rebuildInstructionsIndex();
        renderRegsFolders();
        await renderRegsDocs();
        toast('Файлы обработаны');
    });
    } finally {
        state.uploadTargetFolderId = undefined;
    }
}

async function probeIndex() {
    const q = normalizeKey($('regsProbeQ')?.value || '');
    const out = $('regsProbeOut');
    if (!q) {
        out.textContent = 'Введите запрос';
        return;
    }
    const docs = state.catalog.documents.filter((d) => d.hasText);
    const hits = [];
    for (const doc of docs) {
        try {
            const pack = await apiGetJson(`data/instructions/chunks/${doc.id}.json`);
            for (const ch of pack.chunks || []) {
                const text = normalizeKey(ch.cleanText || ch.text);
                if (text.includes(q)) {
                    hits.push({ doc, ch });
                    if (hits.length >= 8) break;
                }
            }
        } catch (_) { /* skip */ }
        if (hits.length >= 8) break;
    }
    if (!hits.length) {
        out.textContent = 'Ничего не найдено в индексе';
        return;
    }
    out.innerHTML = hits.map((h) => `
      <div style="margin-bottom:8px;">
        <strong>${escapeHtml(h.doc.title)}</strong> · стр. ${h.ch.page}
        ${h.ch.section ? ` · п. ${escapeHtml(h.ch.section)}` : ''}<br>
        <span class="muted">${escapeHtml(String(h.ch.cleanText || h.ch.text).slice(0, 160))}…</span>
      </div>`).join('');
}

/* ===== Events ===== */

function clearTreeSelection() {
    state.selectedDocIds.clear();
    state.selectedFolderIds.clear();
}

function paintTreeSelection() {
    document.querySelectorAll('#regsFolders .fs-row').forEach((el) => {
        const docId = el.dataset.regsDoc;
        const folderId = el.dataset.regsFolder;
        const on = (docId && state.selectedDocIds.has(docId))
            || (folderId && state.selectedFolderIds.has(folderId));
        el.classList.toggle('is-selected', !!on);
    });
}

async function applyMoveToFolder(targetFolderId) {
    const dest = targetFolderId || null;
    let changed = false;
    for (const id of state.selectedDocIds) {
        const doc = state.catalog.documents.find((d) => d.id === id);
        if (doc && (doc.folderId || null) !== dest) {
            doc.folderId = dest;
            changed = true;
        }
    }
    for (const id of [...state.selectedFolderIds]) {
        if (!id || id === dest) continue;
        if (dest && isFolderDescendant(dest, id)) continue;
        const folder = state.catalog.folders.find((f) => f.id === id);
        if (!folder) continue;
        if (folderParentId(folder) !== dest) {
            folder.parentId = dest;
            folder.order = childFolders(dest).length;
            changed = true;
        }
    }
    if (!changed) return;
    if (dest) state.openFolderIds[dest] = true;
    else state.desktopOpen = true;
    await saveCatalog();
    await rebuildInstructionsIndex();
    renderRegsFolders();
    await renderRegsDocs();
}

function bindSplitResizers() {
    document.querySelectorAll('.split-resize[data-split]').forEach((handle) => {
        const key = handle.dataset.split;
        const layout = handle.closest('.layout');
        const left = layout?.querySelector('.panel-left');
        if (!layout || !left) return;
        const storageKey = `ins_pan_split_${key}`;
        const saved = Number(localStorage.getItem(storageKey));
        if (saved >= 200) layout.style.setProperty('--split-left', `${Math.round(saved)}px`);
        let dragging = false;
        let startX = 0;
        let startW = 0;
        handle.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            dragging = true;
            startX = e.clientX;
            startW = left.getBoundingClientRect().width;
            handle.classList.add('is-active');
            handle.setPointerCapture(e.pointerId);
        });
        handle.addEventListener('pointermove', (e) => {
            if (!dragging) return;
            const max = layout.getBoundingClientRect().width * 0.72;
            const w = Math.min(max, Math.max(200, startW + (e.clientX - startX)));
            layout.style.setProperty('--split-left', `${Math.round(w)}px`);
        });
        const end = () => {
            if (!dragging) return;
            dragging = false;
            handle.classList.remove('is-active');
            localStorage.setItem(storageKey, String(Math.round(left.getBoundingClientRect().width)));
        };
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
    });
}

function isOsFileDrag(dt) {
    if (!dt) return false;
    const items = dt.items;
    if (items && items.length) {
        for (let i = 0; i < items.length; i += 1) {
            if (items[i].kind === 'file') return true;
        }
        return false;
    }
    return [...(dt.types || [])].includes('Files');
}

function dropTargetFolderId(fromEl) {
    const node = fromEl?.closest('[data-regs-folder]');
    if (!node) return null;
    return node.dataset.regsFolder || null;
}

function highlightDropFolder(fromEl) {
    const tree = $('regsFolders');
    tree?.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    const node = fromEl?.closest('[data-regs-folder]');
    if (!node) return;
    const row = node.matches('.fs-row') ? node : node.querySelector(':scope > .fs-row');
    row?.classList.add('is-drop-target');
}

function bindRegsTreeDnd() {
    const tree = $('regsFolders');
    const box = $('regsMarquee');
    if (!tree) return;
    let marquee = null;

    tree.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.fs-row')) return;
        marquee = { x: e.clientX, y: e.clientY };
        if (box) {
            box.hidden = false;
            box.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;';
        }
    });
    window.addEventListener('pointermove', (e) => {
        if (!marquee) return;
        const x = Math.min(marquee.x, e.clientX);
        const y = Math.min(marquee.y, e.clientY);
        if (box) {
            box.style.left = `${x}px`;
            box.style.top = `${y}px`;
            box.style.width = `${Math.abs(e.clientX - marquee.x)}px`;
            box.style.height = `${Math.abs(e.clientY - marquee.y)}px`;
        }
        clearTreeSelection();
        tree.querySelectorAll('.fs-row').forEach((el) => {
            const r = el.getBoundingClientRect();
            const hit = !(r.right < x || r.left > x + Math.abs(e.clientX - marquee.x)
                || r.bottom < y || r.top > y + Math.abs(e.clientY - marquee.y));
            if (!hit) return;
            if (el.dataset.regsDoc) state.selectedDocIds.add(el.dataset.regsDoc);
            else if (el.dataset.regsFolder) state.selectedFolderIds.add(el.dataset.regsFolder);
        });
        paintTreeSelection();
    });
    window.addEventListener('pointerup', () => {
        if (!marquee) return;
        marquee = null;
        if (box) box.hidden = true;
    });

    tree.addEventListener('dragstart', (e) => {
        const row = e.target.closest('.fs-row');
        if (!row) return;
        const docId = row.dataset.regsDoc || '';
        const folderId = row.dataset.regsFolder || '';
        const inSel = (docId && state.selectedDocIds.has(docId))
            || (folderId && state.selectedFolderIds.has(folderId));
        if (!inSel) {
            clearTreeSelection();
            if (docId) state.selectedDocIds.add(docId);
            if (folderId) state.selectedFolderIds.add(folderId);
            paintTreeSelection();
        }
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'regs-move');
    });
    const clearDropPaint = () => {
        tree.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        $('regsDropHost')?.classList.remove('is-drop');
    };
    tree.addEventListener('dragend', clearDropPaint);
    window.addEventListener('dragend', clearDropPaint);
    tree.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = isOsFileDrag(e.dataTransfer) ? 'copy' : 'move';
        highlightDropFolder(e.target);
    });
    tree.addEventListener('drop', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearDropPaint();
        const files = e.dataTransfer?.files;
        if (files && files.length) {
            state.uploadTargetFolderId = dropTargetFolderId(e.target);
            try {
                await handleFileUpload(files);
            } catch (err) {
                toast(err.message || String(err), false);
            }
            return;
        }
        try {
            await applyMoveToFolder(dropTargetFolderId(e.target));
        } catch (err) {
            toast(err.message || String(err), false);
        }
    });
}

function bindUi() {
    bindSplitResizers();
    bindRegsTreeDnd();
    document.querySelectorAll('.tab-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
            document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
            $(`view-${btn.dataset.tab}`)?.classList.add('active');
            if (btn.dataset.tab === 'regs') {
                renderRegsFolders();
                renderRegsDocs();
            }
        });
    });

    $('sectionSelect')?.addEventListener('change', (e) => {
        state.sectionId = e.target.value || null;
        renderTimeline();
    });
    $('stationSearch')?.addEventListener('input', () => renderTimeline());

    $('timeline')?.addEventListener('click', (e) => {
        const item = e.target.closest('[data-station]');
        if (!item) return;
        state.selectedStation = item.dataset.station;
        state.editBrake = null;
        state.editOp = null;
        state.editPassage = null;
        state.editHint = null;
        renderTimeline();
        renderStationCard();
    });

    $('stationCard')?.addEventListener('click', async (e) => {
        const toggle = e.target.closest('[data-acc-toggle]');
        if (toggle) {
            captureStationDrafts();
            const id = toggle.dataset.accToggle;
            state.accOpen[id] = !state.accOpen[id];
            renderStationCard();
            return;
        }

        const cancel = e.target.closest('[data-cancel-edit]');
        if (cancel) {
            const kind = cancel.dataset.cancelEdit;
            if (kind === 'brake') state.editBrake = null;
            if (kind === 'op') state.editOp = null;
            if (kind === 'passage') state.editPassage = null;
            if (kind === 'hint') state.editHint = null;
            renderStationCard();
            return;
        }

        const delBrake = e.target.closest('[data-del-brake]');
        if (delBrake) {
            const [dir, idxStr] = delBrake.dataset.delBrake.split(':');
            const idx = Number(idxStr);
            if (state.spr.brakes?.[dir]) {
                state.spr.brakes[dir].splice(idx, 1);
                await saveSpr();
                state.editBrake = null;
                renderStationCard();
            }
            return;
        }

        const saveBrake = e.target.closest('[data-save-brake]');
        if (saveBrake) {
            const [oldDir, idxStr] = saveBrake.dataset.saveBrake.split(':');
            const idx = Number(idxStr);
            try {
                const nextDir = $('editBrakeDir')?.value || oldDir;
                const item = validateBrake({
                    station: state.selectedStation,
                    type: $('editBrakeType')?.value,
                    km: $('editBrakeKm')?.value,
                    piket: $('editBrakePk')?.value
                });
                if (!state.spr.brakes) state.spr.brakes = { from_moscow: [], to_moscow: [], dead_ends: [] };
                if (!Array.isArray(state.spr.brakes[nextDir])) state.spr.brakes[nextDir] = [];
                if (nextDir === oldDir) {
                    state.spr.brakes[oldDir][idx] = item;
                } else {
                    state.spr.brakes[oldDir].splice(idx, 1);
                    state.spr.brakes[nextDir].push(item);
                }
                await saveSpr();
                state.editBrake = null;
                renderStationCard();
            } catch (err) {
                toast(err.message || String(err), false);
            }
            return;
        }

        const editBrake = e.target.closest('[data-edit-brake]') || (
            e.target.closest('[data-brake-chip]')
            && !e.target.closest('button, select, input, textarea')
            ? e.target.closest('[data-brake-chip]')
            : null
        );
        if (editBrake && !e.target.closest('[data-del-brake]')) {
            state.editBrake = editBrake.dataset.editBrake || editBrake.dataset.brakeChip;
            state.accOpen.brakes = true;
            renderStationCard();
            return;
        }

        const delOp = e.target.closest('[data-del-op]');
        if (delOp) {
            const entry = getOpsEntry(state.selectedStation);
            entry.ops.splice(Number(delOp.dataset.delOp), 1);
            await saveSpr();
            state.editOp = null;
            renderStationCard();
            return;
        }

        const saveOp = e.target.closest('[data-save-op]');
        if (saveOp) {
            const idx = Number(saveOp.dataset.saveOp);
            const entry = getOpsEntry(state.selectedStation);
            const dwell = Number($('editOpDwell')?.value || 60);
            if (!Number.isFinite(dwell) || dwell < 1) {
                toast('Укажите минуты стоянки', false);
                return;
            }
            const type = $('editOpType')?.value || 'TO';
            const direction = $('editOpDir')?.value || 'from_moscow';
            const label = String($('editOpLabel')?.value || '').trim() || `${OP_TYPE_LABEL[type] || type} ≥ ${dwell} мин`;
            entry.ops[idx] = { ...entry.ops[idx], type, direction, when: { dwellMinGte: dwell }, label };
            await saveSpr();
            state.editOp = null;
            renderStationCard();
            return;
        }

        const editOp = e.target.closest('[data-edit-op]') || (
            e.target.closest('[data-op-chip]')
            && !e.target.closest('button, select, input, textarea')
            ? e.target.closest('[data-op-chip]')
            : null
        );
        if (editOp && !e.target.closest('[data-del-op]')) {
            state.editOp = Number(editOp.dataset.editOp ?? editOp.dataset.opChip);
            state.accOpen.ops = true;
            renderStationCard();
            return;
        }

        const remTag = e.target.closest('[data-remove-tag]');
        if (remTag) {
            const raw = remTag.dataset.removeTag;
            const cut = raw.indexOf(':');
            const dir = raw.slice(0, cut);
            const tag = raw.slice(cut + 1);
            const entry = getOpsEntry(state.selectedStation);
            entry.tags[dir] = (entry.tags[dir] || []).filter((t) => t !== tag);
            await saveSpr();
            renderStationCard();
            return;
        }

        const saveText = e.target.closest('[data-save-text]');
        if (saveText) {
            const [kind, dir] = saveText.dataset.saveText.split(':');
            const entry = getOpsEntry(state.selectedStation);
            const val = String($(kind === 'passage' ? 'editpassageText' : 'edithintText')?.value || '').trim();
            if (kind === 'passage') {
                entry.passage[dir] = val.slice(0, 160);
                state.editPassage = null;
            } else {
                entry.hints[dir] = val.slice(0, 200);
                state.editHint = null;
            }
            await saveSpr();
            renderStationCard();
            return;
        }

        const delText = e.target.closest('[data-del-text]');
        if (delText) {
            const [kind, dir] = delText.dataset.delText.split(':');
            const entry = getOpsEntry(state.selectedStation);
            if (kind === 'passage') entry.passage[dir] = '';
            else entry.hints[dir] = '';
            await saveSpr();
            renderStationCard();
            return;
        }

        const editText = e.target.closest('[data-edit-text]') || (
            e.target.closest('[data-text-chip]')
            && !e.target.closest('button, select, input, textarea')
            ? e.target.closest('[data-text-chip]')
            : null
        );
        if (editText && !e.target.closest('[data-del-text]')) {
            const key = editText.dataset.editText || editText.dataset.textChip;
            const [kind, dir] = key.split(':');
            if (kind === 'passage') {
                state.editPassage = dir;
                state.accOpen.passage = true;
            } else {
                state.editHint = dir;
                state.accOpen.hints = true;
            }
            renderStationCard();
            return;
        }

        if (e.target.id === 'addBrakeBtn') {
            try {
                state.brakeForm.type = $('brakeTypeSel')?.value || state.brakeForm.type;
                state.brakeForm.direction = $('brakeDirSel')?.value || state.brakeForm.direction;
                state.brakeForm.km = $('brakeKm')?.value ?? '';
                state.brakeForm.piket = $('brakePiket')?.value ?? '';
                const item = validateBrake({
                    station: state.selectedStation,
                    type: state.brakeForm.type,
                    km: state.brakeForm.km,
                    piket: state.brakeForm.piket
                });
                if (!state.spr.brakes) state.spr.brakes = { from_moscow: [], to_moscow: [], dead_ends: [] };
                if (!Array.isArray(state.spr.brakes[state.brakeForm.direction])) {
                    state.spr.brakes[state.brakeForm.direction] = [];
                }
                state.spr.brakes[state.brakeForm.direction].push(item);
                await saveSpr();
                state.brakeForm.km = '';
                state.brakeForm.piket = '';
                state.accOpen.brakes = true;
                renderStationCard();
            } catch (err) {
                toast(err.message || String(err), false);
            }
            return;
        }

        if (e.target.id === 'addPassageBtn') {
            const dir = $('passageDirSel')?.value || 'from_moscow';
            const text = String($('passageQuick')?.value || '').trim().slice(0, 160);
            if (!text) {
                toast('Введите текст прохода', false);
                return;
            }
            const entry = getOpsEntry(state.selectedStation);
            entry.passage[dir] = text;
            await saveSpr();
            state.accOpen.passage = true;
            renderStationCard();
            return;
        }

        if (e.target.id === 'addHintBtn') {
            const dir = $('hintDirSel')?.value || 'from_moscow';
            const text = String($('hintQuick')?.value || '').trim().slice(0, 200);
            if (!text) {
                toast('Введите подсказку', false);
                return;
            }
            const entry = getOpsEntry(state.selectedStation);
            entry.hints[dir] = text;
            await saveSpr();
            state.accOpen.hints = true;
            renderStationCard();
            return;
        }

        if (e.target.id === 'addTagBtn') {
            const tag = String($('hintQuick')?.value || '').trim().slice(0, 32);
            if (!tag) return;
            const dir = $('hintDirSel')?.value || 'from_moscow';
            const entry = getOpsEntry(state.selectedStation);
            if (!entry.tags[dir].includes(tag)) entry.tags[dir].push(tag);
            await saveSpr();
            state.accOpen.hints = true;
            renderStationCard();
            return;
        }

        if (e.target.id === 'addOpBtn') {
            captureStationDrafts();
            const dwell = Number(state.opForm.dwellMinGte || 60);
            const label = String(state.opForm.label || '').trim()
                || `${OP_TYPE_LABEL[state.opForm.type] || state.opForm.type} при стоянке ≥ ${dwell} мин`;
            if (!Number.isFinite(dwell) || dwell < 1) {
                toast('Укажите минуты стоянки', false);
                return;
            }
            const entry = getOpsEntry(state.selectedStation);
            entry.ops.push({
                id: uid('op'),
                type: state.opForm.type,
                direction: state.opForm.direction,
                when: { dwellMinGte: dwell },
                label
            });
            await saveSpr();
            state.opForm.label = '';
            state.accOpen.ops = true;
            renderStationCard();
        }
    });

    $('regsFileInput')?.addEventListener('change', async (e) => {
        try {
            await handleFileUpload(e.target.files);
        } catch (err) {
            console.warn(err);
            toast(err.message || String(err), false);
        }
        e.target.value = '';
    });
    $('regsFolders')?.addEventListener('click', (e) => {
        const fileBtn = e.target.closest('[data-regs-doc]');
        if (fileBtn) {
            state.regsDocId = fileBtn.dataset.regsDoc;
            state.regsFolderId = fileBtn.dataset.parentFolder || null;
            clearTreeSelection();
            state.selectedDocIds.add(fileBtn.dataset.regsDoc);
            renderRegsFolders();
            renderRegsDocs();
            return;
        }
        const btn = e.target.closest('[data-regs-folder]');
        if (!btn) return;
        const id = btn.dataset.regsFolder || null;
        if (id) {
            const wasSelected = state.regsFolderId === id && !state.regsDocId;
            if (wasSelected) {
                const open = state.openFolderIds[id] !== false;
                state.openFolderIds[id] = !open;
            } else {
                state.openFolderIds[id] = true;
            }
            state.regsFolderId = id;
            clearTreeSelection();
            state.selectedFolderIds.add(id);
        } else {
            if (!state.regsFolderId && !state.regsDocId) state.desktopOpen = !state.desktopOpen;
            else state.desktopOpen = true;
            state.regsFolderId = null;
            clearTreeSelection();
        }
        state.regsDocId = null;
        renderRegsFolders();
        renderRegsDocs();
    });
    $('regsFolders')?.addEventListener('contextmenu', (e) => {
        const fileBtn = e.target.closest('[data-regs-doc]');
        if (fileBtn) {
            state.regsDocId = fileBtn.dataset.regsDoc;
            state.regsFolderId = fileBtn.dataset.parentFolder || null;
            renderRegsFolders();
            showCtxMenu(e, 'item', { docId: fileBtn.dataset.regsDoc, folderId: fileBtn.dataset.parentFolder || '' });
            return;
        }
        const folderBtn = e.target.closest('[data-regs-folder]');
        if (folderBtn) {
            const id = folderBtn.dataset.regsFolder || '';
            state.regsFolderId = id || null;
            state.regsDocId = null;
            renderRegsFolders();
            showCtxMenu(e, 'item', { folderId: id, docId: '' });
            return;
        }
        showCtxMenu(e, 'empty', { folderId: state.regsFolderId || '', docId: '' });
    });
    $('regsCtxMenu')?.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-ctx]');
        if (!btn) return;
        const menu = $('regsCtxMenu');
        const action = btn.dataset.ctx;
        const folderId = menu.dataset.folderId || null;
        const docId = menu.dataset.docId || null;
        hideCtxMenu();
        try {
            if (action === 'new-folder') {
                if (folderId) {
                    state.regsFolderId = folderId;
                    state.regsDocId = null;
                    state.openFolderIds[folderId] = true;
                }
                await createRegsFolder();
            }
            else if (action === 'add-doc') pickFiles(folderId);
            else if (action === 'index') {
                if (docId) await indexDocument(docId, { forceOcr: true });
                else await indexFolder(folderId || null);
            } else if (action === 'delete') {
                if (docId) await deleteRegsDocument(docId);
                else await deleteRegsFolder(folderId);
            }
        } catch (err) {
            toast(err.message || String(err), false);
        }
    });
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#regsCtxMenu')) hideCtxMenu();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hideCtxMenu();
    });

    $('ocrPrevPage')?.addEventListener('click', () => {
        flushOcrPage();
        if (state.ocr.page > 1) state.ocr.page -= 1;
        renderOcrPage();
    });
    $('ocrNextPage')?.addEventListener('click', () => {
        flushOcrPage();
        if (state.ocr.page < state.ocr.pageCount) state.ocr.page += 1;
        renderOcrPage();
    });
    $('ocrSanitizeBtn')?.addEventListener('click', () => {
        const docId = state.ocr.docId;
        if (!docId) return;
        reOcrDocument(docId).catch((err) => toast(err.message || String(err), false));
    });
    $('ocrCommitBtn')?.addEventListener('click', () => {
        commitOcrToIndex({ keepStudio: true }).catch((err) => toast(err.message || String(err), false));
    });

    const dropHost = $('regsDropHost');
    dropHost?.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (isOsFileDrag(e.dataTransfer)) dropHost.classList.add('is-drop');
        else dropHost.classList.remove('is-drop');
    });
    dropHost?.addEventListener('dragleave', (e) => {
        if (!dropHost.contains(e.relatedTarget)) dropHost.classList.remove('is-drop');
    });
    dropHost?.addEventListener('drop', async (e) => {
        e.preventDefault();
        dropHost.classList.remove('is-drop');
        dropHost.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        const files = e.dataTransfer?.files;
        if (files && files.length) {
            state.uploadTargetFolderId = dropTargetFolderId(e.target);
            try {
                await handleFileUpload(files);
            } catch (err) {
                toast(err.message || String(err), false);
            }
            return;
        }
        try {
            await applyMoveToFolder(dropTargetFolderId(e.target));
        } catch (err) {
            toast(err.message || String(err), false);
        }
    });
    let searchT = 0;
    $('regsChunkSearch')?.addEventListener('input', (e) => {
        window.clearTimeout(searchT);
        searchT = window.setTimeout(() => {
            state.chunkQuery = String(e.target.value || '');
            renderRegsDocs();
        }, 180);
    });
}

async function boot() {
    const status = $('connStatus');
    try {
        const health = await fetch('/api/health').then((r) => r.json());
        status.textContent = 'localhost OK';
        status.classList.add('is-ok');
        console.log('[admin]', health);

        const [spr, lineSections, catalog] = await Promise.all([
            apiGetJson('spr.json'),
            apiGetJson('data/line-sections.json').catch(() => null),
            apiGetJson('data/instructions/catalog.json')
        ]);
        state.spr = spr;
        state.sections = lineSections;
        state.catalog = catalog;
        ensureCatalog();
        ensureStationOps();

        renderSectionSelect();
        renderTimeline();
        bindUi();
        if (health.ocr?.ok) {
            toast('Данные загружены');
        } else {
            toast(`Данные загружены. OCR: ${health.ocr?.error || 'недоступен'}`, false);
        }
    } catch (err) {
        console.error(err);
        status.textContent = 'нет связи с server.mjs';
        status.classList.add('is-err');
        toast(`Ошибка: ${err.message || err}. Запустите npm start в Ins_pan`, false);
    }
}

boot();
