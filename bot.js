require('dotenv').config();
const http = require('http');
http.createServer((req, res) => res.end('Bot attivo!')).listen(process.env.PORT || 3000);
const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config/rules.json');
function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const warningCount = {};
const LOG_PATH = path.join(__dirname, 'config/violations.log');

function logViolation(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFileSync(LOG_PATH, line);
}

function userKey(chatId, userId) {
  return `${chatId}:${userId}`;
}

// ─── Analisi moderazione ──────────────────────────────────────────────────────
async function analyzeMessage(text, config) {
  const rulesText = config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
  const bannedWords = config.bannedWords.length
    ? `Parole sempre vietate: ${config.bannedWords.join(', ')}` : '';
  const lang = config.language ? `Lingua permessa: ${config.language}` : '';

  const prompt = `Sei un moderatore AI per un gruppo Telegram che discute di politica, guerra, attualità, calcio e argomenti sulle donne.

REGOLE:
${rulesText}
${bannedWords}
${lang}

MESSAGGIO: "${text}"

Analizza il messaggio e rispondi SOLO con JSON valido, nessun testo extra:
{
  "violation": true o false,
  "severity": "low" o "medium" o "high",
  "rule_violated": "regola violata breve o null",
  "warning_message": "messaggio di avviso in tono informale e diretto, come lo direbbe un amico, in italiano, o null",
  "suggested_action": "warn" o "mute" o "kick" o "ban",
  "contains_misinformation": true o false,
  "misinformation_correction": "correzione breve e accurata in italiano o null",
  "is_question": true o false,
  "question_answer": "risposta breve alla domanda in italiano o null"
}`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role: 'user', content: prompt }],
  });

  let responseText = response.content[0].text.trim();
  responseText = responseText.replace(/```json|```/g, '').trim();
  return JSON.parse(responseText);
}

// ─── Risposta quando taggato ──────────────────────────────────────────────────
async function respondToMention(text, username) {
  const prompt = `Sei un membro del gruppo Telegram, non un bot. Parli in modo naturale, informale e diretto come farebbe un amico esperto di politica, guerra, attualità, calcio e argomenti generali.
Usa un tono casual, puoi usare espressioni colloquiali italiane, abbreviazioni e linguaggio da chat. Max 3 frasi. Niente elenchi puntati.
${username} ti ha scritto: "${text}"`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return response.content[0].text.trim();
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

// ─── Benvenuto nuovi membri ───────────────────────────────────────────────────
bot.on('new_chat_members', async (msg) => {
  const chatId = msg.chat.id;
  const config = loadConfig();
  for (const member of msg.new_chat_members) {
    if (member.is_bot) continue;
    const name = member.first_name;
    const rules = config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
    await bot.sendMessage(chatId,
      `👋 Benvenuto/a *${name}*!\n\nQueste sono le regole del gruppo:\n\n${rules}\n\nBuona discussione! 🎉`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── Main message handler ─────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  console.log('📨 Messaggio ricevuto:', msg.chat.type, msg.text);
  try {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text?.trim();

    if (!['group', 'supergroup'].includes(msg.chat.type)) return;
    if (!text || text.length < 2) return;
    if (!userId) return;

    const config = loadConfig();
    if (config.monitoredGroups.length > 0 && !config.monitoredGroups.includes(chatId)) return;

    // Comandi admin
    if (text.startsWith('/mod') && config.adminIds.includes(userId)) {
      await handleAdminCommand(msg, text, config);
      return;
    }

    // Comando /regole per tutti
    if (text === '/regole') {
      const rules = config.rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
      await bot.sendMessage(chatId, `📋 *Regole del gruppo*\n\n${rules}`, { parse_mode: 'Markdown' });
      return;
    }

    // Risponde quando viene taggato
    const botUsername = '@Nunziatella_bot';
    if (text.includes(botUsername)) {
      const cleanText = text.replace(botUsername, '').trim();
      const username = msg.from.username ? `@${msg.from.username}` : msg.from.first_name;
      const risposta = await respondToMention(cleanText || 'Ciao!', username);
      await bot.sendMessage(chatId, `💬 ${risposta}`, { parse_mode: 'Markdown' });
      return;
    }

    // Ignora admin per moderazione
    if (config.adminIds.includes(userId)) return;

    // Analisi AI
    const result = await analyzeMessage(text, config);

    // Correzione disinformazione
    if (result.contains_misinformation && result.misinformation_correction) {
      await bot.sendMessage(chatId,
        `ℹ️ *Attenzione* — questa informazione potrebbe non essere accurata:\n\n${result.misinformation_correction}`,
        { parse_mode: 'Markdown' }
      );
    }

    // Risposta a domande
    if (result.is_question && result.question_answer && !result.violation) {
      await bot.sendMessage(chatId,
        `🤖 ${result.question_answer}`,
        { parse_mode: 'Markdown' }
      );
    }

    // Moderazione violazioni
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

console.log('🤖 Moderatore Telegram attivo con Claude!');
