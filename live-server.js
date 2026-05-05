const fs = require("fs");
const http = require("http");
const net = require("net");
const path = require("path");

const root = __dirname;
loadDotEnv(path.join(root, ".env"));
const preferredPort = Number(process.env.PORT || 5173);
const host = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const clients = new Set();
const openRouterModel = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const elevenLabsVoiceName = process.env.ELEVENLABS_VOICE_NAME || "Jonathan Livingston";
let cachedElevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID || "";
const rooms = new Map();
const dataDir = path.join(root, "data");
const campaignsPath = path.join(dataDir, "campaigns.json");
const campaigns = new Map();

function loadDotEnv(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      value = value.replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    console.warn("Could not load .env file", error);
  }
}

function loadCampaigns() {
  try {
    if (!fs.existsSync(campaignsPath)) return;
    const parsed = JSON.parse(fs.readFileSync(campaignsPath, "utf8"));
    Object.entries(parsed).forEach(([code, state]) => campaigns.set(code, state));
  } catch (error) {
    console.warn("Could not load campaigns", error);
  }
}

function saveCampaigns() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(campaignsPath, JSON.stringify(Object.fromEntries(campaigns), null, 2));
}

function createSaveCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return campaigns.has(code) ? createSaveCode() : code;
}

loadCampaigns();

const liveReloadScript = `
<script>
  const events = new EventSource("/__live-reload");
  events.addEventListener("reload", () => location.reload());
</script>`;

function sendFile(response, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();

    if (path.basename(filePath) === "index.html") {
      content = content.toString("utf8");
      if (!isProduction) {
        content = content.replace("</body>", `${liveReloadScript}</body>`);
      }
      response.setHeader("Content-Type", "text/html; charset=utf-8");
    } else if (extension === ".gif") {
      response.setHeader("Content-Type", "image/gif");
    } else if (extension === ".png") {
      response.setHeader("Content-Type", "image/png");
    } else if (extension === ".jpg" || extension === ".jpeg") {
      response.setHeader("Content-Type", "image/jpeg");
    } else if (extension === ".css") {
      response.setHeader("Content-Type", "text/css; charset=utf-8");
    } else if (extension === ".js") {
      response.setHeader("Content-Type", "text/javascript; charset=utf-8");
    }

    response.end(content);
  });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) {
        request.destroy();
        reject(new Error("Request too large"));
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

function parseMaybeJson(value) {
  let parsed = value;
  for (let index = 0; index < 4; index += 1) {
    if (typeof parsed !== "string") break;
    const trimmed = parsed.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("[") && !trimmed.startsWith("\""))) break;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      break;
    }
  }
  return parsed;
}

function humanizeKey(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatPowerBreakdown(value, indent = 0) {
  const parsed = parseMaybeJson(value);
  const pad = "  ".repeat(indent);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.prototype.hasOwnProperty.call(parsed, "powerBreakdown")) {
    return formatPowerBreakdown(parsed.powerBreakdown, indent);
  }

  if (Array.isArray(parsed)) {
    return parsed.map((item) => {
      const cleaned = parseMaybeJson(item);
      if (cleaned && typeof cleaned === "object") {
        return `${pad}-\n${formatPowerBreakdown(cleaned, indent + 1)}`;
      }
      return `${pad}- ${cleaned ?? "Unknown"}`;
    }).join("\n");
  }

  if (parsed && typeof parsed === "object") {
    return Object.entries(parsed).map(([key, item]) => {
      const cleaned = parseMaybeJson(item);
      if (cleaned && typeof cleaned === "object") {
        return `${pad}${humanizeKey(key)}:\n${formatPowerBreakdown(cleaned, indent + 1)}`;
      }
      return `${pad}${humanizeKey(key)}: ${cleaned === "" || cleaned == null ? "Unknown" : cleaned}`;
    }).join("\n");
  }

  return String(parsed === "" || parsed == null ? "" : parsed);
}

