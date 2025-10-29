// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import process from 'process';
import { MongoClient } from 'mongodb';

// ------------------ CONFIG ------------------
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN yoʻq. .env ga BOT_TOKEN qoʻshing');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL ? (process.env.RENDER_EXTERNAL_URL.replace(/\/$/,'') + '/webhook/' + token) : null;
const ADMIN_IDS = (process.env.ADMIN_IDS || '') // misol: "12345,67890"
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://Otabek:Otabek0212@cluster0.38fsqsp.mongodb.net/';
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'animebot';

// ---------- Globals ----------
let dbClient = null;
let DB = null;
let animesCol = null;
let countersCol = null;
const sessions = new Map(); // in-memory sessions: key = String(chatId) yoki String(fromId)

// inline cache seconds
const INLINE_CACHE_SECONDS = 15;

// ---------- Telegram bot (webhook mode by default if WEBHOOK_URL) ----------
const bot = new TelegramBot(token, { polling: false });
let BOT_USERNAME = null;

// ---------- Helper: connect to Mongo ----------
async function initMongo() {
  try {
    console.log('Mongo connecting to', MONGO_URI, ' db:', MONGO_DB_NAME);
    dbClient = new MongoClient(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    await dbClient.connect();
    DB = dbClient.db(MONGO_DB_NAME);
    animesCol = DB.collection('animes');
    countersCol = DB.collection('counters');
    // Ensure index on name for search (text index)
    await animesCol.createIndex({ name: 'text' }).catch(()=>{});
    console.log('Mongo connected ✅');
  } catch (e) {
    console.error('Mongo connect error:', e && (e.message || e));
    process.exit(1);
  }
}

// ---------- Utility DB functions ----------
async function getNextSequence(name = 'animeid') {
  // atomic increment counter
  const res = await countersCol.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return res.value.seq;
}

async function insertAnimeToDB(animeObj) {
  // animeObj: { name, season, episode_count, video_id, poster_id }
  const id = await getNextSequence('animeid');
  const doc = {
    id,
    name: animeObj.name || '',
    season: (animeObj.season === undefined || animeObj.season === null) ? null : animeObj.season,
    episode_count: animeObj.episode_count || 0,
    video_id: animeObj.video_id || '',
    poster_id: animeObj.poster_id || '',
    created_at: new Date()
  };
  await animesCol.insertOne(doc);
  return id;
}

async function findAnimesByQuery(q, limit = 7) {
  if (!q) {
    return await animesCol.find().sort({ created_at: -1 }).limit(limit).toArray();
  }
  // try text search first, fallback to regex
  let results = [];
  try {
    results = await animesCol.find({ $text: { $search: q } }, { projection: { score: { $meta: "textScore" } } })
      .sort({ score: { $meta: "textScore" } })
      .limit(limit)
      .toArray();
    if (results.length) return results;
  } catch (e) {
    // ignore and fallback
  }
  const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  results = await animesCol.find({ name: regex }).limit(limit).toArray();
  return results;
}

async function listAllAnimes() {
  return await animesCol.find().sort({ id: 1 }).toArray();
}

async function getAnimeById(id) {
  // id numeric
  return await animesCol.findOne({ id: Number(id) });
}

// ---------- Session helpers ----------
function startSession(chatId, adminId) {
  const s = {
    adminId,
    step: 'awaiting_video',
    data: {
      name: null,
      season: null,
      episode_count: null,
      video_id: null,
      poster_id: null
    }
  };
  sessions.set(String(chatId), s);
  return s;
}
function endSession(chatId) {
  sessions.delete(String(chatId));
}
function getSession(chatId) {
  return sessions.get(String(chatId));
}
function sessionStepKeyboard({ allowBack = false, allowSkip = false } = {}) {
  const kb = [];
  const row = [];
  if (allowBack) row.push({ text: '🔙 Orqaga', callback_data: 'action_back' });
  row.push({ text: '❌ Bekor qilish', callback_data: 'action_cancel' });
  if (allowSkip) row.push({ text: '✅ Skip', callback_data: 'action_skip' });
  kb.push(row);
  return { reply_markup: { inline_keyboard: kb } };
}
function confirmKeyboard() {
  return {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Tasdiqlash', callback_data: 'action_confirm' },
          { text: '✏️ Tahrirlash', callback_data: 'action_edit' },
          { text: '❌ Bekor qilish', callback_data: 'action_cancel' }
        ]
      ]
    }
  };
}
function summaryTextForSession(s) {
  return [
    `📌 Anime nomi: ${s.data.name || '—'}`,
    `📆 Fasl: ${s.data.season ?? '—'}`,
    `🎞️ Qism soni: ${s.data.episode_count ?? '—'}`,
    `🎥 Video file_id: ${s.data.video_id ?? '—'}`,
    `🖼️ Poster file_id: ${s.data.poster_id ?? '—'}`
  ].join('\n');
}

