import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { getDatabase } from '@netlify/database';
import { getStore } from '@netlify/blobs';

const db = getDatabase();
// Credentials are checked only by this server-side function, never by browser JavaScript.
const ADMIN_USERNAME = 'Юлия Александровна';
const ADMIN_PASSWORD = 'Fifnid2012';
let schemaReady;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const fail = (message, status = 400) => json({ error: message }, status);
const hash = value => createHash('sha256').update(value).digest('hex');

async function ensureSchema() {
  if (!schemaReady) schemaReady = (async () => {
    await db.sql`CREATE TABLE IF NOT EXISTS public.class_groups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`CREATE TABLE IF NOT EXISTS public.students (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      display_name text NOT NULL,
      display_name_norm text,
      password_salt text,
      password_hash text,
      session_hash text UNIQUE,
      group_id uuid NULL REFERENCES public.class_groups(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`ALTER TABLE public.students ADD COLUMN IF NOT EXISTS display_name_norm text`;
    await db.sql`ALTER TABLE public.students ADD COLUMN IF NOT EXISTS password_salt text`;
    await db.sql`ALTER TABLE public.students ADD COLUMN IF NOT EXISTS password_hash text`;
    await db.sql`ALTER TABLE public.students ALTER COLUMN session_hash DROP NOT NULL`;
    await db.sql`UPDATE public.students SET display_name_norm = lower(trim(regexp_replace(display_name, '[[:space:]]+', ' ', 'g')))
      WHERE display_name_norm IS NULL`;
    await db.sql`WITH duplicates AS (
        SELECT id, display_name_norm, row_number() OVER (PARTITION BY display_name_norm ORDER BY created_at, id) AS n
        FROM public.students
      )
      UPDATE public.students s
      SET display_name = s.display_name || ' (' || duplicates.n || ')',
          display_name_norm = duplicates.display_name_norm || ' (' || duplicates.n || ')'
      FROM duplicates WHERE s.id = duplicates.id AND duplicates.n > 1`;
    await db.sql`ALTER TABLE public.students ALTER COLUMN display_name_norm SET NOT NULL`;
    await db.sql`CREATE UNIQUE INDEX IF NOT EXISTS students_display_name_norm_idx ON public.students(display_name_norm)`;

    await db.sql`CREATE TABLE IF NOT EXISTS public.student_sessions (
      token_hash text PRIMARY KEY,
      student_id uuid NOT NULL REFERENCES public.students(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`CREATE INDEX IF NOT EXISTS student_sessions_student_idx ON public.student_sessions(student_id)`;
    // Carry forward browser sessions created by the previous release, storing only their hashes.
    const legacySessions = await db.sql`SELECT id, session_hash FROM public.students WHERE session_hash IS NOT NULL`;
    for (const old of legacySessions) {
      await db.sql`INSERT INTO public.student_sessions(token_hash, student_id, expires_at)
        VALUES (${hash(old.session_hash)}, ${old.id}, now() + interval '365 days')
        ON CONFLICT (token_hash) DO NOTHING`;
    }
    await db.sql`UPDATE public.students SET session_hash = NULL WHERE session_hash IS NOT NULL`;

    await db.sql`CREATE TABLE IF NOT EXISTS public.class_messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.class_groups(id) ON DELETE CASCADE,
      student_id uuid NULL REFERENCES public.students(id) ON DELETE CASCADE,
      sender_name text NOT NULL DEFAULT 'Участник',
      sender_role text NOT NULL DEFAULT 'student',
      body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`ALTER TABLE public.class_messages ALTER COLUMN student_id DROP NOT NULL`;
    await db.sql`ALTER TABLE public.class_messages ADD COLUMN IF NOT EXISTS sender_name text NOT NULL DEFAULT 'Участник'`;
    await db.sql`ALTER TABLE public.class_messages ADD COLUMN IF NOT EXISTS sender_role text NOT NULL DEFAULT 'student'`;
    await db.sql`UPDATE public.class_messages m SET sender_name = s.display_name
      FROM public.students s WHERE m.student_id = s.id AND m.sender_name = 'Участник'`;
    await db.sql`CREATE TABLE IF NOT EXISTS public.class_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.class_groups(id) ON DELETE CASCADE,
      student_id uuid NULL REFERENCES public.students(id) ON DELETE SET NULL,
      sender_name text NOT NULL,
      sender_role text NOT NULL,
      file_name text NOT NULL,
      file_type text NOT NULL,
      file_size integer NOT NULL CHECK (file_size BETWEEN 0 AND 4194304),
      blob_key text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`CREATE INDEX IF NOT EXISTS class_files_group_created_idx ON public.class_files(group_id, created_at DESC)`;
    await db.sql`CREATE TABLE IF NOT EXISTS public.call_participants (
      group_id uuid NOT NULL REFERENCES public.class_groups(id) ON DELETE CASCADE,
      peer_id text NOT NULL,
      owner_key text NOT NULL,
      display_name text NOT NULL,
      role text NOT NULL,
      last_seen timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (group_id, peer_id)
    )`;
    await db.sql`ALTER TABLE public.call_participants ADD COLUMN IF NOT EXISTS owner_key text`;
    await db.sql`CREATE TABLE IF NOT EXISTS public.call_signals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id uuid NOT NULL REFERENCES public.class_groups(id) ON DELETE CASCADE,
      from_peer_id text NOT NULL,
      to_peer_id text NOT NULL,
      sender_name text NOT NULL,
      sender_role text NOT NULL,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`CREATE INDEX IF NOT EXISTS call_signals_target_idx ON public.call_signals(group_id, to_peer_id, created_at DESC)`;
    await db.sql`CREATE TABLE IF NOT EXISTS public.admin_sessions (
      token_hash text PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`;
    await db.sql`CREATE INDEX IF NOT EXISTS class_messages_group_created_idx ON public.class_messages(group_id, created_at DESC)`;
    await db.sql`CREATE INDEX IF NOT EXISTS students_created_idx ON public.students(created_at DESC)`;
  })().catch(error => { schemaReady = null; throw error; });
  return schemaReady;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length > 0 && left.length === right.length && timingSafeEqual(left, right);
}
function normalizeUsername(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').replace(/A/g, 'А').toLocaleLowerCase('ru-RU');
}
function displayName(value) { return String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' '); }
function normalizedName(value) { return displayName(value).toLocaleLowerCase('ru-RU'); }
function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const passwordHash = scryptSync(password, salt, 64).toString('hex');
  return { salt, passwordHash };
}
function passwordMatches(password, salt, expectedHash) {
  if (!password || !salt || !expectedHash) return false;
  return safeEqual(scryptSync(String(password), salt, 64).toString('hex'), expectedHash);
}
function sessionToken(body) {
  const token = String(body.sessionToken || '');
  return /^[A-Za-z0-9_-]{36,100}$/.test(token) ? token : null;
}
async function addStudentSession(token, studentId) {
  await db.sql`INSERT INTO public.student_sessions(token_hash, student_id, expires_at)
    VALUES (${hash(token)}, ${studentId}, now() + interval '365 days')
    ON CONFLICT (token_hash) DO UPDATE SET student_id = EXCLUDED.student_id, expires_at = EXCLUDED.expires_at`;
}
async function currentStudent(token) {
  if (!token) return null;
  const rows = await db.sql`SELECT s.id, s.display_name, s.group_id, s.password_hash, g.name AS group_name
    FROM public.student_sessions ss
    JOIN public.students s ON s.id = ss.student_id
    LEFT JOIN public.class_groups g ON g.id = s.group_id
    WHERE ss.token_hash = ${hash(token)} AND ss.expires_at > now() LIMIT 1`;
  return rows[0] || null;
}
async function verifyAdmin(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[A-Za-z0-9_-]{36,100}$/.test(token)) return false;
  const rows = await db.sql`SELECT token_hash FROM public.admin_sessions
    WHERE token_hash = ${hash(token)} AND expires_at > now() LIMIT 1`;
  return rows.length > 0;
}
function validUuid(value) { return /^[0-9a-f-]{36}$/i.test(String(value || '')); }

