Javascript 
/**
 * CLOUDFLARE WORKER: TELEGRAM AI BOT (GEMINI NATIVE)
 * Zero-Cost Architecture | Auto-Summarization | State Management
 * 
 * PREREQUISITES:
 * 1. Cloudflare Account (Free)
 * 2. Telegram Bot Token (@BotFather)
 * 3. Google Gemini API Key (Google AI Studio)
 * 
 * ENVIRONMENT VARIABLES REQUIRED:
 * - TELEGRAM_BOT_TOKEN
 * - GEMINI_API_KEY
 * - ADMIN_CHAT_ID (Your personal Telegram User ID for error logs)
 * - DB (Cloudflare D1 Database Binding)
 */

const CONFIG = {
  MAX_FILE_SIZE: 5 * 1024 * 1024, // 5 MB
  MAX_FILES_PER_DAY: 2,
  MAX_HISTORY_TURNS: 10, // Start summarizing after 10 messages
  MAX_SUMMARY_COUNT: 5,  // Warn user after 5 summarizations
  IDLE_TIMEOUT_MS: 24 * 60 * 60 * 1000, // 24 Hours
  MAX_PERSONA_CHARS: 800
};

export default {
  async fetch(request, env, ctx) {
    // Only accept POST requests from Telegram Webhooks
    if (request.method !== 'POST') {
      return new Response('Telegram AI Bot Endpoint Active.', { status: 200 });
    }

    let adminChatId = env.ADMIN_CHAT_ID;
    
    try {
      const update = await request.json();
      
      // Auto-initialize D1 Database tables if they don't exist
      await initializeDatabase(env.DB);

      // Handle Telegram Callback Queries (Inline Buttons)
      if (update.callback_query) {
        await handleCallback(update.callback_query, env);
        return new Response('OK', { status: 200 });
      }

      // Handle standard Telegram Messages
      if (update.message) {
        await handleMessage(update.message, env, ctx);
      }

      return new Response('OK', { status: 200 });
      
    } catch (error) {
      console.error(error);
      if (adminChatId) {
        const errorMsg = `🚨 *Bot Error Alert*\n\n*Message:* ${error.message}\n*Stack:* \`${error.stack?.substring(0, 500)}\``;
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, adminChatId, errorMsg);
      }
      // Always return 200 to Telegram so it doesn't get stuck in a retry loop
      return new Response('OK', { status: 200 });
    }
  }
};