// ---------- Setup server & webhook ----------
const app = express();
app.use(express.json());

if (WEBHOOK_URL) {
  bot.setWebHook(WEBHOOK_URL).then(() => {
    console.log('Webhook o\'rnatildi:', WEBHOOK_URL);
  }).catch(err => {
    console.warn('Webhook o\'rnatishda xato:', err && err.message);
  });

  app.post('/webhook/' + token, (req, res) => {
    console.log('WEBHOOK update receive (cut):', JSON.stringify(req.body).slice(0,1000));
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
} else {
  console.log('WEBHOOK_URL yo\'q — webhook o\'rnatilmadi. (RENDER_EXTERNAL_URL belgilanmagan)');
}

app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---------- Bot username fetch ----------
(async () => {
  try {
    const me = await bot.getMe();
    BOT_USERNAME = me.username || null;
    console.log('Bot username:', BOT_USERNAME);
  } catch (e) {
    console.warn('bot.getMe() xato:', e && e.message);
  }
})();

// ---------- Error logging ----------
process.on('uncaughtException', (err) => console.error('uncaughtException:', err && err.stack));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
bot.on('polling_error', (err) => console.error('polling_error:', err && err.stack));
bot.on('webhook_error', (err) => console.error('webhook_error:', err && err.stack));
bot.on('error', (err) => console.error('bot error:', err && err.stack));

/* ---------- Bot commandlar va eventlar ----------
   NOTE: DB bilan ishlash uchun initMongo() chaqirilgan bo'lishi kerak
   shu fayl ishga tushganda initMongo() allaqachon bajariladi
*/

// /start
bot.onText(/\/start(?:\s(.+))?/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (ADMIN_IDS.includes(Number(fromId))) {
    const text = `👋 Salom, Admin!\n\nAsosiy menyu:\n1. ➕ Yangi anime qo‘shish (/addanime)\n2. 🔍 Inline orqali qidirish (@${BOT_USERNAME || 'bot'})\n\nIltimos, /addanime buyrug‘i bilan yangi anime qo‘shing.`;
    const kb = {
      reply_markup: {
        keyboard: [
          [{ text: '➕ Yangi anime qo‘shish (/addanime)' }],
          [{ text: '🔍 Inline orqali qidirish' }]
        ],
        resize_keyboard: true,
        one_time_keyboard: false
      }
    };
    await bot.sendMessage(chatId, text, kb).catch(err => console.error('sendMessage /start err:', err));
  } else {
    await bot.sendMessage(chatId, 'Salom! Anime qidirish uchun botni inline rejimida chaqiring: @' + (BOT_USERNAME || 'bot')).catch(()=>{});
  }
});

// /addanime
bot.onText(/\/addanime/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (!ADMIN_IDS.includes(Number(fromId))) {
    await bot.sendMessage(chatId, '❌ Bu buyruq faqat adminlar uchun.').catch(()=>{});
    return;
  }
  const s = startSession(chatId, fromId);
  await bot.sendMessage(chatId, '🎬 Yangi anime qo‘shish jarayoni boshlandi.\nIltimos anime video faylini yuboring (video file yoki document sifatida).', sessionStepKeyboard({ allowBack: false, allowSkip: false })).catch(()=>{});
});

