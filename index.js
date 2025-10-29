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
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/webhook/${token}` : null;

// MongoDB sozlamalari
const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('MONGO_URI yoʻq. .env ga MONGO_URI qoʻshing');
    process.exit(1);
}
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'animebot';


// ---------- Globals ----------
// Bu massiv bot ishga tushganda MongoDB dan to'ldiriladi
let ADMIN_IDS = []; 

let dbClient = null;
let DB = null;
let animesCol = null;
let countersCol = null;
let configCol = null; // Yangi: Adminlarni saqlash uchun collection
const sessions = new Map();

const INLINE_CACHE_SECONDS = 15;

const bot = new TelegramBot(token, { polling: !WEBHOOK_URL });
let BOT_USERNAME = null;

// ---------- MongoDB Functions ----------

// Adminlarni MongoDB dan yuklab olish funksiyasi
async function loadAdminIds() {
    const config = await configCol.findOne({ _id: 'bot_config' });
    if (config && config.admin_ids) {
        ADMIN_IDS = config.admin_ids;
        console.log('Adminlar MongoDB dan yuklandi:', ADMIN_IDS);
    } else {
        console.log('MongoDB da adminlar topilmadi. Birinchi foydalanuvchi admin bo`ladi.');
    }
}

// /start bosgan birinchi odamni MongoDB'ga admin sifatida saqlash
async function setupFirstAdmin(msg) {
    if (ADMIN_IDS.length > 0) {
        return false; // Admin allaqachon mavjud
    }

    const fromId = msg.from.id;
    ADMIN_IDS.push(fromId); // Xotiraga qo'shish

    // Ma'lumotlar bazasiga saqlash
    await configCol.updateOne(
        { _id: 'bot_config' },
        { $set: { admin_ids: ADMIN_IDS } },
        { upsert: true }
    );

    console.log(`🎉 Birinchi admin tayinlandi va MongoDB'ga saqlandi: ${fromId}`);
    await bot.sendMessage(fromId, `🎉 Tabriklayman! Siz botning birinchi admini etib tayinlandingiz.`).catch(()=>{});
    return true;
}


async function initMongo() {
  try {
    console.log('MongoDB ga ulanilmoqda...');
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
    DB = dbClient.db(MONGO_DB_NAME);
    animesCol = DB.collection('animes');
    countersCol = DB.collection('counters');
    configCol = DB.collection('config'); // config collection'ini ishlatish
    
    await animesCol.createIndex({ name: 'text' }).catch(() => {});
    console.log('MongoDB ga muvaffaqiyatli ulandi ✅');

    // Adminlarni yuklash
    await loadAdminIds();

  } catch (e) {
    console.error('Mongo connect error:', e);
    process.exit(1);
  }
}

async function getNextSequence(name = 'animeid') {
  const res = await countersCol.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return res.value.seq;
}

async function insertAnimeToDB(animeObj) {
  const id = await getNextSequence('animeid');
  const doc = { id, ...animeObj, created_at: new Date() };
  await animesCol.insertOne(doc);
  return id;
}

async function findAnimesByQuery(q, limit = 10) {
    if (!q) {
        return await animesCol.find().sort({ created_at: -1 }).limit(limit).toArray();
    }
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return await animesCol.find({ name: regex }).limit(limit).toArray();
}

async function listAllAnimes() {
  return await animesCol.find().sort({ id: 1 }).toArray();
}

async function getAnimeById(id) {
  return await animesCol.findOne({ id: Number(id) });
}

// ---------- Session helpers (o'zgarishsiz) ----------
function startSession(chatId, adminId) {
  const s = { adminId, step: 'awaiting_video', data: { name: null, season: null, episode_count: null, video_id: null, poster_id: null } };
  sessions.set(String(chatId), s);
  return s;
}
function endSession(chatId) { sessions.delete(String(chatId)); }
function getSession(chatId) { return sessions.get(String(chatId)); }
function sessionStepKeyboard({ allowBack = false, allowSkip = false } = {}) {
  const kb = [];
  const row = [];
  if (allowBack) row.push({ text: '🔙 Orqaga', callback_data: 'action_back' });
  row.push({ text: '❌ Bekor qilish', callback_data: 'action_cancel' });
  if (allowSkip) row.push({ text: '✅ O‘tkazib yuborish', callback_data: 'action_skip' });
  kb.push(row);
  return { reply_markup: { inline_keyboard: kb } };
}
function confirmKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'action_confirm' }, { text: '✏️ Tahrirlash', callback_data: 'action_edit' }, { text: '❌ Bekor qilish', callback_data: 'action_cancel' }]] } };
}
function summaryTextForSession(s) {
  return [ `📌 Anime nomi: ${s.data.name || '—'}`, `📆 Fasl: ${s.data.season ?? '—'}`, `🎞️ Qism soni: ${s.data.episode_count ?? '—'}`, `🎥 Video file_id: ${s.data.video_id ?? '—'}`, `🖼️ Poster file_id: ${s.data.poster_id ?? '—'}` ].join('\n');
}

