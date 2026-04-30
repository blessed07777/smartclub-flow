const express = require('express');
const crypto  = require('crypto');
const app     = express();
app.use(express.json());

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const sessions    = {};

function decryptRequest(body) {
  const { encrypted_aes_key, encrypted_flow_data, initial_vector } = body;
  const aesKey = crypto.privateDecrypt(
    { key: PRIVATE_KEY, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encrypted_aes_key, 'base64')
  );
  const iv            = Buffer.from(initial_vector, 'base64');
  const encryptedData = Buffer.from(encrypted_flow_data, 'base64');
  const TAG_LENGTH    = 16;
  const encryptedBody = encryptedData.slice(0, -TAG_LENGTH);
  const tag           = encryptedData.slice(-TAG_LENGTH);
  const decipher      = crypto.createDecipheriv('aes-128-gcm', aesKey, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encryptedBody), decipher.final()]);
  return { body: JSON.parse(decrypted.toString('utf8')), aesKey, iv };
}

function encryptResponse(response, aesKey, iv) {
  const flippedIv = Buffer.alloc(iv.length);
  for (let i = 0; i < iv.length; i++) flippedIv[i] = ~iv[i];
  const cipher = crypto.createCipheriv('aes-128-gcm', aesKey, flippedIv);
  return Buffer.concat([
    cipher.update(JSON.stringify(response), 'utf8'),
    cipher.final(),
    cipher.getAuthTag()
  ]).toString('base64');
}

app.post('/flow', (req, res) => {
  // Ping без шифрования
  if (req.body?.action === 'ping') {
    return res.json({ data: { status: 'active' } });
  }

  try {
    const { body, aesKey, iv } = decryptRequest(req.body);
    const { action, data, flow_token } = body;
    const { name, phone, grade, goal, program } = data || {};
    let response;

    if (action === 'ping') {
      response = { data: { status: 'active' } };

    } else if (grade && !goal && !program) {
      sessions[flow_token] = { name, phone, grade };
      const map = { junior: 'GOAL_JUNIOR', middle: 'GOAL_MIDDLE', senior: 'GOAL_SENIOR', ent: 'GOAL_ENT' };
      response = { screen: map[grade] || 'GOAL_JUNIOR', data: {} };

    } else if (goal && !program) {
      if (sessions[flow_token]) sessions[flow_token].goal = goal;
      const map = {
        base: 'RESULT_BASE', mind: 'RESULT_MIND',
        nil: 'RESULT_NIL', subject: 'RESULT_SUBJECT', level: 'RESULT_LEVEL',
        grades: 'RESULT_GRADES', strong: 'RESULT_STRONG',
        low: 'RESULT_ENT_LOW', mid: 'RESULT_ENT_MID', high: 'RESULT_ENT_HIGH'
      };
      response = { screen: map[goal] || 'RESULT_BASE', data: { goal } };

    } else if (program) {
      const s = sessions[flow_token] || {};
      console.log(`✅ ${s.name} | ${s.phone} | ${s.grade} | ${program}`);
      response = { screen: 'SUCCESS', data: { program } };

    } else {
      response = { screen: 'QUIZ', data: {} };
    }

    res.send(encryptResponse(response, aesKey, iv));

  } catch (e) {
    console.error('Ошибка:', e.message);
    res.status(500).send('error');
  }
});

app.listen(process.env.PORT || 3000, () => console.log('✅ Сервер запущен'));
