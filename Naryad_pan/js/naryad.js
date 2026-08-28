(() => {
  const MARKERS = [
    { value: 'пн-чт', label: 'пн–чт' },
    { value: 'пт', label: 'пт' },
    { value: 'сб', label: 'сб' },
    { value: 'вс', label: 'вс' },
  ];

  const docList = document.getElementById('docList');
  const fileInput = document.getElementById('fileInput');
  const logEl = document.getElementById('log');
  const previewBody = document.getElementById('previewBody');
  const warningsEl = document.getElementById('warningsBox');

  let rows = [];
  let rowSeq = 0;
  let activeRowId = null;
  let previewToken = null;
  let warnIndex = new Map();

  function log(msg, cls = '') {
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.innerHTML = `<span class="dim">[naryad]</span> ${escapeHtml(msg)}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function newRow(partial = {}) {
    return {
      id: `r${++rowSeq}`,
      file: partial.file || null,
      mode: partial.mode || 'marker',
      marker: partial.marker || 'пн-чт',
      date: partial.date || '',
    };
  }

  function guessMarker(name) {
    const u = String(name || '').toUpperCase();
    if (u.includes('ПН_ЧТ') || u.includes('ПНЧТ')) return 'пн-чт';
    if (u.includes('_ПТ') || u.includes(' ПТ')) return 'пт';
    if (u.includes('_СБ') || u.includes(' СБ')) return 'сб';
    if (u.includes('_ВС') || u.includes(' ВС')) return 'вс';
    return 'пн-чт';
  }

  function rowScheduleLabel(row) {
    if (row.mode === 'date' && row.date) return `${row.date} (разово)`;
    return row.marker || 'маркер?';
  }

  function formatMsk(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function renderBundleInfo(info) {
    const el = document.getElementById('bundleSummary');
    if (!info?.exists) {
      el.innerHTML = '<span class="dim">Файл ещё не создан</span>';
      return;
    }
    const periods = (info.normativePeriods || []).map((p) => {
      const to = p.to || '…';
      const cls = p.active ? 'is-active' : '';
      return `<li class="${cls}">${escapeHtml(p.id)}: ${escapeHtml(String(p.from))} – ${escapeHtml(String(to))} · ${p.rows} строк, ${p.files} файлов${p.active ? ' · <span class="active">активный</span>' : ''}</li>`;
    }).join('');
    el.innerHTML = `
      <div>Последняя запись: <strong>${escapeHtml(formatMsk(info.lastWriteAt || info.fileModifiedAt))}</strong></div>
      <div>Активный норматив: <span class="active">${escapeHtml(info.activeNormativeId || '—')}</span> · в корне JSON ${info.rootShiftDetailsRows ?? '—'} строк</div>
      <div class="dim">Периодов: ${info.normativesCount ?? 0}</div>
      <ul class="bundle-periods">${periods}</ul>
    `;
    if (info.activeNormativeFrom && !document.getElementById('normFrom').dataset.userTouched) {
      document.getElementById('normFrom').value = info.activeNormativeFrom;
      updateStats();
    }
  }

  async function loadBundleInfo() {
    try {
      const res = await fetch('/api/bundle-info');
      const data = await res.json();
      if (data.ok) renderBundleInfo(data);
    } catch {
      document.getElementById('bundleSummary').innerHTML = '<span class="dim">нет связи с сервером</span>';
    }
  }

  function logMergePlan(plan) {
    if (!plan) return;
    if (plan.action === 'replace') {
      log(`запись заменит блок ${plan.normativeFrom} (${plan.newBlockRows} строк)`);
    } else {
      log(`запись добавит блок ${plan.normativeFrom} (${plan.newBlockRows} строк)`);
    }
    if (plan.willClosePreviousTo && plan.previousActiveId) {
      log(`предыдущий ${plan.previousActiveId} закроется ${plan.willClosePreviousTo}`);
    }
  }

  function filledCount() {
    return rows.filter((r) => r.file).length;
  }

  function updateStats(extra = {}) {
    document.getElementById('statMarkers').textContent = `${filledCount()}/${rows.length}`;
    document.getElementById('statPeriod').textContent = document.getElementById('normFrom').value || '—';
    if (extra.rows != null) document.getElementById('statRows').textContent = String(extra.rows);
    if (extra.routes != null) document.getElementById('statRoutes').textContent = String(extra.routes);
    document.getElementById('btnApply').disabled = !previewToken;
  }

  function setSteps(stepDone) {
    document.querySelectorAll('.step').forEach((el, i) => {
      el.classList.toggle('is-done', i < stepDone);
      el.classList.toggle('is-active', i === stepDone);
    });
  }

  function renderDocList() {
    docList.innerHTML = rows.map((row) => {
      const hasFile = Boolean(row.file);
      const name = hasFile ? row.file.name : 'PDF или xlsx — нажмите или перетащите';
      const modeCls = row.mode === 'date' ? 'is-date' : 'is-marker';
      return `
        <div class="doc-card ${hasFile ? 'is-filled' : ''} ${activeRowId === row.id ? 'is-active' : ''} ${modeCls}" data-id="${row.id}">
          <button type="button" class="doc-card__file" data-pick="${row.id}">
            <span class="doc-card__name">${escapeHtml(name)}</span>
            <span class="doc-card__meta">${hasFile ? formatBytes(row.file.size) : 'файл не выбран'}</span>
          </button>
          <div class="doc-card__schedule">
            <button type="button" class="doc-card__remove" data-remove="${row.id}" title="Убрать">×</button>
            <div class="doc-card__hint">Разово — дата. Повтор — маркер дня недели.</div>
            <input class="doc-card__date" type="date" data-date="${row.id}" value="${row.date || ''}" title="Только этот день">
            <div class="doc-card__markers">
              ${MARKERS.map((m) => `
                <button type="button" class="marker ${row.mode === 'marker' && row.marker === m.value ? 'is-on' : ''}" data-tag="${m.value}" data-id="${row.id}">${m.label}</button>
              `).join('')}
            </div>
          </div>
        </div>
      `;
    }).join('');

    docList.querySelectorAll('[data-pick]').forEach((btn) => {
      btn.addEventListener('click', () => {
        activeRowId = btn.dataset.pick;
        fileInput.click();
      });
    });

    docList.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        rows = rows.filter((r) => r.id !== btn.dataset.remove);
        if (!rows.length) rows.push(newRow());
        renderDocList();
        updateStats();
      });
    });

    docList.querySelectorAll('.marker').forEach((btn) => {
      btn.addEventListener('click', () => {
        const row = rows.find((r) => r.id === btn.dataset.id);
        if (!row) return;
        row.mode = 'marker';
        row.marker = btn.dataset.tag;
        row.date = '';
        renderDocList();
      });
    });

    docList.querySelectorAll('[data-date]').forEach((inp) => {
      inp.addEventListener('change', () => {
        const row = rows.find((r) => r.id === inp.dataset.date);
        if (!row) return;
        if (inp.value) {
          row.mode = 'date';
          row.date = inp.value;
        } else if (row.mode === 'date') {
          row.mode = 'marker';
          row.marker = row.marker || 'пн-чт';
        }
        renderDocList();
      });
      inp.addEventListener('click', (e) => e.stopPropagation());
    });

    docList.querySelectorAll('.doc-card').forEach((el) => {
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('is-dragover'); });
      el.addEventListener('dragleave', () => el.classList.remove('is-dragover'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        el.classList.remove('is-dragover');
        const f = e.dataTransfer?.files?.[0];
        const row = rows.find((r) => r.id === el.dataset.id);
        if (f && row) assignFile(row, f);
      });
    });
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function assignFile(row, file) {
    const ok = /\.(pdf|xlsx)$/i.test(file.name);
    if (!ok) {
      log('нужен PDF или xlsx', 'warn');
      return;
    }
    row.file = file;
    if (row.mode === 'marker') row.marker = guessMarker(file.name);
    renderDocList();
    updateStats();
    log(`файл: ${file.name} → ${rowScheduleLabel(row)}`);
  }

  function addRowsFromFiles(fileList) {
    const arr = Array.from(fileList || []);
    if (!arr.length) return;
    const empty = rows.find((r) => !r.file);
    arr.forEach((file, i) => {
      let row;
      if (i === 0 && empty) {
        row = empty;
      } else {
        row = newRow({ marker: guessMarker(file.name) });
        rows.push(row);
      }
      assignFile(row, file);
    });
  }

  function validateRows(ready) {
    for (const row of ready) {
      if (row.mode === 'date') {
        if (!row.date) {
          log('укажите дату или выберите маркер', 'warn');
          return false;
        }
      } else if (!row.marker) {
        log('выберите маркер дня недели', 'warn');
        return false;
      }
    }
    return true;
  }

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f && activeRowId) {
      const row = rows.find((r) => r.id === activeRowId);
      if (row) assignFile(row, f);
    }
    fileInput.value = '';
  });

  document.getElementById('btnAddRow').addEventListener('click', () => {
    rows.push(newRow());
    renderDocList();
    updateStats();
  });

  document.getElementById('dropBulk').addEventListener('dragover', (e) => {
    e.preventDefault();
    document.getElementById('dropBulk').classList.add('is-dragover');
  });
  document.getElementById('dropBulk').addEventListener('dragleave', () => {
    document.getElementById('dropBulk').classList.remove('is-dragover');
  });
  document.getElementById('dropBulk').addEventListener('drop', (e) => {
    e.preventDefault();
    document.getElementById('dropBulk').classList.remove('is-dragover');
    addRowsFromFiles(e.dataTransfer?.files);
  });
  document.getElementById('dropBulk').addEventListener('click', () => {
    fileInput.multiple = true;
    activeRowId = null;
    fileInput.onchange = () => {
      addRowsFromFiles(fileInput.files);
      fileInput.multiple = false;
      fileInput.onchange = null;
      fileInput.value = '';
    };
    fileInput.click();
  });

  function routeClass(kind) {
    if (kind === 'night') return 'route-tag night';
    if (kind === 'morn') return 'route-tag morn';
    return 'route-tag';
  }

  function buildWarnIndex(warnings) {
    warnIndex = new Map();
    (warnings || []).forEach((w) => {
      const key = `${w.date}::${w.route}`;
      if (!warnIndex.has(key)) warnIndex.set(key, []);
      warnIndex.get(key).push(w);
    });
  }

  function renderWarnings(warnings) {
    if (!warnings?.length) {
      warningsEl.hidden = true;
      warningsEl.innerHTML = '';
      return;
    }
    warningsEl.hidden = false;
    const errs = warnings.filter((w) => w.level === 'error').length;
    const warns = warnings.filter((w) => w.level === 'warn').length;
    warningsEl.innerHTML = `
      <div class="warn-head">Проверка: <span class="err">${errs} ошибок</span>, ${warns} предупреждений</div>
      <ul class="warn-list">${warnings.map((w) => `
        <li class="${w.level === 'error' ? 'is-err' : 'is-warn'}">${escapeHtml(w.file ? `[${w.file}] ` : '')}${escapeHtml(w.message)}</li>
      `).join('')}</ul>
    `;
  }

  function renderPreviewTable(rowsData) {
    if (!rowsData?.length) {
      previewBody.innerHTML = `<tr><td colspan="9" class="empty-cell">Нет строк</td></tr>`;
      return;
    }
    previewBody.innerHTML = rowsData.map((r) => {
      const key = `${r.date}::${r.route}`;
      const issues = warnIndex.get(key) || [];
      const cls = issues.some((w) => w.level === 'error') ? 'row-err' : issues.length ? 'row-warn' : '';
      const title = issues.map((w) => w.message).join('; ');
      return `
        <tr class="${cls}" title="${escapeHtml(title)}">
          <td><span class="day-chip">${escapeHtml(r.date)}</span></td>
          <td><span class="${routeClass(r.kind)}">${escapeHtml(r.route)}</span></td>
          <td class="mono">${escapeHtml(r.startPlace || '')}</td>
          <td class="mono">${escapeHtml(r.startTime || '')}</td>
          <td class="trains-cell" title="${escapeHtml(r.trains || '')}">${escapeHtml(r.trains || '')}</td>
          <td class="mono">${escapeHtml(r.endTime || '')}</td>
          <td class="mono">${escapeHtml(r.workHours || '')}</td>
          <td class="mono">${escapeHtml(r.nightHours || '')}</td>
          <td class="mono">${escapeHtml(r.lunch || '—')}</td>
        </tr>
      `;
    }).join('');
  }

  async function apiPreview() {
    const ready = rows.filter((r) => r.file);
    if (!ready.length) {
      log('добавьте хотя бы один файл', 'warn');
      return;
    }
    if (!validateRows(ready)) return;

    const normativeFrom = document.getElementById('normFrom').value;
    if (!normativeFrom) {
      log('укажите дату начала норматива', 'warn');
      return;
    }

    const form = new FormData();
    form.append('meta', JSON.stringify({
      normativeFrom,
      closePrevious: document.getElementById('closePrev').checked,
      rows: ready.map((r) => ({
        mode: r.mode,
        marker: r.mode === 'marker' ? r.marker : undefined,
        date: r.mode === 'date' ? r.date : undefined,
      })),
    }));
    ready.forEach((r, i) => form.append(`file_${i}`, r.file, r.file.name));

    log('разбор…');
    document.getElementById('btnPreview').disabled = true;
    try {
      const res = await fetch('/api/preview', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

      previewToken = data.previewToken;
      lastRows = data.rows || [];
      buildWarnIndex(data.warnings);
      renderWarnings(data.warnings);
      renderPreviewTable(lastRows);
      updateStats({ rows: data.stats?.rows, routes: data.stats?.routes });
      setSteps(3);
      logMergePlan(data.mergePlan);

      (data.files || []).forEach((f) => {
        const tag = f.kind === 'разово' ? 'разово' : 'маркер';
        log(`${f.name} [${tag} ${f.label}]: ${f.rows} строк, ${f.routes} маршрутов`);
      });
      if (data.stats?.errors) log(`ошибок проверки: ${data.stats.errors}`, 'warn');
      else log('предпросмотр OK — можно записывать');
    } catch (err) {
      log(String(err.message || err), 'warn');
      previewToken = null;
      updateStats();
    } finally {
      document.getElementById('btnPreview').disabled = false;
    }
  }

  async function apiApply() {
    if (!previewToken) return;
    try {
      const res = await fetch('/api/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ previewToken, writeLocal: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSteps(4);
      log(`записано: ${(data.paths || []).join(', ')}`);
      if (data.meta?.lastWriteAt) log(`в базе: активный ${data.meta.activeNormativeId}, ${data.meta.rootShiftDetailsRows} строк в корне`);
      loadBundleInfo();
    } catch (err) {
      log(String(err.message || err), 'warn');
    }
  }

  document.getElementById('btnPreview').addEventListener('click', apiPreview);
  document.getElementById('btnApply').addEventListener('click', apiApply);
  document.getElementById('normFrom').addEventListener('change', () => {
    document.getElementById('normFrom').dataset.userTouched = '1';
    updateStats();
  });

  fetch('/api/health').then((r) => r.json()).then((data) => {
    log(`сервер подключён${data.build ? ` (${data.build})` : ''}`);
    loadBundleInfo();
  }).catch(() => {
    log('запустите: cd Naryad_pan && python serve.py', 'warn');
  });

  rows.push(newRow());
  renderDocList();
  updateStats();
  setSteps(0);
})();