async function resolveElevenLabsVoiceId(apiKey) {
  if (cachedElevenLabsVoiceId) return cachedElevenLabsVoiceId;

  const voicesResponse = await fetch("https://api.elevenlabs.io/v1/voices", {
    headers: { "xi-api-key": apiKey },
  });

  if (!voicesResponse.ok) {
    throw new Error(`Could not load ElevenLabs voices: ${await voicesResponse.text()}`);
  }

  const data = await voicesResponse.json();
  const voice = data.voices?.find((item) =>
    String(item.name || "").toLowerCase().includes(elevenLabsVoiceName.toLowerCase())
  );

  if (!voice?.voice_id) {
    throw new Error(`Could not find ElevenLabs voice matching "${elevenLabsVoiceName}".`);
  }

  cachedElevenLabsVoiceId = voice.voice_id;
  return cachedElevenLabsVoiceId;
}

async function narrate(request, response) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    sendJson(response, 501, { error: "ELEVENLABS_API_KEY is not set." });
    return;
  }

  const body = await readJson(request);
  const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 1800);
  if (!text) {
    sendJson(response, 400, { error: "No text provided." });
    return;
  }

  const voiceId = await resolveElevenLabsVoiceId(apiKey);
  const ttsResponse = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify({
      text,
      model_id: process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2",
      voice_settings: {
        stability: Number(process.env.ELEVENLABS_STABILITY || 0.52),
        similarity_boost: Number(process.env.ELEVENLABS_SIMILARITY || 0.78),
        style: Number(process.env.ELEVENLABS_STYLE || 0),
        use_speaker_boost: true,
      },
    }),
  });

  if (!ttsResponse.ok) {
    sendJson(response, 502, { error: `ElevenLabs failed: ${await ttsResponse.text()}` });
    return;
  }

  const audio = Buffer.from(await ttsResponse.arrayBuffer());
  response.writeHead(200, {
    "Content-Type": "audio/mpeg",
    "Cache-Control": "no-store",
  });
  response.end(audio);
}

async function characterGuide(request, response) {
  const body = await readJson(request);
  const characterIdea = String(body.characterIdea || "").trim();
  const characterClass = String(body.characterClass || "").trim() || "Wanderer";
  const sheet = body.sheet || {};
  const currentMessage = String(body.message || characterIdea || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-12) : [];

  const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!openRouterKey) {
    sendJson(response, 200, {
      message:
        "AI guide is ready, but OPENROUTER_API_KEY is not set on the local server yet.\n\n" +
        `Current power/class: ${characterClass}\n\n` +
        "Once the key is set, I can ask simple questions like:\n" +
        "1. Do you want to keep this class name?\n" +
        "2. What kind of power should it become in this world?\n" +
        "3. Should the concept be heroic, dark, funny, or mysterious?",
    });
    return;
  }

  const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
      "HTTP-Referer": "http://localhost:5173",
      "X-OpenRouter-Title": "Fog Click Character Creator",
    },
    body: JSON.stringify({
      model: openRouterModel,
      max_tokens: 180,
      temperature: 0.8,
      messages: [
        {
          role: "system",
          content:
            "You are a concise fantasy RPG character creation guide. Help adapt the user's idea into an original D&D-style character sheet and power/class concept. If the user references an existing franchise or character, do not copy copyrighted names, exact lore, or exact powers; make an original inspired alternative. Continue the conversation using the provided history. Ask 1-3 simple next-step questions. Keep it under 120 words.",
        },
        {
          role: "user",
          content:
            `Character idea anchor: ${characterIdea || "No idea provided"}\n` +
            `Current power/class field: ${characterClass}\n` +
            `Full character sheet JSON:\n${JSON.stringify(sheet, null, 2)}\n` +
            "Use this as persistent character context unless the player asks to change it.",
        },
        ...history
          .filter((item) => item && (item.role === "user" || item.role === "assistant"))
          .map((item) => ({
            role: item.role,
            content: String(item.content || "").slice(0, 1200),
          })),
        {
          role: "user",
          content: currentMessage || "Continue helping me build this character.",
        },
      ],
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    sendJson(response, 500, { message: `The guide failed to answer.\n${errorText.slice(0, 300)}` });
    return;
  }

  const data = await aiResponse.json();
  const message = data.choices?.[0]?.message?.content;
  sendJson(response, 200, { message: message || "The guide is thinking, but returned no text." });
}

