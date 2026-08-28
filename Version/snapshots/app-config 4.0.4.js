window.APP_CONFIG = {
    yandexProxy: 'https://functions.yandexcloud.net/d4etmp7m8cfgrv283027',
    /** Должен совпадать с CLIENT_GATE_TOKEN в env Cloud Function */
    yandexClientToken: 'da_cppk_client_2026_web',
    webPushVapidPublicKey: 'BPKYfiRk4SLmag3Q4xclEcQB8TkYY-3r-jfzo00lXFjW6JSIDi8-F7MDH72MEIhsLeFSSY62fYlrR-h5-hMVA1A',
    depotApiUrl: 'https://script.google.com/macros/s/AKfycbyXZtOedTna78AwC4bvdGnMqXxqZ1cflSwODYXYIjm7zWA2BfYqpBJlhDZ0JzqozW4RkA/exec',
    cloudtipsLayoutId: '0c990fdb',
    cloudtipsPaymentUrl: 'https://pay.cloudtips.ru/p/0c990fdb',
    cloudtipsFeeApiUrl: 'https://api.cloudtips.ru/api/payment/fee'
};

/** Базовый URL Cloud Function без хвостового слэша */
window.daYandexProxyBase = function daYandexProxyBase() {
    return String(window.APP_CONFIG?.yandexProxy || '').replace(/\/?$/, '');
};

/** Заголовок X-DA-Client для всех запросов к Cloud Function */
window.daBuildProxyFetchInit = function daBuildProxyFetchInit(init = {}) {
    const token = String(window.APP_CONFIG?.yandexClientToken || '').trim();
    const headers = new Headers(init.headers || undefined);
    if (token && !headers.has('X-DA-Client')) {
        headers.set('X-DA-Client', token);
    }
    return { ...init, headers };
};

window.daIsYandexProxyUrl = function daIsYandexProxyUrl(url) {
    const base = window.daYandexProxyBase();
    return Boolean(base && String(url || '').startsWith(base));
};