// message handler (sessions)
bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return; // komandalar alohida
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s) return;
  if (msg.from.id !== s.adminId) {
    await bot.sendMessage(chatId, '⚠️ Bu sessiya bilan ishlash huquqi yoʻq.').catch(()=>{});
    return;
  }

  try {
    if (s.step === 'awaiting_video') {
      let fileId = null;
      if (msg.video && msg.video.file_id) fileId = msg.video.file_id;
      else if (msg.document && msg.document.mime_type && msg.document.mime_type.startsWith('video')) fileId = msg.document.file_id;
      if (!fileId) {
        await bot.sendMessage(chatId, '❗ Iltimos, video yuboring (video fayl yoki video sifatida yuborilgan document).', sessionStepKeyboard({ allowBack: true })).catch(()=>{});
        return;
      }
      s.data.video_id = fileId;
      s.step = 'awaiting_name';
      await bot.sendMessage(chatId, '✅ Video qabul qilindi.\n\nEndi anime nomini kiriting 📝 (masalan: Naruto)', sessionStepKeyboard({ allowBack: true })).catch(()=>{});
      return;
    }

    if (s.step === 'awaiting_name') {
      if (!msg.text) {
        await bot.sendMessage(chatId, '❗ Iltimos, matn shaklida anime nomini yuboring.', sessionStepKeyboard({ allowBack: true })).catch(()=>{});
        return;
      }
      s.data.name = msg.text.trim();
      s.step = 'awaiting_episode_count';
      await bot.sendMessage(chatId, '📺 Qism sonini kiriting (raqam).', sessionStepKeyboard({ allowBack: true, allowSkip: false })).catch(()=>{});
      return;
    }

    if (s.step === 'awaiting_episode_count') {
      if (!msg.text || isNaN(Number(msg.text.trim()))) {
        await bot.sendMessage(chatId, '❗ Iltimos, faqat raqam kiriting (masalan: 24). Agar raqamni bilmasangiz "0" deb yuboring.', sessionStepKeyboard({ allowBack: true })).catch(()=>{});
        return;
      }
      s.data.episode_count = Number(msg.text.trim());
      s.step = 'awaiting_poster';
      await bot.sendMessage(chatId, '🖼️ Endi anime posteri uchun rasm yuboring (photo sifatida). Agar yo‘q bo‘lsa "Skip" tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
      return;
    }

    if (s.step === 'awaiting_poster') {
      if (!msg.photo || !msg.photo.length) {
        await bot.sendMessage(chatId, '❗ Iltimos, photo yuboring. Yoki "Skip" tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
        return;
      }
      const photo = msg.photo[msg.photo.length - 1];
      s.data.poster_id = photo.file_id;
      s.step = 'awaiting_season';
      await bot.sendMessage(chatId, '📆 Agar fasl (season) mavjud bo‘lsa raqamini kiriting (masalan: 2). Aks holda "Skip" tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
      return;
    }

    if (s.step === 'awaiting_season') {
      if (!msg.text) {
        await bot.sendMessage(chatId, '❗ Iltimos, fasl raqamini yozing yoki Skip tugmasini bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
        return;
      }
      const t = msg.text.trim().toLowerCase();
      if (t === 'skip' || t === '➡️ skip') {
        s.data.season = null;
      } else if (!isNaN(Number(msg.text.trim()))) {
        s.data.season = Number(msg.text.trim());
      } else {
        await bot.sendMessage(chatId, '❗ Iltimos, raqam kiriting yoki Skip deb yozing.', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
        return;
      }
      s.step = 'confirm';
      await bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(s), confirmKeyboard()).catch(()=>{});
      return;
    }

    if (s.step === 'confirm') {
      const text = (msg.text || '').trim().toLowerCase();
      if (text === 'tasdiqlash' || text === 'confirm' || text === '✅ tasdiqlash') {
        const id = await insertAnimeToDB(s.data);
        await bot.sendMessage(chatId, `✅ Anime saqlandi (ID: ${id}).`).catch(()=>{});
        endSession(chatId);
      } else {
        await bot.sendMessage(chatId, '❗ Iltimos tugmalardan foydalaning (✅ Tasdiqlash / ✏️ Tahrirlash / ❌ Bekor).', confirmKeyboard()).catch(()=>{});
      }
      return;
    }

  } catch (err) {
    console.error('session message handler xato:', err && (err.message || err));
    await bot.sendMessage(chatId, 'Xato yuz berdi: ' + (err && err.message)).catch(()=>{});
    endSession(chatId);
  }
});

// ---------- Callback query ----------
bot.on('callback_query', async (query) => {
  const data = query.data;
  const chatId = query.message ? query.message.chat.id : query.from.id;
  const fromId = query.from.id;

  // inline view callback: view_{id}
  if (data && data.startsWith('view_')) {
    const id = Number(data.split('_')[1]);
    const anime = await getAnimeById(id);
    if (!anime) {
      await bot.answerCallbackQuery(query.id, { text: 'Anime topilmadi.' }).catch(()=>{});
      return;
    }
    try {
      await bot.sendMessage(chatId, `📺 ${anime.name}\n📆 Fasl: ${anime.season ?? '—'} | 🎞️ Qism: ${anime.episode_count}`).catch(()=>{});
      if (anime.poster_id) await bot.sendPhoto(chatId, anime.poster_id, { caption: 'Poster' }).catch(()=>{});
      if (anime.video_id) await bot.sendVideo(chatId, anime.video_id, { caption: `Video: ${anime.name}` }).catch(()=>{});
      else await bot.sendMessage(chatId, 'Video mavjud emas.').catch(()=>{});
      await bot.answerCallbackQuery(query.id).catch(()=>{});
    } catch (e) {
      console.error('view callback xato:', e && e.message);
      await bot.answerCallbackQuery(query.id, { text: 'Xato yuz berdi.' }).catch(()=>{});
    }
    return;
  }

  // other callback actions related to sessions
  const s = getSession(chatId);
  if (!s) {
    await bot.answerCallbackQuery(query.id, { text: 'Aktiv sessiya topilmadi.' }).catch(()=>{});
    return;
  }
  if (fromId !== s.adminId) {
    await bot.answerCallbackQuery(query.id, { text: 'Bu tugmani bosish huquqi sizda yo‘q.' }).catch(()=>{});
    return;
  }

  if (data === 'action_cancel') {
    endSession(chatId);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(()=>{});
    await bot.sendMessage(chatId, '❌ Jarayon bekor qilindi.').catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }

  if (data === 'action_back') {
    const order = ['awaiting_video','awaiting_name','awaiting_episode_count','awaiting_poster','awaiting_season','confirm'];
    let idx = order.indexOf(s.step);
    if (idx <= 0) {
      await bot.answerCallbackQuery(query.id, { text: 'Orqaga qaytish mumkin emas.' }).catch(()=>{});
      return;
    }
    idx = idx - 1;
    s.step = order[idx];
    await bot.sendMessage(chatId, `🔙 Orqaga qaytildi. Hozirgi bosqich: ${s.step}`).catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }

  if (data === 'action_skip') {
    if (s.step === 'awaiting_poster') {
      s.data.poster_id = null;
      s.step = 'awaiting_season';
      await bot.sendMessage(chatId, '🟢 Poster skip qilindi. Endi faslni kiriting yoki Skip bosing.', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
    } else if (s.step === 'awaiting_season') {
      s.data.season = null;
      s.step = 'confirm';
      await bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(s), confirmKeyboard()).catch(()=>{});
    } else {
      await bot.sendMessage(chatId, 'Skip bu bosqich uchun mavjud emas.').catch(()=>{});
    }
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }

  if (data === 'action_confirm') {
    try {
      const id = await insertAnimeToDB(s.data);
      await bot.sendMessage(chatId, `✅ Anime saqlandi (ID: ${id}).`).catch(()=>{});
      endSession(chatId);
      await bot.answerCallbackQuery(query.id).catch(()=>{});
    } catch (e) {
      console.error('action_confirm save err:', e && e.message);
      await bot.answerCallbackQuery(query.id, { text: 'Saqlashda xato yuz berdi.' }).catch(()=>{});
    }
    return;
  }

  if (data === 'action_edit') {
    await bot.sendMessage(chatId, 'Qaysi maydonni tahrirlashni xohlaysiz?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Nom', callback_data: 'edit_name' }, { text: 'Qism soni', callback_data: 'edit_episode_count' }],
          [{ text: 'Poster', callback_data: 'edit_poster' }, { text: 'Fasl', callback_data: 'edit_season' }],
          [{ text: 'Ortga (Bekor)', callback_data: 'edit_cancel' }]
        ]
      }
    }).catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }

  if (data === 'edit_name') {
    s.step = 'awaiting_name';
    await bot.sendMessage(chatId, '✏️ Yangi nom kiriting:').catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }
  if (data === 'edit_episode_count') {
    s.step = 'awaiting_episode_count';
    await bot.sendMessage(chatId, '✏️ Yangi qism sonini kiriting (raqam):').catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }
  if (data === 'edit_poster') {
    s.step = 'awaiting_poster';
    await bot.sendMessage(chatId, '🖼️ Yangi poster yuboring (photo):', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }
  if (data === 'edit_season') {
    s.step = 'awaiting_season';
    await bot.sendMessage(chatId, '✏️ Yangi fasl raqamini kiriting yoki Skip bosing:', sessionStepKeyboard({ allowBack: true, allowSkip: true })).catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }
  if (data === 'edit_cancel') {
    s.step = 'confirm';
    await bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(s), confirmKeyboard()).catch(()=>{});
    await bot.answerCallbackQuery(query.id).catch(()=>{});
    return;
  }

  await bot.answerCallbackQuery(query.id, { text: 'Noma\'lum amal.' }).catch(()=>{});
});