async function gameMaster(request, response) {
  const body = await readJson(request);
  const sheet = body.sheet || {};
  const action = String(body.action || "").trim();
  const history = Array.isArray(body.history) ? body.history.slice(-16) : [];
  const currentPowerBreakdown = String(body.currentPowerBreakdown || "").trim();
  const trackerInstructions = String(body.trackerInstructions || sheet.breakdownLiveInstructions || sheet.breakdownTracks || "").trim();
  const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!openRouterKey) {
    sendJson(response, 200, {
      message:
        "The game master is ready, but OPENROUTER_API_KEY is not set on the local server yet. Once it is set, I can judge actions against your sheet.",
    });
    return;
  }

  const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
      "HTTP-Referer": "http://localhost:5173",
      "X-OpenRouter-Title": "Fog Click Character Creator",
    },
    body: JSON.stringify({
      model: openRouterModel,
      max_tokens: 420,
      temperature: 0.75,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are a gritty solo campaign game master. Use the character sheet, story recap, campaign settings, abilities, passive senses, gear, requested power-breakdown tracking fields, and stat scaling as hard context for what the player can do. Treat any recap field as prior canon and continue from it instead of restarting the story. The stats are verse-scaling comparisons, not D&D numbers. If an action exceeds the written scaling, abilities, passive senses, or gear, narrate an attempted failure clearly. Do not grant new powers or rewrite the sheet unless earned. Follow the selected tone, difficulty, and canon rules. Keep continuity from history. Style: tense, cinematic, sensory, direct, dangerous; avoid cheerful tutorial phrasing. Return only valid JSON with this shape: {\"message\":\"1-2 gritty paragraphs plus a short 'What do you do?' line\",\"scan\":\"optional console sense/scan text or empty string\",\"powerBreakdown\":\"plain tracker lines only\",\"memory\":\"updated canon/memory notes or empty string\",\"choices\":[\"2-4 short action choices\"],\"threat\":true_or_false}. Always return powerBreakdown. The powerBreakdown value must be plain readable lines only, never nested JSON, never braces, never escaped quotes, and never markdown. It must list the exact things the player asked to track as compact lines, such as 'Time of Day: ...', 'JJK Grade Comparison: ...', 'Power Growth: ...', 'Suit Charge: ...', 'Cursed Energy Output: ...'. If a tracked value is unknown, write 'Unknown' instead of ignoring it. Update those lines based on the current scene/action and previous breakdown. If the player scans, senses, tracks, detects, asks a suit AI, uses cursed energy sensing, mana sensing, radar, smell, danger sense, or any similar ability, put the results in scan. The scan must be based on the character's passive senses, gear, power, and scaling. Set threat true when danger, hostile energy, pursuit, injury, or alarm is present. Keep memory as concise canon: current objective, injuries, allies, enemies, learned facts, and power limits.",
        },
        {
          role: "user",
          content:
            `Current character sheet JSON:\n${JSON.stringify(sheet, null, 2)}\n\n` +
            `Power Breakdown tracker instructions:\n${trackerInstructions || "Use sheet.breakdownTracks if present; otherwise track power state, growth, and limits."}\n\n` +
            `Current Power Breakdown box:\n${currentPowerBreakdown || "None yet"}`,
        },
        ...history
          .filter((item) => item && (item.role === "user" || item.role === "assistant"))
          .map((item) => ({
            role: item.role,
            content: String(item.content || "").slice(0, 1400),
          })),
        {
          role: "user",
          content: action || "Begin the scene.",
        },
      ],
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    sendJson(response, 500, { message: `The game master failed.\n${errorText.slice(0, 300)}` });
    return;
  }

  const data = await aiResponse.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  try {
    const parsed = JSON.parse(content);
    sendJson(response, 200, {
      message: parsed.message || "The world waits in silence.",
      scan: parsed.scan || "",
      powerBreakdown: formatPowerBreakdown(parsed.powerBreakdown || ""),
      memory: parsed.memory || "",
      choices: Array.isArray(parsed.choices) ? parsed.choices : [],
      threat: Boolean(parsed.threat),
    });
  } catch (error) {
    sendJson(response, 200, { message: content || "The world waits in silence.", scan: "", powerBreakdown: "", memory: "", choices: [], threat: false });
  }
}

function roomSnapshot(room) {
  return {
    roomCode: room.code,
    players: [...room.players.keys()],
    requiredPlayers: room.requiredPlayers,
    pendingCount: room.pending.size,
    messages: room.messages,
  };
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 5; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return rooms.has(code) ? createRoomCode() : code;
}

