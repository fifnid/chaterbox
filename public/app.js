(() => {
  'use strict';
  const $ = s => document.querySelector(s);
  const state = { studentToken: '', student: null, studentRoom: 'class', aiStorageSession: '', tutorHistory: [], translationHistory: [], ocrWorkerPromise: null, ocrWorker: null, ocrWorkerLanguage: '', ocrLoadingLanguage: '', ocrPreviewUrl: null, tutorBusy: false, translateBusy: false, tutorAutoSpeak: localStorage.getItem('linia_tutor_autospeak') !== 'off', tutorUtterance: null, tutorSpeechSequence: 0, teacherEmotion: 'neutral', aiControllers: new Set(), adminToken: '', adminChat: null, adminGroups: [], installEvent: null, poll: null, adminPoll: null, call: null, pendingCall: null, htmlUrl: null };
  const sections = ['welcome', 'studentPanel', 'adminPanel'];
  const setBanner = (node, text = '', kind = 'info') => {
    node.textContent = text;
    node.className = text ? `banner ${kind}` : 'banner';
  };
  const show = id => sections.forEach(name => { $(`#${name}`).style.display = name === id ? (name === 'welcome' ? 'grid' : 'block') : 'none'; });
  const escapeText = value => String(value ?? '');
  const formatDate = value => {
    try { return new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  };
  function getStudentToken() {
    let token = localStorage.getItem('linia_student_session');
    if (!token) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
      localStorage.setItem('linia_student_session', token);
    }
    return token;
  }
  async function api(action, data = {}, admin = false) {
    let response;
    try {
      response = await fetch('/api', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(admin && state.adminToken ? { authorization: `Bearer ${state.adminToken}` } : {})
        },
        body: JSON.stringify({ action, ...data })
      });
    } catch {
      throw new Error('Не удалось связаться с сервером. Откройте сайт по адресу Netlify и проверьте подключение.');
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Ошибка сервера (${response.status}).`);
    return result;
  }
  function openAdmin() { $('#adminModal').classList.add('open'); $('#adminUser').focus(); }
  function closeAdmin() { $('#adminModal').classList.remove('open'); $('#adminPass').value = ''; setBanner($('#loginError')); }
  $('#openAdmin').addEventListener('click', openAdmin);
  $('#closeAdmin').addEventListener('click', closeAdmin);
  $('#cancelAdmin').addEventListener('click', closeAdmin);
  $('#adminModal').addEventListener('click', e => { if (e.target === $('#adminModal')) closeAdmin(); });

  function aiStorageKey(kind) {
    const suffix = state.studentToken.slice(-18) || 'guest';
    return `linia_${kind}_${suffix}`;
  }
  function persistStudentTools() {
    try {
      localStorage.setItem(aiStorageKey('tutor'), JSON.stringify(state.tutorHistory.slice(-30)));
      localStorage.setItem(aiStorageKey('translations'), JSON.stringify(state.translationHistory.slice(-20)));
    } catch {}
  }
  function cancelAiRequests() {
    stopTutorSpeech();
    for (const controller of state.aiControllers) controller.abort();
    state.aiControllers.clear();
  }
  function initializeStudentTools() {
    if (state.aiStorageSession === state.studentToken) return;
    cancelAiRequests();
    state.aiStorageSession = state.studentToken;
    try {
      const tutor = JSON.parse(localStorage.getItem(aiStorageKey('tutor')) || '[]');
      const translations = JSON.parse(localStorage.getItem(aiStorageKey('translations')) || '[]');
      state.tutorHistory = Array.isArray(tutor) ? tutor.slice(-30) : [];
      state.translationHistory = Array.isArray(translations) ? translations.slice(-20) : [];
    } catch { state.tutorHistory = []; state.translationHistory = []; }
    renderTutorMessages(); renderTranslationHistory();
    const lastTutorReply = [...state.tutorHistory].reverse().find(message => message.role === 'assistant');
    state.teacherEmotion = lastTutorReply?.emotion === 'frown' ? 'frown' : 'neutral';
    setTeacherAvatar(state.teacherEmotion, false);
    const lastTranslation = state.translationHistory[state.translationHistory.length - 1];
    if (lastTranslation) $('#translationText').textContent = lastTranslation.result || '';
  }
  function isDirectAnswerRequest(text) {
    const value = String(text || '');
    return /\b(?:copy|cheat|answers? only|just give me|give me (?:the )?(?:full )?answer|tell me the answer|what(?:'s| is) the answer|solve (?:this|it) for me|do (?:the )?homework for me)\b/i.test(value)
      || /спиши|списать|ответы? только|готов(?:ый|ые)\s+ответ|дай\s+(?:мне\s+)?(?:готовый\s+)?ответ|реши\s+(?:за\s+)?(?:задач|упражнен|пример|домашн)|сделай\s+(?:всё|все)\s+за\s+меня/i.test(value);
  }
  function setTeacherAvatar(emotion = 'neutral', speaking = false) {
    const image = $('#teacherAvatar'); const frame = image?.closest('.teacher-avatar-frame');
    if (!image || !frame) return;
    const frown = emotion === 'frown';
    frame.classList.toggle('is-speaking', !!speaking);
    frame.classList.toggle('is-frowning', frown);
    image.alt = frown ? 'Портрет преподавательницы: мягко хмурится, предлагая решить задание самостоятельно' : 'Портрет преподавательницы по присланной фотографии';
    const mood = $('#teacherMoodTag');
    if (mood) mood.textContent = frown ? (speaking ? 'Try it yourself!' : 'Think it through') : (speaking ? 'Speaking…' : 'Ready to help');
  }
  function chooseEnglishVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = window.speechSynthesis.getVoices().filter(voice => /^en[-_]/i.test(voice.lang || ''));
    const rank = voice => {
      const lang = (voice.lang || '').replace('_', '-').toLowerCase();
      const accent = lang.startsWith('en-gb') ? 0 : lang.startsWith('en-us') ? 10 : 20;
      const name = /samantha|serena|kate|susan|moira|victoria|ava|aria|hazel|tessa|libby|google uk english female/i.test(voice.name || '') ? -2 : 0;
      return accent + name;
    };
    return voices.sort((a, b) => rank(a) - rank(b))[0] || null;
  }
  function updateTutorVoiceStatus() {
    const status = $('#tutorVoiceStatus'); if (!status) return;
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      status.textContent = 'В этом браузере нет встроенной озвучки. Попробуйте открыть приложение в Safari или Chrome.';
      $('#tutorAutoplay').disabled = true;
      return;
    }
    $('#tutorAutoplay').disabled = false;
    const voice = chooseEnglishVoice();
    status.textContent = voice
      ? `Голос: ${voice.name} · ${voice.lang}. Предпочитается британский английский; качество зависит от устройства.`
      : 'Используется доступный голос English (UK); список голосов зависит от устройства.';
  }
  function stopTutorSpeech() {
    state.tutorSpeechSequence += 1;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    state.tutorUtterance = null;
    if (state.tutorActiveButton) { state.tutorActiveButton.textContent = '▶ Listen'; state.tutorActiveButton = null; }
    setTeacherAvatar(state.teacherEmotion || 'neutral', false);
  }
  function speakTutorText(text, emotion = 'neutral', playbackButton = null) {
    if (!('speechSynthesis' in window) || !('SpeechSynthesisUtterance' in window)) {
      updateTutorVoiceStatus(); return;
    }
    if (state.tutorActiveButton) { state.tutorActiveButton.textContent = '▶ Listen'; state.tutorActiveButton = null; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text || ''));
    const voice = chooseEnglishVoice();
    utterance.lang = voice?.lang || 'en-GB';
    if (voice) utterance.voice = voice;
    utterance.rate = 0.92; utterance.pitch = emotion === 'frown' ? 0.96 : 1.02; utterance.volume = 1;
    const sequence = ++state.tutorSpeechSequence;
    state.tutorUtterance = utterance; state.teacherEmotion = emotion;
    state.tutorActiveButton = playbackButton;
    if (playbackButton) playbackButton.textContent = '■ Stop';
    setTeacherAvatar(emotion, true);
    utterance.onend = utterance.onerror = () => {
      if (sequence !== state.tutorSpeechSequence) return;
      state.tutorUtterance = null;
      if (state.tutorActiveButton) { state.tutorActiveButton.textContent = '▶ Listen'; state.tutorActiveButton = null; }
      setTeacherAvatar(emotion, false);
    };
    try { window.speechSynthesis.speak(utterance); }
    catch { state.tutorUtterance = null; setTeacherAvatar(emotion, false); updateTutorVoiceStatus(); }
  }
  function renderTutorMessages() {
    const root = $('#tutorMessages'); if (!root) return;
    root.replaceChildren();
    if (!state.tutorHistory.length) {
      const welcome = document.createElement('div'); welcome.className = 'chat-welcome';
      const bold = document.createElement('b'); bold.textContent = 'Спроси про английский';
      const desc = document.createElement('span'); desc.textContent = 'Помощник объяснит правило и даст похожее задание — исходное попробуешь решить сам.';
      welcome.append(bold, desc); root.append(welcome); return;
    }
    state.tutorHistory.forEach((message, index) => {
      const emotion = message.emotion === 'frown' ? 'frown' : 'neutral';
      const item = document.createElement('div');
      item.className = `ai-message ${message.role === 'assistant' ? 'assistant' : 'user'}${message.role === 'assistant' && emotion === 'frown' ? ' tutor-frown' : ''}`;
      const text = document.createElement('div'); text.textContent = message.content || ''; item.append(text);
      const meta = document.createElement('small'); meta.textContent = message.role === 'assistant' ? 'English · ИИ-помощник' : 'Вы'; item.append(meta);
      if (message.role === 'assistant') {
        const actions = document.createElement('div'); actions.className = 'ai-message-actions';
        const button = document.createElement('button'); button.type = 'button'; button.className = 'tutor-play-btn'; button.textContent = '▶ Listen';
        button.dataset.messageIndex = String(index); button.dataset.expression = emotion; button.setAttribute('aria-label', 'Озвучить ответ на английском');
        actions.append(button); item.append(actions);
      }
      root.append(item);
    });
    root.scrollTop = root.scrollHeight;
  }
  $('#tutorAutoplay').checked = state.tutorAutoSpeak;
  $('#tutorAutoplay').addEventListener('change', () => {
    state.tutorAutoSpeak = $('#tutorAutoplay').checked;
    if (!state.tutorAutoSpeak) stopTutorSpeech();
    try { localStorage.setItem('linia_tutor_autospeak', state.tutorAutoSpeak ? 'on' : 'off'); } catch {}
  });
  $('#tutorMessages').addEventListener('click', event => {
    const button = event.target.closest('.tutor-play-btn'); if (!button) return;
    if (button === state.tutorActiveButton) { stopTutorSpeech(); return; }
    const message = state.tutorHistory[Number(button.dataset.messageIndex)];
    if (message?.role === 'assistant') speakTutorText(message.content, button.dataset.expression === 'frown' ? 'frown' : 'neutral', button);
  });
  if ('speechSynthesis' in window) {
    if (typeof window.speechSynthesis.addEventListener === 'function') window.speechSynthesis.addEventListener('voiceschanged', updateTutorVoiceStatus);
    else window.speechSynthesis.onvoiceschanged = updateTutorVoiceStatus;
  }
  updateTutorVoiceStatus();
  function renderTranslationHistory() {
    const root = $('#translationHistory'); if (!root) return;
    root.replaceChildren();
    for (const item of state.translationHistory.slice(-8).reverse()) {
      const entry = document.createElement('article'); entry.className = 'translation-entry';
      const label = document.createElement('small'); label.textContent = item.direction === 'en-ru' ? 'Английский → русский' : 'Русский → английский';
      const source = document.createElement('div'); source.textContent = item.source || '';
      const result = document.createElement('div'); result.className = 'translation-entry-result'; result.textContent = item.result || '';
      entry.append(label, source, result); root.append(entry);
    }
  }
  function setStudentRoom(room) {
    const available = ['class', 'tutor', 'translator'];
    const nextRoom = available.includes(room) ? room : 'class';
    if (nextRoom !== 'tutor') stopTutorSpeech();
    state.studentRoom = nextRoom;
    for (const name of available) {
      const view = $(`#student${name === 'class' ? 'Class' : name === 'tutor' ? 'Tutor' : 'Translator'}Room`);
      if (view) view.classList.toggle('hidden', name !== state.studentRoom);
    }
    document.querySelectorAll('.room-tab').forEach(button => {
      const selected = button.dataset.room === state.studentRoom;
      button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected));
    });
  }
  document.querySelectorAll('.room-tab').forEach(button => button.addEventListener('click', () => setStudentRoom(button.dataset.room)));
  function showStudent(data) {
    state.student = data.student;
    initializeStudentTools();
    setStudentRoom(state.studentRoom);
    show('studentPanel');
    $('#studentHello').textContent = `Здравствуйте, ${data.student.name}`;
    $('#studentGroupTitle').textContent = data.student.groupName ? `Группа «${data.student.groupName}»` : 'Учитель скоро назначит вам группу';
    $('#groupChatTitle').textContent = data.student.groupName ? `Чат · ${data.student.groupName}` : 'Чат класса';
    $('#groupBadge').textContent = data.student.groupName ? 'Ваша группа' : 'Группа не назначена';
    $('#myGroup').textContent = data.student.groupName ? `Вы состоите в группе «${data.student.groupName}».` : 'Учитель пока не назначил группу. Здесь появится название вашего класса.';
    setBanner($('#studentNotice'));
    const hasGroup = !!data.student.groupName;
    $('#sendForm').classList.toggle('hidden', !hasGroup);
    $('#studentCallButton').classList.toggle('hidden', !hasGroup);
    const root = $('#chatMessages');
    root.innerHTML = '';
    if (!hasGroup) {
      const note = document.createElement('div'); note.className = 'chat-welcome';
      note.innerHTML = '<b>Ожидаем распределения</b>Когда учитель добавит вас в группу, вы увидите её название и сможете общаться с классом.';
      root.append(note); return;
    }
    if (!data.messages?.length) {
      const note = document.createElement('div'); note.className = 'chat-welcome';
      note.innerHTML = '<b>Начните общение</b>Здесь будут сообщения вашей группы.'; root.append(note); return;
    }
    data.messages.forEach(message => {
      const item = document.createElement('div'); item.className = 'msg' + (message.isMine ? ' mine' : '');
      if (message.type === 'file') item.append(buildFileCard(message, false));
      else { const text = document.createElement('div'); text.textContent = message.body; item.append(text); }
      const meta = document.createElement('small'); meta.textContent = `${message.sender_role === 'teacher' ? 'Учитель' : message.sender_name} · ${formatDate(message.created_at)}`; item.append(meta);
      root.append(item);
    });
    root.scrollTop = root.scrollHeight;
  }
  async function freeAiCompletion(messages, maxTokens = 400) {
    const controller = new AbortController(); state.aiControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch('https://text.pollinations.ai/openai', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ model: 'openai-fast', messages, temperature: 0.25, max_tokens: maxTokens, stream: false })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 429) throw new Error('У бесплатного ИИ сейчас ограничение по частоте. Подождите немного и попробуйте снова.');
        throw new Error(result.error?.message || result.error || `Внешний ИИ вернул ошибку ${response.status}.`);
      }
      const content = result.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw new Error('ИИ вернул пустой ответ. Попробуйте ещё раз.');
      return content.trim();
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Бесплатный ИИ отвечает слишком долго. Попробуйте ещё раз чуть позже.');
      if (error instanceof TypeError) throw new Error('Внешний ИИ сейчас недоступен в этой сети. Проверьте интернет и попробуйте позже.');
      throw error;
    } finally { clearTimeout(timer); state.aiControllers.delete(controller); }
  }
  $('#tutorForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.tutorBusy) return;
    const input = $('#tutorInput'); const question = input.value.trim();
    if (!question) return;
    const sessionToken = state.studentToken;
    stopTutorSpeech();
    state.teacherEmotion = isDirectAnswerRequest(question) ? 'frown' : 'neutral';
    setTeacherAvatar(state.teacherEmotion, false);
    state.tutorBusy = true; $('#tutorSend').disabled = true; $('#tutorSend').textContent = 'Думаю…';
    input.value = ''; $('#tutorStatus').textContent = 'ИИ готовит объяснение…';
    state.tutorHistory.push({ role: 'user', content: question });
    state.tutorHistory = state.tutorHistory.slice(-30); persistStudentTools(); renderTutorMessages();
    const system = 'You are a kind, patient English tutor for school students. Speak only in simple, level-appropriate English. Explain grammar and vocabulary clearly using short examples. Never provide a complete ready-made answer to homework, worksheets, tests, or exercises. Instead explain the relevant rule, demonstrate a different but similar example, and invite the learner to try the original. If asked directly for an answer, politely guide them with a hint or a leading question. Stay focused on learning English, avoid collecting personal information, and keep each reply under about 130 words.';
    try {
      const messages = [{ role: 'system', content: system }, ...state.tutorHistory.slice(-10).map(({ role, content }) => ({ role, content }))];
      const answer = await freeAiCompletion(messages, 350);
      if (state.studentToken !== sessionToken) return;
      const emotion = state.teacherEmotion === 'frown' || /\b(?:try it yourself|i can(?:not|'t) give you the (?:full )?answer|i won.t do (?:the )?homework for you|i can give you a hint)\b/i.test(answer) ? 'frown' : 'neutral';
      state.teacherEmotion = emotion;
      state.tutorHistory.push({ role: 'assistant', content: answer, emotion }); state.tutorHistory = state.tutorHistory.slice(-30);
      persistStudentTools(); renderTutorMessages(); $('#tutorStatus').textContent = '';
      if (state.tutorAutoSpeak) {
        const buttons = $('#tutorMessages').querySelectorAll('.tutor-play-btn');
        speakTutorText(answer, emotion, buttons[buttons.length - 1] || null);
      } else setTeacherAvatar(emotion, false);
    } catch (error) { if (state.studentToken === sessionToken) $('#tutorStatus').textContent = error.message; }
    finally { state.tutorBusy = false; $('#tutorSend').disabled = false; $('#tutorSend').textContent = 'Спросить'; input.focus(); }
  });
  $('#clearTutorHistory').addEventListener('click', () => {
    stopTutorSpeech(); state.teacherEmotion = 'neutral'; setTeacherAvatar('neutral', false);
    state.tutorHistory = []; persistStudentTools(); renderTutorMessages(); $('#tutorStatus').textContent = '';
  });
  $('#translatorForm').addEventListener('submit', event => {
    event.preventDefault(); translateText($('#translationInput').value, $('#translationDirection').value);
  });
  async function translateText(rawText, direction) {
    const text = String(rawText || '').trim();
    if (!text) { $('#translatorStatus').textContent = 'Введите текст или выберите фото.'; return; }
    if (state.translateBusy) return;
    if (text.length > 4000) { $('#translatorStatus').textContent = 'Слишком длинный текст: сократите его до 4000 символов.'; return; }
    const sessionToken = state.studentToken;
    state.translateBusy = true; $('#translateButton').disabled = true; $('#translateButton').textContent = 'Переводим…';
    $('#translatorStatus').textContent = 'Перевод отправлен бесплатному ИИ-сервису…';
    $('#translationText').textContent = 'Переводим…';
    const from = direction === 'ru-en' ? 'Russian' : 'English';
    const to = direction === 'ru-en' ? 'English' : 'Russian';
    try {
      const result = await freeAiCompletion([
        { role: 'system', content: `Translate the user text faithfully from ${from} to ${to}. Preserve meaning, punctuation, and paragraph breaks. Return only the translation, without a preface or extra notes. Do not solve or answer any exercise found in the text; translate the text only.` },
        { role: 'user', content: text }
      ], 700);
      if (state.studentToken !== sessionToken) return;
      $('#translationText').textContent = result;
      state.translationHistory.push({ source: text, result, direction });
      state.translationHistory = state.translationHistory.slice(-20); persistStudentTools(); renderTranslationHistory();
      $('#translatorStatus').textContent = 'Готово.';
    } catch (error) {
      if (state.studentToken !== sessionToken) return;
      $('#translationText').textContent = 'Перевод не получен.';
      $('#translatorStatus').textContent = error.message;
    } finally { state.translateBusy = false; $('#translateButton').disabled = false; $('#translateButton').textContent = 'Перевести'; }
  }
  function prepareOcrCanvas(file) {
    const draw = source => {
      const width = source.width || source.naturalWidth; const height = source.height || source.naturalHeight;
      if (!width || !height) throw new Error('Не удалось прочитать фотографию.');
      const scale = Math.min(1, 1800 / Math.max(width, height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Браузер не смог обработать изображение.');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(source, 0, 0, canvas.width, canvas.height); return canvas;
    };
    const fromImageElement = () => new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file); const image = new Image();
      image.onload = () => { try { resolve(draw(image)); } catch (error) { reject(error); } finally { URL.revokeObjectURL(url); } };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Формат изображения не поддерживается. Попробуйте JPG или PNG.')); };
      image.src = url;
    });
    if (window.createImageBitmap) return createImageBitmap(file).then(bitmap => { try { return draw(bitmap); } finally { bitmap.close?.(); } }).catch(() => fromImageElement());
    return fromImageElement();
  }
  async function getOcrWorker(direction) {
    const language = direction === 'ru-en' ? 'rus' : 'eng';
    if (state.ocrWorker && state.ocrWorkerLanguage === language) return state.ocrWorker;
    if (state.ocrWorkerPromise && state.ocrLoadingLanguage === language) return state.ocrWorkerPromise;
    if (state.ocrWorkerPromise) await state.ocrWorkerPromise.catch(() => {});
    if (state.ocrWorker) { await state.ocrWorker.terminate().catch(() => {}); state.ocrWorker = null; state.ocrWorkerLanguage = ''; }
    state.ocrLoadingLanguage = language;
    state.ocrWorkerPromise = (async () => {
      $('#translatorStatus').textContent = 'Загружаем OCR-модуль…';
      const library = await import('/ocr/tesseract.esm.min.js');
      const createWorker = library.createWorker || library.default?.createWorker;
      if (!createWorker) throw new Error('Не удалось загрузить OCR-модуль.');
      return createWorker(language, 1, { workerPath: '/ocr/worker.min.js', corePath: '/ocr/core/', langPath: '/ocr/lang/', logger: progress => {
        const percent = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress * 100)}%` : '';
        $('#translatorStatus').textContent = `${progress.status || 'Загружаем OCR-модель'}${percent}. Фото обрабатывается на этом устройстве…`;
      } });
    })().then(worker => { state.ocrWorker = worker; state.ocrWorkerLanguage = language; return worker; })
      .catch(error => { state.ocrWorkerPromise = null; state.ocrLoadingLanguage = ''; throw error; })
      .finally(() => { state.ocrWorkerPromise = null; state.ocrLoadingLanguage = ''; });
    return state.ocrWorkerPromise;
  }
  $('#chooseTranslationPhoto').addEventListener('click', () => { $('#translationPhotoInput').value = ''; $('#translationPhotoInput').click(); });
  $('#translationPhotoInput').addEventListener('change', async event => {
    const file = event.target.files?.[0]; if (!file) return;
    if (!file.type.startsWith('image/')) { $('#translatorStatus').textContent = 'Выберите изображение.'; return; }
    if (file.size > 12 * 1024 * 1024) { $('#translatorStatus').textContent = 'Фото больше 12 МБ. Уменьшите изображение и выберите снова.'; return; }
    if (state.ocrPreviewUrl) URL.revokeObjectURL(state.ocrPreviewUrl);
    state.ocrPreviewUrl = URL.createObjectURL(file); $('#translatorPhotoPreview').src = state.ocrPreviewUrl; $('#translatorPhotoPreview').classList.remove('hidden');
    const direction = $('#translationDirection').value;
    const sessionToken = state.studentToken;
    $('#chooseTranslationPhoto').disabled = true; $('#translateButton').disabled = true; $('#translationDirection').disabled = true;
    try {
      const canvas = await prepareOcrCanvas(file);
      const worker = await getOcrWorker(direction);
      $('#translatorStatus').textContent = 'Распознаём текст на фото локально…';
      const result = await worker.recognize(canvas);
      if (state.studentToken !== sessionToken) return;
      const recognized = String(result.data?.text || '').trim();
      if (!recognized) throw new Error('Текст не распознан. Попробуйте более чёткое, ровное фото при хорошем освещении.');
      $('#translationInput').value = recognized.slice(0, 4000);
      $('#translatorStatus').textContent = recognized.length > 4000 ? 'Распознано. Для одного перевода используется первые 4000 символов.' : 'Текст распознан на устройстве. Переводим…';
      await translateText($('#translationInput').value, direction);
    } catch (error) {
      if (state.studentToken === sessionToken) $('#translatorStatus').textContent = `Не удалось распознать фото: ${error.message || 'проверьте соединение и качество снимка.'} Само изображение не отправлялось.`;
    } finally { $('#chooseTranslationPhoto').disabled = false; $('#translateButton').disabled = false; $('#translationDirection').disabled = false; }
  });
  $('#clearTranslations').addEventListener('click', () => {
    state.translationHistory = []; persistStudentTools(); renderTranslationHistory(); $('#translationText').textContent = 'История очищена.'; $('#translatorStatus').textContent = '';
  });
  async function registerStudent(event) {
    event.preventDefault();
    const button = $('#studentSubmit');
    const name = $('#studentName').value.trim().replace(/\s+/g, ' ');
    const password = $('#studentPassword').value;
    if (name.length < 2) { setBanner($('#notice'), 'Введите имя или никнейм (не менее двух символов).', 'error'); return; }
    if (password && password.length < 8) { setBanner($('#notice'), 'Пароль должен содержать не менее 8 символов.', 'error'); return; }
    button.disabled = true; button.textContent = 'Подключаем…';
    try {
      state.studentToken = getStudentToken();
      const result = await api('student-login', { name, password, sessionToken: state.studentToken });
      $('#studentPassword').value = '';
      localStorage.setItem('linia_student_name', result.student.name);
      showStudent({ ...result, messages: [] });
      await refreshStudent(); startPolling();
    } catch (error) {
      setBanner($('#notice'), error.message, 'error');
    } finally { button.disabled = false; button.textContent = 'Продолжить'; }
  }
  $('#studentForm').addEventListener('submit', registerStudent);
  function openAccount() {
    if (!state.student) return;
    const protectedAccount = Boolean(state.student.hasPassword);
    $('#accountTitle').textContent = state.student.name;
    $('#accountDescription').textContent = protectedAccount
      ? 'Измените пароль аккаунта. Для этого сначала подтвердите текущий пароль.'
      : 'Добавьте пароль, чтобы входить в этот аккаунт с другого телефона. Пока пароля нет, вход возможен только по имени.';
    $('#currentPasswordWrap').classList.toggle('hidden', !protectedAccount);
    $('#currentStudentPassword').required = protectedAccount;
    $('#currentStudentPassword').value = '';
    $('#newStudentPassword').value = '';
    setBanner($('#accountNotice'));
    $('#accountModal').classList.add('open');
    $('#newStudentPassword').focus();
  }
  function closeAccount() {
    $('#accountModal').classList.remove('open');
    $('#currentStudentPassword').value = '';
    $('#newStudentPassword').value = '';
  }
  $('#accountButton').addEventListener('click', openAccount);
  $('#closeAccount').addEventListener('click', closeAccount);
  $('#cancelAccount').addEventListener('click', closeAccount);
  $('#accountModal').addEventListener('click', event => { if (event.target === $('#accountModal')) closeAccount(); });
  $('#accountForm').addEventListener('submit', async event => {
    event.preventDefault();
    const newPassword = $('#newStudentPassword').value;
    if (newPassword.length < 8) { setBanner($('#accountNotice'), 'Пароль должен содержать не менее 8 символов.', 'error'); return; }
    const button = $('#saveAccountPassword'); button.disabled = true; button.textContent = 'Сохраняем…';
    try {
      await api('account-set-password', {
        sessionToken: state.studentToken,
        currentPassword: $('#currentStudentPassword').value,
        newPassword
      });
      state.student.hasPassword = true;
      setBanner($('#accountNotice'), 'Пароль сохранён. Теперь для входа под этим именем потребуется пароль.', 'ok');
      $('#currentPasswordWrap').classList.remove('hidden');
      $('#currentStudentPassword').required = true;
      $('#currentStudentPassword').value = '';
      $('#newStudentPassword').value = '';
      $('#accountDescription').textContent = 'Пароль добавлен. Для его изменения подтвердите текущий пароль.';
    } catch (error) { setBanner($('#accountNotice'), error.message, 'error'); }
    finally { button.disabled = false; button.textContent = 'Сохранить'; }
  });
  async function refreshStudent() {
    if (!state.studentToken || $('#studentPanel').style.display === 'none') return;
    try {
      const data = await api('student-home', { sessionToken: state.studentToken });
      showStudent(data);
    } catch (error) {
      if (/Сессия не найдена/i.test(error.message)) {
        cancelAiRequests(); localStorage.removeItem(aiStorageKey('tutor')); localStorage.removeItem(aiStorageKey('translations'));
        if (state.ocrPreviewUrl) URL.revokeObjectURL(state.ocrPreviewUrl); state.ocrPreviewUrl = null;
        $('#translatorPhotoPreview').removeAttribute('src'); $('#translatorPhotoPreview').classList.add('hidden');
        localStorage.removeItem('linia_student_session'); localStorage.removeItem('linia_student_name');
        state.studentToken = ''; state.aiStorageSession = ''; state.tutorHistory = []; state.translationHistory = [];
        show('welcome'); setBanner($('#notice'), 'Эта сессия закончилась. Введите имя ещё раз.', 'info'); stopPolling();
      } else setBanner($('#studentNotice'), error.message, 'error');
    }
  }
  function startPolling() { stopPolling(); state.poll = setInterval(refreshStudent, 7000); }
  function stopPolling() { if (state.poll) clearInterval(state.poll); state.poll = null; }
  $('#studentLogout').addEventListener('click', () => {
    stopPolling(); cancelAiRequests();
    localStorage.removeItem(aiStorageKey('tutor')); localStorage.removeItem(aiStorageKey('translations'));
    state.tutorHistory = []; state.translationHistory = []; state.aiStorageSession = '';
    if (state.ocrPreviewUrl) URL.revokeObjectURL(state.ocrPreviewUrl); state.ocrPreviewUrl = null;
    $('#translatorPhotoPreview').removeAttribute('src'); $('#translatorPhotoPreview').classList.add('hidden');
    $('#translationInput').value = ''; $('#translationText').textContent = 'Здесь появится перевод.'; $('#translatorStatus').textContent = '';
    if (state.ocrWorker) state.ocrWorker.terminate().catch(() => {});
    state.ocrWorker = null; state.ocrWorkerPromise = null; state.ocrWorkerLanguage = '';
    state.studentToken = ''; state.student = null;
    localStorage.removeItem('linia_student_session'); localStorage.removeItem('linia_student_name');
    $('#studentName').value = ''; show('welcome'); setBanner($('#notice'), 'Вы вышли. Для повторного входа введите имя.', 'info');
  });

  function readableBytes(size) {
    if (!size) return '0 Б';
    if (size < 1024) return `${size} Б`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} КБ`;
    return `${(size / (1024 * 1024)).toFixed(1)} МБ`;
  }
  function buildFileCard(file, isAdmin) {
    const card = document.createElement('div'); card.className = 'file-message';
    const info = document.createElement('div'); info.className = 'file-message-info';
    const name = document.createElement('div'); name.className = 'file-message-name'; name.textContent = file.file_name || 'Вложение';
    const details = document.createElement('div'); details.className = 'file-message-meta'; details.textContent = `${file.file_type || 'Файл'} · ${readableBytes(file.file_size)}`;
    info.append(name, details);
    const actions = document.createElement('div'); actions.className = 'file-message-actions';
    const download = document.createElement('button'); download.type = 'button'; download.className = 'file-action'; download.textContent = 'Скачать';
    download.addEventListener('click', () => getAttachment(file, isAdmin, false)); actions.append(download);
    if (/\.html?$/i.test(file.file_name || '')) {
      const view = document.createElement('button'); view.type = 'button'; view.className = 'file-action'; view.textContent = 'Открыть HTML';
      view.addEventListener('click', () => getAttachment(file, isAdmin, true)); actions.append(view);
    }
    card.append(info, actions); return card;
  }
  async function getAttachment(file, isAdmin, openHtml) {
    try {
      const response = await fetch('/api', {
        method: 'POST', headers: {
          'content-type': 'application/json',
          ...(isAdmin && state.adminToken ? { authorization: `Bearer ${state.adminToken}` } : {})
        },
        body: JSON.stringify({ action: 'file-download', fileId: file.id, sessionToken: state.studentToken })
      });
      if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || 'Не удалось получить файл.'); }
      const data = await response.blob();
      const blob = new Blob([data], { type: openHtml ? 'text/html;charset=utf-8' : (file.file_type || 'application/octet-stream') });
      const url = URL.createObjectURL(blob);
      if (openHtml) {
        if (state.htmlUrl) URL.revokeObjectURL(state.htmlUrl);
        state.htmlUrl = url; $('#htmlPreviewTitle').textContent = file.file_name || 'HTML-файл';
        $('#htmlFrame').src = url; $('#htmlPreviewModal').classList.add('open');
      } else {
        const link = document.createElement('a'); link.href = url; link.download = file.file_name || 'file';
        document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
    } catch (error) { setBanner(isAdmin ? $('#adminNotice') : $('#studentNotice'), error.message, 'error'); }
  }
  function closeHtmlPreview() {
    if (document.fullscreenElement === $('#htmlPreviewModal')) document.exitFullscreen?.().catch(() => {});
    $('#htmlFrame').src = 'about:blank'; $('#htmlPreviewModal').classList.remove('open');
    if (state.htmlUrl) URL.revokeObjectURL(state.htmlUrl); state.htmlUrl = null;
  }
  $('#closeHtmlPreview').addEventListener('click', closeHtmlPreview);
  async function toggleFullscreen(element, button) {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (element.requestFullscreen) await element.requestFullscreen();
      else button.title = 'Просмотр уже занимает всё доступное окно; полноэкранный режим браузера не поддерживается.';
    } catch { button.title = 'Браузер не разрешил полноэкранный режим. Просмотр уже развёрнут на весь экран страницы.'; }
  }
  $('#htmlFullscreenButton').addEventListener('click', () => toggleFullscreen($('#htmlPreviewModal'), $('#htmlFullscreenButton')));
  $('#callFullscreenButton').addEventListener('click', () => toggleFullscreen($('.call-modal'), $('#callFullscreenButton')));
  document.addEventListener('fullscreenchange', () => {
    const htmlFull = document.fullscreenElement === $('#htmlPreviewModal');
    const callFull = document.fullscreenElement === $('.call-modal');
    $('#htmlFullscreenButton').setAttribute('aria-label', htmlFull ? 'Выйти из полноэкранного режима' : 'На весь экран');
    $('#callFullscreenButton').setAttribute('aria-label', callFull ? 'Свернуть видеосвязь' : 'Развернуть видеосвязь');
  });
  $('#htmlPreviewModal').addEventListener('click', event => { if (event.target === $('#htmlPreviewModal')) closeHtmlPreview(); });
  async function uploadAttachment(file, isAdmin, groupId = null) {
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { setBanner(isAdmin ? $('#adminNotice') : $('#studentNotice'), 'Файл больше 4 МБ. Для этой версии выберите файл поменьше.', 'error'); return; }
    const targetBanner = isAdmin ? $('#adminNotice') : $('#studentNotice');
    setBanner(targetBanner, `Загружаем «${file.name}»…`, 'info');
    const form = new FormData(); form.append('action', 'file-upload'); form.append('file', file, file.name);
    if (isAdmin) form.append('groupId', groupId || state.adminChat?.id || '');
    else form.append('sessionToken', state.studentToken);
    try {
      const response = await fetch('/api', { method: 'POST', headers: isAdmin && state.adminToken ? { authorization: `Bearer ${state.adminToken}` } : {}, body: form });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `Ошибка загрузки (${response.status}).`);
      setBanner(targetBanner, `Файл «${file.name}» отправлен.`, 'ok');
      if (isAdmin) await refreshTeacherChat(); else await refreshStudent();
    } catch (error) { setBanner(targetBanner, error.message, 'error'); }
  }
  $('#studentAttach').addEventListener('click', () => $('#studentFileInput').click());
  $('#studentFileInput').addEventListener('change', event => { uploadAttachment(event.target.files[0], false); event.target.value = ''; });
  $('#teacherAttach').addEventListener('click', () => $('#teacherFileInput').click());
  $('#teacherFileInput').addEventListener('change', event => { uploadAttachment(event.target.files[0], true); event.target.value = ''; });

  async function sendMessage(event) {
    event.preventDefault(); const input = $('#messageInput'); const message = input.value.trim(); if (!message) return;
    const button = $('#sendForm button'); button.disabled = true;
    try { await api('message-send', { sessionToken: state.studentToken, message }); input.value = ''; await refreshStudent(); }
    catch (error) { setBanner($('#studentNotice'), error.message, 'error'); }
    finally { button.disabled = false; input.focus(); }
  }
  $('#sendForm').addEventListener('submit', sendMessage);

  async function adminLogin(event) {
    event.preventDefault(); const button = $('#adminSubmit'); button.disabled = true; button.textContent = 'Проверяем…'; setBanner($('#loginError'));
    try {
      const result = await api('admin-login', { username: $('#adminUser').value.trim(), password: $('#adminPass').value });
      state.adminToken = result.token; sessionStorage.setItem('linia_admin_session', result.token); closeAdmin(); await loadAdmin();
    } catch (error) { setBanner($('#loginError'), error.message, 'error'); }
    finally { button.disabled = false; button.textContent = 'Войти'; }
  }
  $('#adminForm').addEventListener('submit', adminLogin);
  async function loadAdmin() {
    try {
      const data = await api('admin-overview', {}, true);
      state.adminToken = sessionStorage.getItem('linia_admin_session') || state.adminToken;
      renderAdmin(data); show('adminPanel'); setBanner($('#adminNotice'));
    } catch (error) {
      if (/сеанс учителя истёк/i.test(error.message)) { state.adminToken = ''; sessionStorage.removeItem('linia_admin_session'); openAdmin(); }
      else { show('adminPanel'); setBanner($('#adminNotice'), error.message, 'error'); }
    }
  }
  function renderAdmin(data) {
    const students = data.students || [], groups = data.groups || [];
    state.adminGroups = groups;
    const chatSelect = $('#teacherGroupSelect');
    chatSelect.innerHTML = '';
    if (!groups.length) { const empty = document.createElement('option'); empty.value = ''; empty.textContent = 'Групп пока нет'; chatSelect.append(empty); }
    groups.forEach(group => { const option = document.createElement('option'); option.value = group.id; option.textContent = group.name; option.selected = state.adminChat?.id === group.id; chatSelect.append(option); });
    $('#studentCount').textContent = `${students.length} ${students.length === 1 ? 'ученик' : students.length >= 2 && students.length <= 4 ? 'ученика' : 'учеников'}`;
    $('#groupCount').textContent = String(groups.length);
    const groupRoot = $('#groups'); groupRoot.innerHTML = '';
    if (!groups.length) { groupRoot.innerHTML = '<div class="empty">Создайте первую группу.</div>'; }
    groups.forEach(group => {
      const row = document.createElement('div'); row.className = 'group-item';
      const icon = document.createElement('div'); icon.className = 'group-icon'; icon.textContent = '✳';
      const content = document.createElement('div'); const title = document.createElement('div'); title.className = 'group-name'; title.textContent = group.name;
      const count = document.createElement('div'); count.className = 'group-count'; count.textContent = `${group.member_count} учеников`;
      const open = document.createElement('button'); open.type = 'button'; open.className = 'group-open'; open.textContent = 'Открыть чат';
      open.setAttribute('aria-label', `Открыть чат группы ${group.name}`); open.addEventListener('click', () => openTeacherChat(group));
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger-btn group-delete-btn'; remove.textContent = 'Удалить';
      remove.setAttribute('aria-label', `Удалить группу ${group.name}`);
      remove.addEventListener('click', async () => {
        if (!confirm(`Удалить группу «${group.name}»? Ученики останутся в списке без группы, сообщения чата этой группы будут удалены.`)) return;
        remove.disabled = true;
        try {
          await api('group-delete', { groupId: group.id }, true);
          if (state.adminChat?.id === group.id) { stopAdminChatPolling(); state.adminChat = null; $('#adminChatView').classList.add('hidden'); $('#adminOverview').classList.remove('hidden'); }
          await loadAdmin(); setBanner($('#adminNotice'), `Группа «${group.name}» удалена.`, 'ok');
        } catch (error) { setBanner($('#adminNotice'), error.message, 'error'); remove.disabled = false; }
      });
      content.append(title, count); row.append(icon, content, open, remove); groupRoot.append(row);
    });
    const studentRoot = $('#students'); studentRoot.innerHTML = '';
    if (!students.length) studentRoot.innerHTML = '<div class="empty">Пока никто не зарегистрировался. Когда ученик введёт имя на главной странице, он появится здесь.</div>';
    students.forEach(student => {
      const row = document.createElement('div'); row.className = 'student';
      const detail = document.createElement('div');
      const name = document.createElement('div'); name.className = 'student-name'; name.textContent = student.display_name;
      const date = document.createElement('div'); date.className = 'student-time'; date.textContent = `Регистрация: ${formatDate(student.created_at)}`;
      detail.append(name, date);
      const select = document.createElement('select'); select.className = 'select'; select.setAttribute('aria-label', `Группа для ${student.display_name}`);
      const noGroup = document.createElement('option'); noGroup.value = ''; noGroup.textContent = 'Не распределён'; select.append(noGroup);
      groups.forEach(group => { const option = document.createElement('option'); option.value = group.id; option.textContent = group.name; option.selected = group.id === student.group_id; select.append(option); });
      select.addEventListener('change', async () => {
        select.disabled = true;
        try { await api('student-assign', { studentId: student.id, groupId: select.value || null }, true); await loadAdmin(); setBanner($('#adminNotice'), `Изменения сохранены для «${student.display_name}».`, 'ok'); }
        catch (error) { setBanner($('#adminNotice'), error.message, 'error'); select.disabled = false; }
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger-btn'; remove.textContent = 'Удалить';
      remove.setAttribute('aria-label', `Удалить участника ${student.display_name}`);
      remove.addEventListener('click', async () => {
        if (!confirm(`Удалить участника «${student.display_name}»? Его аккаунт и сообщения будут удалены.`)) return;
        remove.disabled = true;
        try { await api('student-delete', { studentId: student.id }, true); await loadAdmin(); setBanner($('#adminNotice'), `Участник «${student.display_name}» удалён.`, 'ok'); }
        catch (error) { setBanner($('#adminNotice'), error.message, 'error'); remove.disabled = false; }
      });
      row.append(detail, select, remove); studentRoot.append(row);
    });
  }
  async function openTeacherChat(group) {
    state.adminChat = group;
    stopAdminChatPolling();
    $('#adminOverview').classList.add('hidden');
    $('#adminChatView').classList.remove('hidden');
    $('#teacherGroupTitle').textContent = `Чат группы «${group.name}»`;
    $('#teacherGroupSelect').value = group.id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    await refreshTeacherChat();
    state.adminPoll = setInterval(refreshTeacherChat, 7000);
  }
  async function refreshTeacherChat() {
    if (!state.adminChat || $('#adminChatView').classList.contains('hidden')) return;
    try {
      const data = await api('admin-group-messages', { groupId: state.adminChat.id }, true);
      renderTeacherMessages(data.messages || []);
      setBanner($('#adminNotice'));
    } catch (error) { setBanner($('#adminNotice'), error.message, 'error'); }
  }
  function renderTeacherMessages(messages) {
    const root = $('#teacherMessages'); root.innerHTML = '';
    if (!messages.length) {
      const note = document.createElement('div'); note.className = 'chat-welcome';
      note.innerHTML = '<b>В этой группе пока нет сообщений</b>Напишите ученикам первое сообщение.'; root.append(note); return;
    }
    messages.forEach(message => {
      const item = document.createElement('div'); item.className = 'msg' + (message.sender_role === 'teacher' ? ' mine' : '');
      if (message.type === 'file') item.append(buildFileCard(message, true));
      else { const text = document.createElement('div'); text.textContent = message.body; item.append(text); }
      const meta = document.createElement('small');
      meta.textContent = `${message.sender_role === 'teacher' ? 'Вы, учитель' : message.sender_name} · ${formatDate(message.created_at)}`;
      item.append(meta); root.append(item);
    });
    root.scrollTop = root.scrollHeight;
  }
  function stopAdminChatPolling() { if (state.adminPoll) clearInterval(state.adminPoll); state.adminPoll = null; }
  $('#teacherGroupSelect').addEventListener('change', () => {
    const group = state.adminGroups.find(item => item.id === $('#teacherGroupSelect').value);
    if (group) openTeacherChat(group);
  });
  $('#teacherBack').addEventListener('click', () => {
    stopAdminChatPolling(); state.adminChat = null;
    $('#adminChatView').classList.add('hidden'); $('#adminOverview').classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $('#teacherSendForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!state.adminChat) return;
    const input = $('#teacherMessageInput'), message = input.value.trim(); if (!message) return;
    const button = $('#teacherSendForm button'); button.disabled = true;
    try {
      await api('admin-message-send', { groupId: state.adminChat.id, message }, true);
      input.value = ''; await refreshTeacherChat();
    } catch (error) { setBanner($('#adminNotice'), error.message, 'error'); }
    finally { button.disabled = false; input.focus(); }
  });

  $('#groupForm').addEventListener('submit', async event => {
    event.preventDefault(); const input = $('#groupName'), name = input.value.trim(); if (!name) return;
    try { await api('group-create', { name }, true); input.value = ''; await loadAdmin(); setBanner($('#adminNotice'), `Группа «${name}» создана.`, 'ok'); }
    catch (error) { setBanner($('#adminNotice'), error.message, 'error'); }
  });
  $('#adminRefresh').addEventListener('click', loadAdmin);
  $('#adminLogout').addEventListener('click', () => { stopAdminChatPolling(); state.adminChat = null; state.adminToken = ''; sessionStorage.removeItem('linia_admin_session'); show('welcome'); setBanner($('#notice'), 'Вы вышли из панели учителя.', 'info'); });

  async function startVideoCall(groupId, groupName, isTeacher) {
    if (state.call || state.pendingCall) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
      setBanner(isTeacher ? $('#adminNotice') : $('#studentNotice'), 'Для видеосвязи нужен сайт по HTTPS, открытый напрямую в Safari или Chrome. Встроенные окна приложений могут блокировать камеру.', 'error');
      return;
    }
    state.pendingCall = { groupId, groupName, isTeacher };
    $('#callTitle').textContent = `Видеосвязь · ${groupName}`;
    $('#callStatus').textContent = 'Перед подключением разрешите камеру и микрофон.';
    $('#grantCallAccess').disabled = false;
    $('#grantCallAccess').textContent = 'Разрешить и продолжить';
    $('#callPermission').classList.remove('hidden');
    $('#callActive').classList.add('hidden');
    setBanner($('#callError'));
    $('#callModal').classList.add('open');
  }
  function cameraPermissionHelp(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'PermissionDeniedError' || error?.name === 'SecurityError') {
      return 'Браузер или настройки устройства запретили камеру/микрофон. Разрешите оба пункта в настройках этого сайта рядом с адресом и обновите страницу. На iPhone: Настройки iOS → Safari → Камера и микрофон. Если сайт открыт внутри другого приложения, откройте его напрямую в Safari/Chrome. Убедитесь, что адрес начинается с HTTPS.';
    }
    if (error?.name === 'NotFoundError' || error?.name === 'DevicesNotFoundError') return 'Не найдена камера или микрофон. Подключите устройство или проверьте, что камера доступна системе.';
    if (error?.name === 'NotReadableError' || error?.name === 'TrackStartError') return 'Камера или микрофон заняты другим приложением. Закройте его и нажмите «Повторить запрос».';
    if (error?.name === 'OverconstrainedError') return 'Камера не поддерживает запрошенный режим. Проверьте устройство и попробуйте снова.';
    return `Не удалось включить камеру и микрофон${error?.message ? `: ${error.message}` : '.'} Проверьте разрешения сайта и попробуйте снова.`;
  }
  async function requestCallMedia() {
    const pending = state.pendingCall;
    if (!pending || state.call) return;
    const button = $('#grantCallAccess');
    button.disabled = true;
    button.textContent = 'Ожидаем разрешение браузера…';
    $('#callStatus').textContent = 'Когда браузер спросит, нажмите «Разрешить».';
    setBanner($('#callError'));
    try {
      // Вызывается непосредственно обработчиком кнопки, чтобы Safari/Chrome показали системный запрос разрешения.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' } });
      if (state.pendingCall !== pending) { stream.getTracks().forEach(track => track.stop()); return; }
      const { groupId, groupName, isTeacher } = pending;
      const peerId = crypto.randomUUID();
      state.pendingCall = null;
      state.call = { groupId, groupName, isTeacher, peerId, stream, screenStream: null, screenTrack: null, pcs: new Map(), peerMeta: new Map(), remoteTiles: new Map(), remoteScreens: new Set(), candidateQueues: new Map(), seen: new Set(), offered: new Set(), poll: null };
      $('#toggleMic').textContent = 'Выключить микрофон';
      $('#toggleCamera').textContent = 'Выключить камеру';
      $('#toggleCamera').disabled = false;
      $('#screenShareButton').textContent = 'Показать экран';
      $('#screenShareButton').setAttribute('aria-pressed', 'false');
      $('#screenShareButton').disabled = false;
      $('#videoGrid .local-tile').classList.remove('screen-share');
      $('#videoGrid .local-tile span').textContent = 'Вы';
      updateVideoLayout();
      $('#callPermission').classList.add('hidden');
      $('#callActive').classList.remove('hidden');
      $('#callStatus').textContent = 'Подключаемся к группе…';
      const local = $('#localVideo'); local.srcObject = stream; local.play().catch(() => {});
      const result = await api('call-join', { groupId, peerId, sessionToken: state.studentToken }, isTeacher);
      if (!state.call) return;
      state.call.groupId = result.groupId;
      await syncCallPeers(result.participants || []);
      await pollCall();
      if (state.call) state.call.poll = setInterval(pollCall, 1700);
    } catch (error) {
      if (!state.call && state.pendingCall !== pending) return;
      if (state.call) {
        await endVideoCall(false);
        setBanner(pending.isTeacher ? $('#adminNotice') : $('#studentNotice'), `Не удалось подключиться к звонку: ${error.message}`, 'error');
        return;
      }
      setBanner($('#callError'), cameraPermissionHelp(error), 'error');
      $('#callStatus').textContent = 'Разрешение пока не получено. Измените настройки доступа и повторите.';
    } finally {
      if (!state.call) {
        button.disabled = false;
        button.textContent = 'Повторить запрос';
      }
    }
  }
  function createPeerConnection(peer) {
    const call = state.call;
    if (!call) return null;
    if (call.pcs.has(peer.peerId)) { call.peerMeta.set(peer.peerId, peer); return call.pcs.get(peer.peerId); }
    const pc = new RTCPeerConnection({ iceServers: [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' }
    ] });
    call.pcs.set(peer.peerId, pc); call.peerMeta.set(peer.peerId, peer); call.candidateQueues.set(peer.peerId, []);
    call.stream.getAudioTracks().forEach(track => pc.addTrack(track, call.stream));
    const videoTrack = call.screenTrack || call.stream.getVideoTracks()[0];
    if (videoTrack) pc.addTrack(videoTrack, call.stream);
    pc.onicecandidate = event => { if (event.candidate) sendCallSignal(peer.peerId, { type: 'candidate', candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      let stream = event.streams?.[0];
      if (!stream) { stream = call.remoteTiles.get(peer.peerId)?.stream || new MediaStream(); stream.addTrack(event.track); }
      addRemoteVideo(peer, stream);
    };
    pc.onconnectionstatechange = () => updateCallStatus();
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'failed') setBanner($('#callError'), 'Не удалось установить P2P-соединение. Возможно, сеть блокирует видеосвязь без TURN-сервера.', 'error');
      updateCallStatus();
    };
    return pc;
  }
  async function maybeOffer(peer) {
    const call = state.call;
    if (!call || call.peerId.localeCompare(peer.peerId) >= 0 || call.offered.has(peer.peerId)) return;
    const pc = createPeerConnection(peer); call.offered.add(peer.peerId);
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      await sendCallSignal(peer.peerId, { type: 'offer', description: pc.localDescription.toJSON() });
    } catch (error) { setBanner($('#callError'), `Не удалось начать видеосвязь с ${peer.name}: ${error.message}`, 'error'); }
  }
  async function syncCallPeers(participants) {
    const call = state.call; if (!call) return;
    const active = new Set();
    for (const peer of participants) {
      if (!peer.peerId || peer.peerId === call.peerId) continue;
      active.add(peer.peerId); call.peerMeta.set(peer.peerId, peer);
      createPeerConnection(peer);
      await maybeOffer(peer);
      if (call.screenTrack) sendCallSignal(peer.peerId, { type: 'share-start' });
    }
    for (const peerId of [...call.pcs.keys()]) if (!active.has(peerId)) removeCallPeer(peerId);
    updateCallStatus(active.size);
  }
  function addRemoteVideo(peer, stream) {
    const call = state.call; if (!call) return;
    let tile = call.remoteTiles.get(peer.peerId);
    if (!tile) {
      tile = document.createElement('div'); tile.className = 'video-tile';
      const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.srcObject = stream;
      const label = document.createElement('span'); label.textContent = call.remoteScreens.has(peer.peerId) ? `Экран · ${peer.name || 'Участник'}` : (peer.name || 'Участник');
      if (call.remoteScreens.has(peer.peerId)) tile.classList.add('screen-share');
      tile.append(video, label); $('#videoGrid').append(tile); call.remoteTiles.set(peer.peerId, { tile, video, label, stream });
    } else { tile.video.srcObject = stream; tile.stream = stream; }
    tile.video.play().catch(() => {});
    updateVideoLayout();
  }
  function setRemoteScreenShare(peerId, active) {
    const call = state.call; if (!call) return;
    if (active) call.remoteScreens.add(peerId); else call.remoteScreens.delete(peerId);
    const remote = call.remoteTiles.get(peerId);
    if (remote) {
      remote.tile.classList.toggle('screen-share', active);
      remote.label.textContent = active ? `Экран · ${call.peerMeta.get(peerId)?.name || 'Участник'}` : (call.peerMeta.get(peerId)?.name || 'Участник');
    }
  }
  function updateVideoLayout() {
    const grid = $('#videoGrid');
    grid.classList.toggle('two-participants', grid.querySelectorAll('.video-tile').length === 2);
  }
  function removeCallPeer(peerId) {
    const call = state.call; if (!call) return;
    const pc = call.pcs.get(peerId); if (pc) pc.close();
    call.pcs.delete(peerId); call.peerMeta.delete(peerId); call.candidateQueues.delete(peerId); call.offered.delete(peerId);
    const remote = call.remoteTiles.get(peerId); if (remote) remote.tile.remove(); call.remoteTiles.delete(peerId); call.remoteScreens.delete(peerId);
    updateVideoLayout(); updateCallStatus();
  }
  async function sendCallSignal(toPeerId, payload) {
    const call = state.call; if (!call) return;
    try { await api('call-signal', { groupId: call.groupId, peerId: call.peerId, toPeerId, payload, sessionToken: state.studentToken }, call.isTeacher); }
    catch (error) { if (state.call) setBanner($('#callError'), error.message, 'error'); }
  }
  async function handleCallSignal(signal) {
    const call = state.call; if (!call || call.seen.has(signal.id)) return;
    call.seen.add(signal.id);
    const peer = { peerId: signal.fromPeerId, name: signal.name, role: signal.role };
    const pc = createPeerConnection(peer); const payload = signal.payload || {};
    try {
      if (payload.type === 'offer') {
        await pc.setRemoteDescription(payload.description);
        const queued = call.candidateQueues.get(peer.peerId) || [];
        for (const candidate of queued) await pc.addIceCandidate(candidate);
        call.candidateQueues.set(peer.peerId, []);
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        await sendCallSignal(peer.peerId, { type: 'answer', description: pc.localDescription.toJSON() });
      } else if (payload.type === 'answer') {
        if (pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription(payload.description);
          const queued = call.candidateQueues.get(peer.peerId) || [];
          for (const candidate of queued) await pc.addIceCandidate(candidate);
          call.candidateQueues.set(peer.peerId, []);
        }
      } else if (payload.type === 'share-start') {
        setRemoteScreenShare(peer.peerId, true);
      } else if (payload.type === 'share-stop') {
        setRemoteScreenShare(peer.peerId, false);
      } else if (payload.type === 'candidate' && payload.candidate) {
        const candidate = new RTCIceCandidate(payload.candidate);
        if (pc.remoteDescription) await pc.addIceCandidate(candidate);
        else call.candidateQueues.get(peer.peerId).push(candidate);
      }
    } catch (error) { setBanner($('#callError'), `Ошибка соединения с ${peer.name}: ${error.message}`, 'error'); }
  }
  async function pollCall() {
    const call = state.call; if (!call) return;
    try {
      const result = await api('call-poll', { groupId: call.groupId, peerId: call.peerId, sessionToken: state.studentToken }, call.isTeacher);
      await syncCallPeers(result.participants || []);
      for (const signal of result.signals || []) await handleCallSignal(signal);
      if (!result.participants?.length) $('#callStatus').textContent = 'Вы в звонке. Ожидаем подключение группы…';
    } catch (error) { if (state.call) setBanner($('#callError'), error.message, 'error'); }
  }
  function updateCallStatus(participantCount = state.call?.pcs.size || 0) {
    if (!state.call) return;
    $('#callStatus').textContent = participantCount ? `Вы и ещё ${participantCount} ${participantCount === 1 ? 'участник' : 'участника'} в звонке` : 'Вы в звонке. Ожидаем подключение группы…';
  }
  async function startScreenShare() {
    const call = state.call;
    if (!call) return;
    if (call.screenTrack) { await stopScreenShare(); return; }
    const button = $('#screenShareButton');
    if (!navigator.mediaDevices?.getDisplayMedia) {
      setBanner($('#callError'), 'Этот браузер не поддерживает показ экрана из веб-страницы. Обновите Safari/Chrome или откройте звонок в браузере, который поддерживает демонстрацию экрана; на телефонах поддержка зависит от версии ОС и браузера.', 'error');
      return;
    }
    button.disabled = true;
    let acquiredStream = null;
    try {
      // Запрашиваем захват непосредственно по нажатию, чтобы браузер открыл системный выбор экрана/окна.
      acquiredStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenStream = acquiredStream;
      if (state.call !== call) { screenStream.getTracks().forEach(track => track.stop()); return; }
      const screenTrack = screenStream.getVideoTracks()[0];
      if (!screenTrack) throw new Error('Браузер не вернул видеодорожку экрана.');
      const cameraTrack = call.stream.getVideoTracks()[0];
      const changedSenders = [];
      try {
        for (const pc of call.pcs.values()) {
          const sender = pc.getSenders().find(item => item.track?.kind === 'video');
          if (sender) { await sender.replaceTrack(screenTrack); changedSenders.push(sender); }
        }
      } catch (error) {
        await Promise.all(changedSenders.map(sender => sender.replaceTrack(cameraTrack).catch(() => {})));
        throw error;
      }
      call.screenStream = screenStream; call.screenTrack = screenTrack;
      $('#localVideo').srcObject = screenStream; $('#localVideo').play().catch(() => {});
      $('#videoGrid .local-tile').classList.add('screen-share');
      $('#videoGrid .local-tile span').textContent = 'Ваш экран';
      $('#toggleCamera').disabled = true;
      button.textContent = 'Остановить показ'; button.setAttribute('aria-pressed', 'true');
      setBanner($('#callError'));
      for (const peerId of call.pcs.keys()) sendCallSignal(peerId, { type: 'share-start' });
      screenTrack.addEventListener('ended', () => { if (state.call === call) stopScreenShare(); }, { once: true });
    } catch (error) {
      acquiredStream?.getTracks().forEach(track => track.stop());
      const mobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      const detail = error?.name === 'NotAllowedError'
        ? (mobile ? 'Этот мобильный браузер или ОС не разрешили захват экрана. На iPhone веб-сайты обычно не могут начать системную трансляцию экрана; на Android поддержка зависит от браузера и версии.' : 'Вы отменили выбор экрана или браузер не разрешил захват.')
        : (error.message || 'Не удалось начать демонстрацию.');
      setBanner($('#callError'), `${detail} Если системный выбор экрана не появился, это ограничение браузера/ОС, а не разрешение камеры.`, 'error');
    } finally { if (state.call === call) button.disabled = false; }
  }
  async function stopScreenShare() {
    const call = state.call;
    if (!call?.screenTrack) return;
    const screenStream = call.screenStream;
    call.screenTrack = null; call.screenStream = null;
    const cameraTrack = call.stream.getVideoTracks()[0];
    await Promise.all([...call.pcs.values()].map(pc => {
      const sender = pc.getSenders().find(item => item.track?.kind === 'video');
      return sender ? sender.replaceTrack(cameraTrack).catch(() => {}) : Promise.resolve();
    }));
    screenStream?.getTracks().forEach(track => track.stop());
    $('#localVideo').srcObject = call.stream; $('#localVideo').play().catch(() => {});
    $('#videoGrid .local-tile')?.classList.remove('screen-share');
    const localLabel = $('#videoGrid .local-tile span'); if (localLabel) localLabel.textContent = 'Вы';
    $('#toggleCamera').disabled = false;
    $('#toggleCamera').textContent = cameraTrack.enabled ? 'Выключить камеру' : 'Включить камеру';
    const button = $('#screenShareButton'); button.textContent = 'Показать экран'; button.setAttribute('aria-pressed', 'false');
    for (const peerId of call.pcs.keys()) sendCallSignal(peerId, { type: 'share-stop' });
  }
  async function endVideoCall(notify = true) {
    state.pendingCall = null;
    const call = state.call; if (!call) { $('#callModal').classList.remove('open'); return; }
    state.call = null; if (call.poll) clearInterval(call.poll);
    if (document.fullscreenElement === $('.call-modal')) document.exitFullscreen?.().catch(() => {});
    for (const pc of call.pcs.values()) pc.close();
    call.screenStream?.getTracks().forEach(track => track.stop());
    call.stream.getTracks().forEach(track => track.stop());
    $('#localVideo').srcObject = null;
    for (const remote of call.remoteTiles.values()) remote.tile.remove();
    updateVideoLayout();
    $('#callModal').classList.remove('open'); setBanner($('#callError'));
    if (notify) api('call-leave', { groupId: call.groupId, peerId: call.peerId, sessionToken: state.studentToken }, call.isTeacher).catch(() => {});
  }
  $('#grantCallAccess').addEventListener('click', requestCallMedia);
  $('#studentCallButton').addEventListener('click', () => state.student?.groupName && startVideoCall(state.student.groupId, state.student.groupName, false));
  $('#teacherCallButton').addEventListener('click', () => state.adminChat && startVideoCall(state.adminChat.id, state.adminChat.name, true));
  $('#closeCall').addEventListener('click', () => endVideoCall());
  $('#endCall').addEventListener('click', () => endVideoCall());
  $('#callModal').addEventListener('click', event => { if (event.target === $('#callModal')) endVideoCall(); });
  $('#toggleMic').addEventListener('click', event => {
    const track = state.call?.stream.getAudioTracks()[0]; if (!track) return;
    track.enabled = !track.enabled; event.currentTarget.textContent = track.enabled ? 'Выключить микрофон' : 'Включить микрофон';
  });
  $('#toggleCamera').addEventListener('click', event => {
    const track = state.call?.stream.getVideoTracks()[0]; if (!track) return;
    track.enabled = !track.enabled; event.currentTarget.textContent = track.enabled ? 'Выключить камеру' : 'Включить камеру';
  });
  $('#screenShareButton').addEventListener('click', startScreenShare);
  window.addEventListener('pagehide', () => { if (state.call) endVideoCall(); });

  async function install() {
    if (state.installEvent) {
      state.installEvent.prompt(); await state.installEvent.userChoice; state.installEvent = null; $('#installBtn').classList.add('hidden'); return;
    }
    $('#installHelp').classList.toggle('show');
  }
  $('#installBtn').addEventListener('click', install);
  $('#studentInstall').addEventListener('click', install);
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installEvent = event; $('#installBtn').classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { $('#installBtn').classList.add('hidden'); setBanner($('#studentNotice'), 'Приложение установлено.', 'ok'); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('/sw.js').catch(() => {});

  async function boot() {
    const adminToken = sessionStorage.getItem('linia_admin_session');
    if (adminToken) { state.adminToken = adminToken; await loadAdmin(); return; }
    const token = localStorage.getItem('linia_student_session');
    if (token) {
      state.studentToken = token;
      try { const result = await api('student-home', { sessionToken: token }); showStudent(result); startPolling(); return; }
      catch (error) {
        if (!/Сессия не найдена/i.test(error.message)) setBanner($('#notice'), `Страница загружена, но сервер пока не отвечает: ${error.message}`, 'error');
        else { localStorage.removeItem('linia_student_session'); localStorage.removeItem('linia_student_name'); }
      }
    }
    show('welcome');
  }
  show('welcome');
  boot();
})();