// ---------- Inline query handler ----------
bot.on('inline_query', async (iq) => {
  const q = (iq.query || '').trim();
  let matches = await findAnimesByQuery(q, 7);
  matches = matches.slice(0,7);

  const results = matches.map(a => {
    const captionLines = [`📺 ${a.name}`, `🎞️ Qism: ${a.episode_count}`, `📆 Fasl: ${a.season ?? '—'}`];
    const caption = captionLines.join(' | ');
    if (a.poster_id) {
      return {
        type: 'photo',
        id: String(a.id),
        photo_file_id: a.poster_id,
        caption: caption,
        reply_markup: {
          inline_keyboard: [[{ text: 'Ko‘rish', callback_data: `view_${a.id}` }]]
        }
      };
    } else {
      return {
        type: 'article',
        id: String(a.id),
        title: a.name,
        input_message_content: {
          message_text: `📺 ${a.name}\n🎞️ Qism: ${a.episode_count}\n📆 Fasl: ${a.season ?? '—'}`
        },
        reply_markup: {
          inline_keyboard: [[{ text: 'Ko‘rish', callback_data: `view_${a.id}` }]]
        },
        description: `Qism: ${a.episode_count}, Fasl: ${a.season ?? '—'}`
      };
    }
  });

  try {
    await bot.answerInlineQuery(iq.id, results, { cache_time: INLINE_CACHE_SECONDS, is_personal: true });
  } catch (e) {
    console.error('inline_query err:', e && e.message);
  }
});

