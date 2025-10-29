// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import process from 'process';
// ObjectId'ni MongoDB kutubxonasidan import qilamiz
import { MongoClient, ObjectId } from 'mongodb';

// ------------------ KONFIGURATSIYA ------------------
const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('XATO: BOT_TOKEN muhit oʻzgaruvchisi topilmadi.');
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/webhook/${token}` : null;

const MONGO_URI = process.env.MONGO_URI;
if (!MONGO_URI) {
    console.error('XATO: MONGO_URI muhit oʻzgaruvchisi topilmadi.');
    process.exit(1);
}
const MONGO_DB_NAME = process.env.MONGO_DB_NAME || 'animebot';


// ------------------ GLOBAL O'ZGARUVCHILAR ------------------
let ADMIN_IDS = [];
let dbClient, DB, animesCol, configCol;
const sessions = new Map();
const INLINE_CACHE_SECONDS = 10;
const bot = new TelegramBot(token, { polling: !WEBHOOK_URL });
let BOT_USERNAME = null;
const BOT_START_TIME = Math.floor(Date.now() / 1000);

// ======================================================================
// ================== BIR MARTALIK ADMIN TAYINLASH ======================
// ======================================================================
async function loadAdminsFromDB() {
    try {
        const config = await configCol.findOne({ _id: 'bot_config' });
        if (config && Array.isArray(config.admin_ids) && config.admin_ids.length > 0) {
            ADMIN_IDS = config.admin_ids;
            console.log('Adminlar MongoDB dan yuklandi:', ADMIN_IDS);
        } else {
            console.log('Ma\'lumotlar bazasida adminlar topilmadi. Birinchi foydalanuvchi kutilmoqda.');
        }
    } catch (e) { console.error("Adminlarni MongoDB'dan yuklashda xato:", e); }
}

async function setupFirstAdmin(msg) {
    if (ADMIN_IDS.length > 0) return false;
    const fromId = msg.from.id;
    ADMIN_IDS.push(fromId);
    try {
        await configCol.updateOne({ _id: 'bot_config' }, { $set: { admin_ids: ADMIN_IDS } }, { upsert: true });
        console.log(`🎉 BIRINCHI ADMIN TAYINLANDI! ID: ${fromId}.`);
        await bot.sendMessage(fromId, `🎉 Tabriklayman! Siz ushbu botning admini etib tayinlandingiz.`).catch(()=>{});
        return true;
    } catch (e) {
        console.error("Birinchi adminni MongoDB'ga saqlashda xato:", e);
        ADMIN_IDS = [];
        return false;
    }
}
// ======================================================================

// ------------------ MONGO DB FUNKSIYALARI ------------------
async function initMongo() {
  try {
    console.log('MongoDB ga ulanilmoqda...');
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
    await dbClient.db("admin").command({ ping: 1 });
    console.log("MongoDB ga muvaffaqiyatli ulanildi! ✅");

    DB = dbClient.db(MONGO_DB_NAME);
    animesCol = DB.collection('animes');
    configCol = DB.collection('config');
    
    await animesCol.createIndex({ name: 'text' }).catch(() => {});
    await loadAdminsFromDB();

  } catch (e) {
    console.error("\n--- MONGO DB ULASHDA KRITIK XATO ---\n", e.message);
    process.exit(1);
  }
}

// ID TIZIMI O'ZGARTIRILDI: Endi `counters` collection ishlatilmaydi.
async function insertAnimeToDB(animeObj) {
  const doc = { ...animeObj, created_at: new Date() };
  const result = await animesCol.insertOne(doc);
  return result.insertedId; // MongoDB o'zi yaratgan noyob _id ni qaytaramiz
}

async function findAnimesByQuery(q, limit = 10) {
    if (!q) return await animesCol.find().sort({ created_at: -1 }).limit(limit).toArray();
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return await animesCol.find({ name: regex }).limit(limit).toArray();
}
async function listAllAnimes() { return await animesCol.find().sort({ created_at: -1 }).toArray(); }

// ID TIZIMI O'ZGARTIRILDI: Endi string id qabul qilib, ObjectId ga o'giradi.
async function getAnimeById(idString) { 
    try {
        return await animesCol.findOne({ _id: new ObjectId(idString) });
    } catch (e) {
        console.error("Noto'g'ri ID formati yoki topilmadi:", idString, e.message);
        return null;
    }
}

// ------------------ SESSIYA YORDAMCHILARI ------------------
function startSession(chatId, adminId) {
  const s = { adminId, step: 'awaiting_video', data: { name: null, season: null, episode_count: null, video_id: null, poster_id: null } };
  sessions.set(String(chatId), s);
}
function endSession(chatId) { sessions.delete(String(chatId)); }
function getSession(chatId) { return sessions.get(String(chatId)); }
function summaryTextForSession(s) {
  return [ `📌 Nomi: ${s.data.name || '—'}`, `📆 Fasl: ${s.data.season ?? '—'}`, `🎞️ Qism: ${s.data.episode_count ?? '—'}`, `🖼️ Poster: ${s.data.poster_id ? '✅ Bor' : '❌ Yoʻq'}` ].join('\n');
}
function sessionStepKeyboard({ allowSkip = false } = {}) {
  const row = [{ text: '❌ Bekor qilish', callback_data: 'action_cancel' }];
  if (allowSkip) row.push({ text: '✅ O‘tkazib yuborish', callback_data: 'action_skip' });
  return { reply_markup: { inline_keyboard: [row] } };
}
function confirmKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'action_confirm' }, { text: '❌ Bekor qilish', callback_data: 'action_cancel' }]] } };
}

// ------------------ SERVER VA WEBHOOK ------------------
if (WEBHOOK_URL) {
  const app = express(); app.use(express.json());
  bot.setWebHook(WEBHOOK_URL).then(() => console.log('Webhook o\'rnatildi:', WEBHOOK_URL)).catch(err => console.error('Webhook xatosi:', err));
  app.post(`/webhook/${token}`, (req, res) => {
    if (req.body?.message?.date < BOT_START_TIME) return res.sendStatus(200);
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
  app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));
  app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda`));
} else { console.log('Polling rejimida ishga tushirildi.'); }

