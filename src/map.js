const POPUP_DELAY = 200;

// Определение данных и путей
const externalData = window.externalData ?? null;
const interactiveAreasData = window.interactiveAreasData ?? null;
const mapImagePath = window.mapImagePath ?? 'yard_map.jpg';

let parsedData = null;
let interactiveAreas = [];
let mapImage = null;
let interactiveAreasContainer = null;
let mapErrorOverlay = null;
let mapLoadingOverlay = null;
let dataStatusContainer = null;
let dataStatusText = null;
let dataStatusSpinner = null;
let mapReady = false;
let areasReady = false;
let mapLoadFallbackTried = false;
let popupTimer = null;
let lastPointerEvent = null;

const interactiveAreaSchema = {
    required: ['name', 'x', 'y', 'width', 'height', 'matchField'],
    propertyTypes: {
        name: 'string',
        x: 'number',
        y: 'number',
        width: 'number',
        height: 'number',
        matchField: 'string',
        matchValue: 'string'
    }
};

function normalizePath(path) {
    if (!path || typeof path !== 'string') {
        return path;
    }
    return path.replace(/\\/g, '/');
}

function convertToFileUrl(path) {
    if (!path || typeof path !== 'string') {
        return path;
    }

    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('file://')) {
        return path;
    }

    if (/^[A-Za-z]:/.test(path)) {
        const normalized = normalizePath(path);
        return 'file:///' + normalized;
    }

    return normalizePath(path);
}