async function runRoomTurn(room) {
  const actions = [...room.pending.entries()].map(([player, action]) => `${player}: ${action}`).join("\n");
  room.pending.clear();

  const body = {
    sheet: {
      party: [...room.players.entries()].map(([name, player]) => ({ name, sheet: player.sheet })),
    },
    action:
      `Both players have acted this turn:\n${actions}\n\n` +
      "Update the shared Power Breakdown tracker using each player's requested tracking fields.",
    history: room.messages.map((message) => ({
      role: message.speaker === "Narrator" ? "assistant" : "user",
      content: `${message.speaker}: ${message.text}`,
    })),
  };

  const fakeRequest = {
    on(event, callback) {
      if (event === "data") callback(Buffer.from(JSON.stringify(body)));
      if (event === "end") callback();
      return this;
    },
  };

  let responsePayload = null;
  const fakeResponse = {
    writeHead() {},
    end(payload) {
      responsePayload = JSON.parse(payload);
    },
  };

  await gameMaster(fakeRequest, fakeResponse);
  room.messages.push({
    speaker: "Narrator",
    text: responsePayload?.message || "The world waits.",
    scan: responsePayload?.scan || "",
    powerBreakdown: responsePayload?.powerBreakdown || "",
    memory: responsePayload?.memory || "",
    choices: responsePayload?.choices || [],
    threat: Boolean(responsePayload?.threat),
  });
}

