/**
 * ЦППК — API для приложения «Цифровой помощник»
 *
 * Данные в таблице: doGet читает листы при КАЖДОМ запросе — переразвёртывание не нужно.
 * Переразвёртывание (/exec) нужно только после изменения ЭТОГО кода → npm run clasp:push
 */

const SHEET_GRAPH = 'График работы_Прил';
const SHEET_SHIFTS = 'Часы_смен_прил';
const SHEET_IMPORT = 'Импорт';
const SHEET_BASE = 'Часы_смен_База';
const SHEET_SETTINGS = 'Настройки';
const SHEET_FEEDBACK = 'Обратная_связь';

/** Токен @bag_rep_bot — дублируется на листе «Настройки» для правки без redeploy кода */
const FEEDBACK_TELEGRAM_BOT_TOKEN_DEFAULT = '8849278670:AAFsjKwoDYqgQFs_TfYzXxnnsCEsSJWvICc';

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Депо Скрипты')
    .addItem('Принять в работу', 'acceptImportToBase')
    .addItem('Проверить сборку графиков', 'checkJsonOutput')
    .addItem('Проверить сборку часов смен', 'checkShiftsOutput')
    .addSeparator()
    .addItem('Настроить баг-репортер', 'setupFeedbackReporter')
    .addToUi();
}

function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};

    if (params.action === 'feedback') {
      const result = handleFeedbackPayload(params);
      const callback = String(params.callback || '').trim();
      if (callback && /^[a-zA-Z_$][\w$]*$/.test(callback)) {
        return ContentService.createTextOutput(`${callback}(${JSON.stringify(result)})`)
          .setMimeType(ContentService.MimeType.JAVASCRIPT);
      }
      return jsonResponse(result);
    }

    if (params.action === 'gcalToken') {
      return jsonResponse(handleGoogleCalendarTokenExchange(params));
    }

    if (params.check === 'version') {
      return jsonResponse(getVersionPayload());
    }

    const employees = getAllEmployeesData();
    const shiftDetails = getShiftDetailsData();
    const versionInfo = getVersionPayload(employees.length, shiftDetails.length);

    return jsonResponse({
      version: versionInfo.version,
      dataVersion: versionInfo.version,
      lastUpdated: versionInfo.lastUpdated,
      employees: employees,
      shiftDetails: shiftDetails
    });
  } catch (error) {
    return jsonResponse({
      status: 'error',
      message: error.toString(),
      stack: error.stack
    });
  }
}

function doPost(e) {
  try {
    let payload = {};
    if (e && e.parameter) {
      payload = Object.assign({}, e.parameter);
    }
    if (e && e.postData && e.postData.contents) {
      const type = String(e.postData.type || '').toLowerCase();
      if (type.indexOf('application/json') !== -1) {
        try {
          payload = Object.assign(payload, JSON.parse(e.postData.contents));
        } catch (parseErr) {
          // keep form payload
        }
      } else if (type.indexOf('application/x-www-form-urlencoded') !== -1) {
        String(e.postData.contents).split('&').forEach(pair => {
          const idx = pair.indexOf('=');
          if (idx === -1) return;
          const key = decodeURIComponent(pair.slice(0, idx).replace(/\+/g, ' '));
          const value = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
          payload[key] = value;
        });
      }
    }

    if (String(payload.action || '').trim() === 'feedback') {
      return jsonResponse(handleFeedbackPayload(payload));
    }

    if (String(payload.action || '').trim() === 'gcalToken') {
      return jsonResponse(handleGoogleCalendarTokenExchange(payload));
    }

    return jsonResponse({ ok: false, error: 'unknown_action' });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error.toString()
    });
  }
}

/** OAuth Google Calendar — client id по умолчанию; secret — в листе «Настройки» ключ GCAL_CLIENT_SECRET */
const GCAL_CLIENT_ID_DEFAULT = '1039992706846-9f1jh5polagou6eebec3tpcs52idvphg.apps.googleusercontent.com';

