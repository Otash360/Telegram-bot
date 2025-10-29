// index.js
import TelegramBot from 'node-telegram-bot-api';
import express from 'express';
import process from 'process';
import { MongoClient } from 'mongodb';

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
let dbClient, DB, animesCol, countersCol, configCol;
const sessions = new Map();
const INLINE_CACHE_SECONDS = 10;
const bot = new TelegramBot(token, { polling: !WEBHOOK_URL });
let BOT_USERNAME = null;


// ======================================================================
// ======================================================================
// ========= BIR MARTALIK ADMIN TAYINLASH FUNKSIYALARI ==================
//
// Ushbu blokdagi funksiyalar botga birinchi marta /start bosgan
// foydalanuvchini yagona admin sifatida MongoDB'ga saqlash uchun ishlaydi.
// Admin tayinlangandan so'ng, bu kodni o'chirib tashlashingiz yoki
// izohga olib qo'yishingiz mumkin.
//
// ======================================================================

/**
 * MongoDB dan adminlar ro'yxatini yuklaydi.
 */
async function loadAdminsFromDB() {
    try {
        const config = await configCol.findOne({ _id: 'bot_config' });
        if (config && Array.isArray(config.admin_ids) && config.admin_ids.length > 0) {
            ADMIN_IDS = config.admin_ids;
            console.log('Adminlar MongoDB dan yuklandi:', ADMIN_IDS);
        } else {
            console.log('Ma\'lumotlar bazasida adminlar topilmadi. Birinchi foydalanuvchi kutilmoqda.');
        }
    } catch (e) {
        console.error("Adminlarni MongoDB'dan yuklashda xato:", e);
    }
}

/**
 * Agar admin hali tayinlanmagan bo'lsa, birinchi /start bosgan foydalanuvchini admin sifatida saqlaydi.
 */
async function setupFirstAdmin(msg) {
    if (ADMIN_IDS.length > 0) return false;

    const fromId = msg.from.id;
    ADMIN_IDS.push(fromId);

    try {
        await configCol.updateOne({ _id: 'bot_config' }, { $set: { admin_ids: ADMIN_IDS } }, { upsert: true });
        console.log(`🎉 BIRINCHI ADMIN TAYINLANDI! ID: ${fromId}. Ma'lumot MongoDB'ga saqlandi.`);
        await bot.sendMessage(fromId, `🎉 Tabriklayman! Siz ushbu botning admini etib tayinlandingiz.`).catch(()=>{});
        return true;
    } catch (e) {
        console.error("Birinchi adminni MongoDB'ga saqlashda xato:", e);
        ADMIN_IDS = [];
        return false;
    }
}
// ======================================================================
// =================== ADMIN TAYINLASH BLOKI TUGADI =====================
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
    countersCol = DB.collection('counters');
    configCol = DB.collection('config');
    
    await animesCol.createIndex({ name: 'text' }).catch(() => {});
    await loadAdminsFromDB();

  } catch (e) {
    console.error("\n--- MONGO DB ULASHDA KRITIK XATO ---\n", e.message);
    process.exit(1);
  }
}

/**
 * XATOLIK TUZATILGAN FUNKSIYA
 * Atomik ravishda yangi ID generatsiya qiladi.
 */
async function getNextSequence(name = 'animeid') {
  const res = await countersCol.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );

  // XATOLIKNI TUZATISH: findOneAndUpdate natijasini tekshirish
  if (!res || res.value === null || res.value === undefined) {
      console.error('getNextSequence xatosi: counters collectionidan ID olinmadi. MongoDB javobi:', res);
      throw new Error('Ma\'lumotlar bazasidan yangi ID generatsiya qilib bo\'lmadi.');
  }
  return res.value.seq;
}

async function insertAnimeToDB(animeObj) {
  const id = await getNextSequence('animeid');
  const doc = { id, ...animeObj, created_at: new Date() };
  await animesCol.insertOne(doc);
  return id;
}

async function findAnimesByQuery(q, limit = 10) {
    if (!q) return await animesCol.find().sort({ created_at: -1 }).limit(limit).toArray();
    const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return await animesCol.find({ name: regex }).limit(limit).toArray();
}
async function listAllAnimes() { return await animesCol.find().sort({ id: 1 }).toArray(); }
async function getAnimeById(id) { return await animesCol.findOne({ id: Number(id) }); }

// ------------------ SESSIYA YORDAMCHILARI ------------------
function startSession(chatId, adminId) {
  const s = { adminId, step: 'awaiting_video', data: { name: null, season: null, episode_count: null, video_id: null, poster_id: null } };
  sessions.set(String(chatId), s);
}
function endSession(chatId) { sessions.delete(String(chatId)); }
function getSession(chatId) { return sessions.get(String(chatId)); }

// YANGILANGAN: Tasdiqlash xabarida poster ma'lumoti qo'shildi
function summaryTextForSession(s) {
  return [
    `📌 Nomi: ${s.data.name || '—'}`,
    `📆 Fasl: ${s.data.season ?? '—'}`,
    `🎞️ Qism: ${s.data.episode_count ?? '—'}`,
    `🖼️ Poster: ${s.data.poster_id ? '✅ Bor' : '❌ Yoʻq'}`
  ].join('\n');
}

function sessionStepKeyboard({ allowBack = false, allowSkip = false } = {}) {
  const kb = []; const row = [];
  if (allowBack) row.push({ text: '🔙 Orqaga', callback_data: 'action_back' });
  row.push({ text: '❌ Bekor qilish', callback_data: 'action_cancel' });
  if (allowSkip) row.push({ text: '✅ O‘tkazib yuborish', callback_data: 'action_skip' });
  kb.push(row); return { reply_markup: { inline_keyboard: kb } };
}
function confirmKeyboard() {
  return { reply_markup: { inline_keyboard: [[{ text: '✅ Tasdiqlash', callback_data: 'action_confirm' }, { text: '❌ Bekor qilish', callback_data: 'action_cancel' }]] } };
}