async function callIdentity(req, body) {
  const adminToken = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (await verifyAdmin(req)) {
    if (!validUuid(body.groupId)) return null;
    const groups = await db.sql`SELECT id FROM public.class_groups WHERE id = ${body.groupId}::uuid LIMIT 1`;
    return groups.length ? { groupId: body.groupId, name: ADMIN_USERNAME, role: 'teacher', studentId: null, ownerKey: hash(adminToken) } : null;
  }
  const token = sessionToken(body);
  const student = await currentStudent(token);
  if (!student?.group_id) return null;
  return { groupId: student.group_id, name: student.display_name, role: 'student', studentId: student.id, ownerKey: hash(token) };
}
async function groupTimeline(groupId, studentId = null) {
  const [texts, files] = await Promise.all([
    db.sql`SELECT id, body, created_at, sender_name, sender_role, student_id
      FROM public.class_messages WHERE group_id = ${groupId} ORDER BY created_at DESC LIMIT 100`,
    db.sql`SELECT id, file_name, file_type, file_size, created_at, sender_name, sender_role, student_id
      FROM public.class_files WHERE group_id = ${groupId} ORDER BY created_at DESC LIMIT 100`
  ]);
  return [
    ...texts.map(m => ({ type: 'text', body: m.body, created_at: m.created_at, sender_name: m.sender_name, sender_role: m.sender_role, isMine: studentId ? m.student_id === studentId : false })),
    ...files.map(f => ({ type: 'file', id: f.id, file_name: f.file_name, file_type: f.file_type, file_size: f.file_size, created_at: f.created_at, sender_name: f.sender_name, sender_role: f.sender_role, isMine: studentId ? f.student_id === studentId : false }))
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export default async function handler(req) {
  if (req.method !== 'POST') return fail('Используйте POST.', 405);
  try {
    await ensureSchema();
    let body;
    let uploadedFile = null;
    if ((req.headers.get('content-type') || '').includes('multipart/form-data')) {
      const form = await req.formData();
      body = { action: form.get('action'), sessionToken: form.get('sessionToken'), groupId: form.get('groupId') };
      uploadedFile = form.get('file');
    } else {
      body = await req.json().catch(() => ({}));
    }
    const action = String(body.action || '');

    if (action === 'student-login') {
      const name = displayName(body.name);
      const nameNorm = normalizedName(name);
      const token = sessionToken(body);
      const password = String(body.password || '');
      if (!token) return fail('Не удалось открыть сессию. Обновите страницу и попробуйте ещё раз.');
      if (name.length < 2 || name.length > 60) return fail('Введите имя длиной от 2 до 60 символов.');
      if (password && (password.length < 8 || password.length > 128)) return fail('Пароль должен содержать от 8 до 128 символов.');

      let rows = await db.sql`SELECT id, display_name, password_salt, password_hash
        FROM public.students WHERE display_name_norm = ${nameNorm} LIMIT 1`;
      let student = rows[0];
      let created = false;
      if (student) {
        if (student.password_hash) {
          if (!password) return fail('Для этого имени уже установлен пароль. Введите его.', 401);
          if (!passwordMatches(password, student.password_salt, student.password_hash)) return fail('Неверное имя или пароль.', 401);
        } else if (password) {
          const record = passwordRecord(password);
          await db.sql`UPDATE public.students SET password_salt = ${record.salt}, password_hash = ${record.passwordHash} WHERE id = ${student.id}`;
        }
      } else {
        const record = password ? passwordRecord(password) : { salt: null, passwordHash: null };
        try {
          rows = await db.sql`INSERT INTO public.students(display_name, display_name_norm, password_salt, password_hash)
            VALUES (${name}, ${nameNorm}, ${record.salt}, ${record.passwordHash})
            RETURNING id, display_name, password_salt, password_hash`;
          student = rows[0]; created = true;
        } catch (error) {
          if (error?.code === '23505') return fail('Такое имя уже заняли. Введите это имя и пароль, если он установлен.', 409);
          throw error;
        }
      }
      await addStudentSession(token, student.id);
      const profile = await currentStudent(token);
      return json({ created, student: { name: profile.display_name, groupId: profile.group_id, groupName: profile.group_name, hasPassword: Boolean(profile.password_hash) } });
    }

    if (action === 'account-set-password') {
      const token = sessionToken(body);
      const student = await currentStudent(token);
      if (!student) return fail('Сессия истекла. Войдите по имени ещё раз.', 401);
      const nextPassword = String(body.newPassword || '');
      if (nextPassword.length < 8 || nextPassword.length > 128) return fail('Новый пароль должен содержать от 8 до 128 символов.');
      if (student.password_hash && !passwordMatches(String(body.currentPassword || ''), student.password_salt, student.password_hash)) {
        return fail('Введите текущий пароль, чтобы изменить его.', 401);
      }
      const record = passwordRecord(nextPassword);
      await db.sql`UPDATE public.students SET password_salt = ${record.salt}, password_hash = ${record.passwordHash} WHERE id = ${student.id}`;
      return json({ ok: true });
    }

    if (action === 'admin-login') {
      const submittedUser = normalizeUsername(body.username);
      const expectedUser = normalizeUsername(ADMIN_USERNAME);
      if (!safeEqual(submittedUser, expectedUser) || !safeEqual(body.password, ADMIN_PASSWORD)) return fail('Неверное имя пользователя или пароль.', 401);
      const token = randomBytes(32).toString('base64url');
      await db.sql`INSERT INTO public.admin_sessions(token_hash, expires_at)
        VALUES (${hash(token)}, now() + interval '8 hours')`;
      return json({ token });
    }

    if (action === 'admin-overview') {
      if (!await verifyAdmin(req)) return fail('Сеанс учителя истёк. Войдите снова.', 401);
      const groups = await db.sql`SELECT g.id, g.name, g.created_at, count(s.id)::int AS member_count
        FROM public.class_groups g LEFT JOIN public.students s ON s.group_id = g.id
        GROUP BY g.id ORDER BY g.created_at DESC`;
      const students = await db.sql`SELECT s.id, s.display_name, s.created_at, s.group_id, g.name AS group_name
        FROM public.students s LEFT JOIN public.class_groups g ON g.id = s.group_id
        ORDER BY s.created_at DESC LIMIT 1000`;
      return json({ groups, students });
    }

    if (action === 'group-create') {
      if (!await verifyAdmin(req)) return fail('Требуется вход учителя.', 401);
      const name = displayName(body.name);
      if (name.length < 2 || name.length > 50) return fail('Название группы должно быть от 2 до 50 символов.');
      try {
        const rows = await db.sql`INSERT INTO public.class_groups(name) VALUES (${name}) RETURNING id, name, created_at`;
        return json({ group: rows[0] }, 201);
      } catch (error) {
        if (error?.code === '23505') return fail('Группа с таким названием уже есть.');
        throw error;
      }
    }

    if (action === 'group-delete') {
      if (!await verifyAdmin(req)) return fail('Требуется вход учителя.', 401);
      if (!validUuid(body.groupId)) return fail('Не удалось найти группу. Обновите список.');
      const files = await db.sql`SELECT blob_key FROM public.class_files WHERE group_id = ${body.groupId}::uuid`;
      const blobStore = getStore('linia-class-files');
      for (const file of files) await blobStore.delete(file.blob_key);
      const rows = await db.sql`DELETE FROM public.class_groups WHERE id = ${body.groupId}::uuid RETURNING id`;
      if (!rows.length) return fail('Группа не найдена.', 404);
      return json({ ok: true });
    }

    if (action === 'student-delete') {
      if (!await verifyAdmin(req)) return fail('Требуется вход учителя.', 401);
      if (!validUuid(body.studentId)) return fail('Не удалось найти ученика. Обновите список.');
      const rows = await db.sql`DELETE FROM public.students WHERE id = ${body.studentId}::uuid RETURNING id`;
      if (!rows.length) return fail('Участник не найден.', 404);
      return json({ ok: true });
    }

    if (action === 'file-upload') {
      if (!uploadedFile || typeof uploadedFile.arrayBuffer !== 'function') return fail('Не получилось прочитать файл. Выберите его ещё раз.');
      if (uploadedFile.size > 4 * 1024 * 1024) return fail('Максимальный размер файла — 4 МБ.');
      let identity;
      if (await verifyAdmin(req)) {
        if (!validUuid(body.groupId)) return fail('Выберите группу для отправки файла.');
        const groups = await db.sql`SELECT id FROM public.class_groups WHERE id = ${body.groupId}::uuid LIMIT 1`;
        if (!groups.length) return fail('Группа не найдена.', 404);
        identity = { groupId: body.groupId, studentId: null, name: ADMIN_USERNAME, role: 'teacher' };
      } else {
        const student = await currentStudent(sessionToken(body));
        if (!student) return fail('Сессия истекла. Войдите снова.', 401);
        if (!student.group_id) return fail('Сначала дождитесь назначения группы.');
        identity = { groupId: student.group_id, studentId: student.id, name: student.display_name, role: 'student' };
      }
      const fileName = String(uploadedFile.name || 'file').replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 180);
      const ext = fileName.toLowerCase();
      const mimeType = uploadedFile.type || (ext.endsWith('.html') || ext.endsWith('.htm') ? 'text/html' : 'application/octet-stream');
      const fileId = randomUUID();
      const blobStore = getStore('linia-class-files');
      await blobStore.set(fileId, uploadedFile, { metadata: { name: fileName, type: mimeType } });
      try {
        await db.sql`INSERT INTO public.class_files(id, group_id, student_id, sender_name, sender_role, file_name, file_type, file_size, blob_key)
          VALUES (${fileId}::uuid, ${identity.groupId}::uuid, ${identity.studentId}::uuid, ${identity.name}, ${identity.role}, ${fileName}, ${mimeType}, ${uploadedFile.size}, ${fileId})`;
      } catch (error) {
        await blobStore.delete(fileId).catch(() => {});
        throw error;
      }
      return json({ ok: true, file: { id: fileId, file_name: fileName, file_type: mimeType, file_size: uploadedFile.size } }, 201);
    }

    if (action === 'file-download') {
      if (!validUuid(body.fileId)) return fail('Файл не найден.', 404);
      let rows;
      if (await verifyAdmin(req)) {
        rows = await db.sql`SELECT id, group_id, file_name, file_type, blob_key FROM public.class_files WHERE id = ${body.fileId}::uuid LIMIT 1`;
      } else {
        const student = await currentStudent(sessionToken(body));
        if (!student?.group_id) return fail('Требуется вход в группу.', 401);
        rows = await db.sql`SELECT id, group_id, file_name, file_type, blob_key FROM public.class_files
          WHERE id = ${body.fileId}::uuid AND group_id = ${student.group_id} LIMIT 1`;
      }
      if (!rows.length) return fail('Файл не найден или у вас нет доступа.', 404);
      const file = rows[0];
      const contents = await getStore('linia-class-files').get(file.blob_key, { type: 'arrayBuffer' });
      if (contents === null) return fail('Файл больше недоступен.', 404);
      const safeName = encodeURIComponent(file.file_name).replace(/'/g, '%27');
      return new Response(contents, { headers: {
        'content-type': file.file_type || 'application/octet-stream',
        'content-disposition': `attachment; filename*=UTF-8''${safeName}`,
        'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'
      } });
    }

    if (action === 'admin-group-messages') {
      if (!await verifyAdmin(req)) return fail('Требуется вход учителя.', 401);
      if (!validUuid(body.groupId)) return fail('Выберите группу ещё раз.');
      const groups = await db.sql`SELECT id, name FROM public.class_groups WHERE id = ${body.groupId}::uuid LIMIT 1`;
      if (!groups.length) return fail('Группа не найдена.', 404);
      const messages = await groupTimeline(body.groupId);
      return json({ group: groups[0], messages });
    }

    if (action === 'admin-message-send') {
      if (!await verifyAdmin(req)) return fail('Требуется вход учителя.', 401);
      if (!validUuid(body.groupId)) return fail('Выберите группу ещё раз.');
      const message = String(body.message || '').trim();
      if (!message || message.length > 2000) return fail('Сообщение должно содержать от 1 до 2000 символов.');
      const groups = await db.sql`SELECT id FROM public.class_groups WHERE id = ${body.groupId}::uuid LIMIT 1`;
      if (!groups.length) return fail('Группа не найдена.', 404);
      await db.sql`INSERT INTO public.class_messages(group_id, student_id, sender_name, sender_role, body)
        VALUES (${body.groupId}::uuid, NULL, ${ADMIN_USERNAME}, 'teacher', ${message})`;
      return json({ ok: true }, 201);
    }

    if (action === 'student-assign') {
      if (!await verifyAdmin(req)) return fail('Требуется вход учителя.', 401);
      if (!validUuid(body.studentId)) return fail('Не удалось найти ученика. Обновите список.');
      const groupId = body.groupId ? String(body.groupId) : null;
      if (groupId && !validUuid(groupId)) return fail('Выберите существующую группу.');
      const rows = await db.sql`UPDATE public.students SET group_id = ${groupId}::uuid
        WHERE id = ${body.studentId}::uuid RETURNING id`;
      if (!rows.length) return fail('Ученик не найден.', 404);
      return json({ ok: true });
    }

    if (action === 'student-home') {
      const student = await currentStudent(sessionToken(body));
      if (!student) return fail('Сессия не найдена. Введите имя ещё раз.', 401);
      if (!student.group_id) return json({ student: { name: student.display_name, groupId: null, groupName: null, hasPassword: Boolean(student.password_hash) }, messages: [] });
      const messages = await groupTimeline(student.group_id, student.id);
      return json({ student: { name: student.display_name, groupId: student.group_id, groupName: student.group_name, hasPassword: Boolean(student.password_hash) }, messages });
    }

    if (action === 'message-send') {
      const student = await currentStudent(sessionToken(body));
      if (!student) return fail('Сессия не найдена. Введите имя ещё раз.', 401);
      if (!student.group_id) return fail('Сначала дождитесь, пока учитель назначит вам группу.');
      const message = String(body.message || '').trim();
      if (!message || message.length > 2000) return fail('Сообщение должно содержать от 1 до 2000 символов.');
      await db.sql`INSERT INTO public.class_messages(group_id, student_id, sender_name, sender_role, body)
        VALUES (${student.group_id}, ${student.id}, ${student.display_name}, 'student', ${message})`;
      return json({ ok: true }, 201);
    }

    if (action === 'call-join') {
      const identity = await callIdentity(req, body);
      const peerId = String(body.peerId || '');
      if (!identity) return fail('Войдите в аккаунт и выберите группу для звонка.', 401);
      if (!validUuid(peerId)) return fail('Не удалось создать видеозвонок. Попробуйте ещё раз.');
      await db.sql`DELETE FROM public.call_participants WHERE group_id = ${identity.groupId}::uuid AND last_seen < now() - interval '45 seconds'`;
      const active = await db.sql`SELECT peer_id FROM public.call_participants WHERE group_id = ${identity.groupId}::uuid AND last_seen > now() - interval '20 seconds'`;
      if (!active.some(p => p.peer_id === peerId) && active.length >= 6) return fail('В этой групповой видеосвязи уже максимум 6 участников.', 409);
      await db.sql`INSERT INTO public.call_participants(group_id, peer_id, owner_key, display_name, role, last_seen)
        VALUES (${identity.groupId}::uuid, ${peerId}, ${identity.ownerKey}, ${identity.name}, ${identity.role}, now())
        ON CONFLICT (group_id, peer_id) DO UPDATE SET owner_key = EXCLUDED.owner_key, display_name = EXCLUDED.display_name, role = EXCLUDED.role, last_seen = now()`;
      const participants = await db.sql`SELECT peer_id, display_name, role FROM public.call_participants
        WHERE group_id = ${identity.groupId}::uuid AND peer_id <> ${peerId} AND last_seen > now() - interval '20 seconds'`;
      return json({ groupId: identity.groupId, participants: participants.map(p => ({ peerId: p.peer_id, name: p.display_name, role: p.role })) });
    }

    if (action === 'call-poll') {
      const identity = await callIdentity(req, body);
      const peerId = String(body.peerId || '');
      if (!identity || !validUuid(peerId)) return fail('Видеозвонок закончился. Подключитесь снова.', 401);
      const own = await db.sql`UPDATE public.call_participants SET last_seen = now()
        WHERE group_id = ${identity.groupId}::uuid AND peer_id = ${peerId} AND owner_key = ${identity.ownerKey} RETURNING peer_id`;
      if (!own.length) return fail('Подключение к звонку потеряно. Завершите звонок и войдите снова.', 409);
      const participants = await db.sql`SELECT peer_id, display_name, role FROM public.call_participants
        WHERE group_id = ${identity.groupId}::uuid AND last_seen > now() - interval '20 seconds'`;
      const signals = await db.sql`SELECT id, from_peer_id, sender_name, sender_role, payload FROM public.call_signals
        WHERE group_id = ${identity.groupId}::uuid AND to_peer_id = ${peerId} AND created_at > now() - interval '2 minutes'
        ORDER BY created_at ASC LIMIT 200`;
      await db.sql`DELETE FROM public.call_signals WHERE group_id = ${identity.groupId}::uuid AND created_at < now() - interval '5 minutes'`;
      return json({
        participants: participants.filter(p => p.peer_id !== peerId).map(p => ({ peerId: p.peer_id, name: p.display_name, role: p.role })),
        signals: signals.map(signal => ({ id: signal.id, fromPeerId: signal.from_peer_id, name: signal.sender_name, role: signal.sender_role, payload: signal.payload }))
      });
    }

    if (action === 'call-signal') {
      const identity = await callIdentity(req, body);
      const peerId = String(body.peerId || ''), toPeerId = String(body.toPeerId || '');
      const payload = body.payload;
      if (!identity || !validUuid(peerId) || !validUuid(toPeerId)) return fail('Сигнал видеосвязи недействителен.', 401);
      if (!payload || !['offer', 'answer', 'candidate', 'share-start', 'share-stop'].includes(payload.type)) return fail('Неизвестный тип сигнала.');
      if (Buffer.byteLength(JSON.stringify(payload)) > 24000) return fail('Сигнал слишком большой.');
      const peers = await db.sql`SELECT peer_id FROM public.call_participants
        WHERE group_id = ${identity.groupId}::uuid AND ((peer_id = ${peerId} AND owner_key = ${identity.ownerKey}) OR peer_id = ${toPeerId}) AND last_seen > now() - interval '30 seconds'`;
      if (peers.length !== 2) return fail('Участник звонка уже отключился.');
      await db.sql`INSERT INTO public.call_signals(group_id, from_peer_id, to_peer_id, sender_name, sender_role, payload)
        VALUES (${identity.groupId}::uuid, ${peerId}, ${toPeerId}, ${identity.name}, ${identity.role}, ${JSON.stringify(payload)}::jsonb)`;
      return json({ ok: true });
    }

    if (action === 'call-leave') {
      const identity = await callIdentity(req, body);
      const peerId = String(body.peerId || '');
      if (identity && validUuid(peerId)) {
        await db.sql`DELETE FROM public.call_participants WHERE group_id = ${identity.groupId}::uuid AND peer_id = ${peerId} AND owner_key = ${identity.ownerKey}`;
        await db.sql`DELETE FROM public.call_signals WHERE group_id = ${identity.groupId}::uuid AND (from_peer_id = ${peerId} OR to_peer_id = ${peerId})`;
      }
      return json({ ok: true });
    }

    return fail('Неизвестная команда.', 404);
  } catch (error) {
    console.error('[Линия API]', error);
    const detail = String(error?.message || '');
    if (/database|connection|NETLIFY_DB|connect/i.test(detail)) {
      return fail('База ещё не подключена. Проверьте Netlify Database в настройках проекта и повторите публикацию.', 503);
    }
    return fail('Сервер временно не смог обработать запрос. Попробуйте ещё раз.', 500);
  }
}

export const config = { path: '/api' };