function getGoogleCalendarSettings() {
  ensureFeedbackSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(2, 1, lastRow, 2).getValues();
  const map = {};
  rows.forEach(row => {
    const key = String(row[0] || '').trim();
    if (key) map[key] = String(row[1] || '').trim();
  });
  return {
    clientId: map.GCAL_CLIENT_ID || GCAL_CLIENT_ID_DEFAULT,
    clientSecret: map.GCAL_CLIENT_SECRET || ''
  };
}

function handleGoogleCalendarTokenExchange(params) {
  const code = String(params.code || '').trim();
  const redirectUri = String(params.redirect_uri || '').trim();
  const codeVerifier = String(params.code_verifier || '').trim();

  if (!code || !redirectUri || !codeVerifier) {
    return { ok: false, error: 'missing_params', error_description: 'code, redirect_uri, code_verifier обязательны' };
  }

  const settings = getGoogleCalendarSettings();
  const payload = {
    code: code,
    client_id: settings.clientId,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier
  };
  if (settings.clientSecret) {
    payload.client_secret = settings.clientSecret;
  }

  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: payload,
    muteHttpExceptions: true
  });

  const text = resp.getContentText() || '{}';
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    return { ok: false, error: 'parse_error', error_description: text.slice(0, 500) };
  }

  if (data.error) {
    return { ok: false, error: data.error, error_description: data.error_description || data.error };
  }

  return {
    ok: true,
    access_token: data.access_token || '',
    expires_in: data.expires_in || 3600,
    token_type: data.token_type || 'Bearer'
  };
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Версия данных — Drive lastUpdated (если есть scope) или размеры листов.
 * Приложение сравнивает её каждые 2 мин и подтягивает новый JSON без redeploy.
 */
function getVersionPayload(employeeCount, shiftCount) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const graphSheet = ss.getSheetByName(SHEET_GRAPH);
  const shiftsSheet = ss.getSheetByName(SHEET_SHIFTS);
  const tz = Session.getScriptTimeZone();

  const gRows = graphSheet ? graphSheet.getLastRow() : 0;
  const gCols = graphSheet ? graphSheet.getLastColumn() : 0;
  const sRows = shiftsSheet ? shiftsSheet.getLastRow() : 0;
  const sCols = shiftsSheet ? shiftsSheet.getLastColumn() : 0;

  let lastUpdated = '';
  try {
    const updatedAt = DriveApp.getFileById(ss.getId()).getLastUpdated();
    lastUpdated = Utilities.formatDate(updatedAt, tz, "yyyy-MM-dd'T'HH:mm:ss");
  } catch (e) {
    lastUpdated = `dims-${gRows}x${gCols}-${sRows}x${sCols}`;
  }

  const emp = employeeCount != null ? employeeCount : '—';
  const sh = shiftCount != null ? shiftCount : '—';
  const version = `${lastUpdated}|g${gRows}x${gCols}|s${sRows}x${sCols}|e${emp}|d${sh}`;

  return {
    version: version,
    dataVersion: version,
    lastUpdated: lastUpdated
  };
}

function acceptImportToBase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const importSheet = ss.getSheetByName(SHEET_IMPORT);
  const baseSheet = ss.getSheetByName(SHEET_BASE);
  const ui = SpreadsheetApp.getUi();

  if (!importSheet || !baseSheet) {
    ui.alert('Ошибка', `Проверь названия листов ${SHEET_IMPORT} и ${SHEET_BASE}`, ui.ButtonSet.OK);
    return;
  }

  const targetDate = importSheet.getRange('A2').getValue();
  if (!targetDate) {
    ui.alert('Ошибка', 'Ячейка A2 на листе Импорт пустая.', ui.ButtonSet.OK);
    return;
  }

  const lastRow = importSheet.getLastRow();
  const lastCol = importSheet.getLastColumn();

  if (lastRow < 1 || lastCol < 2) {
    ui.alert('Инфо', 'Нет данных для импорта', ui.ButtonSet.OK);
    return;
  }

  const dataColsCount = lastCol - 1;
  const importRange = importSheet.getRange(1, 2, lastRow, dataColsCount);
  const rawData = importRange.getValues();
  const preparedRows = rawData.map(row => [targetDate, ...row]);

  const lastRowBase = baseSheet.getLastRow();
  baseSheet.getRange(lastRowBase + 1, 1, preparedRows.length, preparedRows[0].length).setValues(preparedRows);

  importRange.clearContent();
  importRange.clearFormat();

  ui.alert('Успех', 'Данные перенесены в базу. JSON в приложении обновится автоматически (до 2 мин).', ui.ButtonSet.OK);
}