async function initializeDatabase(db) {
  const setupSql = `
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      personality TEXT DEFAULT '',
      files_today INTEGER DEFAULT 0,
      last_file_date TEXT DEFAULT '',
      summary_count INTEGER DEFAULT 0,
      last_active INTEGER DEFAULT 0,
      state TEXT DEFAULT 'chatting'
    );
    CREATE TABLE IF NOT EXISTS history (
      user_id INTEGER PRIMARY KEY,
      messages TEXT DEFAULT '[]'
    );
  `;
  // Cloudflare D1 batch execution
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, personality TEXT DEFAULT '', files_today INTEGER DEFAULT 0, last_file_date TEXT DEFAULT '', summary_count INTEGER DEFAULT 0, last_active INTEGER DEFAULT 0, state TEXT DEFAULT 'chatting')`),
    db.prepare(`CREATE TABLE IF NOT EXISTS history (user_id INTEGER PRIMARY KEY, messages TEXT DEFAULT '[]')`)
  ]);
}

async function handleMessage(msg, env, ctx) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';
  const botToken = env.TELEGRAM_BOT_TOKEN;
  
  // Get or Create User
  let user = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(chatId).first();
  if (!user) {
    await env.DB.prepare("INSERT INTO users (id, last_active) VALUES (?, ?)").bind(chatId, Date.now()).run();
    user = { id: chatId, personality: '', files_today: 0, last_file_date: '', summary_count: 0, last_active: Date.now(), state: 'chatting' };
  }

  // 1. Handle Static Commands
  if (text === '/start') {
    await sendMenu(botToken, chatId, "Welcome! I'm your AI assistant. Choose an option to configure your experience:");
    return;
  }
  
  if (text === '/deploy') {
    await sendDeployInstructions(botToken, chatId);
    return;
  }

  // 2. Handle State Machine (Setting Personality)
  if (user.state === 'waiting_persona') {
    if (!text) {
      await sendTelegramMessage(botToken, chatId, "Please send text to set your personality rules.");
      return;
    }
    const safePersona = text.substring(0, CONFIG.MAX_PERSONA_CHARS);
    await env.DB.prepare("UPDATE users SET personality = ?, state = 'chatting' WHERE id = ?").bind(safePersona, chatId).run();
    await sendTelegramMessage(botToken, chatId, `✅ *Personality saved!* (Length: ${safePersona.length}/${CONFIG.MAX_PERSONA_CHARS})\n\nI will remember this context forever. Use /start to see the menu.`);
    return;
  }

  // 3. Handle Inactivity Auto-Reset
  const now = Date.now();
  if (now - user.last_active > CONFIG.IDLE_TIMEOUT_MS) {
    await clearHistory(env.DB, chatId);
    await sendTelegramMessage(botToken, chatId, "🧹 *Chat reset:* Starting a fresh conversation since it's been over 24 hours!");
    user.summary_count = 0;
  }

  // Update Last Active
  await env.DB.prepare("UPDATE users SET last_active = ? WHERE id = ?").bind(now, chatId).run();

  // 4. File / Media Handling
  let fileData = null;
  let mimeType = null;

  if (msg.photo || msg.document || msg.voice) {
    const today = new Date().toISOString().split('T')[0];
    
    // Reset file limit if it's a new day
    if (user.last_file_date !== today) {
      user.files_today = 0;
      user.last_file_date = today;
    }

    if (user.files_today >= CONFIG.MAX_FILES_PER_DAY) {
      await sendTelegramMessage(botToken, chatId, "🚫 *Daily file limit reached!* You can send up to 2 files per day. Try again tomorrow.");
      return;
    }

    const fileMeta = getFileMetadata(msg);
    if (fileMeta.size > CONFIG.MAX_FILE_SIZE) {
      await sendTelegramMessage(botToken, chatId, `⚠️ *File too large!* Limit is 5MB. Your file is ${(fileMeta.size / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }

    // Send typing action to show it's working
    await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, action: 'upload_document' })
    });

    fileData = await downloadTelegramFileBase64(botToken, fileMeta.id);
    mimeType = fileMeta.mime || 'application/octet-stream';
    
    // Increment limit
    user.files_today++;
    await env.DB.prepare("UPDATE users SET files_today = ?, last_file_date = ? WHERE id = ?").bind(user.files_today, today, chatId).run();
  }

  // Ensure there's a prompt
  if (!text && !fileData) return;

  // 5. Context & History Management
  let historyRow = await env.DB.prepare("SELECT messages FROM history WHERE user_id = ?").bind(chatId).first();
  let history = historyRow ? JSON.parse(historyRow.messages) : [];

  // Check if we need to auto-summarize
  if (history.length > CONFIG.MAX_HISTORY_TURNS) {
    await sendTelegramMessage(botToken, chatId, "⏳ *Context limit reached. Summarizing previous history to save memory...*");
    const summary = await summarizeConversation(env.GEMINI_API_KEY, history);
    
    history = [{ role: 'model', parts: [{ text: `[SYSTEM SUMMARY OF PREVIOUS CHAT]: ${summary}` }] }];
    user.summary_count++;
    
    await env.DB.prepare("UPDATE users SET summary_count = ? WHERE id = ?").bind(user.summary_count, chatId).run();
  }

  // Construct User Part
  const userParts = [];
  if (text) userParts.push({ text: text });
  if (fileData) userParts.push({ inline_data: { mime_type: mimeType, data: fileData } });
  
  history.push({ role: 'user', parts: userParts });

  // 6. Call AI API
  await fetch(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' })
  });

  const aiReplyText = await callGeminiAPI(env.GEMINI_API_KEY, history, user.personality);
  
  // Format reply (Add warning if summarized too much)
  let finalReply = aiReplyText;
  if (user.summary_count > CONFIG.MAX_SUMMARY_COUNT) {
    finalReply += "\n\n⚠️ *System Note:* This chat has been summarized many times and may start losing specific details. Tap Menu -> Start New to reset context.";
  }

  // Append AI reply to history
  history.push({ role: 'model', parts: [{ text: aiReplyText }] });

  // 7. Save History & Send Reply
  await env.DB.prepare("INSERT OR REPLACE INTO history (user_id, messages) VALUES (?, ?)").bind(chatId, JSON.stringify(history)).run();
  await sendTelegramMessage(botToken, chatId, finalReply);
}