// ------------------ SERVER VA WEBHOOK ------------------
if (WEBHOOK_URL) {
  const app = express(); app.use(express.json());
  bot.setWebHook(WEBHOOK_URL).then(() => console.log('Webhook o\'rnatildi:', WEBHOOK_URL)).catch(err => console.error('Webhook xatosi:', err));
  app.post(`/webhook/${token}`, (req, res) => { bot.processUpdate(req.body); res.sendStatus(200); });
  app.get('/', (req, res) => res.send('Bot ishlayapti ✅'));
  app.listen(PORT, () => console.log(`Server ${PORT}-portda ishlamoqda`));
} else { console.log('Polling rejimida ishga tushirildi.'); }

// ------------------ XATOLIKLARNI USHLASH ------------------
bot.getMe().then(me => { BOT_USERNAME = me.username; console.log('Bot username:', BOT_USERNAME); }).catch(e => console.warn('Bot ma\'lumotlarini olib bo\'lmadi.'));
process.on('uncaughtException', (err, origin) => console.error(`Xavfli xato: ${origin}`, err));
process.on('unhandledRejection', (reason) => console.error('Tutilmagan promise xatosi:', reason));
bot.on('error', (err) => console.error('Botda umumiy xato:', err));

// ------------------ BOT BUYRUQLARI VA HANDLERLARI ------------------

// /start buyrug'i
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

bot.onText(/\/addanime/, (msg) => handleAddAnime(msg));
bot.onText(/\/listanimes/, (msg) => handleListAnimes(msg));

// Barcha xabarlarni qayta ishlaydigan yagona handler
bot.on('message', async (msg) => {
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
                return bot.sendMessage(chatId, '✅ Video qabul qilindi.\n\nEndi anime nomini kiriting 📝', sessionStepKeyboard({ allowBack: true }));
            
            case 'awaiting_name':
                if (!msg.text) return bot.sendMessage(chatId, '❗ Iltimos, matn yuboring.', sessionStepKeyboard({ allowBack: true }));
                session.data.name = msg.text.trim(); session.step = 'awaiting_poster';
                return bot.sendMessage(chatId, '🖼️ Endi anime posterini (rasmini) yuboring yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));

            // YANGILANGAN QADAM: Poster qabul qilish
            case 'awaiting_poster':
                session.data.poster_id = msg.photo?.[msg.photo.length - 1]?.file_id || null; 
                session.step = 'awaiting_episode_count';
                return bot.sendMessage(chatId, '🎞️ Endi qismlar sonini kiriting (raqam). Bilmasangiz "0" yuboring.', sessionStepKeyboard({ allowBack: true }));

            case 'awaiting_episode_count':
                if (!msg.text || isNaN(Number(msg.text.trim()))) return bot.sendMessage(chatId, '❗ Faqat raqam kiriting.', sessionStepKeyboard({ allowBack: true }));
                session.data.episode_count = Number(msg.text.trim()); session.step = 'awaiting_season';
                return bot.sendMessage(chatId, '📆 Fasl raqamini kiriting yoki o‘tkazib yuboring.', sessionStepKeyboard({ allowBack: true, allowSkip: true }));
            
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

// Inline tugmalarni (callback_query) ushlab olish
bot.on('callback_query', async (query) => {
    const { data, from, message } = query;
    const chatId = message.chat.id;

    if (data.startsWith('view_')) {
        await bot.answerCallbackQuery(query.id);
        const anime = await getAnimeById(data.split('_')[1]);
        if (!anime) return bot.sendMessage(chatId, 'Bu anime topilmadi.');
        try {
            if (anime.poster_id) await bot.sendPhoto(chatId, anime.poster_id);
            if (anime.video_id) return bot.sendVideo(chatId, anime.video_id, { caption: `📺 ${anime.name}` });
            else return bot.sendMessage(chatId, `📺 ${anime.name}\n(Bu anime uchun video topilmadi)`);
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
            const id = await insertAnimeToDB(s.data); 
            await bot.sendMessage(chatId, `✅ Anime muvaffaqiyatli saqlandi (ID: ${id}).`);
        } catch (e) { 
            console.error("action_confirm xatosi:", e);
            await bot.sendMessage(chatId, 'Saqlashda xato yuz berdi: ' + e.message); 
        }
        endSession(chatId);
    }
});

// Inline rejimda qidirish
bot.on('inline_query', async (iq) => {
    try {
        const matches = await findAnimesByQuery(iq.query.trim());
        const results = matches.map(a => ({
            type: 'article', id: String(a.id), title: a.name,
            input_message_content: { message_text: `⏳ "${a.name}" animesi yuborilmoqda...` },
            reply_markup: { inline_keyboard: [[{ text: '🎬 Ko‘rish', callback_data: `view_${a.id}` }]] },
            description: `Qism: ${a.episode_count}, Fasl: ${a.season ?? '—'}`
        }));
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
    const text = rows.map(a => `🆔${a.id} — ${a.name}`).join('\n');
    for (let i = 0; i < text.length; i += 4096) {
        await bot.sendMessage(msg.chat.id, text.substring(i, i + 4096));
    }
}

// ------------------ BOTNI ASOSIY ISHGA TUSHIRISH ------------------
(async () => {
    await initMongo();
    console.log('Bot to`liq ishga tushdi va buyruqlarni qabul qilishga tayyor.');
})();