function checkJsonOutput() {
  const data = getAllEmployeesData();
  const ui = SpreadsheetApp.getUi();

  if (data.length === 0) {
    ui.alert('Пусто', 'Скрипт не нашёл ни одного сотрудника в графике.', ui.ButtonSet.OK);
    return;
  }

  const firstEmp = data[0];
  const firstShift = firstEmp.shifts.length > 0 ? firstEmp.shifts[0] : null;
  const ver = getVersionPayload(data.length, getShiftDetailsData().length);

  let msg = `Маркер версии: ${ver.version}\n`;
  msg += `Всего сотрудников: ${data.length}\n\n`;
  msg += `Первый: ${firstEmp.fio} (${firstEmp.position || '—'})\n\n`;

  if (firstShift) {
    msg += `Первая смена:\n`;
    msg += `Дата: ${firstShift.date}\n`;
    msg += `Маршрут: ${firstShift.route} (${firstShift.debugCol}${firstShift.debugRow})\n`;
    msg += `Часов: ${firstShift.hours}\n`;
    msg += `Явка: ${firstShift.startTime}\n`;
    msg += `Концы: ${firstShift.endTime}\n`;
  } else {
    msg += 'Нет запланированных смен.';
  }

  ui.alert('Проверка графика', msg, ui.ButtonSet.OK);
}

function checkShiftsOutput() {
  const data = getShiftDetailsData();
  const ui = SpreadsheetApp.getUi();

  if (data.length === 0) {
    ui.alert('Пусто', `Лист ${SHEET_SHIFTS} пуст или содержит только шапку.`, ui.ButtonSet.OK);
    return;
  }

  const ver = getVersionPayload(getAllEmployeesData().length, data.length);
  let msg = `Маркер версии: ${ver.version}\n`;
  msg += `Маршрутов в расшифровке: ${data.length}\n\n`;
  msg += `Пример первой записи:\n${JSON.stringify(data[0], null, 2)}`;

  ui.alert('Проверка часов смен', msg, ui.ButtonSet.OK);
}

function getAllEmployeesData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_GRAPH);
  if (!sheet) {
    throw new Error(`Лист ${SHEET_GRAPH} не найден`);
  }

  const range = sheet.getDataRange();
  const fullData = range.getValues();
  const displayData = range.getDisplayValues();
  const result = [];

  if (fullData.length < 3) return result;

  const datesArray = fullData[1];
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

  const getColLetter = (colIdx) => {
    return colIdx < 26
      ? alphabet[colIdx]
      : alphabet[Math.floor(colIdx / 26) - 1] + alphabet[colIdx % 26];
  };

  for (let r = 2; r < fullData.length; r += 7) {
    if (r + 6 >= fullData.length) break;

    const employeeId = (displayData[r][1] || displayData[r + 1][1] || '').toString().trim();
    const lastName = (displayData[r][2] || '').toString().trim();
    const firstName = (displayData[r + 1][2] || '').toString().trim();
    const fio = `${lastName} ${firstName}`.trim();
    const position = (displayData[r][3] || displayData[r + 1][3] || '').toString().trim();

    if (!fio || fio.startsWith('#')) continue;

    const employeeShifts = [];

    for (let colIdx = 4; colIdx < datesArray.length; colIdx++) {
      const route = (displayData[r][colIdx] || '').toString().trim();

      if (!route || route === 'В' || route === 'О' || route === 'З') continue;

      const rawDate = datesArray[colIdx];
      const formattedDate = (rawDate instanceof Date)
        ? Utilities.formatDate(rawDate, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : rawDate.toString();

      employeeShifts.push({
        date: formattedDate,
        route: route,
        hours: (displayData[r + 1][colIdx] || '').toString().trim(),
        startTime: (displayData[r + 2][colIdx] || '').toString().trim(),
        endTime: (displayData[r + 3][colIdx] || '').toString().trim(),
        lunch: (displayData[r + 4][colIdx] || '').toString().trim(),
        trainNum: (displayData[r + 5][colIdx] || '').toString().trim(),
        nightHours: (displayData[r + 6][colIdx] || '').toString().trim(),
        debugCol: getColLetter(colIdx),
        debugRow: r + 1
      });
    }

    result.push({
      tabNumber: employeeId,
      fio: fio,
      position: position,
      shifts: employeeShifts
    });
  }

  return result;
}