function buildJsonFromObjectStrings(rawString) {
    const cleanedString = rawString.trim().replace(/^\[/, '').replace(/\]$/, '');
    if (!cleanedString) {
        return '[]';
    }

    const objectStrings = cleanedString.split(/}\s*,\s*{/).map(chunk => {
        let normalized = chunk.trim();
        if (!normalized.startsWith('{')) {
            normalized = '{' + normalized;
        }
        if (!normalized.endsWith('}')) {
            normalized = normalized + '}';
        }
        return normalized;
    });

    const jsonReadyObjects = objectStrings.map(chunk => {
        const escapedBackslashes = chunk.replace(/\\/g, '\\\\');
        const quotedKeys = escapedBackslashes.replace(/([{,]\s*)([^,{:]+?)(\s*:\s*)/g, (match, prefix, key, separator) => {
            const safeKey = key.trim().replace(/"/g, '\\"');
            return `${prefix}"${safeKey}"${separator}`;
        });

        const quotedValues = quotedKeys.replace(/:\s*([^,"}{\[\]]+)(?=\s*[},])/g, (match, value) => {
            const trimmedValue = value.trim();

            if (/^-?\d+(?:[.,]\d+)?$/.test(trimmedValue)) {
                return `: ${trimmedValue.replace(',', '.')}`;
            }

            const safeValue = trimmedValue.replace(/"/g, '\\"');
            return `: "${safeValue}"`;
        });

        return quotedValues;
    });

    return `[${jsonReadyObjects.join(',')}]`;
}

function parseObjectsStringManually(dataString) {
    const jsonString = buildJsonFromObjectStrings(dataString);
    const parsed = JSON.parse(jsonString);

    if (!Array.isArray(parsed)) {
        throw new Error('Ожидается массив объектов с данными для карты.');
    }

    return parsed;
}

function parseDataString(dataString) {
    if (!dataString || typeof dataString !== 'string') {
        return null;
    }

    const trimmedString = dataString.trim();

    if (!trimmedString) {
        return null;
    }

    try {
        const parsed = JSON.parse(trimmedString);

        if (!Array.isArray(parsed)) {
            throw new Error('Ожидается массив объектов с данными для карты.');
        }

        return parsed;
    } catch (jsonError) {
        return parseObjectsStringManually(trimmedString);
    }
}

function parseInteractiveAreasString(rawString) {
    if (!rawString || typeof rawString !== 'string') {
        return [];
    }

    const trimmed = rawString.trim();

    if (!trimmed) {
        return [];
    }

    try {
        const parsed = JSON.parse(trimmed);
        validateInteractiveAreasData(parsed);
        return parsed;
    } catch (error) {
        const parsed = parseObjectsStringManually(trimmed);
        validateInteractiveAreasData(parsed);
        return parsed;
    }
}

function parseDateTime(dateTimeString) {
    if (!dateTimeString) return null;

    if (dateTimeString.includes('-') || dateTimeString.includes('T')) {
        return new Date(dateTimeString);
    }

    const match = dateTimeString.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
    if (match) {
        const [, day, month, year, hour, minute, second] = match;
        const safeSecond = second ?? '00';
        return new Date(year, month - 1, day, hour, minute, safeSecond);
    }

    return new Date(dateTimeString);
}

function formatDateTime(dateTimeString) {
    if (!dateTimeString) return '';

    const date = parseDateTime(dateTimeString);
    if (!date || isNaN(date.getTime())) return dateTimeString;

    return date.toLocaleString('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function validateInteractiveAreasData(data) {
    if (!Array.isArray(data)) {
        throw new Error('Интерактивные области должны быть массивом объектов.');
    }

    data.forEach((area, index) => {
        interactiveAreaSchema.required.forEach(field => {
            if (area[field] === undefined) {
                throw new Error(`Область №${index + 1} не содержит обязательное поле "${field}".`);
            }
        });

        ['x', 'y', 'width', 'height'].forEach(field => {
            if (area[field] !== undefined) {
                area[field] = Number(String(area[field]).replace(',', '.'));
            }
        });

        Object.entries(interactiveAreaSchema.propertyTypes).forEach(([field, type]) => {
            if (area[field] !== undefined && typeof area[field] !== type) {
                throw new Error(`Поле "${field}" в области №${index + 1} должно быть типа ${type}.`);
            }
        });
    });
}

function normalizeStringValue(value) {
    if (value === undefined || value === null) return '';

    return String(value)
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function filterDataByObject(dataArray, matchField, matchValue) {
    if (!dataArray || !Array.isArray(dataArray)) {
        return [];
    }

    const normalizedMatchValue = normalizeStringValue(matchValue);

    return dataArray.filter(item => {
        const fieldValue = item[matchField];
        if (!fieldValue) return false;

        const normalizedFieldValue = normalizeStringValue(fieldValue);

        return (
            normalizedFieldValue === normalizedMatchValue ||
            normalizedFieldValue.includes(normalizedMatchValue) ||
            normalizedMatchValue.includes(normalizedFieldValue)
        );
    });
}

function validateAreaBounds(areaConfig, naturalWidth, naturalHeight) {
    const errors = [];

    if (!areaConfig || typeof areaConfig !== 'object') {
        errors.push('Конфигурация области не задана или имеет неверный формат');
        return { isValid: false, errors };
    }

    const numericValues = {};
    ['x', 'y', 'width', 'height'].forEach(field => {
        const value = Number(areaConfig[field]);
        numericValues[field] = value;

        if (!Number.isFinite(value)) {
            errors.push(`Поле ${field} должно быть числом`);
            return;
        }

        if ((field === 'width' || field === 'height') && value <= 0) {
            errors.push(`Поле ${field} должно быть больше 0`);
        }

        if ((field === 'x' || field === 'y') && value < 0) {
            errors.push(`Поле ${field} не может быть отрицательным`);
        }
    });

    if (Number.isFinite(numericValues.x) && Number.isFinite(numericValues.width)) {
        if (numericValues.x + numericValues.width > naturalWidth) {
            errors.push('Область выходит за правую границу карты');
        }
    }

    if (Number.isFinite(numericValues.y) && Number.isFinite(numericValues.height)) {
        if (numericValues.y + numericValues.height > naturalHeight) {
            errors.push('Область выходит за нижнюю границу карты');
        }
    }

    return { isValid: errors.length === 0, errors };
}

function createInteractiveArea(areaConfig, scaleX, scaleY) {
    const area = document.createElement('div');
    area.className = 'interactive-area';
    const x = areaConfig.x;
    const y = areaConfig.y;
    const width = areaConfig.width;
    const height = areaConfig.height;

    area.style.left = (x * scaleX) + 'px';
    area.style.top = (y * scaleY) + 'px';
    area.style.width = (width * scaleX) + 'px';
    area.style.height = (height * scaleY) + 'px';
    area.title = areaConfig.name;

    area.addEventListener('mouseenter', function(e) {
        clearTimeout(popupTimer);
        lastPointerEvent = e;
        popupTimer = setTimeout(() => showPopup(e, areaConfig), POPUP_DELAY);
    });

    area.addEventListener('mousemove', function(e) {
        lastPointerEvent = e;
        updatePopupPosition(e);
    });

    area.addEventListener('mouseleave', function() {
        clearTimeout(popupTimer);
        closePopup();
    });

    return area;
}

function showPopup(event, areaConfig) {
    const popup = document.getElementById('popup');
    const popupHeader = document.getElementById('popup-header');
    const popupContent = document.getElementById('popup-content');

    if (!parsedData || !Array.isArray(parsedData)) {
        popupHeader.textContent = areaConfig.name;
        popupContent.innerHTML = '<div class="popup-no-data">Нет данных для отображения</div>';
    } else {
        const normalizedMatchValue = normalizeStringValue(
            areaConfig.matchValue || areaConfig.name
        );

        const filteredData = filterDataByObject(
            parsedData,
            areaConfig.matchField || 'причал',
            normalizedMatchValue
        );

        popupHeader.textContent = areaConfig.name;

        if (filteredData.length === 0) {
            const matchField = areaConfig.matchField || 'объекта';
            const matchValue = areaConfig.matchValue || areaConfig.name;
            popupContent.innerHTML = `<div class="popup-no-data">Нет совпадений по "${matchField}" = "${matchValue}"</div>`;
        } else {
            let contentHTML = '';
            filteredData.forEach((item, index) => {
                contentHTML += `
                    <div class="popup-item">
                        <div class="popup-item-title">Запись ${index + 1}</div>
                        ${item.судно ? `<div class="popup-item-detail"><strong>Судно:</strong> ${item.судно}</div>` : ''}
                        ${item.причал ? `<div class="popup-item-detail"><strong>Причал:</strong> ${item.причал}</div>` : ''}
                        ${item.вид_подхода ? `<div class="popup-item-detail"><strong>Вид подхода:</strong> ${item.вид_подхода}</div>` : ''}
                        ${item.дата_швартовки ? `<div class="popup-item-detail"><strong>Дата швартовки:</strong> ${formatDateTime(item.дата_швартовки)}</div>` : ''}
                        ${item.дата_выбытия ? `<div class="popup-item-detail"><strong>Дата выбытия:</strong> ${formatDateTime(item.дата_выбытия)}</div>` : ''}
                    </div>
                `;
            });
            popupContent.innerHTML = contentHTML;
        }
    }

    popup.classList.add('visible');
    updatePopupPosition(event || lastPointerEvent);
}

function updatePopupPosition(event) {
    const popup = document.getElementById('popup');
    if (!popup || !event) return;

    const popupRect = popup.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = event.clientX + 15;
    let top = event.clientY + 15;

    if (left + popupRect.width > viewportWidth) {
        left = event.clientX - popupRect.width - 15;
    }
    if (top + popupRect.height > viewportHeight) {
        top = event.clientY - popupRect.height - 15;
    }

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
}

function closePopup() {
    const popup = document.getElementById('popup');
    popup.classList.remove('visible');
}

function renderInteractiveAreas() {
    if (!mapReady || !areasReady || !mapImage || !interactiveAreasContainer) {
        return;
    }

    const clientWidth = mapImage.clientWidth;
    const clientHeight = mapImage.clientHeight;
    const naturalWidth = mapImage.naturalWidth;
    const naturalHeight = mapImage.naturalHeight;

    if (!clientWidth || !clientHeight || !naturalWidth || !naturalHeight) {
        return;
    }

    const scaleX = clientWidth / naturalWidth;
    const scaleY = clientHeight / naturalHeight;

    interactiveAreasContainer.innerHTML = '';

    if (!interactiveAreas || interactiveAreas.length === 0) {
        console.warn('Интерактивные области отсутствуют или не загружены.');
        return;
    }

    interactiveAreas.forEach(areaConfig => {
        const validation = validateAreaBounds(areaConfig, naturalWidth, naturalHeight);
        if (!validation.isValid) {
            console.warn(`Область "${areaConfig.name || 'без названия'}" пропущена: ${validation.errors.join('; ')}`);
            return;
        }

        const area = createInteractiveArea(areaConfig, scaleX, scaleY);
        interactiveAreasContainer.appendChild(area);
    });
}

function showMapError(message) {
    if (!mapErrorOverlay) {
        return;
    }

    if (message) {
        mapErrorOverlay.textContent = message;
    }

    mapErrorOverlay.classList.add('visible');
}

function hideMapError() {
    if (!mapErrorOverlay) {
        return;
    }

    mapErrorOverlay.classList.remove('visible');
}

function setLoadingIndicator(isVisible, text) {
    if (!mapLoadingOverlay) return;

    const textNode = mapLoadingOverlay.querySelector('.loading-indicator__text');
    if (textNode && text) {
        textNode.textContent = text;
    }

    mapLoadingOverlay.classList.toggle('visible', Boolean(isVisible));
}

function setDataStatus({ message, loading = false, error = false }) {
    if (!dataStatusContainer || !dataStatusText || !dataStatusSpinner) return;

    dataStatusContainer.style.display = 'flex';
    dataStatusText.textContent = message;
    dataStatusSpinner.style.display = loading ? 'inline-block' : 'none';

    if (error) {
        dataStatusContainer.classList.add('data-status__error');
    } else {
        dataStatusContainer.classList.remove('data-status__error');
    }

    if (!loading && !error) {
        setTimeout(() => {
            dataStatusContainer.style.display = 'none';
        }, 2000);
    }
}

function loadMapImage() {
    if (!mapImage) {
        return;
    }

    if (!mapImagePath) {
        console.warn('Путь к изображению карты не указан. Укажите путь в переменной mapImagePath.');
        return;
    }

    let imageSrc = mapImagePath;

    if (/^[A-Za-z]:/.test(mapImagePath) && window.location.protocol === 'file:') {
        imageSrc = convertToFileUrl(mapImagePath);
    } else {
        imageSrc = normalizePath(mapImagePath);
    }

    hideMapError();
    setLoadingIndicator(true, 'Загрузка карты...');
    mapImage.src = imageSrc;

    if (mapImage.complete && mapImage.naturalWidth) {
        mapReady = true;
        setLoadingIndicator(false);
        renderInteractiveAreas();
        return;
    }

    mapImage.addEventListener('load', function() {
        mapReady = true;
        setLoadingIndicator(false);
        hideMapError();
        renderInteractiveAreas();
    });

    mapImage.addEventListener('error', function() {
        const fallbackRelativePath = 'yard_map.jpg';
        console.error('Не удалось загрузить изображение карты по пути:', mapImage.src);

        if (!mapLoadFallbackTried && mapImagePath && mapImage.src !== fallbackRelativePath) {
            mapLoadFallbackTried = true;
            console.warn('Попытка загрузить изображение по относительному пути по умолчанию:', fallbackRelativePath);
            mapImage.src = fallbackRelativePath;
            return;
        }

        setLoadingIndicator(false, '');
        showMapError('Изображение карты недоступно. Проверьте путь к файлу или запустите страницу через локальный веб-сервер.');
    });
}

async function loadInteractiveAreas() {
    if (!interactiveAreasData) {
        console.warn('Путь к файлу интерактивных областей не указан. Укажите путь в переменной interactiveAreasPath.');
        return;
    }

    const trimmedAreas = String(interactiveAreasData).trim();
    const looksLikeInlineData = trimmedAreas.startsWith('{') || trimmedAreas.startsWith('[');

    setDataStatus({ message: 'Загружаем интерактивные области...', loading: true });

    if (looksLikeInlineData) {
        try {
            const parsedAreas = parseInteractiveAreasString(trimmedAreas);
            if (Array.isArray(parsedAreas) && parsedAreas.length > 0) {
                interactiveAreas = parsedAreas;
                areasReady = true;
                renderInteractiveAreas();
                setDataStatus({ message: 'Интерактивные области загружены', loading: false });
                return;
            }

            setDataStatus({ message: 'Данные областей не найдены', loading: false, error: true });
            console.warn('Строка интерактивных областей есть, но записей не найдено.');
            return;
        } catch (error) {
            setDataStatus({ message: 'Не удалось разобрать интерактивные области', loading: false, error: true });
            console.error('Ошибка разбора интерактивных областей:', error);
            return;
        }
    }

    let areasUrl = interactiveAreasData;

    if (/^[A-Za-z]:/.test(interactiveAreasData) && window.location.protocol === 'file:') {
        areasUrl = convertToFileUrl(interactiveAreasData);
    } else {
        areasUrl = normalizePath(interactiveAreasData);
    }

    try {
        const response = await fetch(areasUrl);

        if (!response.ok) {
            throw new Error('Код ответа: ' + response.status);
        }

        const text = await response.text();
        const parsedAreas = parseInteractiveAreasString(text);

        if (Array.isArray(parsedAreas) && parsedAreas.length > 0) {
            interactiveAreas = parsedAreas;
            areasReady = true;
            renderInteractiveAreas();
            setDataStatus({ message: 'Интерактивные области загружены', loading: false });
        } else {
            setDataStatus({ message: 'Данные областей не найдены', loading: false, error: true });
            console.warn('Файл интерактивных областей загружен, но данных нет.');
        }
    } catch (error) {
        setDataStatus({ message: 'Не удалось загрузить интерактивные области', loading: false, error: true });
        if (error.message && (error.message.includes('CORS') || error.message.includes('Failed to fetch'))) {
            console.error('Ошибка CORS при загрузке интерактивных областей. Для работы с локальными файлами необходимо запустить веб-сервер (например, через Python: python -m http.server или через Live Server в VS Code).');
            console.warn('Альтернатива: используйте относительные пути (например, "interactiveAreas.json") вместо абсолютных путей Windows.');
        } else {
            console.error('Ошибка загрузки интерактивных областей:', error);
        }
    }
}

function initializeDataParsing() {
    if (!externalData) {
        return;
    }

    setDataStatus({ message: 'Загружаем данные объектов...', loading: true });

    if (typeof externalData === 'string') {
        try {
            parsedData = parseDataString(externalData);
            setDataStatus({ message: 'Данные объектов загружены', loading: false });
        } catch (error) {
            setDataStatus({ message: 'Не удалось разобрать данные объектов', loading: false, error: true });
            console.error(error.message);
        }
    } else if (Array.isArray(externalData)) {
        parsedData = externalData;
        setDataStatus({ message: 'Данные объектов загружены', loading: false });
    }
}

function bootstrap() {
    mapImage = document.getElementById('map-image');
    interactiveAreasContainer = document.getElementById('interactive-areas');
    mapErrorOverlay = document.getElementById('map-error-overlay');
    mapLoadingOverlay = document.getElementById('map-loading');
    dataStatusContainer = document.getElementById('data-status');
    dataStatusText = document.getElementById('data-status-text');
    dataStatusSpinner = document.getElementById('data-status-spinner');

    loadMapImage();
    loadInteractiveAreas();
    initializeDataParsing();

    document.addEventListener('click', function(e) {
        const popup = document.getElementById('popup');
        if (popup && !popup.contains(e.target) && !e.target.classList.contains('interactive-area')) {
            closePopup();
        }
    });

    window.addEventListener('resize', function() {
        renderInteractiveAreas();
    });
}

document.addEventListener('DOMContentLoaded', bootstrap);

window.closePopup = closePopup;