// ---------- Server & Webhook ----------
if (WEBHOOK_URL) {
  const app = express();
  app.use(express.json());
  bot.setWebHook(WEBHOOK_URL).then(() => console.log('Webhook o\'rnatildi:', WEBHOOK_URL)).catch(err => console.error('Webhook xatosi:', err));
  app.post(`/webhook/${token}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));
  app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda`));
} else {
  console.log('Polling rejimida ishga tushirildi.');
}

// ---------- Bot Username & Error Handlers ----------
bot.getMe().then(me => { BOT_USERNAME = me.username; console.log('Bot username:', BOT_USERNAME); }).catch(e => console.warn('Bot ma\'lumotlarini olib bo\'lmadi:', e.message));
process.on('uncaughtException', (err) => console.error('uncaughtException:', err));
process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
bot.on('error', (err) => console.error('Bot xatosi:', err));

// ---------- Bot Handlers ----------

// /start
bot.onText(/\/start/, async (msg) => {
    await setupFirstAdmin(msg);
    const chatId = msg.chat.id;
    if (ADMIN_IDS.includes(msg.from.id)) {
        const text = `👋 Salom, Admin!\n\nMenyudan foydalaning:`;
        const kb = { reply_markup: { keyboard: [[{ text: '➕ Yangi anime qo‘shish' }], [{ text: '📜 Barcha animelar' }]], resize_keyboard: true } };
        await bot.sendMessage(chatId, text, kb);
    } else {
        await bot.sendMessage(chatId, `Salom! Anime qidirish uchun botni inline rejimida chaqiring: @${BOT_USERNAME || 'bot'} qidiruv_sozi`);
    }
});

// Admin tugmalari uchun handler
bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/') || !ADMIN_IDS.includes(msg.from.id)) return;
    if (getSession(msg.chat.id)) return; // Sessiya aktiv bo'lsa, tugmalarni bosishni o'tkazib yuborish

    switch (msg.text) {
        case '➕ Yangi anime qo‘shish': return handleAddAnime(msg);
        case '📜 Barcha animelar': return handleListAnimes(msg);
    }
});

// /addanime
async function handleAddAnime(msg) {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(chatId, '❌ Bu buyruq faqat adminlar uchun.');
    startSession(chatId, msg.from.id);
    await bot.sendMessage(chatId, '🎬 Yangi anime qo‘shish boshlandi.\nIltimos anime video faylini yuboring.', sessionStepKeyboard());
}
bot.onText(/\/addanime/, handleAddAnime);

// Sessiyalar uchun xabar handleri
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const s = getSession(chatId);
  if (!s || msg.from.id !== s.adminId || (msg.text && msg.text.startsWith('/'))) return;

  try {
    switch (s.step) {
      case 'awaiting_video':
        const videoFileId = msg.video?.file_id || (msg.document?.mime_type?.startsWith('video') ? msg.document.file_id : null);
        if (!videoFileId) return bot.sendMessage(chatId, '❗ Iltimos, video yuboring.', sessionStepKeyboard());
        s.data.video_id = videoFileId;
        s.step = 'awaiting_name';
        return bot.sendMessage(chatId, '✅ Video qabul qilindi.\n\nEndi anime nomini kiriting 📝', sessionStepKeyboard({ allowBack: true }));

      case 'awaiting_name':
        if (!msg.text) return bot.sendMessage(chatId, '❗ Iltimos, matn yuboring.', sessionStepKeyboard({ allowBack: true }));
        s.data.name = msg.text.trim();
        s.step = 'awaiting_episode_count';
        return bot.sendMessage(chatId, '📺 Qism sonini kiriting (raqam). Bilmasangiz "0" yuboring.', sessionStepKeyboard({ allowBack: true }));

      case 'awaiting_episode_count':
        if (!msg.text || isNaN(Number(msg.text.trim()))) return bot.sendMessage(chatId, '❗ Iltimos, raqam kiriting.', sessionStepKeyboard({ allowBack: true }));
        s.data.episode_count = Number(msg.text.trim());
        s.step = 'awaiting_poster';
        return bot.sendMessage(chatId, '🖼️ Anime posterini rasm qilib yuboring yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));

      case 'awaiting_poster':
        if (!msg.photo?.length) return bot.sendMessage(chatId, '❗ Rasm yuboring yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
        s.data.poster_id = msg.photo[msg.photo.length - 1].file_id;
        s.step = 'awaiting_season';
        return bot.sendMessage(chatId, '📆 Fasl raqamini kiriting yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));

      case 'awaiting_season':
        s.data.season = (msg.text && !isNaN(Number(msg.text.trim()))) ? Number(msg.text.trim()) : null;
        s.step = 'confirm';
        return bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(s), confirmKeyboard());
    }
  } catch (err) {
    console.error('Session xatosi:', err);
    await bot.sendMessage(chatId, 'Xato yuz berdi: ' + err.message);
    endSession(chatId);
  }
});