function getShiftDetailsData() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SHIFTS);
  if (!sheet) {
    throw new Error(`Лист ${SHEET_SHIFTS} не найден`);
  }

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const displayData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getDisplayValues();
  const rawData = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const result = [];

  for (let i = 0; i < displayData.length; i++) {
    const row = displayData[i];
    const rawRow = rawData[i];

    if (!row[1]) continue;

    let formattedDate = row[0];
    if (rawRow[0] instanceof Date) {
      formattedDate = Utilities.formatDate(rawRow[0], Session.getScriptTimeZone(), 'yyyy-MM-dd');
    }

    result.push({
      date: formattedDate,
      route: (row[1] || '').toString().trim(),
      startPlace: (row[2] || '').toString().trim(),
      startTime: (row[3] || '').toString().trim(),
      trains: (row[4] || '').toString().trim(),
      endTime: (row[5] || '').toString().trim(),
      nightHours: (row[6] || '').toString().trim(),
      workHours: (row[7] || '').toString().trim(),
      morningRoute: (row[8] || '').toString().trim(),
      lunch: (row[9] || '').toString().trim()
    });
  }

  return result;
}

function setupFeedbackReporter() {
  ensureFeedbackSheets();
  const settings = getFeedbackSettings();
  const ui = SpreadsheetApp.getUi();
  let msg = 'Листы «Настройки» и «Обратная_связь» готовы.\n\n';
  msg += `Токен бота: ${settings.token ? 'задан' : 'не задан'}\n`;
  msg += `Chat ID: ${settings.chatId || 'не задан — напишите /start боту @bag_rep_bot'}\n\n`;
  msg += 'Chat ID подставится автоматически после первого сообщения боту.';
  ui.alert('Баг-репортер', msg, ui.ButtonSet.OK);
}

function ensureFeedbackSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SHEET_SETTINGS);
    settingsSheet.getRange(1, 1, 1, 2).setValues([['Ключ', 'Значение']]);
    settingsSheet.getRange(2, 1, 4, 2).setValues([
      ['TELEGRAM_BOT_TOKEN', FEEDBACK_TELEGRAM_BOT_TOKEN_DEFAULT],
      ['TELEGRAM_CHAT_ID', ''],
      ['GCAL_CLIENT_ID', GCAL_CLIENT_ID_DEFAULT],
      ['GCAL_CLIENT_SECRET', '']
    ]);
    settingsSheet.setFrozenRows(1);
  } else {
    const rows = settingsSheet.getRange(2, 1, Math.max(settingsSheet.getLastRow(), 2), 1).getValues();
    const keys = rows.map(r => String(r[0] || '').trim());
    if (!keys.includes('GCAL_CLIENT_ID')) {
      settingsSheet.appendRow(['GCAL_CLIENT_ID', GCAL_CLIENT_ID_DEFAULT]);
    }
    if (!keys.includes('GCAL_CLIENT_SECRET')) {
      settingsSheet.appendRow(['GCAL_CLIENT_SECRET', '']);
    }
  }

  let feedbackSheet = ss.getSheetByName(SHEET_FEEDBACK);
  if (!feedbackSheet) {
    feedbackSheet = ss.insertSheet(SHEET_FEEDBACK);
    feedbackSheet.getRange(1, 1, 1, 7).setValues([[
      'Дата', 'Версия', 'Таб №', 'ФИО', 'Экран', 'Сообщение', 'Telegram'
    ]]);
    feedbackSheet.setFrozenRows(1);
  }
}