async function scaleStats(request, response) {
  const body = await readJson(request);
  const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!openRouterKey) {
    sendJson(response, 200, {
      message: "The stat scaler is ready, but OPENROUTER_API_KEY is not set on the local server yet.",
    });
    return;
  }

  const prompt =
    `Player name: ${String(body.playerName || "Player")}\n` +
    `Power/class: ${String(body.power || "Unwritten")}\n` +
    `Universe/verse: ${String(body.universe || "Original fantasy")}\n` +
    `Fate: ${String(body.fate || "Unwritten")}\n` +
    `Appearance: ${String(body.appearance || "Unwritten")}\n` +
    `Abilities: ${String(body.abilities || "Unwritten")}\n` +
    `Passive senses: ${String(body.senses || "Unwritten")}\n` +
    `Gear: ${String(body.gear || "Unwritten")}\n` +
    `Power breakdown should track: ${String(body.breakdownTracks || "Power growth, current state, and story-relevant power metrics")}\n` +
    `Campaign settings: ${JSON.stringify(body.campaign || {})}\n` +
    `Story recap / prior canon: ${String(body.storyRecap || body.recap || "No prior story recap")}\n` +
    `Character idea: ${String(body.characterIdea || "No extra idea")}\n\n` +
    "Act as a strict power-scaling judge, not a story writer. Read the recap and sheet for actual feats, stated abilities, gear, injuries, limits, and outcomes. " +
    "Scale the character's current stats to the chosen universe from evidence only. If the recap proves the character can fight a top-tier character, say that; if it does not prove it, say the closest supported tier and what evidence is missing. " +
    "Do not invent random feats, random upgrades, random enemies defeated, or random comparisons. Do not generate story prompts. " +
    "Use concise comparison language like 'below Gojo but above most Grade 1 sorcerers because...', 'can physically contend with Maki-level fighters if the suit is active...', or 'unknown: no speed feat in recap.' " +
    "For each stat, include the evidence basis in the same sentence. Comparisons to known characters/tier names are allowed, but keep them short.";

  const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
      "HTTP-Referer": "http://localhost:5173",
      "X-OpenRouter-Title": "Fog Click Character Creator",
    },
    body: JSON.stringify({
      model: openRouterModel,
      max_tokens: 520,
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Return only valid JSON with this exact shape: {\"stats\":{\"strength\":\"...\",\"dexterity\":\"...\",\"constitution\":\"...\",\"intelligence\":\"...\",\"wisdom\":\"...\",\"charisma\":\"...\"}}. Each value must be one evidence-based power-scaling sentence, not a story prompt and not a D&D dice score. If evidence is weak or missing, say 'unknown' or 'not proven' for that stat instead of inventing scaling. Be conservative and consistent with the recap.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    sendJson(response, 500, { message: `The stat scaler failed.\n${errorText.slice(0, 300)}` });
    return;
  }

  const data = await aiResponse.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  try {
    sendJson(response, 200, JSON.parse(content));
  } catch (error) {
    sendJson(response, 200, { message: content });
  }
}

async function powerBreakdown(request, response) {
  const body = await readJson(request);
  const openRouterKey = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY;

  if (!openRouterKey) {
    sendJson(response, 200, { powerBreakdown: "Power Breakdown AI is ready, but OPENROUTER_API_KEY is not set." });
    return;
  }

  const sheet = body.sheet || {};
  const current = String(body.currentPowerBreakdown || "").trim();
  const scene = String(body.scene || "Campaign start").trim();
  const trackerInstructions = String(body.trackerInstructions || sheet.breakdownLiveInstructions || "").trim();

  const aiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${openRouterKey}`,
      "HTTP-Referer": "http://localhost:5173",
      "X-OpenRouter-Title": "Fog Click Character Creator",
    },
    body: JSON.stringify({
      model: openRouterModel,
      max_tokens: 600,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You maintain the Power Breakdown console for a solo campaign. Return only valid JSON: {\"powerBreakdown\":\"...\"}. The powerBreakdown value must be plain readable tracker lines only, never nested JSON, never braces, never escaped quotes, and never markdown. This is a tracker box, not narration. Use the player's requested tracking fields as explicit compact lines, for example 'Time of Day: ...', 'JJK Grade Comparison: ...', 'Power Growth: ...'. Update it from the sheet, recap, current scene, prior breakdown, and live tracker instructions. Track concrete state, not story prose: time of day, power growth, verse grade/tier comparison, suit charge, energy level, current form, injuries, cooldowns, unlocked abilities, gear state, or whatever the player requested. If information is unknown, write Unknown instead of ignoring or inventing it.",
        },
        {
          role: "user",
          content:
            `Character sheet JSON:\n${JSON.stringify(sheet, null, 2)}\n\n` +
            `Live tracker instructions, not story action:\n${trackerInstructions || "None"}\n\n` +
            `Current scene/action:\n${scene}\n\n` +
            `Current power breakdown:\n${current || "None yet"}`,
        },
      ],
    }),
  });

  if (!aiResponse.ok) {
    const errorText = await aiResponse.text();
    sendJson(response, 500, { message: `The power breakdown failed.\n${errorText.slice(0, 300)}` });
    return;
  }

  const data = await aiResponse.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  try {
    const parsed = JSON.parse(content);
    sendJson(response, 200, { powerBreakdown: formatPowerBreakdown(parsed.powerBreakdown || content) });
  } catch (error) {
    sendJson(response, 200, { powerBreakdown: formatPowerBreakdown(content) });
  }
}

const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);

  if (!isProduction && request.url === "/__live-reload") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.write("\n");
    clients.add(response);
    request.on("close", () => clients.delete(response));
    return;
  }

  if (requestUrl.pathname === "/api/character-guide") {
    if (request.method !== "POST") {
      sendJson(response, 405, { message: "Method not allowed" });
      return;
    }

    characterGuide(request, response).catch((error) => {
      sendJson(response, 500, { message: `The guide crashed: ${error.message}` });
    });
    return;
  }

  if (requestUrl.pathname === "/api/game-master") {
    if (request.method !== "POST") {
      sendJson(response, 405, { message: "Method not allowed" });
      return;
    }

    gameMaster(request, response).catch((error) => {
      sendJson(response, 500, { message: `The game master crashed: ${error.message}` });
    });
    return;
  }

  if (requestUrl.pathname === "/api/scale-stats") {
    if (request.method !== "POST") {
      sendJson(response, 405, { message: "Method not allowed" });
      return;
    }

    scaleStats(request, response).catch((error) => {
      sendJson(response, 500, { message: `The stat scaler crashed: ${error.message}` });
    });
    return;
  }

  if (requestUrl.pathname === "/api/narrate") {
    if (request.method !== "POST") {
      sendJson(response, 405, { message: "Method not allowed" });
      return;
    }

    narrate(request, response).catch((error) => {
      sendJson(response, 500, { error: error.message });
    });
    return;
  }

  if (requestUrl.pathname === "/api/power-breakdown") {
    if (request.method !== "POST") {
      sendJson(response, 405, { message: "Method not allowed" });
      return;
    }

    powerBreakdown(request, response).catch((error) => {
      sendJson(response, 500, { message: `The power breakdown crashed: ${error.message}` });
    });
    return;
  }

  if (requestUrl.pathname === "/api/rooms" && request.method === "POST") {
    readJson(request)
      .then((body) => {
        const code = createRoomCode();
        const playerName = String(body.playerName || "Player 1").trim();
        const room = {
          code,
          requiredPlayers: 2,
          players: new Map([[playerName, { sheet: body.sheet || {} }]]),
          pending: new Map(),
          messages: [{ speaker: "System", text: `Room ${code} created. Waiting for another player.` }],
        };
        rooms.set(code, room);
        sendJson(response, 200, roomSnapshot(room));
      })
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return;
  }

  if (requestUrl.pathname === "/api/campaigns" && request.method === "POST") {
    readJson(request)
      .then((state) => {
        const code = createSaveCode();
        campaigns.set(code, { ...state, savedAt: new Date().toISOString() });
        saveCampaigns();
        sendJson(response, 200, { code });
      })
      .catch((error) => sendJson(response, 500, { error: error.message }));
    return;
  }

  const campaignMatch = requestUrl.pathname.match(/^\/api\/campaigns\/([A-Z0-9]+)$/);
  if (campaignMatch && request.method === "GET") {
    const code = campaignMatch[1].toUpperCase();
    const state = campaigns.get(code);
    if (!state) {
      sendJson(response, 404, { error: `Campaign ${code} was not found.` });
      return;
    }
    sendJson(response, 200, { code, state });
    return;
  }

  const roomMatch = requestUrl.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)(?:\/(join|action))?$/);
  if (roomMatch) {
    const code = roomMatch[1].toUpperCase();
    const operation = roomMatch[2] || "status";
    const room = rooms.get(code);

    if (!room) {
      sendJson(response, 404, { error: `Room ${code} was not found.` });
      return;
    }

    if (operation === "status" && request.method === "GET") {
      sendJson(response, 200, roomSnapshot(room));
      return;
    }

    if (operation === "join" && request.method === "POST") {
      readJson(request)
        .then((body) => {
          const playerName = String(body.playerName || `Player ${room.players.size + 1}`).trim();
          room.players.set(playerName, { sheet: body.sheet || {} });
          room.messages.push({ speaker: "System", text: `${playerName} joined the campaign.` });
          sendJson(response, 200, { ...roomSnapshot(room), message: `Joined room ${code}.` });
        })
        .catch((error) => sendJson(response, 500, { error: error.message }));
      return;
    }

    if (operation === "action" && request.method === "POST") {
      readJson(request)
        .then(async (body) => {
          const playerName = String(body.playerName || "Player").trim();
          const action = String(body.action || "").trim();
          room.players.set(playerName, { sheet: body.sheet || {} });
          room.pending.set(playerName, action);
          room.messages.push({ speaker: playerName, text: action });

          if (room.pending.size >= Math.min(room.requiredPlayers, room.players.size)) {
            await runRoomTurn(room);
          }

          sendJson(response, 200, {
            ...roomSnapshot(room),
            message:
              room.pending.size > 0
                ? `Waiting for ${Math.min(room.requiredPlayers, room.players.size) - room.pending.size} more player action.`
                : "Turn resolved.",
          });
        })
        .catch((error) => sendJson(response, 500, { error: error.message }));
      return;
    }

    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const requestPath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.join(root, decodeURIComponent(requestPath));
  const relativePath = path.relative(root, filePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  sendFile(response, filePath);
});

if (!isProduction) {
  fs.watch(root, { recursive: true }, (eventType, filename) => {
    if (!filename || !/\.(html|css|js|gif|png|jpe?g)$/i.test(filename)) return;
    for (const client of clients) {
      client.write("event: reload\ndata: now\n\n");
    }
  });
}

function isPortOpen(portToTry) {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(portToTry, host);
  });
}

async function findPort(startPort) {
  if (process.env.PORT) return startPort;
  for (let portToTry = startPort; portToTry <= 5190; portToTry += 1) {
    if (await isPortOpen(portToTry)) return portToTry;
    console.log(`Port ${portToTry} is in use. Trying ${portToTry + 1}...`);
  }
  throw new Error("No open port found between 5173 and 5190.");
}

findPort(preferredPort).then((portToUse) => {
  server.listen(portToUse, host, () => {
    const localHost = host === "0.0.0.0" ? "localhost" : host;
    console.log(`Live server running at http://${localHost}:${portToUse}`);
  });
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
