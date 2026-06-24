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

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Депо Скрипты')
    .addItem('Принять в работу', 'acceptImportToBase')
    .addItem('Проверить сборку графиков', 'checkJsonOutput')
    .addItem('Проверить сборку часов смен', 'checkShiftsOutput')
    .addToUi();
}

function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};

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