function getFeedbackSettings() {
  ensureFeedbackSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(2, 1, lastRow, 2).getValues();
  const map = {};
  rows.forEach(row => {
    const key = String(row[0] || '').trim();
    if (key) map[key] = String(row[1] || '').trim();
  });

  return {
    token: map.TELEGRAM_BOT_TOKEN || FEEDBACK_TELEGRAM_BOT_TOKEN_DEFAULT,
    chatId: map.TELEGRAM_CHAT_ID || ''
  };
}

function setFeedbackSetting(key, value) {
  ensureFeedbackSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const lastRow = Math.max(sheet.getLastRow(), 2);
  const rows = sheet.getRange(2, 1, lastRow, 2).getValues();
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0] || '').trim() === key) {
      sheet.getRange(i + 2, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function resolveTelegramChatId(token, currentChatId) {
  if (currentChatId) return currentChatId;

  try {
    const resp = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20`, {
      muteHttpExceptions: true
    });
    const data = JSON.parse(resp.getContentText() || '{}');
    const updates = Array.isArray(data.result) ? data.result : [];

    for (let i = updates.length - 1; i >= 0; i--) {
      const update = updates[i];
      const chat = (update.message && update.message.chat)
        || (update.callback_query && update.callback_query.message && update.callback_query.message.chat);
      if (chat && chat.id) {
        const chatId = String(chat.id);
        setFeedbackSetting('TELEGRAM_CHAT_ID', chatId);
        return chatId;
      }
    }
  } catch (e) {
    // ignore
  }

  return '';
}

function appendFeedbackLogRow(entry, telegramStatus) {
  ensureFeedbackSheets();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_FEEDBACK);
  const tz = Session.getScriptTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([
    now,
    entry.version || '',
    entry.tab || '',
    entry.user || '',
    entry.screen || '',
    entry.message || '',
    telegramStatus || ''
  ]);
}

function sendFeedbackTelegram(token, chatId, text) {
  const resp = UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      chat_id: chatId,
      text: text,
      disable_web_page_preview: true
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText() || '{}');
  if (!data.ok) {
    throw new Error(data.description || `Telegram HTTP ${resp.getResponseCode()}`);
  }
  return data;
}

function handleFeedbackPayload(payload) {
  const message = String(payload.message || '').trim().slice(0, 2000);
  if (!message) {
    return { ok: false, error: 'empty_message' };
  }

  const entry = {
    version: String(payload.version || '').trim().slice(0, 32),
    tab: String(payload.tab || '').trim().slice(0, 32),
    user: String(payload.user || '').trim().slice(0, 120),
    screen: String(payload.screen || '').trim().slice(0, 32),
    message: message
  };

  const settings = getFeedbackSettings();
  const chatId = resolveTelegramChatId(settings.token, settings.chatId);
  let telegramStatus = 'skipped';

  const lines = [
    '📝 Обратная связь · Цифровой помощник',
    '',
    entry.message,
    '',
    '---',
    `Версия: ${entry.version || '—'}`,
    `ФИО: ${entry.user || '—'}`,
    `Таб. №: ${entry.tab || '—'}`,
    `Экран: ${entry.screen || '—'}`
  ];

  if (chatId) {
    try {
      sendFeedbackTelegram(settings.token, chatId, lines.join('\n'));
      telegramStatus = 'sent';
    } catch (err) {
      telegramStatus = `error: ${err}`;
    }
  } else {
    telegramStatus = 'no_chat_id';
  }

  appendFeedbackLogRow(entry, telegramStatus);

  if (telegramStatus === 'sent') {
    return { ok: true };
  }

  if (telegramStatus === 'no_chat_id') {
    return {
      ok: true,
      warning: 'saved_to_sheet',
      message: 'Сохранено в таблицу. Напишите /start боту @bag_rep_bot — следующие сообщения уйдут в Telegram.'
    };
  }

  return {
    ok: true,
    warning: 'telegram_failed',
    message: 'Сохранено в таблицу, но Telegram временно недоступен.'
  };
}