// ---------- Admin helper: /listanimes ----------
bot.onText(/\/listanimes/, async (msg) => {
  const chatId = msg.chat.id;
  const fromId = msg.from.id;
  if (!ADMIN_IDS.includes(Number(fromId))) {
    await bot.sendMessage(chatId, '❌ Bu buyruq faqat adminlar uchun.').catch(()=>{});
    return;
  }
  const rows = await listAllAnimes();
  if (!rows.length) {
    await bot.sendMessage(chatId, 'Hozircha saqlangan anime yo‘q.').catch(()=>{});
    return;
  }
  const parts = rows.map(a => `ID:${a.id} — ${a.name} | Qism: ${a.episode_count} | Fasl: ${a.season ?? '—'}`).join('\n');
  await bot.sendMessage(chatId, 'Saqlangan anime roʻyxati:\n\n' + parts).catch(()=>{});
});

// ---------- Init everything ----------
(async () => {
  await initMongo();
  console.log('Init tamam ✅');
  // agar webhook yo'q bo'lsa, pollingni yoqish (lokal testlar uchun)
  if (!WEBHOOK_URL) {
    console.log('Fallback: polling yoqilyapti (test uchun).');
    bot.options.polling = true;
    if (typeof bot.startPolling === 'function') bot.startPolling();
  }
})();