// ------------------ XATOLIKLARNI USHLASH ------------------
bot.getMe().then(me => { BOT_USERNAME = me.username; console.log('Bot username:', BOT_USERNAME); }).catch(e => console.warn('Bot ma\'lumotlarini olib bo\'lmadi.'));
process.on('uncaughtException', (err, origin) => console.error(`Xavfli xato: ${origin}`, err));
process.on('unhandledRejection', (reason) => console.error('Tutilmagan promise xatosi:', reason));
bot.on('error', (err) => console.error('Botda umumiy xato:', err));

// ------------------ BOT BUYRUQLARI VA HANDLERLARI ------------------
bot.onText(/\/start/, async (msg) => {
    await setupFirstAdmin(msg);
    if (ADMIN_IDS.includes(msg.from.id)) {
        const text = `👋 Assalomu alaykum, Admin!`;
        const kb = { reply_markup: { keyboard: [[{ text: '➕ Yangi anime qo‘shish' }], [{ text: '📜 Barcha animelar' }]], resize_keyboard: true } };
        await bot.sendMessage(msg.chat.id, text, kb);
    } else {
        await bot.sendMessage(msg.chat.id, `Salom! Anime qidirish uchun chatda shunday yozing: @${BOT_USERNAME || 'bot_nomi'} anime_nomi`);
    }
});

bot.on('message', async (msg) => {
    if (msg.date < BOT_START_TIME) return;
    const s = getSession(msg.chat.id);
    if (s && s.adminId === msg.from.id) return handleSessionMessage(msg, s);
    if (msg.text && !msg.text.startsWith('/') && ADMIN_IDS.includes(msg.from.id)) {
        switch (msg.text) {
            case '➕ Yangi anime qo‘shish': return handleAddAnime(msg);
            case '📜 Barcha animelar': return handleListAnimes(msg);
        }
    }
});

