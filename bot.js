require('dotenv').config();
const http = require('http');
http.createServer((req, res) => res.end('Bot attivo!')).listen(process.env.PORT || 3000);
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config/rules.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ─── State ────────────────────────────────────────────────────────────────────
const warningCount = {};
const LOG_PATH = path.join(__dirname, 'config/violations.log');

function logViolation(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(LOG_PATH, line);
}

function userKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

// ─── AI Moderation ────────────────────────────────────────────────────────────
async function analyzeMessage(text, config) {
  const rulesText = config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const bannedWords = config.bannedWords.length
    ? `Parole sempre vietate: ${config.bannedWords.join(', ')}`
    : '';
  const lang = config.language ? `Lingua permessa: ${config.language}` : '';

  const prompt = `Sei un moderatore AI per un gruppo Telegram. Analizza il messaggio e stabilisci se viola le regole.

REGOLE:
${rulesText}
${bannedWords}
${lang}

MESSAGGIO: "${text}"

Rispondi SOLO con JSON valido, nessun testo extra, nessun markdown:
{
  "violation": true o false,
  "severity": "low" o "medium" o "high",
  "rule_violated": "regola violata breve o null",
  "warning_message": "messaggio di avviso gentile ma fermo in italiano, o null",
  "suggested_action": "warn" o "mute" o "kick" o "ban"
}`;

  const result = await model.generateContent(prompt);
  let responseText = result.response.text().trim();
  responseText = responseText.replace(/```json|```/g, '').trim();
  return JSON.parse(responseText);
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function muteUser(chatId, userId, minutes = 30) {
  const until = Math.floor(Date.now() / 1000) + minutes * 60;
  await bot.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_polls: false,
      can_send_other_messages: false,
    },
    until_date: until,
  });
}

async function kickUser(chatId, userId) {
  await bot.banChatMember(chatId, userId, { until_date: Math.floor(Date.now() / 1000) + 35 });
}

async function banUser(chatId, userId) {
  await bot.banChatMember(chatId, userId);
}

async function deleteMessage(chatId, messageId) {
  try { await bot.deleteMessage(chatId, messageId); } catch (_) {}
}

async function notifyAdmins(config, text) {
  for (const adminId of config.adminIds) {
    try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) {}
  }
}

// ─── Main message handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();

    if (!['group', 'supergroup'].includes(msg.chat.type)) return;
    if (!text || text.length < 2) return;
    if (!userId) return;

    const config = loadConfig();

    if (config.monitoredGroups.length > 0 && !config.monitoredGroups.includes(chatId)) return;
    if (config.adminIds.includes(userId)) return;

    if (text.startsWith('/mod') && config.adminIds.includes(userId)) {
      await handleAdminCommand(msg, text, config);
      return;
    }

    const result = await analyzeMessage(text, config);
    if (!result.violation) return;

    const key = userKey(chatId, userId);
    warningCount[key] = (warningCount[key] || 0) + 1;
    const count = warningCount[key];
    const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;

    logViolation({ chatId, userId, username, message: text, rule: result.rule_violated, severity: result.severity, warning_count: count });

    if (config.deleteViolations) await deleteMessage(chatId, msg.message_id);

    let action = count >= config.maxWarnings ? config.actionOnMaxWarnings : result.suggested_action;
    let actionText = '';

    switch (action) {
      case 'mute':
        await muteUser(chatId, userId, config.muteDurationMinutes || 30);
        actionText = `🔇 Silenziato per ${config.muteDurationMinutes || 30} minuti`;
        break;
      case 'kick':
        await kickUser(chatId, userId);
        actionText = '👢 Rimosso dal gruppo';
        break;
      case 'ban':
        await banUser(chatId, userId);
        actionText = '🚫 Bannato permanentemente';
        break;
      default:
        actionText = `_(Avviso ${count}/${config.maxWarnings})_`;
    }

    await bot.sendMessage(chatId,
      `⚠️ ${username}\n${result.warning_message}\n\n📋 _${result.rule_violated}_\n${actionText}`,
      { parse_mode: 'Markdown' }
    );

    if (result.severity === 'high' || ['kick', 'ban'].includes(action)) {
      await notifyAdmins(config,
        `🚨 *Violazione ${result.severity.toUpperCase()}*\n👤 ${username}\n💬 "${text.substring(0, 100)}"\n📋 ${result.rule_violated}\n⚡ ${actionText}`
      );
    }

  } catch (err) {
    console.error('❌ Errore:', err.message);
  }
});

// ─── Admin commands ───────────────────────────────────────────────────────────
async function handleAdminCommand(msg, text, config) {
  const chatId = msg.chat.id;
  const parts = text.split(' ');
  const cmd = parts[1];

  if (cmd === 'status') {
    const entries = Object.entries(warningCount)
      .filter(([k]) => k.startsWith(chatId + ':'))
      .map(([k, c]) => `• ${k.split(':')[1]}: ${c} avvisi`)
      .join('\n') || 'Nessun avviso';
    await bot.sendMessage(chatId, `📊 *Stato Moderatore*\n\n${entries}`, { parse_mode: 'Markdown' });
  } else if (cmd === 'reset' && parts[2]) {
    warningCount[userKey(chatId, parts[2])] = 0;
    await bot.sendMessage(chatId, `✅ Avvisi azzerati per ${parts[2]}`);
  } else if (cmd === 'rules') {
    const rules = config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    await bot.sendMessage(chatId, `📋 *Regole*\n\n${rules}`, { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId,
      `🤖 *Comandi Admin*\n\n/mod status\n/mod reset [userId]\n/mod rules`,
      { parse_mode: 'Markdown' }
    );
  }
}

console.log('🤖 Moderatore Telegram attivo con Gemini!');
