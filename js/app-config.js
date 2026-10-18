window.APP_CONFIG = {
    yandexProxy: '',
    yandexClientToken: '',
    webPushVapidPublicKey: 'BPKYfiRk4SLmag3Q4xclEcQB8TkYY-3r-jfzo00lXFjW6JSIDi8-F7MDH72MEIhsLeFSSY62fYlrR-h5-hMVA1A',
    depotApiUrl: 'https://script.google.com/macros/s/AKfycbyXZtOedTna78AwC4bvdGnMqXxqZ1cflSwODYXYIjm7zWA2BfYqpBJlhDZ0JzqozW4RkA/exec',
    cloudtipsLayoutId: '0c990fdb',
    cloudtipsPaymentUrl: 'https://pay.cloudtips.ru/p/0c990fdb',
    cloudtipsFeeApiUrl: 'https://api.cloudtips.ru/api/payment/fee',
    sheduleMax: {
        s3BaseUrl: 'https://shedulemax-public.s3.cloud.ru',
        apiBaseUrl: 'http://127.0.0.1:8792',
        functionUrl: '',
        useDirectS3: true,
        preferStopsApi: false,
        threadRev: 12
    }
};

window.daYandexProxyBase = function daYandexProxyBase() {
    return '';
};

window.daBuildProxyFetchInit = function daBuildProxyFetchInit(init = {}) {
    return { ...init };
};

window.daIsYandexProxyUrl = function daIsYandexProxyUrl() {
    return false;
};