// Callback Query Handler
bot.on('callback_query', async (query) => {
    const { data, from, message } = query;
    const chatId = message.chat.id;

    if (data.startsWith('view_')) {
        const id = Number(data.split('_')[1]);
        const anime = await getAnimeById(id);
        if (!anime) return bot.answerCallbackQuery(query.id, { text: 'Anime topilmadi.' });
        try {
            if (anime.video_id) {
                await bot.sendVideo(chatId, anime.video_id, {
                    caption: `📺 ${anime.name}\n📆 Fasl: ${anime.season ?? '—'} | 🎞️ Qism: ${anime.episode_count ?? '—'}`
                });
            } else {
                await bot.sendMessage(chatId, `📺 ${anime.name}\n(Bu anime uchun video topilmadi)`);
            }
            return bot.answerCallbackQuery(query.id);
        } catch (e) {
            console.error('view callback xato:', e);
            return bot.answerCallbackQuery(query.id, { text: 'Videoni yuborishda xato.' });
        }
    }

    const s = getSession(chatId);
    if (!s || from.id !== s.adminId) return bot.answerCallbackQuery(query.id, { text: 'Siz uchun emas.' });

    await bot.answerCallbackQuery(query.id);

    if (data === 'action_cancel') {
        endSession(chatId);
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => {});
        return bot.sendMessage(chatId, '❌ Jarayon bekor qilindi.');
    }

    if (data === 'action_skip') {
        if (s.step === 'awaiting_poster') {
            s.data.poster_id = null;
            s.step = 'awaiting_season';
            return bot.sendMessage(chatId, '🟢 Poster o‘tkazib yuborildi. Endi faslni kiriting yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
        } else if (s.step === 'awaiting_season') {
            s.data.season = null;
            s.step = 'confirm';
            return bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(s), confirmKeyboard());
        }
    }

    if (data === 'action_confirm') {
        try {
            const id = await insertAnimeToDB(s.data);
            await bot.sendMessage(chatId, `✅ Anime saqlandi (ID: ${id}).`);
            endSession(chatId);
            await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => {});
        } catch (e) {
            console.error('action_confirm xatosi:', e);
            await bot.sendMessage(chatId, 'Saqlashda xato yuz berdi.');
        }
    }
});

// Inline Query
bot.on('inline_query', async (iq) => {
    try {
        const q = iq.query.trim();
        const matches = await findAnimesByQuery(q, 10);
        const results = matches.map(a => ({
            type: 'article',
            id: String(a.id),
            title: a.name,
            input_message_content: {
                message_text: `⏳ "${a.name}" animesi yuborilmoqda...`
            },
            reply_markup: {
                inline_keyboard: [[{ text: '🎬 Ko‘rish', callback_data: `view_${a.id}` }]]
            },
            description: `Qism: ${a.episode_count}, Fasl: ${a.season ?? '—'}`
        }));
        await bot.answerInlineQuery(iq.id, results, { cache_time: INLINE_CACHE_SECONDS, is_personal: true });
    } catch (e) {
        console.error('inline_query xatosi:', e);
    }
});

// /listanimes
async function handleListAnimes(msg) {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const rows = await listAllAnimes();
    if (!rows.length) return bot.sendMessage(chatId, 'Saqlangan animelar yo‘q.');

    const text = rows.map(a => `ID:${a.id} — ${a.name}`).join('\n');
    for (let i = 0; i < text.length; i += 4096) {
        await bot.sendMessage(chatId, text.substring(i, i + 4096));
    }
}
bot.onText(/\/listanimes/, handleListAnimes);

// ---------- Init ----------
(async () => {
    await initMongo();
    console.log('Bot to`liq ishga tushdi ✅ 1111');
})();