async function handleSessionMessage(msg, session) {
    const chatId = msg.chat.id;
    try {
        switch (session.step) {
            case 'awaiting_video':
                const videoId = msg.video?.file_id || (msg.document?.mime_type?.startsWith('video') ? msg.document.file_id : null);
                if (!videoId) return bot.sendMessage(chatId, '❗ Iltimos, video fayl yuboring.', sessionStepKeyboard());
                session.data.video_id = videoId; session.step = 'awaiting_name';
                return bot.sendMessage(chatId, '✅ Video qabul qilindi.\n\nEndi anime nomini kiriting 📝');
            case 'awaiting_name':
                if (!msg.text) return bot.sendMessage(chatId, '❗ Iltimos, matn yuboring.');
                session.data.name = msg.text.trim(); session.step = 'awaiting_poster';
                return bot.sendMessage(chatId, '🖼️ Endi anime posterini (rasmini) yuboring yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowSkip: true }));
            case 'awaiting_poster':
                session.data.poster_id = msg.photo?.[msg.photo.length - 1]?.file_id || null; 
                session.step = 'awaiting_episode_count';
                return bot.sendMessage(chatId, '🎞️ Endi qismlar sonini kiriting (raqam). Bilmasangiz "0" yuboring.');
            case 'awaiting_episode_count':
                if (!msg.text || isNaN(Number(msg.text.trim()))) return bot.sendMessage(chatId, '❗ Faqat raqam kiriting.');
                session.data.episode_count = Number(msg.text.trim()); session.step = 'awaiting_season';
                return bot.sendMessage(chatId, '📆 Fasl raqamini kiriting yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowSkip: true }));
            case 'awaiting_season':
                session.data.season = (msg.text && !isNaN(Number(msg.text.trim()))) ? Number(msg.text.trim()) : null; 
                session.step = 'confirm';
                return bot.sendMessage(chatId, 'Yakuniy ma\'lumotlar:\n\n' + summaryTextForSession(session), confirmKeyboard());
        }
    } catch (err) {
        console.error('Session xatosi:', err);
        await bot.sendMessage(chatId, 'Jarayonda xatolik yuz berdi. Sessiya bekor qilindi.');
        endSession(chatId);
    }
}

bot.on('callback_query', async (query) => {
    if (query.message?.date < BOT_START_TIME) return;
    const { data, from, message } = query;
    const chatId = message.chat.id;

    if (data.startsWith('view_')) {
        await bot.answerCallbackQuery(query.id);
        const animeId = data.substring(5); // "view_" dan keyingi qismini olamiz
        const anime = await getAnimeById(animeId);
        if (!anime) return bot.sendMessage(chatId, 'Bu anime topilmadi yoki o`chirilgan.');
        try {
            const caption = `📺 ${anime.name}\n🎞️ Qism: ${anime.episode_count ?? 'Noma\'lum'}\n📆 Fasl: ${anime.season ?? 'Noma\'lum'}`;
            if (anime.poster_id) await bot.sendPhoto(chatId, anime.poster_id, { caption });
            if (anime.video_id) return bot.sendVideo(chatId, anime.video_id);
            else if (!anime.poster_id) return bot.sendMessage(chatId, `${caption}\n\n(Bu anime uchun video topilmadi)`);
        } catch (e) { return bot.sendMessage(chatId, 'Media fayllarni yuborishda xato yuz berdi.'); }
        return;
    }

    const s = getSession(chatId);
    if (!s || from.id !== s.adminId) return bot.answerCallbackQuery(query.id, { text: 'Siz uchun emas.' });
    
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: message.message_id }).catch(() => {});

    if (data === 'action_cancel') { endSession(chatId); return bot.sendMessage(chatId, '❌ Jarayon bekor qilindi.'); }
    
    if (data === 'action_confirm') {
        try {
            const insertedId = await insertAnimeToDB(s.data); 
            await bot.sendMessage(chatId, `✅ Anime muvaffaqiyatli saqlandi (ID: ${insertedId.toString()}).`);
        } catch (e) { 
            console.error("action_confirm xatosi:", e);
            await bot.sendMessage(chatId, 'Saqlashda xato yuz berdi: ' + e.message); 
        }
        endSession(chatId);
    }
});

// YECHIM: Inline qidiruvda rasm chiqarish uchun yangilangan funksiya
bot.on('inline_query', async (iq) => {
    try {
        const matches = await findAnimesByQuery(iq.query.trim());
        const results = matches.map(anime => {
            const id = anime._id.toString();
            const caption = `🎞️ ${anime.episode_count ?? '?'} qism | 📆 ${anime.season ?? '?'} fasl`;
            
            // Agar poster bo'lsa, 'photo' tipida natija qaytaramiz
            if (anime.poster_id) {
                return {
                    type: 'photo',
                    id: id,
                    photo_file_id: anime.poster_id,
                    title: anime.name,
                    description: caption,
                    reply_markup: {
                        inline_keyboard: [[{ text: '🎬 Ko‘rish', callback_data: `view_${id}` }]]
                    }
                };
            }
            
            // Agar poster bo'lmasa, 'article' tipida qaytaramiz
            return {
                type: 'article',
                id: id,
                title: anime.name,
                input_message_content: { message_text: `⏳ "${anime.name}" animesi yuborilmoqda...` },
                reply_markup: { inline_keyboard: [[{ text: '🎬 Ko‘rish', callback_data: `view_${id}` }]] },
                description: caption
            };
        });
        await bot.answerInlineQuery(iq.id, results, { cache_time: INLINE_CACHE_SECONDS, is_personal: true });
    } catch (e) { console.error('inline_query xatosi:', e); }
});

async function handleAddAnime(msg) {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    startSession(msg.chat.id, msg.from.id);
    await bot.sendMessage(msg.chat.id, '🎬 Yangi anime qo‘shish boshlandi.\nIltimos, anime videosini yuboring.', sessionStepKeyboard());
}

async function handleListAnimes(msg) {
    if (!ADMIN_IDS.includes(msg.from.id)) return;
    const rows = await listAllAnimes();
    if (!rows.length) return bot.sendMessage(msg.chat.id, 'Saqlangan animelar yo‘q.');
    const text = rows.map(a => `🆔 ${a._id.toString()}\n— ${a.name}`).join('\n\n');
    for (let i = 0; i < text.length; i += 4096) {
        await bot.sendMessage(msg.chat.id, text.substring(i, i + 4096));
    }
}

// ------------------ BOTNI ASOSIY ISHGA TUSHIRISH ------------------
(async () => {
    await initMongo();
    console.log('Bot to`liq ishga tushdi va buyruqlarni qabul qilishga tayyor.');
})();