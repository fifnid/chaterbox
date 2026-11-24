import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
const required = [
  'public/index.html', 'public/app.js', 'public/manifest.webmanifest', 'public/sw.js',
  'public/icons/icon-192.png', 'public/icons/icon-512.png', 'public/icons/apple-touch-icon.png', 'public/icons/icon-1024.png', 'public/icons/icon-maskable-512.png', 'public/favicon.ico', 'public/favicon.png',
  'public/avatars/teacher-neutral.png',
  'netlify/functions/api.mjs', 'public/ocr/tesseract.esm.min.js', 'public/ocr/worker.min.js',
  'public/ocr/core/tesseract-core.wasm.js', 'public/ocr/core/tesseract-core.wasm',
  'public/ocr/core/tesseract-core-simd.wasm.js', 'public/ocr/core/tesseract-core-simd.wasm',
  'public/ocr/lang/eng.traineddata.gz', 'public/ocr/lang/rus.traineddata.gz'
];
for (const path of required) await access(new URL(`../${path}`, import.meta.url), constants.R_OK);
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'));
if (manifest.theme_color !== '#07152e' || !manifest.icons.some(icon => icon.purpose === 'maskable')) throw new Error('Не настроены цвет темы или maskable-иконка PWA.');
if (!html.includes('href="/favicon.ico"') || !html.includes('href="/icons/icon-192.png"') || !html.includes('<title>Chatterbox')) throw new Error('Favicon, брендовая иконка или название Chatterbox не подключены.');
if (manifest.name !== 'Chatterbox — классное пространство' || manifest.short_name !== 'Chatterbox') throw new Error('Название PWA не обновлено на Chatterbox.');
if (!html.includes('id="welcome"') || !html.includes('id="openAdmin"')) throw new Error('Экран входа или кнопка учителя не найдены.');
if (!html.includes('id="teacherBack"') || !html.includes('id="teacherSendForm"') || !html.includes('id="teacherGroupSelect"')) throw new Error('Интерфейс переключения чатов учителя не найден.');
if (!html.includes('id="accountButton"') || !html.includes('id="accountModal"') || !html.includes('id="studentPassword"')) throw new Error('Настройки пароля аккаунта не найдены.');
for (const id of ['studentCallButton', 'teacherCallButton', 'callModal', 'callPermission', 'grantCallAccess', 'callActive', 'screenShareButton', 'callFullscreenButton', 'htmlFullscreenButton', 'studentRoomNav', 'studentTutorRoom', 'teacherAvatar', 'tutorAutoplay', 'tutorVoiceStatus', 'tutorForm', 'studentTranslatorRoom', 'translatorForm', 'translationPhotoInput', 'studentFileInput', 'teacherFileInput', 'htmlPreviewModal']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Не найден элемент видео/файлов ${id}.`);
}
const js = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const api = await readFile(new URL('../netlify/functions/api.mjs', import.meta.url), 'utf8');
const netlify = await readFile(new URL('../netlify.toml', import.meta.url), 'utf8');
if (!/Permissions-Policy\s*=\s*"camera=\(self\), microphone=\(self\)/.test(netlify)) throw new Error('Политика безопасности блокирует камеру или микрофон.');
if (!js.includes('openTeacherChat') || !api.includes("action === 'admin-group-messages'") || !api.includes("action === 'admin-message-send'")) throw new Error('Не найдены обработчики чатов учителя.');
for (const action of ['student-login', 'account-set-password', 'student-delete', 'group-delete', 'file-upload', 'file-download', 'call-join', 'call-poll', 'call-signal', 'call-leave']) {
  if (!api.includes(`action === '${action}'`)) throw new Error(`Не найден API-обработчик ${action}.`);
}
if (!js.includes('startVideoCall') || !js.includes('requestCallMedia') || !js.includes('getUserMedia') || !js.includes('cameraPermissionHelp') || !js.includes('getDisplayMedia') || !js.includes('toggleFullscreen') || !js.includes('two-participants') || !js.includes('freeAiCompletion') || !js.includes('translateText') || !js.includes('getOcrWorker') || !js.includes('openai-fast') || !js.includes('uploadAttachment') || !js.includes('Открыть HTML') || !js.includes('speechSynthesis') || !js.includes('speakTutorText') || !js.includes('isDirectAnswerRequest')) throw new Error('Не найдены интерфейсы видеосвязи/ИИ/озвучки/перевода/полноэкранного просмотра/вложений.');
if (!api.includes("'share-start'") || !api.includes("'share-stop'")) throw new Error('Не найдена сигнализация демонстрации экрана.');
console.log('Проверка пройдена: аккаунты, чаты, файлы/HTML, видеосвязь/демонстрация, ИИ/озвучка/аватар, перевод, PWA и OCR-ассеты.');
