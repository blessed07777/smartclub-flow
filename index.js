const express = require('express');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());

// ─── Ключ (задать в Railway → Variables → PRIVATE_KEY) ────────────────────────
const PRIVATE_KEY_RAW = process.env.PRIVATE_KEY || '';

// Railway хранит переменные одной строкой — восстанавливаем переносы строк
const PRIVATE_KEY = PRIVATE_KEY_RAW.replace(/\\n/g, '\n');

// ─── Хранилище сессий (в памяти; для прода замените на Redis) ─────────────────
const sessions = {};

// ─── Расшифровка запроса от Meta ──────────────────────────────────────────────
function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;

  if (!PRIVATE_KEY) throw new Error('PRIVATE_KEY не задан в переменных окружения');

  // Расшифровываем AES-ключ приватным RSA-ключом
  const aesKey = crypto.privateDecrypt(
    {
      key:     PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(encrypted_aes_key, 'base64')
  );

  const iv            = Buffer.from(initial_vector, 'base64');
  const encryptedData = Buffer.from(encrypted_flow_data, 'base64');
  const TAG_LENGTH    = 16;
  const encryptedBody = encryptedData.slice(0, -TAG_LENGTH);
  const tag           = encryptedData.slice(-TAG_LENGTH);

  const decipher = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedBody), decipher.final()]);

  return { body: JSON.parse(decrypted.toString('utf8')), aesKey, iv };
}

// ─── Шифрование ответа для Meta ───────────────────────────────────────────────
function encryptResponse(response, aesKey, iv) {
  // IV инвертируется побитово для ответа
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i];

  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]).toString('base64');
}

// ─── Основной обработчик Flow ─────────────────────────────────────────────────
app.post('/flow', (req, res) => {

  // Health check от Meta (незашифрованный ping)
  if (req.body?.action === 'ping') {
    console.log('📡 Health check ping — ответ active');
    return res.json({ data: { status: 'active' } });
  }

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    const { action, data, flow_token } = body;
    const { name, phone, grade, goal, program } = data || {};

    console.log(`▶ action=${action} grade=${grade} goal=${goal} program=${program}`);

    let response;

    if (action === 'ping') {
      // На случай зашифрованного ping
      response = { data: { status: 'active' } };

    } else if (action === 'data_exchange') {

      // ШАГ 1: Заполнен квиз (есть name, phone, grade, goal) → роутим на программу
      if (goal && name && phone && !program) {
        sessions[flow_token] = { name, phone, grade, goal };

        const screenMap = {
          nil:   'RESULT_NIL',
          rfmsh: 'RESULT_RFMSH',
          bil:   'RESULT_BIL',
          ent:   'RESULT_ENT'
        };
        const screen = screenMap[goal] || 'RESULT_NIL';

        console.log(`→ Маршрут: ${screen} для ${name}`);
        response = { screen, data: { name, phone, grade, goal } };

      // ШАГ 2: Нажали "Записаться" (есть program) → SUCCESS
      } else if (program) {
        const client = sessions[flow_token] || {};
        const msg = [
          '✅ Новая заявка через WhatsApp Flow!',
          `👤 Имя: ${client.name || name || '—'}`,
          `📞 Телефон: ${client.phone || phone || '—'}`,
          `🎓 Класс: ${client.grade || grade || '—'}`,
          `📚 Программа: ${program.toUpperCase()}`
        ].join('\n');

        console.log(msg);
        notifyManager(msg);

        response = { screen: 'SUCCESS', data: { program } };

      } else {
        // Fallback
        response = { screen: 'QUIZ', data: {} };
      }

    } else {
      response = { screen: 'QUIZ', data: {} };
    }

    const encrypted = encryptResponse(response, aesKey, iv);
    res.send(encrypted);

  } catch (err) {
    console.error('❌ Ошибка обработки Flow:', err.message);
    res.status(500).send('error');
  }
});

// ─── Уведомление менеджера (Telegram) ────────────────────────────────────────
async function notifyManager(msg) {
  const token  = process.env.TELEGRAM_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[notifyManager] Telegram не настроен, пропускаем');
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text: msg })
    });
    const result = await response.json();
    if (!result.ok) console.error('Telegram ошибка:', result.description);
    else            console.log('📨 Telegram уведомление отправлено');
  } catch (e) {
    console.error('Telegram fetch error:', e.message);
  }
}

// ─── Запуск ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ SmartClub Flow сервер запущен на порту ${PORT}`);
  console.log(`🔑 PRIVATE_KEY: ${PRIVATE_KEY ? 'загружен (' + PRIVATE_KEY.length + ' символов)' : '❌ НЕ ЗАДАН!'}`);
});