async function handleCallback(callbackQuery, env) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const botToken = env.TELEGRAM_BOT_TOKEN;

  // Acknowledge the callback query to remove Telegram's loading spinner
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQuery.id })
  });

  if (data === 'menu_new') {
    await clearHistory(env.DB, chatId);
    await env.DB.prepare("UPDATE users SET state = 'chatting', summary_count = 0 WHERE id = ?").bind(chatId).run();
    await sendTelegramMessage(botToken, chatId, "✨ *New conversation started!* Previous context wiped. What would you like to talk about?");
  } 
  else if (data === 'menu_reset') {
    await clearHistory(env.DB, chatId);
    await env.DB.prepare("UPDATE users SET personality = '', state = 'chatting', summary_count = 0 WHERE id = ?").bind(chatId).run();
    await sendTelegramMessage(botToken, chatId, "🧨 *Full Reset Complete.* Conversation and Personality settings have been deleted.");
  }
  else if (data === 'menu_persona') {
    await env.DB.prepare("UPDATE users SET state = 'waiting_persona' WHERE id = ?").bind(chatId).run();
    await sendTelegramMessage(botToken, chatId, "📝 *Set Personality*\n\nReply to this message with how I should act. (e.g. 'Act as an expert Python mentor').\n\n*Max: 800 characters.*");
  }
  else if (data === 'menu_continue') {
    await sendTelegramMessage(botToken, chatId, "Continuing previous conversation! Just send me a message.");
  }
}

async function callGeminiAPI(apiKey, history, personality) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: history,
    systemInstruction: {
      parts: [{ text: personality || "You are a helpful, concise AI assistant communicating on Telegram." }]
    },
    generationConfig: { maxOutputTokens: 2000 }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error: ${response.status} - ${errText}`);
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I generated an empty response.";
}

async function summarizeConversation(apiKey, history) {
  // Strip out images/documents to save tokens during summarization
  const textOnlyHistory = history.map(turn => {
    return `${turn.role.toUpperCase()}: ${turn.parts.filter(p => p.text).map(p => p.text).join(' ')}`;
  }).join('\n\n');

  const prompt = `Please provide a concise, factual summary of the following conversation. Highlight key topics, facts discussed, and user preferences. \n\n${textOnlyHistory}`;
  
  const summaryResult = await callGeminiAPI(apiKey, [{ role: 'user', parts: [{ text: prompt }] }], "You are a backend system summarizer.");
  return summaryResult;
}

async function clearHistory(db, chatId) {
  await db.prepare("UPDATE history SET messages = '[]' WHERE user_id = ?").bind(chatId).run();
}

async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown'
    })
  });
}

async function sendMenu(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const keyboard = {
    inline_keyboard: [
      [{ text: "✨ Start New Chat", callback_data: "menu_new" }, { text: "▶️ Continue", callback_data: "menu_continue" }],
      [{ text: "🧠 Set Personality", callback_data: "menu_persona" }],
      [{ text: "🧨 Hard Reset (Wipe All)", callback_data: "menu_reset" }]
    ]
  };

  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: text, reply_markup: keyboard, parse_mode: 'Markdown' })
  });
}

function getFileMetadata(msg) {
  if (msg.document) return { id: msg.document.file_id, size: msg.document.file_size, mime: msg.document.mime_type };
  if (msg.voice) return { id: msg.voice.file_id, size: msg.voice.file_size, mime: msg.voice.mime_type };
  if (msg.photo) {
    const largestPhoto = msg.photo[msg.photo.length - 1]; // Last item is the largest resolution
    return { id: largestPhoto.file_id, size: largestPhoto.file_size, mime: 'image/jpeg' };
  }
  return { id: null, size: 0, mime: null };
}

async function downloadTelegramFileBase64(botToken, fileId) {
  // 1. Get File Path
  const fileInfoRes = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
  const fileInfo = await fileInfoRes.json();
  if (!fileInfo.ok) throw new Error("Could not retrieve file info from Telegram.");
  
  const filePath = fileInfo.result.file_path;
  
  // 2. Download Binary File
  const fileDownloadUrl = `https://api.telegram.org/file/bot${botToken}/${filePath}`;
  const fileRes = await fetch(fileDownloadUrl);
  const arrayBuffer = await fileRes.arrayBuffer();
  
  // 3. Convert to Base64 for Gemini
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sendDeployInstructions(botToken, chatId) {
  const instructions = `
🚀 *How to clone and deploy this bot:*

*Step 1: Get API Keys*
• Get a Telegram Token from @BotFather.
• Get a Free Gemini Key from Google AI Studio.

*Step 2: Setup Cloudflare*
• Install Wrangler: \`npm i -g wrangler\`
• Create D1 Database: \`wrangler d1 create telegram_ai_bot_db\`
• Create a new folder, add this code to \`worker.js\`.
• Setup \`wrangler.toml\` pointing to your worker and D1 DB binding.

*Step 3: Deploy*
• Add secrets: 
  \`wrangler secret put TELEGRAM_BOT_TOKEN\`
  \`wrangler secret put GEMINI_API_KEY\`
  \`wrangler secret put ADMIN_CHAT_ID\`
• Deploy: \`wrangler deploy\`

*Step 4: Set Webhook*
Open this URL in your browser, replacing \`<BOT_TOKEN>\` and \`<WORKER_URL>\`:
\`https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<WORKER_URL>\`
  `;
  await sendTelegramMessage(botToken, chatId, instructions);
}
