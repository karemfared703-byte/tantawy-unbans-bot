require("dotenv").config();

const {
  Client,
  ChannelType,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const { chromium } = require("playwright");
const sharp = require("sharp");
const fs = require("fs");
const http = require("http");
const path = require("path");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: ["CHANNEL"],
});

const CHECK_EVERY_SECONDS = Number(process.env.CHECK_EVERY_SECONDS || 300);
const CONCURRENT_CHECKS = Number(process.env.CONCURRENT_CHECKS || 1);
const ACTIVE_CONFIRMATIONS = Number(process.env.ACTIVE_CONFIRMATIONS || 3);
const BROWSER_RESTART_MINUTES = Number(process.env.BROWSER_RESTART_MINUTES || 30);
const DASHBOARD_ENABLED = process.env.DASHBOARD_ENABLED !== "false";
const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || process.env.PORT || 3000);
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";
const STARTED_AT = Date.now();

function resolveDataDir() {
  if (process.env.DATA_DIR) return path.resolve(process.env.DATA_DIR);
  if (fs.existsSync("/data")) return "/data";
  return __dirname;
}

const DATA_DIR = resolveDataDir();
const MONITORS_FILE = process.env.MONITORS_FILE || path.join(DATA_DIR, "monitors.json");
const GUILD_CONFIGS_FILE = process.env.GUILD_CONFIGS_FILE || path.join(DATA_DIR, "guild-configs.json");
const RECENT_UNBANS_FILE = process.env.RECENT_UNBANS_FILE || path.join(DATA_DIR, "recent-unbans.json");

const monitors = {};
const guildConfigs = {};
let recentUnbans = [];
let operationLogs = [];
const queue = [];

let activeJobs = 0;
let sharedBrowser = null;
let restartingBrowser = false;

if (!fs.existsSync("screenshots")) fs.mkdirSync("screenshots");

function getTime() {
  return new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h} hours, ${m} minutes, ${sec} seconds`;
}

function safeDelete(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

function cleanupOldScreenshots() {
  try {
    const folder = "screenshots";
    if (!fs.existsSync(folder)) return;

    const now = Date.now();
    const maxAge = 1000 * 60 * 10;

    for (const file of fs.readdirSync(folder)) {
      const filePath = path.join(folder, file);
      const stat = fs.statSync(filePath);

      if (now - stat.mtimeMs > maxAge) safeDelete(filePath);
    }
  } catch (error) {
    console.log("Cleanup error:", error.message);
  }
}

function normalizeMonitorRecord(key, item) {
  if (!item || typeof item !== "object") return null;

  const username = String(item.username || "").trim();
  const guildId = String(item.guildId || "dm").trim();
  const userId = String(item.userId || "").trim();
  const channelId = String(item.channelId || "").trim();

  if (!username || !guildId || !userId || !channelId) return null;

  return {
    username,
    guildId,
    userId,
    channelId,
    lastStatus: item.lastStatus || "unknown",
    startedAt: Number(item.startedAt || Date.now()),
    bannedStartedAt: item.bannedStartedAt ? Number(item.bannedStartedAt) : null,
    activeHits: Number(item.activeHits || 0),
  };
}

function loadMonitors() {
  try {
    if (!fs.existsSync(MONITORS_FILE)) {
      console.log(`No monitor store found at ${MONITORS_FILE}`);
      return;
    }

    const saved = JSON.parse(fs.readFileSync(MONITORS_FILE, "utf8"));
    let count = 0;

    for (const [key, item] of Object.entries(saved)) {
      const normalized = normalizeMonitorRecord(key, item);
      if (!normalized) continue;

      monitors[key] = normalized;
      count++;
    }

    console.log(`Loaded ${count} monitor(s) from ${MONITORS_FILE}`);
  } catch (error) {
    console.log("Load monitors error:", error.message);
  }
}

function saveMonitors() {
  try {
    const folder = path.dirname(MONITORS_FILE);
    fs.mkdirSync(folder, { recursive: true });

    const tmpPath = `${MONITORS_FILE}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(monitors, null, 2));
    fs.renameSync(tmpPath, MONITORS_FILE);
  } catch (error) {
    console.log("Save monitors error:", error.message);
  }
}

function writeJsonAtomic(filePath, value) {
  const folder = path.dirname(filePath);
  fs.mkdirSync(folder, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2));
  fs.renameSync(tmpPath, filePath);
}

function getGuildConfig(guildId) {
  if (!guildConfigs[guildId]) {
    guildConfigs[guildId] = {
      guildId,
      botName: "",
      embedColor: "#5865F2",
      logoUrl: "",
      welcomeMessage: "",
      roomPrefix: "unban",
      commandChannelId: null,
      privateCategoryId: null,
      logsChannelId: null,
      allowedRoleId: null,
      adminRoleId: null,
      licenseExpiresAt: null,
      cleanupHours: 24,
      paused: false,
      rooms: {},
      roomActivity: {},
      roomCloseAt: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  if (!guildConfigs[guildId].rooms) guildConfigs[guildId].rooms = {};
  if (!guildConfigs[guildId].roomActivity) guildConfigs[guildId].roomActivity = {};
  if (!guildConfigs[guildId].roomCloseAt) guildConfigs[guildId].roomCloseAt = {};
  return guildConfigs[guildId];
}

function loadGuildConfigs() {
  try {
    if (!fs.existsSync(GUILD_CONFIGS_FILE)) {
      console.log(`No guild config store found at ${GUILD_CONFIGS_FILE}`);
      return;
    }

    const saved = JSON.parse(fs.readFileSync(GUILD_CONFIGS_FILE, "utf8"));
    let count = 0;

    for (const [guildId, config] of Object.entries(saved)) {
      if (!config || typeof config !== "object") continue;
      guildConfigs[guildId] = {
        guildId,
        botName: String(config.botName || ""),
        embedColor: String(config.embedColor || "#5865F2"),
        logoUrl: String(config.logoUrl || ""),
        welcomeMessage: String(config.welcomeMessage || ""),
        roomPrefix: String(config.roomPrefix || "unban"),
        commandChannelId: config.commandChannelId || null,
        privateCategoryId: config.privateCategoryId || null,
        logsChannelId: config.logsChannelId || null,
        allowedRoleId: config.allowedRoleId || null,
        adminRoleId: config.adminRoleId || null,
        licenseExpiresAt: config.licenseExpiresAt ? Number(config.licenseExpiresAt) : null,
        cleanupHours: Number(config.cleanupHours || 24),
        paused: Boolean(config.paused),
        rooms: config.rooms && typeof config.rooms === "object" ? config.rooms : {},
        roomActivity: config.roomActivity && typeof config.roomActivity === "object" ? config.roomActivity : {},
        roomCloseAt: config.roomCloseAt && typeof config.roomCloseAt === "object" ? config.roomCloseAt : {},
        createdAt: Number(config.createdAt || Date.now()),
        updatedAt: Number(config.updatedAt || Date.now()),
      };
      count++;
    }

    console.log(`Loaded ${count} guild config(s) from ${GUILD_CONFIGS_FILE}`);
  } catch (error) {
    console.log("Load guild configs error:", error.message);
  }
}

function saveGuildConfigs() {
  try {
    writeJsonAtomic(GUILD_CONFIGS_FILE, guildConfigs);
  } catch (error) {
    console.log("Save guild configs error:", error.message);
  }
}

function loadRecentUnbans() {
  try {
    if (!fs.existsSync(RECENT_UNBANS_FILE)) {
      console.log(`No recent unban store found at ${RECENT_UNBANS_FILE}`);
      return;
    }

    const saved = JSON.parse(fs.readFileSync(RECENT_UNBANS_FILE, "utf8"));
    recentUnbans = Array.isArray(saved) ? saved.filter((item) => item && item.username) : [];
    console.log(`Loaded ${recentUnbans.length} recent unban record(s) from ${RECENT_UNBANS_FILE}`);
  } catch (error) {
    console.log("Load recent unbans error:", error.message);
  }
}

function saveRecentUnbans() {
  try {
    writeJsonAtomic(RECENT_UNBANS_FILE, recentUnbans.slice(-500));
  } catch (error) {
    console.log("Save recent unbans error:", error.message);
  }
}

function monitorKey(guildId, userId, username) {
  return `${guildId}:${userId}:${username.toLowerCase()}`;
}

function parseColor(value, fallback = 0x5865f2) {
  const text = String(value || "").trim().replace("#", "");
  if (/^[0-9a-f]{6}$/i.test(text)) return Number.parseInt(text, 16);
  return fallback;
}

function normalizeHexColor(value) {
  const text = String(value || "").trim();
  const cleaned = text.startsWith("#") ? text : `#${text}`;
  return /^#[0-9a-f]{6}$/i.test(cleaned) ? cleaned.toUpperCase() : null;
}

function getEmbedColor(guildOrId) {
  const guildId = typeof guildOrId === "string" ? guildOrId : guildOrId?.id;
  const config = getGuildConfig(guildId);
  return parseColor(config.embedColor);
}

function getLicenseStatus(guildId) {
  const config = getGuildConfig(guildId);
  if (!config.licenseExpiresAt) return { active: true, label: "Lifetime", daysLeft: null };

  const msLeft = config.licenseExpiresAt - Date.now();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  return {
    active: msLeft > 0,
    label: msLeft > 0 ? `${daysLeft} day(s) left` : `Expired ${Math.abs(daysLeft)} day(s) ago`,
    daysLeft,
  };
}

function hasRole(member, roleId) {
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}

function canUseBot(member) {
  if (!member?.guild) return false;
  const config = getGuildConfig(member.guild.id);
  if (isAdmin(member)) return true;
  if (!config.allowedRoleId) return true;
  return hasRole(member, config.allowedRoleId);
}

function addOperationLog(guildId, message, meta = {}) {
  const entry = {
    guildId,
    message,
    meta,
    at: Date.now(),
  };

  operationLogs.push(entry);
  operationLogs = operationLogs.slice(-300);
  console.log(`[${guildId}] ${message}`);
}

async function sendGuildLog(guildId, message, meta = {}) {
  addOperationLog(guildId, message, meta);

  try {
    const config = getGuildConfig(guildId);
    if (!config.logsChannelId) return;

    const channel = await client.channels.fetch(config.logsChannelId).catch(() => null);
    if (!channel?.isTextBased?.()) return;

    const details = Object.entries(meta)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `**${key}:** ${value}`)
      .join("\n");

    const embed = new EmbedBuilder()
      .setColor(getEmbedColor(guildId))
      .setTitle("Bot Log")
      .setDescription(details ? `${message}\n\n${details}` : message)
      .setTimestamp(new Date());

    await channel.send({ embeds: [embed] });
  } catch (error) {
    console.log("Guild log error:", error.message);
  }
}

function checkStorage() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const testPath = path.join(DATA_DIR, `.health-${process.pid}.tmp`);
    fs.writeFileSync(testPath, "ok");
    const ok = fs.readFileSync(testPath, "utf8") === "ok";
    fs.unlinkSync(testPath);
    return ok;
  } catch {
    return false;
  }
}

function isInstagramUrl(text) {
  return text.startsWith("http") && text.includes("instagram.com");
}

function getUsername(input) {
  const text = input.trim();

  if (isInstagramUrl(text)) {
    try {
      const u = new URL(text);
      return u.pathname.split("/").filter(Boolean)[0];
    } catch {
      return null;
    }
  }

  return text.replace("@", "").trim();
}

function toInstagramUrl(username) {
  return `https://www.instagram.com/${username}/`;
}

function extractStats(text) {
  const followers =
    text.match(/([\d.,]+[kKmM]?)\s+followers/)?.[1] || "0";

  const following =
    text.match(/([\d.,]+[kKmM]?)\s+following/)?.[1] || "0";

  return { followers, following };
}

function escapeXml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapTextByWidth(text, maxWidth, fontSize, bold = false) {
  const value = String(text || "").trim();
  if (!value) return [];
  if (estimateTextWidth(value, fontSize, bold) <= maxWidth) return [value];

  const lines = [];
  let current = "";

  for (const word of value.split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;

    if (estimateTextWidth(next, fontSize, bold) <= maxWidth) {
      current = next;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    if (estimateTextWidth(word, fontSize, bold) <= maxWidth) {
      current = word;
      continue;
    }

    let chunk = "";
    for (const ch of Array.from(word)) {
      const nextChunk = chunk + ch;
      if (estimateTextWidth(nextChunk, fontSize, bold) <= maxWidth) {
        chunk = nextChunk;
      } else {
        if (chunk) lines.push(chunk);
        chunk = ch;
      }
    }
    current = chunk;
  }

  if (current) lines.push(current);
  return lines;
}

function estimateTextWidth(text, fontSize, bold = false) {
  const base = bold ? 0.6 : 0.55;
  let width = 0;

  for (const ch of Array.from(String(text || ""))) {
    if (" .,;:!|ilI'`".includes(ch)) width += fontSize * 0.28;
    else if ("mwMW@#%&".includes(ch)) width += fontSize * 0.82;
    else if (/\d/.test(ch)) width += fontSize * 0.58;
    else if (ch.charCodeAt(0) > 127) width += fontSize * 0.7;
    else width += fontSize * base;
  }

  return Math.ceil(width);
}

function fitText(text, maxWidth, fontSize, bold = false) {
  const value = String(text || "");
  if (estimateTextWidth(value, fontSize, bold) <= maxWidth) return value;

  const suffix = "...";
  let fitted = value;

  while (
    fitted.length > 0 &&
    estimateTextWidth(fitted + suffix, fontSize, bold) > maxWidth
  ) {
    fitted = fitted.slice(0, -1);
  }

  return fitted ? fitted + suffix : suffix;
}

function splitNamePronouns(fullName) {
  const text = String(fullName || "").trim();
  const match = text.match(
    /\s+((?:he|she|they|it|ze|xe)\/(?:him|her|them|its|zir|xem)(?:\/(?:his|hers|theirs|itself|zirs|xyrs))?)$/i
  );

  if (!match) return { name: text, pronouns: "" };

  return {
    name: text.slice(0, match.index).trim(),
    pronouns: match[1],
  };
}

function starburstPoints(cx, cy, outerRadius, innerRadius, spikes = 12) {
  const points = [];
  const step = Math.PI / spikes;

  for (let i = 0; i < spikes * 2; i++) {
    const radius = i % 2 === 0 ? outerRadius : innerRadius;
    const angle = -Math.PI / 2 + i * step;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }

  return points.join(" ");
}

async function extractProfileData(page, bodyText, username) {
  const u = username.toLowerCase();
  const lines = bodyText.split("\n").map((l) => l.trim()).filter((l) => l);
  const lowerLines = lines.map((l) => l.toLowerCase());

  const uIdx = lowerLines.findIndex((l) => l === u || l === `@${u}`);
  if (uIdx === -1) return null;

  let posts = null, followers = null, following = null;
  let followingIdx = -1;

  for (let i = uIdx; i < lines.length - 1 && i < uIdx + 30; i++) {
    const cur = lines[i];
    const next = lowerLines[i + 1];
    if (posts === null && next === "posts" && /^[\d.,]+[kKmMbB]?$/i.test(cur)) { posts = cur; }
    if (followers === null && next === "followers" && /^[\d.,]+[kKmMbB]?$/i.test(cur)) { followers = cur; }
    if (following === null && next === "following" && /^[\d.,]+[kKmMbB]?$/i.test(cur)) { following = cur; followingIdx = i; }
  }

  if (!posts || !followers || !following) return null;

  const stopWords = new Set(["follow", "message", "no posts yet", "suggested for you", "see all", "use the app", u]);
  let fullName = "";
  let bioLines = [];

  for (let i = followingIdx + 2; i < lines.length; i++) {
    const lower = lowerLines[i];
    if (
      stopWords.has(lower) ||
      lower.startsWith("followed by") ||
      lower.includes("suggested for you")
    ) break;
    if (!fullName) { fullName = lines[i]; } else { bioLines.push(lines[i]); }
  }

  const avatarUrl = await page.evaluate((targetU) => {
    const ogImage = document.querySelector('meta[property="og:image"]');
    if (ogImage) {
      const ogTitle = document.querySelector('meta[property="og:title"]');
      const title = document.title || "";
      if ((ogTitle && ogTitle.content.toLowerCase().includes(targetU)) || title.toLowerCase().includes(targetU)) {
        return ogImage.content;
      }
    }
    for (const h of document.querySelectorAll("header")) {
      if (h.innerText.toLowerCase().includes(targetU)) {
        for (const img of h.querySelectorAll("img")) {
          const alt = (img.alt || "").toLowerCase();
          if (alt.includes(targetU) || alt.includes("profile")) return img.src;
        }
      }
    }
    return "";
  }, u);

  const verified = await page.evaluate((targetU) => {
    const normalize = (text) =>
      String(text || "").trim().replace(/^@/, "").toLowerCase();

    const isVerifiedNode = (el) => {
      if (!el || !el.getAttribute) return false;
      const aria = normalize(el.getAttribute("aria-label"));
      const titleAttr = normalize(el.getAttribute("title"));
      const titleText = normalize(el.querySelector?.("title")?.textContent);
      return aria === "verified" || titleAttr === "verified" || titleText === "verified";
    };

    const visibleRect = (el) => {
      let cur = el;
      for (let depth = 0; depth < 4 && cur; depth++) {
        const rect = cur.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect;
        cur = cur.parentElement;
      }
      return null;
    };

    const profileRoot =
      document.querySelector("main header") ||
      document.querySelector("header") ||
      document.querySelector("main");

    if (!profileRoot) return false;

    const usernameEls = Array.from(profileRoot.querySelectorAll("*"))
      .filter((el) => normalize(el.textContent) === targetU)
      .filter((el) => {
        return !Array.from(el.children || []).some(
          (child) => normalize(child.textContent) === targetU
        );
      });

    const badges = Array.from(
      profileRoot.querySelectorAll('[aria-label="Verified"], [title="Verified"], svg')
    ).filter(isVerifiedNode);

    for (const usernameEl of usernameEls) {
      const userRect = visibleRect(usernameEl);
      if (!userRect) continue;

      for (const badge of badges) {
        const badgeRect = visibleRect(badge);
        if (!badgeRect) continue;

        const userCenterY = userRect.top + userRect.height / 2;
        const badgeCenterY = badgeRect.top + badgeRect.height / 2;
        const sameLine = Math.abs(userCenterY - badgeCenterY) <= 18;
        const nextToUsername =
          badgeRect.left >= userRect.right - 8 &&
          badgeRect.left <= userRect.right + 70;
        const badgeSizeOk = badgeRect.width <= 44 && badgeRect.height <= 44;

        if (sameLine && nextToUsername && badgeSizeOk) return true;
      }
    }

    return false;
  }, u);

  return {
    username,
    posts,
    followers,
    following,
    fullName,
    bio: bioLines.join("\n"),
    verified,
    avatarUrl,
  };
}

function enqueueCheck(username) {
  return new Promise((resolve, reject) => {
    queue.push({ username, resolve, reject });
    runQueue();
  });
}

async function runQueue() {
  while (activeJobs < CONCURRENT_CHECKS && queue.length > 0) {
    const job = queue.shift();
    activeJobs++;

    checkInstagram(job.username)
      .then(job.resolve)
      .catch(job.reject)
      .finally(() => {
        activeJobs--;
        runQueue();
      });
  }
}

async function launchBrowser() {
  return await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-sync",
      "--disable-default-apps",
      "--mute-audio",
      "--disable-renderer-backgrounding",
      "--disable-background-timer-throttling",
    ],
  });
}

async function getBrowser() {
  if (!sharedBrowser) sharedBrowser = await launchBrowser();
  return sharedBrowser;
}

async function restartBrowser() {
  if (restartingBrowser) return;

  if (activeJobs > 0) {
    console.log("Browser restart skipped because jobs are active.");
    return;
  }

  restartingBrowser = true;

  try {
    console.log("Restarting browser...");

    if (sharedBrowser) {
      await sharedBrowser.close().catch(() => {});
      sharedBrowser = null;
    }

    sharedBrowser = await launchBrowser();
    console.log("Browser restarted.");
  } catch (error) {
    console.log("Browser restart error:", error.message);
  } finally {
    restartingBrowser = false;
  }
}

async function createPage(browser) {
  const options = {
    viewport: { width: 430, height: 932 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    colorScheme: "dark",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  };

  if (fs.existsSync("ig-session.json")) {
    console.log("Using ig-session.json");
    options.storageState = "ig-session.json";
  } else {
    console.log("No ig-session.json found");
  }

  const context = await browser.newContext(options);
  const page = await context.newPage();

  return { context, page };
}

async function generateProfileCard(data, outputPath) {
  const { username, avatarUrl, posts, followers, following, fullName, bio, verified } = data;
  const W = 995;
  const avSize = 150, avX = 56, avY = 68;
  const tX = 288;
  const maxTextWidth = W - tX - 58;
  const bioLines = bio
    ? bio
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((line) => wrapTextByWidth(line, maxTextWidth, 22))
      .slice(0, 8)
    : [];
  const bioStartY = 187;
  const bioLineGap = 27;
  const H = Math.min(
    420,
    Math.max(
      244,
      bioLines.length
        ? bioStartY + (bioLines.length - 1) * bioLineGap + 40
        : fullName ? 244 : 226
    )
  );

  const svg = [
    `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`,
    `<rect width="${W}" height="${H}" rx="34" fill="#000000"/>`,
    `<circle cx="${avX + avSize / 2}" cy="${avY + avSize / 2}" r="${avSize / 2 + 1}" fill="#101010" stroke="#2a2a2a" stroke-width="2"/>`,
  ];

  const usernameFont = 28;
  const displayUsername = fitText(username, 205, usernameFont, true);
  const uWidth = estimateTextWidth(displayUsername, usernameFont, true);
  svg.push(`<text x="${tX}" y="61" fill="#f5f5f5" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="${usernameFont}" font-weight="700">${escapeXml(displayUsername)}</text>`);

  let followX = tX + uWidth + 24;
  if (verified) {
    const vX = tX + uWidth + 14;
    const vY = 38;
    followX = vX + 28 + 18;
    svg.push(`<polygon points="${starburstPoints(vX + 14, vY + 14, 16, 13, 12)}" fill="#0095F6"/>`);
    svg.push(`<path d="M${vX + 6} ${vY + 15} L${vX + 11} ${vY + 20} L${vX + 23} ${vY + 8}" stroke="#050505" stroke-width="4" fill="none" stroke-linecap="square" stroke-linejoin="miter"/>`);
  }

  svg.push(`<rect x="${followX}" y="34" width="108" height="40" rx="8" fill="#0095F6"/>`);
  svg.push(`<text x="${followX + 54}" y="60" fill="#fff" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="20" font-weight="700" text-anchor="middle">Follow</text>`);

  const dotsX = followX + 132;
  svg.push(`<text x="${dotsX}" y="58" fill="#d9d9d9" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="32" font-weight="400">...</text>`);

  const renderStat = (val, label, x) => {
    const statFont = 22;
    const safeVal = val || "0";
    svg.push(`<text x="${x}" y="107" fill="#f5f5f5" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="${statFont}" font-weight="700">${escapeXml(safeVal)}</text>`);
    svg.push(`<text x="${x + estimateTextWidth(safeVal, statFont, true) + 7}" y="107" fill="#f5f5f5" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="${statFont}" font-weight="400">${label}</text>`);
  };
  renderStat(posts, "posts", 288);
  renderStat(followers, "followers", 426);
  renderStat(following, "following", 620);

  if (fullName) {
    const nameParts = splitNamePronouns(fullName);
    const displayName = fitText(nameParts.name, 280, 23, true);
    const nameWidth = estimateTextWidth(displayName, 23, true);
    svg.push(`<text x="${tX}" y="156" fill="#f5f5f5" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="23" font-weight="700">${escapeXml(displayName)}</text>`);

    if (nameParts.pronouns) {
      svg.push(`<text x="${tX + nameWidth + 7}" y="156" fill="#a8a8a8" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="16" font-weight="400">${escapeXml(nameParts.pronouns)}</text>`);
    }
  }

  if (bioLines.length) {
    let by = bioStartY;
    for (const line of bioLines) {
      svg.push(`<text x="${tX}" y="${by}" fill="#f5f5f5" font-family="-apple-system,BlinkMacSystemFont,Helvetica Neue,Roboto,Arial,sans-serif" font-size="22" font-weight="400">${escapeXml(line)}</text>`);
      by += bioLineGap;
    }
  }

  svg.push("</svg>");
  const compositeOps = [{ input: Buffer.from(svg.join("")), top: 0, left: 0 }];

  if (avatarUrl) {
    try {
      const resp = await fetch(avatarUrl);
      const buf = Buffer.from(await resp.arrayBuffer());
      const mask = Buffer.from(`<svg width="${avSize}" height="${avSize}"><circle cx="${avSize / 2}" cy="${avSize / 2}" r="${avSize / 2}" fill="white"/></svg>`);
      const av = await sharp(buf).resize(avSize, avSize, { fit: "cover" }).composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
      compositeOps.push({ input: av, top: avY, left: avX });
    } catch (e) { console.log("Avatar error:", e.message); }
  }

  await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } } })
    .composite(compositeOps).png().toFile(outputPath);
}

const INSTA_ERROR_PHRASES = [
  "something went wrong",
  "there's an issue",
  "could not be loaded",
  "reload page",
  "page could not be loaded",
  "please try again",
  "we're working on it",
];

async function checkInstagram(username) {
  let context = null;
  let page = null;

  const url = toInstagramUrl(username);

  try {
    const browser = await getBrowser();
    const created = await createPage(browser);

    context = created.context;
    page = created.page;

    let bodyText = "";
    let bodyTextRaw = "";
    let pageUrl = "";
    let hasError = true;
    let attempt = 0;
    const MAX_RETRIES = 2;

    while (hasError && attempt <= MAX_RETRIES) {
      if (attempt > 0) {
        console.log(`RETRY ${attempt}/${MAX_RETRIES} for @${username}`);
      }

      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });

      await page.waitForTimeout(6000);

      bodyTextRaw = await page.locator("body").innerText();
      bodyText = bodyTextRaw.toLowerCase();
      pageUrl = page.url().toLowerCase();

      console.log(`DEBUG USER: ${username}`);
      console.log(`DEBUG URL: ${page.url()}`);
      console.log(`DEBUG TITLE: ${await page.title()}`);
      console.log(`DEBUG TEXT: ${bodyText.slice(0, 1000)}`);

      hasError = INSTA_ERROR_PHRASES.some((p) => bodyText.includes(p));

      if (hasError) {
        attempt++;
      }
    }

    // Wait for profile content to appear
    await page.waitForFunction(
      (u) => {
        const t = document.body?.innerText?.toLowerCase() || "";
        return t.includes(u) || t.includes("followers");
      },
      username.toLowerCase(),
      { timeout: 12000 }
    ).catch(() => {
      console.log(`Profile wait timeout for @${username}, continuing`);
    });

    // Re-read body after content settles
    bodyTextRaw = await page.locator("body").innerText();
    bodyText = bodyTextRaw.toLowerCase();
    pageUrl = page.url().toLowerCase();

    // Validate the body actually showed this profile
    if (!bodyText.includes(username.toLowerCase())) {
      console.log(`Username @${username} not found in page body, returning unknown`);
      return { status: "unknown", screenshot: null, stats: { followers: "0", following: "0" } };
    }

    // Extract profile data from bodyText + DOM
    const pd = await extractProfileData(page, bodyTextRaw, username);
    if (!pd) {
      console.log(`Profile data extraction failed for @${username}, returning unknown`);
      return { status: "unknown", screenshot: null, stats: { followers: "0", following: "0" } };
    }

    if (!pd.username || !pd.posts || !pd.followers || !pd.following) {
      console.log(`Required card data missing for @${username}, returning unknown`);
      return { status: "unknown", screenshot: null, stats: { followers: "0", following: "0" } };
    }

    const stats = { followers: pd.followers, following: pd.following };

    console.log(`CARD_DATA_USERNAME: ${pd.username}`);
    console.log(`CARD_DATA_POSTS: ${pd.posts}`);
    console.log(`CARD_DATA_FOLLOWERS: ${pd.followers}`);
    console.log(`CARD_DATA_FOLLOWING: ${pd.following}`);
    console.log(`CARD_DATA_FULLNAME: ${pd.fullName}`);
    console.log(`CARD_DATA_BIO: ${pd.bio}`);
    console.log(`CARD_DATA_VERIFIED: ${pd.verified}`);
    console.log(`CARD_DATA_AVATAR_URL: ${pd.avatarUrl}`);

    // Generate Instagram-style card
    const cardPath = `screenshots/card-${Date.now()}-${username}.png`;
    await generateProfileCard({
      username: pd.username, avatarUrl: pd.avatarUrl, verified: pd.verified,
      posts: pd.posts, followers: pd.followers, following: pd.following,
      fullName: pd.fullName, bio: pd.bio,
    }, cardPath);

    const isBanned =
      bodyText.includes("profile isn't available") ||
      bodyText.includes("profile is not available") ||
      bodyText.includes("page isn't available") ||
      bodyText.includes("user not found") ||
      bodyText.includes("this account doesn't exist") ||
      bodyText.includes("the link may be broken") ||
      bodyText.includes("profile may have been removed") ||
      bodyText.includes("sorry, this page isn't available") ||
      bodyText.includes("الحساب غير متاح") ||
      bodyText.includes("هذه الصفحة غير متاحة");

    const isLoginOnly =
      pageUrl.includes("/accounts/login") ||
      (
        bodyText.includes("mobile number, username or email") &&
        bodyText.includes("password")
      );

    const hasUsername = bodyText.includes(username.toLowerCase());

    const hasStats =
      bodyText.includes("followers") &&
      bodyText.includes("following");

    const notBlackScreen = bodyText.length > 80;

    const isActive =
      !isLoginOnly &&
      !isBanned &&
      hasUsername &&
      hasStats &&
      notBlackScreen;

    if (hasError) return { status: "unknown", screenshot: cardPath, stats };
    if (isBanned) return { status: "banned", screenshot: cardPath, stats };
    if (isLoginOnly) return { status: "login", screenshot: cardPath, stats };
    if (isActive) return { status: "active", screenshot: cardPath, stats };

    return { status: "unknown", screenshot: cardPath, stats };
  } catch (error) {
    console.log("CHECK ERROR:", username, error.message);

    return {
      status: "error",
      error: error.message,
      screenshot: null,
      stats: {
        followers: "0",
        following: "0",
      },
    };
  } finally {
    try {
      if (page) await page.close();
    } catch {}

    try {
      if (context) await context.close();
    } catch {}
  }
}

function isAdmin(member) {
  if (!member?.guild) return false;
  const config = getGuildConfig(member.guild.id);
  return Boolean(
    member.permissions?.has(PermissionFlagsBits.ManageGuild) ||
    hasRole(member, config.adminRoleId)
  );
}

function sanitizeChannelName(value) {
  return String(value || "user")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "user";
}

function getConfiguredBotName(guild) {
  const config = getGuildConfig(guild.id);
  return config.botName || guild.members.me?.displayName || client.user.username;
}

function isUserRoom(config, userId, channelId) {
  return config.rooms?.[userId] === channelId;
}

function touchUserRoom(guildId, userId) {
  const config = getGuildConfig(guildId);
  if (!config.rooms?.[userId]) return;

  config.roomActivity[userId] = Date.now();
  config.updatedAt = Date.now();
  saveGuildConfigs();
}

function getUserMonitorEntries(guildId, userId) {
  return Object.entries(monitors)
    .filter(([, item]) => item.guildId === guildId && item.userId === userId);
}

function recordRecentUnban(meta, username, result, duration) {
  if (!meta?.guildId || !meta?.userId) return;

  recentUnbans.push({
    guildId: meta.guildId,
    userId: meta.userId,
    username,
    followers: result.stats?.followers || "0",
    following: result.stats?.following || "0",
    duration,
    at: Date.now(),
  });

  recentUnbans = recentUnbans.slice(-500);
  saveRecentUnbans();
}

function parseUsernames(input) {
  const usernames = [];
  const seen = new Set();

  for (const part of String(input || "").split(/\s+/)) {
    const username = getUsername(part);
    if (!username || username.includes(" ") || username.length < 2) continue;

    const key = username.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    usernames.push(username);
  }

  return usernames.slice(0, 10);
}

function parseDurationMs(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return 0;

  const match = text.match(/^(\d+)(s|m|h|d)?$/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2] || "m";
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };

  return amount * multipliers[unit];
}

function getCommandButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bot:start").setLabel("Start").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("bot:list").setLabel("List").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bot:stats").setLabel("Stats").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot:stop").setLabel("Stop").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("bot:clear").setLabel("Clear All").setStyle(ButtonStyle.Danger)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bot:close").setLabel("Close Room").setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildWelcomeEmbed(member) {
  const config = getGuildConfig(member.guild.id);
  const name = config.botName || getConfiguredBotName(member.guild);
  const description = config.welcomeMessage ||
    "Your private room is ready. Use the buttons below or type a command.";

  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(member.guild.id))
    .setTitle(`Welcome ${member.displayName || member.user.username}`)
    .setDescription(
      `${description}\n\n` +
      "**Available Commands:**\n" +
      "`!t username` - Start monitoring\n" +
      "`!stop username` - Stop monitoring\n" +
      "`!list` - Show your list\n" +
      "`!stats` - Show stats\n" +
      "`!sesun 24` - Recent unbans\n" +
      "`!close` - Close this room"
    )
    .setFooter({ text: name });

  if (config.logoUrl) embed.setThumbnail(config.logoUrl);
  return embed;
}

async function sendWelcomeMessage(channel, member) {
  try {
    await channel.send({
      embeds: [buildWelcomeEmbed(member)],
      components: getCommandButtons(),
    });
  } catch (error) {
    console.log("Welcome message error:", error.message);
  }
}

async function applyServerBotName(message, name) {
  const config = getGuildConfig(message.guild.id);
  config.botName = name;
  config.updatedAt = Date.now();
  saveGuildConfigs();

  try {
    const me = message.guild.members.me || await message.guild.members.fetchMe();
    await me.setNickname(name);
    return true;
  } catch (error) {
    console.log("Set nickname error:", error.message);
    return false;
  }
}

function resolveTextChannel(message, args) {
  const mentioned = message.mentions.channels.first();
  if (mentioned?.type === ChannelType.GuildText) return mentioned;

  const raw = args[0]?.replace(/[<#>]/g, "");
  if (!raw) return message.channel;

  const byId = message.guild.channels.cache.get(raw);
  if (byId?.type === ChannelType.GuildText) return byId;

  return message.guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === raw.toLowerCase()
  ) || message.channel;
}

function resolveRole(message, args) {
  const mentioned = message.mentions.roles.first();
  if (mentioned) return mentioned;

  const raw = args.join(" ").trim().replace(/[<@&>]/g, "");
  if (!raw) return null;
  if (raw.toLowerCase() === "none" || raw.toLowerCase() === "clear") return { id: null, name: "none" };

  const byId = message.guild.roles.cache.get(raw);
  if (byId) return byId;

  return message.guild.roles.cache.find((role) => role.name.toLowerCase() === raw.toLowerCase()) || null;
}

function resolveCategory(message, args) {
  const raw = args.join(" ").trim().replace(/[<#>]/g, "");
  if (!raw) return message.channel.parent || null;
  if (raw.toLowerCase() === "none" || raw.toLowerCase() === "clear") return null;

  const byId = message.guild.channels.cache.get(raw);
  if (byId?.type === ChannelType.GuildCategory) return byId;

  return message.guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === raw.toLowerCase()
  ) || null;
}

async function ensureUserRoom(message) {
  const guild = message.guild;
  const config = getGuildConfig(guild.id);
  const existingId = config.rooms?.[message.author.id];

  if (existingId) {
    const existing = guild.channels.cache.get(existingId) || await guild.channels.fetch(existingId).catch(() => null);
    if (existing) return existing;
  }

  const roomPrefix = sanitizeChannelName(config.roomPrefix || "unban");
  const name = `${roomPrefix}-${sanitizeChannelName(message.member?.displayName || message.author.username)}`;
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: message.author.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.AttachFiles,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageMessages,
      ],
    },
  ];

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: config.privateCategoryId || undefined,
    topic: `Private unban bot room for ${message.author.tag} (${message.author.id})`,
    permissionOverwrites: overwrites,
  });

  config.rooms[message.author.id] = channel.id;
  config.roomActivity[message.author.id] = Date.now();
  delete config.roomCloseAt[message.author.id];
  config.updatedAt = Date.now();
  saveGuildConfigs();
  await sendWelcomeMessage(channel, message.member);
  await sendGuildLog(guild.id, "Private room opened", {
    user: message.author.tag,
    channel: `#${channel.name}`,
  });

  return channel;
}

async function closeUserRoom(guild, userId, reason = "Closed") {
  const config = getGuildConfig(guild.id);
  const channelId = config.rooms?.[userId];
  if (!channelId) return false;

  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);

  delete config.rooms[userId];
  delete config.roomActivity[userId];
  delete config.roomCloseAt[userId];
  config.updatedAt = Date.now();
  saveGuildConfigs();

  if (channel) {
    await channel.delete(reason).catch((error) => console.log("Close room delete error:", error.message));
  }

  await sendGuildLog(guild.id, "Private room closed", { userId, reason });
  return true;
}

async function cleanupInactiveRooms(guildId = null, force = false) {
  const guildIds = guildId ? [guildId] : Object.keys(guildConfigs);
  let closed = 0;

  for (const id of guildIds) {
    const guild = client.guilds.cache.get(id) || await client.guilds.fetch(id).catch(() => null);
    if (!guild) continue;

    const config = getGuildConfig(id);
    const cleanupHours = Number(config.cleanupHours || 24);
    if (!force && cleanupHours <= 0) continue;

    const cutoff = Date.now() - cleanupHours * 60 * 60 * 1000;

    for (const [userId, channelId] of Object.entries(config.rooms || {})) {
      const hasActiveMonitors = getUserMonitorEntries(id, userId).length > 0;
      const lastActive = Number(config.roomActivity?.[userId] || 0);
      const closeAt = Number(config.roomCloseAt?.[userId] || 0);
      const shouldClose =
        !hasActiveMonitors &&
        (
          force ||
          (closeAt && closeAt <= Date.now()) ||
          (cleanupHours > 0 && lastActive > 0 && lastActive <= cutoff)
        );

      if (!shouldClose) continue;

      await closeUserRoom(guild, userId, closeAt ? "Scheduled close" : "Inactive private room cleanup");
      closed++;
    }
  }

  return closed;
}

async function getUserCommandChannel(message) {
  const config = getGuildConfig(message.guild.id);
  if (isUserRoom(config, message.author.id, message.channel.id)) {
    touchUserRoom(message.guild.id, message.author.id);
    return message.channel;
  }

  if (config.commandChannelId && message.channel.id !== config.commandChannelId) {
    await message.reply(`Use <#${config.commandChannelId}> or your private room.`);
    return null;
  }

  const room = await ensureUserRoom(message);
  await message.delete().catch(() => {});

  if (room.id !== message.channel.id) {
    await message.channel.send(`${message.author}, your private bot room is <#${room.id}>.`)
      .then((msg) => setTimeout(() => msg.delete().catch(() => {}), 15000))
      .catch(() => {});
  }

  return room;
}

function buildHelpEmbed(guild) {
  const botName = getConfiguredBotName(guild);

  return new EmbedBuilder()
    .setColor(getEmbedColor(guild.id))
    .setTitle("ℹ️ Bot Commands")
    .setDescription("Commands to monitor Instagram accounts:")
    .addFields(
      { name: "!chat", value: "Open your private bot room. (`!chat`)" },
      { name: "!t", value: "Monitor Instagram usernames. (`!t <username1> [username2] ...`)" },
      { name: "!stop", value: "Stop monitoring a username. (`!stop <username>`)" },
      { name: "!list", value: "List your monitored usernames. (`!list`)" },
      { name: "!clearall", value: "Clear your list. (`!clearall`)" },
      { name: "!stats", value: "Show monitoring statistics. (`!stats`)" },
      { name: "!sesun", value: "Show recently unbanned accounts. (`!sesun <hours>`)" },
      { name: "!close", value: "Close your private room now or later. (`!close [10m]`)" },
      { name: "!health", value: "Show bot health and storage status. (`!health`)" },
      { name: "Admin setup", value: "`!setupname <name>`\n`!setupchannel [#channel]`\n`!setupcategory <category>`\n`!setuplogs #bot-logs`\n`!setuprole @Role`\n`!setupadminrole @Role`\n`!setupcleanup 24`\n`!setupbrand color #ff0055`\n`!license info`" }
    )
    .setFooter({ text: botName });
}

function buildStatsEmbed(message) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const userEntries = getUserMonitorEntries(guildId, userId).map(([, item]) => item);
  const guildEntries = Object.values(monitors).filter((item) => item.guildId === guildId);
  const counts = {};

  for (const item of guildEntries) {
    counts[item.lastStatus || "unknown"] = (counts[item.lastStatus || "unknown"] || 0) + 1;
  }
  const license = getLicenseStatus(guildId);

  return new EmbedBuilder()
    .setColor(getEmbedColor(guildId))
    .setTitle("📊 Bot Stats")
    .setDescription(
      `**Your monitored accounts:** ${userEntries.length}\n` +
      `**Server monitored accounts:** ${guildEntries.length}\n` +
      `**Active:** ${counts.active || 0}\n` +
      `**Banned/Login/Unknown:** ${(counts.banned || 0) + (counts.login || 0) + (counts.unknown || 0)}\n` +
      `**License:** ${license.label}`
    );
}

function buildRecentUnbansEmbed(message, hours) {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const admin = isAdmin(message.member);
  const rows = recentUnbans
    .filter((item) => item.guildId === message.guild.id)
    .filter((item) => admin || item.userId === message.author.id)
    .filter((item) => item.at >= since)
    .slice(-15)
    .reverse();

  const description = rows.length
    ? rows.map((item) => {
      const when = new Date(item.at).toISOString().replace("T", " ").slice(0, 16);
      return `• @${item.username} — ${when} UTC — ${item.followers} followers`;
    }).join("\n")
    : "No recently unbanned accounts in that time window.";

  return new EmbedBuilder()
    .setColor(0x00ff44)
    .setTitle(`Recently Unbanned (${hours}h)`)
    .setDescription(description);
}

function buildHealthEmbed(guild = null) {
  const privateRooms = Object.values(guildConfigs)
    .reduce((sum, config) => sum + Object.keys(config.rooms || {}).length, 0);
  const uptime = formatDuration(Date.now() - STARTED_AT);
  const storageOk = checkStorage();

  const embed = new EmbedBuilder()
    .setColor(storageOk ? 0x00ff44 : 0xff3333)
    .setTitle("Health Check")
    .setDescription(
      `**Bot status:** Online\n` +
      `**Data directory:** ${DATA_DIR}\n` +
      `**Storage:** ${storageOk ? "OK" : "ERROR"}\n` +
      `**Uptime:** ${uptime}\n` +
      `**Servers:** ${client.guilds.cache.size}\n` +
      `**Private rooms:** ${privateRooms}\n` +
      `**Queue:** ${queue.length}\n` +
      `**Active jobs:** ${activeJobs}`
    );

  if (guild) embed.setFooter({ text: getConfiguredBotName(guild) });
  return embed;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function dashboardAuthorized(req, url) {
  if (!DASHBOARD_TOKEN) return false;

  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return bearer === DASHBOARD_TOKEN || url.searchParams.get("token") === DASHBOARD_TOKEN;
}

function dashboardTokenSuffix(url) {
  const token = url.searchParams.get("token") || DASHBOARD_TOKEN;
  return token ? `?token=${encodeURIComponent(token)}` : "";
}

function dashboardStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const totalRooms = Object.values(guildConfigs)
    .reduce((sum, config) => sum + Object.keys(config.rooms || {}).length, 0);
  const todayUnbans = recentUnbans.filter((item) => item.at >= todayStart.getTime()).length;

  return {
    online: Boolean(client.user),
    uptime: formatDuration(Date.now() - STARTED_AT),
    servers: client.guilds.cache.size,
    sessions: Object.keys(monitors).length,
    rooms: totalRooms,
    todayUnbans,
    storageOk: checkStorage(),
  };
}

function renderDashboard(url) {
  if (!DASHBOARD_TOKEN) {
    return `<!doctype html><html><body style="font-family:Arial;background:#111;color:#fff;padding:32px"><h1>Dashboard disabled</h1><p>Set <code>DASHBOARD_TOKEN</code> in Railway, then open <code>/?token=YOUR_TOKEN</code>.</p></body></html>`;
  }

  const tokenSuffix = dashboardTokenSuffix(url);
  const stats = dashboardStats();
  const guildCards = Object.entries(guildConfigs).map(([guildId, config]) => {
    const guild = client.guilds.cache.get(guildId);
    const guildMonitors = Object.values(monitors).filter((item) => item.guildId === guildId);
    const license = getLicenseStatus(guildId);
    const recentOps = operationLogs
      .filter((item) => item.guildId === guildId)
      .slice(-6)
      .reverse()
      .map((item) => `<li>${escapeHtml(new Date(item.at).toLocaleString())} - ${escapeHtml(item.message)}</li>`)
      .join("");

    return `
      <section class="card">
        <div class="row">
          <h2>${escapeHtml(guild?.name || guildId)}</h2>
          <form method="post" action="/dashboard/guild/${encodeURIComponent(guildId)}/pause${tokenSuffix}">
            <input type="hidden" name="paused" value="${config.paused ? "false" : "true"}">
            <button>${config.paused ? "Resume" : "Pause"}</button>
          </form>
        </div>
        <p><b>License:</b> ${escapeHtml(license.label)} | <b>Sessions:</b> ${guildMonitors.length} | <b>Rooms:</b> ${Object.keys(config.rooms || {}).length}</p>
        <form method="post" action="/dashboard/guild/${encodeURIComponent(guildId)}/config${tokenSuffix}" class="grid">
          <label>Bot name <input name="botName" value="${escapeHtml(config.botName)}"></label>
          <label>Embed color <input name="embedColor" value="${escapeHtml(config.embedColor)}"></label>
          <label>Logo URL <input name="logoUrl" value="${escapeHtml(config.logoUrl)}"></label>
          <label>Room prefix <input name="roomPrefix" value="${escapeHtml(config.roomPrefix)}"></label>
          <label>Command channel ID <input name="commandChannelId" value="${escapeHtml(config.commandChannelId || "")}"></label>
          <label>Private category ID <input name="privateCategoryId" value="${escapeHtml(config.privateCategoryId || "")}"></label>
          <label>Logs channel ID <input name="logsChannelId" value="${escapeHtml(config.logsChannelId || "")}"></label>
          <label>Allowed role ID <input name="allowedRoleId" value="${escapeHtml(config.allowedRoleId || "")}"></label>
          <label>Admin role ID <input name="adminRoleId" value="${escapeHtml(config.adminRoleId || "")}"></label>
          <label>Cleanup hours <input name="cleanupHours" type="number" min="0" max="720" value="${escapeHtml(config.cleanupHours || 24)}"></label>
          <label class="wide">Welcome message <input name="welcomeMessage" value="${escapeHtml(config.welcomeMessage)}"></label>
          <button class="wide">Save config</button>
        </form>
        <form method="post" action="/dashboard/guild/${encodeURIComponent(guildId)}/license${tokenSuffix}" class="inline">
          <input name="days" type="number" min="1" max="3650" placeholder="30">
          <button name="action" value="set">Set license days</button>
          <button name="action" value="extend">Extend</button>
          <button name="action" value="clear">Lifetime</button>
        </form>
        <h3>Monitored accounts</h3>
        <p>${guildMonitors.slice(0, 20).map((item) => `@${escapeHtml(item.username)} (${escapeHtml(item.lastStatus)})`).join(", ") || "None"}</p>
        <h3>Last operations</h3>
        <ul>${recentOps || "<li>No operations yet.</li>"}</ul>
      </section>
    `;
  }).join("");

  const recentRows = recentUnbans.slice(-10).reverse().map((item) =>
    `<tr><td>${escapeHtml(item.username)}</td><td>${escapeHtml(item.followers)}</td><td>${escapeHtml(new Date(item.at).toLocaleString())}</td></tr>`
  ).join("");

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Unbans Bot Dashboard</title>
    <style>
      body{font-family:Inter,Arial,sans-serif;background:#0f1117;color:#f4f5f7;margin:0;padding:28px}
      h1,h2,h3{margin:0 0 12px}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0}
      .stat,.card{background:#181b24;border:1px solid #2a2f3d;border-radius:10px;padding:16px}
      .stat b{display:block;font-size:28px;margin-top:8px}
      .card{margin:18px 0}
      .row{display:flex;justify-content:space-between;gap:12px;align-items:center}
      .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
      .wide{grid-column:1/-1}
      input{width:100%;box-sizing:border-box;background:#10131b;color:#fff;border:1px solid #30384a;border-radius:6px;padding:9px;margin-top:5px}
      button{background:#7c3aed;color:white;border:0;border-radius:7px;padding:9px 12px;cursor:pointer}
      .inline{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.inline input{width:120px}
      table{width:100%;border-collapse:collapse}.muted{color:#9aa3b2}td,th{border-bottom:1px solid #272d3a;padding:8px;text-align:left}
    </style>
  </head>
  <body>
    <h1>Unbans Bot Dashboard</h1>
    <p class="muted">Status: ${stats.online ? "Online" : "Offline"} | Uptime: ${escapeHtml(stats.uptime)} | Data: ${escapeHtml(DATA_DIR)}</p>
    <div class="stats">
      <div class="stat">Servers <b>${stats.servers}</b></div>
      <div class="stat">Sessions <b>${stats.sessions}</b></div>
      <div class="stat">Private rooms <b>${stats.rooms}</b></div>
      <div class="stat">Today unbans <b>${stats.todayUnbans}</b></div>
      <div class="stat">Storage <b>${stats.storageOk ? "OK" : "ERR"}</b></div>
    </div>
    ${guildCards || "<p>No server configs yet. Run setup commands in Discord first.</p>"}
    <section class="card"><h2>Recent Unbans</h2><table><tr><th>Username</th><th>Followers</th><th>When</th></tr>${recentRows}</table></section>
  </body></html>`;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleDashboardPost(req, res, url) {
  const match = url.pathname.match(/^\/dashboard\/guild\/([^/]+)\/([^/]+)$/);
  if (!match) {
    res.writeHead(404);
    return res.end("Not found");
  }

  const guildId = decodeURIComponent(match[1]);
  const action = match[2];
  const config = getGuildConfig(guildId);
  const body = new URLSearchParams(await readRequestBody(req));

  if (action === "pause") {
    config.paused = body.get("paused") === "true";
    config.updatedAt = Date.now();
    saveGuildConfigs();
  }

  if (action === "config") {
    config.botName = body.get("botName") || "";
    config.logoUrl = body.get("logoUrl") || "";
    config.welcomeMessage = (body.get("welcomeMessage") || "").slice(0, 500);
    config.roomPrefix = sanitizeChannelName(body.get("roomPrefix") || "unban");
    config.commandChannelId = body.get("commandChannelId") || null;
    config.privateCategoryId = body.get("privateCategoryId") || null;
    config.logsChannelId = body.get("logsChannelId") || null;
    config.allowedRoleId = body.get("allowedRoleId") || null;
    config.adminRoleId = body.get("adminRoleId") || null;
    config.cleanupHours = Math.max(0, Math.min(720, Number(body.get("cleanupHours") || 24)));
    const color = normalizeHexColor(body.get("embedColor") || "");
    if (color) config.embedColor = color;
    config.updatedAt = Date.now();
    saveGuildConfigs();

    if (config.botName) {
      const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
      let me = guild?.members?.me || null;
      if (!me && guild?.members?.fetchMe) me = await guild.members.fetchMe().catch(() => null);
      if (me) await me.setNickname(config.botName).catch(() => {});
    }
  }

  if (action === "license") {
    const licenseAction = body.get("action");
    const days = Math.max(1, Math.min(3650, Number(body.get("days") || 30)));

    if (licenseAction === "clear") config.licenseExpiresAt = null;
    if (licenseAction === "set") config.licenseExpiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
    if (licenseAction === "extend") {
      const base = config.licenseExpiresAt && config.licenseExpiresAt > Date.now() ? config.licenseExpiresAt : Date.now();
      config.licenseExpiresAt = base + days * 24 * 60 * 60 * 1000;
    }

    config.updatedAt = Date.now();
    saveGuildConfigs();
  }

  res.writeHead(303, { Location: `/${dashboardTokenSuffix(url)}` });
  res.end();
}

function startDashboard() {
  if (!DASHBOARD_ENABLED) return;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      res.writeHead(checkStorage() ? 200 : 500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ ok: checkStorage(), dataDir: DATA_DIR, uptime: Date.now() - STARTED_AT }));
    }

    if (!dashboardAuthorized(req, url)) {
      res.writeHead(DASHBOARD_TOKEN ? 401 : 200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(DASHBOARD_TOKEN ? "Unauthorized" : renderDashboard(url));
    }

    if (req.method === "POST") return handleDashboardPost(req, res, url);

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderDashboard(url));
  });

  server.listen(DASHBOARD_PORT, () => {
    console.log(`Dashboard listening on port ${DASHBOARD_PORT}`);
    if (!DASHBOARD_TOKEN) console.log("Dashboard is disabled until DASHBOARD_TOKEN is set.");
  });
}

function applyEmbedBranding(embed, guildId) {
  if (!guildId) return embed;

  const config = getGuildConfig(guildId);
  embed.setColor(getEmbedColor(guildId));
  if (config.logoUrl) embed.setThumbnail(config.logoUrl);
  return embed;
}

function recoveredEmbed(username, result, duration, guildId = null) {
  const attachment = new AttachmentBuilder(result.screenshot, {
    name: "profile.png",
  });

  const embed = new EmbedBuilder()
    .setColor(0x00ff44)
    .setTitle(`Account Recovered | @${username} 🏆✅`)
    .setDescription(
      `**Followers:** ${result.stats.followers || "0"} | **Following:** ${result.stats.following || "0"}\n` +
      `⏱️ **Time Taken:** ${duration}`
    )
    .setImage("attachment://profile.png")
    .setFooter({
      text: `Unbanned at ${getTime()}`,
    });
  applyEmbedBranding(embed, guildId);

  return {
    embeds: [embed],
    files: [attachment],
  };
}

function unavailableEmbed(username, result, guildId = null) {
  const embed = new EmbedBuilder()
    .setColor(0xff3333)
    .setTitle(`Account Unavailable | @${username} 🚫`)
    .setDescription(
      "This account appears to be banned, unavailable, or not accessible."
    )
    .setFooter({
      text: `Monitoring started at ${getTime()}`,
    });
  applyEmbedBranding(embed, guildId);

  const payload = {
    embeds: [embed],
  };

  if (result.screenshot) {
    const attachment = new AttachmentBuilder(result.screenshot, {
      name: "profile.png",
    });

    embed.setImage("attachment://profile.png");
    payload.files = [attachment];
  }

  return payload;
}

async function sendRecovered(channel, username, result, duration, meta = null) {
  const payload = recoveredEmbed(username, result, duration, meta?.guildId);
  await channel.send(payload);
  recordRecentUnban(meta, username, result, duration);
  safeDelete(result.screenshot);
}

async function sendUnavailable(channel, username, result, meta = null) {
  const payload = unavailableEmbed(username, result, meta?.guildId);
  await channel.send(payload);
  safeDelete(result.screenshot);
}

async function startMonitoringUsernames(context, usernames) {
  const { guildId, userId, channel } = context;

  if (!usernames.length) {
    await channel.send("Use: `!t <username1> [username2] ...`");
    return;
  }

  await channel.send(`Checking ${usernames.map((u) => `@${u}`).join(", ")}...`);

  for (const username of usernames) {
    const key = monitorKey(guildId, userId, username);
    if (monitors[key]) {
      await channel.send(`Already monitoring @${username}.`);
      continue;
    }

    const startedAt = Date.now();
    const result = await enqueueCheck(username);
    const duration = formatDuration(Date.now() - startedAt);

    if (result.status === "error") {
      await channel.send(`Error checking @${username}\n\`${result.error}\``);
      await sendGuildLog(guildId, "Instagram check error", { username, error: result.error });
      continue;
    }

    const monitorRecord = {
      username,
      guildId,
      userId,
      channelId: channel.id,
      lastStatus: result.status === "active" ? "active" : result.status,
      startedAt,
      bannedStartedAt: result.status === "active" ? null : startedAt,
      activeHits: 0,
    };

    monitors[key] = monitorRecord;
    saveMonitors();

    if (result.status === "active") {
      await sendRecovered(channel, username, result, duration, { guildId, userId });
    } else {
      await sendUnavailable(channel, username, result, { guildId, userId });
    }

    await sendGuildLog(guildId, "Monitoring started", {
      userId,
      username,
      status: result.status,
      channel: channel.id,
    });
  }
}

async function stopMonitoringUsername(context, username) {
  const { guildId, userId, channel } = context;
  const key = monitorKey(guildId, userId, username);

  if (!monitors[key]) {
    await channel.send(`You are not monitoring @${username}.`);
    return;
  }

  delete monitors[key];
  saveMonitors();
  await channel.send(`Stopped monitoring @${username}.`);
  await sendGuildLog(guildId, "Monitoring stopped", { userId, username });
}

async function clearUserMonitoring(context) {
  const { guildId, userId, channel } = context;
  let removed = 0;

  for (const [key, item] of Object.entries(monitors)) {
    if (item.guildId === guildId && item.userId === userId) {
      delete monitors[key];
      removed++;
    }
  }

  saveMonitors();
  await channel.send(`Cleared ${removed} monitored account(s).`);
  await sendGuildLog(guildId, "Monitoring list cleared", { userId, removed });
}

async function sendUserMonitorList(context) {
  const { guildId, userId, channel } = context;
  const entries = getUserMonitorEntries(guildId, userId)
    .map(([, item]) => `â€¢ @${item.username} â€” ${item.lastStatus}`)
    .join("\n");

  await channel.send(entries || "You are not monitoring any accounts.");
}

client.once("ready", async () => {
  console.log(`Discord bot online: ${client.user.tag}`);
  console.log(`Persistent data directory: ${DATA_DIR}`);

  loadMonitors();
  loadGuildConfigs();
  loadRecentUnbans();
  startDashboard();

  sharedBrowser = await launchBrowser();

  console.log(`Shared browser started. Concurrency: ${CONCURRENT_CHECKS}`);

  setInterval(restartBrowser, 1000 * 60 * BROWSER_RESTART_MINUTES);
  setInterval(cleanupOldScreenshots, 1000 * 60 * 5);
  setInterval(() => cleanupInactiveRooms().catch((error) => {
    console.log("Room cleanup error:", error.message);
  }), 1000 * 60 * 15);

  startMonitorLoop();
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === "!help") {
    try {
      await message.author.send(
        [
          "**Commands:**",
          "`!unban username`",
          "`!unban https://www.instagram.com/username/`",
          "`!list`",
          "`!cancel username`",
          "`!cancel all`",
        ].join("\n")
      );

      return message.reply("✅ Check your DM.");
    } catch {
      return message.reply(
        "❌ Please enable DMs from server members to use this bot."
      );
    }
  }

  if (content === "!list") {
    const list = Object.values(monitors)
      .filter((m) => m.userId === message.author.id)
      .map((m) => `• @${m.username} — ${m.lastStatus}`)
      .join("\n");

    try {
      await message.author.send(list || "No accounts monitored.");
      return message.reply("✅ Sent your monitor list in DM.");
    } catch {
      return message.reply("❌ Please enable DMs from server members.");
    }
  }

  if (content.startsWith("!cancel")) {
    const arg = content.replace("!cancel", "").trim();

    if (arg === "all") {
      Object.keys(monitors).forEach((key) => {
        if (monitors[key].userId === message.author.id) {
          delete monitors[key];
        }
      });
      saveMonitors();

      return message.reply("🛑 Cancelled all your monitors.");
    }

    const username = getUsername(arg);

    if (!username) return message.reply("❌ اكتب يوزر صحيح.");

    const key = `${message.author.id}:${username}`;

    if (monitors[key]) {
      delete monitors[key];
      saveMonitors();
      return message.reply(`🛑 Cancelled monitoring @${username}`);
    }

    return message.reply(`❌ You are not monitoring @${username}`);
  }

  if (!content.startsWith("!unban")) return;

  const input = content.replace("!unban", "").trim();
  const username = getUsername(input);

  if (!username || username.includes(" ") || username.length < 2) {
    return message.reply(
      "❌ اكتب يوزر أو لينك صحيح.\nمثال: `!unban mr_tantawy1`"
    );
  }

  const key = `${message.author.id}:${username}`;

  if (monitors[key]) {
    return message.reply(`⚠️ Already monitoring @${username}`);
  }

  let dmChannel;

  try {
    dmChannel = await message.author.createDM();

    await dmChannel.send(
      `📡 Monitoring @${username} — updates will be sent here. ✅`
    );

    await message.reply("✅ Check your DM.");
  } catch {
    return message.reply(
      "❌ Please enable DMs from server members to use this bot."
    );
  }

  const startedAt = Date.now();
  const result = await enqueueCheck(username);
  const duration = formatDuration(Date.now() - startedAt);

  if (result.status === "error") {
    return dmChannel.send(
      `⚠️ Error checking @${username}\n\`${result.error}\``
    );
  }

  if (result.status === "active") {
    await sendRecovered(dmChannel, username, result, duration);

    monitors[key] = {
      username,
      userId: message.author.id,
      channelId: dmChannel.id,
      lastStatus: "active",
      startedAt,
      bannedStartedAt: null,
      activeHits: 0,
    };
    saveMonitors();

    return;
  }

  monitors[key] = {
    username,
    userId: message.author.id,
    channelId: dmChannel.id,
    lastStatus: result.status,
    startedAt,
    bannedStartedAt: startedAt,
    activeHits: 0,
  };
  saveMonitors();

  return sendUnavailable(dmChannel, username, result);
});

client.removeAllListeners("messageCreate");

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();
  if (!content.startsWith("!")) return;

  if (!message.guild) {
    return message.reply("Please use the bot inside your server. Private chats are created as server channels.");
  }

  const parts = content.split(/\s+/);
  const command = parts.shift().toLowerCase();
  const args = parts;
  const guildId = message.guild.id;
  const userId = message.author.id;
  const config = getGuildConfig(guildId);

  if (command === "!help") {
    return message.channel.send({ embeds: [buildHelpEmbed(message.guild)] });
  }

  if (command === "!setupname") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const name = args.join(" ").trim();
    if (name.length < 2 || name.length > 32) {
      return message.reply("Use: `!setupname Pablo Unbans` (2-32 characters).");
    }

    const nicknameChanged = await applyServerBotName(message, name);
    return message.reply(
      nicknameChanged
        ? `Server bot name set to **${name}**.`
        : `Saved **${name}**, but I could not change my nickname. Give me Manage Nicknames permission.`
    );
  }

  if (command === "!setupchannel") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const channel = resolveTextChannel(message, args);
    config.commandChannelId = channel.id;
    config.updatedAt = Date.now();
    saveGuildConfigs();

    return message.reply(`Command lobby set to ${channel}. Users can type \`!chat\` or \`!t username\` there.`);
  }

  if (command === "!setupcategory") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const category = resolveCategory(message, args);
    config.privateCategoryId = category?.id || null;
    config.updatedAt = Date.now();
    saveGuildConfigs();

    return message.reply(
      category
        ? `Private user rooms will be created under **${category.name}**.`
        : "Private user rooms will be created without a category."
    );
  }

  if (command === "!setuplogs") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const channel = resolveTextChannel(message, args);
    config.logsChannelId = channel.id;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    await sendGuildLog(guildId, "Logs channel configured", { channel: `#${channel.name}` });
    return message.reply(`Logs channel set to ${channel}.`);
  }

  if (command === "!setuprole") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const role = resolveRole(message, args);
    if (!role) return message.reply("Use: `!setuprole @Customer` or `!setuprole none`.");

    config.allowedRoleId = role.id;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(role.id ? `Allowed user role set to **${role.name}**.` : "Allowed user role cleared. Everyone can use the bot.");
  }

  if (command === "!setupadminrole") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const role = resolveRole(message, args);
    if (!role) return message.reply("Use: `!setupadminrole @Admin` or `!setupadminrole none`.");

    config.adminRoleId = role.id;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(role.id ? `Admin role set to **${role.name}**.` : "Admin role cleared. Manage Server still works.");
  }

  if (command === "!setupcleanup") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const hours = Math.max(0, Math.min(720, Number(args[0] || 24)));
    config.cleanupHours = hours;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(hours ? `Auto cleanup set to ${hours} hour(s).` : "Auto cleanup disabled.");
  }

  if (command === "!cleanup") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const closed = await cleanupInactiveRooms(guildId, true);
    return message.reply(`Closed ${closed} inactive private room(s).`);
  }

  if (command === "!pause" || command === "!resume") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    config.paused = command === "!pause";
    config.updatedAt = Date.now();
    saveGuildConfigs();
    await sendGuildLog(guildId, config.paused ? "Bot paused" : "Bot resumed", { by: message.author.tag });
    return message.reply(config.paused ? "Bot is paused for new monitoring sessions." : "Bot resumed.");
  }

  if (command === "!license") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use license commands.");

    const action = (args.shift() || "info").toLowerCase();
    if (action === "info") {
      const license = getLicenseStatus(guildId);
      return message.reply(`License: **${license.label}**`);
    }

    if (action === "set" || action === "extend") {
      const days = Math.max(1, Math.min(3650, Number(args[0] || 30)));
      const base = action === "extend" && config.licenseExpiresAt && config.licenseExpiresAt > Date.now()
        ? config.licenseExpiresAt
        : Date.now();
      config.licenseExpiresAt = base + days * 24 * 60 * 60 * 1000;
      config.updatedAt = Date.now();
      saveGuildConfigs();
      await sendGuildLog(guildId, "License updated", { action, days, expiresAt: new Date(config.licenseExpiresAt).toISOString() });
      return message.reply(`License ${action === "extend" ? "extended" : "set"} for ${days} day(s).`);
    }

    if (action === "clear" || action === "lifetime") {
      config.licenseExpiresAt = null;
      config.updatedAt = Date.now();
      saveGuildConfigs();
      return message.reply("License set to Lifetime.");
    }

    return message.reply("Use: `!license info`, `!license set 30`, `!license extend 15`, `!license clear`.");
  }

  if (command === "!setupbrand") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const field = (args.shift() || "").toLowerCase();
    const value = args.join(" ").trim();

    if (field === "name") {
      if (value.length < 2 || value.length > 32) return message.reply("Use: `!setupbrand name Pablo Unbans`.");
      await applyServerBotName(message, value);
      return message.reply(`Brand name set to **${value}**.`);
    }

    if (field === "color") {
      const color = normalizeHexColor(value);
      if (!color) return message.reply("Use a hex color like `#ff0055`.");
      config.embedColor = color;
    } else if (field === "logo") {
      if (value && !/^https?:\/\//i.test(value)) return message.reply("Logo must be a URL.");
      config.logoUrl = value;
    } else if (field === "roomprefix") {
      const prefix = sanitizeChannelName(value);
      if (!prefix) return message.reply("Use: `!setupbrand roomprefix pablo-ticket`.");
      config.roomPrefix = prefix;
    } else if (field === "welcome") {
      config.welcomeMessage = value.slice(0, 500);
    } else {
      return message.reply("Use: `!setupbrand name|color|logo|roomprefix|welcome <value>`.");
    }

    config.updatedAt = Date.now();
    saveGuildConfigs();
    await sendGuildLog(guildId, "Branding updated", { field });
    return message.reply(`Brand ${field} updated.`);
  }

  if (command === "!setupinfo") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");

    const embed = new EmbedBuilder()
      .setColor(getEmbedColor(guildId))
      .setTitle("Server Bot Setup")
      .setDescription(
        `**Bot name:** ${config.botName || getConfiguredBotName(message.guild)}\n` +
        `**Embed color:** ${config.embedColor || "#5865F2"}\n` +
        `**Room prefix:** ${config.roomPrefix || "unban"}\n` +
        `**Command lobby:** ${config.commandChannelId ? `<#${config.commandChannelId}>` : "Not set"}\n` +
        `**Private category:** ${config.privateCategoryId ? `<#${config.privateCategoryId}>` : "Not set"}\n` +
        `**Logs channel:** ${config.logsChannelId ? `<#${config.logsChannelId}>` : "Not set"}\n` +
        `**Allowed role:** ${config.allowedRoleId ? `<@&${config.allowedRoleId}>` : "Everyone"}\n` +
        `**Admin role:** ${config.adminRoleId ? `<@&${config.adminRoleId}>` : "Manage Server"}\n` +
        `**License:** ${getLicenseStatus(guildId).label}\n` +
        `**Paused:** ${config.paused ? "Yes" : "No"}\n` +
        `**Auto cleanup:** ${config.cleanupHours || 0}h\n` +
        `**Private rooms:** ${Object.keys(config.rooms || {}).length}`
      );

    return message.channel.send({ embeds: [embed] });
  }

  if (command === "!chat") {
    if (!canUseBot(message.member)) return message.reply("You do not have permission to use this bot.");
    if (!getLicenseStatus(guildId).active) return message.reply("This server license has expired. Contact support.");

    try {
      const room = await ensureUserRoom(message);
      touchUserRoom(guildId, userId);
      return message.reply(`Your private bot room is ${room}.`);
    } catch (error) {
      console.log("Create private room error:", error.message);
      return message.reply("I could not create your private room. Give me Manage Channels permission.");
    }
  }

  const monitorCommands = new Set(["!t", "!unban"]);
  const stopCommands = new Set(["!stop", "!cancel"]);
  const userCommands = new Set(["!list", "!clearall", "!stats", "!sesun", "!close", "!health"]);

  if (!monitorCommands.has(command) && !stopCommands.has(command) && !userCommands.has(command)) {
    return;
  }

  if (!canUseBot(message.member)) {
    return message.reply("You do not have permission to use this bot.");
  }

  if (!getLicenseStatus(guildId).active && command !== "!health") {
    return message.reply("This server license has expired. Contact support.");
  }

  if (config.paused && monitorCommands.has(command)) {
    return message.reply("Bot is paused for new monitoring sessions.");
  }

  let targetChannel;
  try {
    targetChannel = await getUserCommandChannel(message);
  } catch (error) {
    console.log("Private command channel error:", error.message);
    return message.reply("I could not open your private bot room. Give me Manage Channels permission.");
  }

  if (!targetChannel) return;

  if (monitorCommands.has(command)) {
    const usernames = parseUsernames(args.join(" "));
    await startMonitoringUsernames({ guildId, userId, channel: targetChannel }, usernames);
    return;
  }

  if (stopCommands.has(command)) {
    if (args[0]?.toLowerCase() === "all") {
      return clearUserMonitoring({ guildId, userId, channel: targetChannel });
    }

    const username = getUsername(args[0] || "");
    if (!username) return targetChannel.send("Use: `!stop <username>`");
    return stopMonitoringUsername({ guildId, userId, channel: targetChannel }, username);
  }

  if (command === "!clearall") {
    return clearUserMonitoring({ guildId, userId, channel: targetChannel });
  }

  if (command === "!list") {
    const entries = getUserMonitorEntries(guildId, userId)
      .map(([, item]) => `• @${item.username} — ${item.lastStatus}`)
      .join("\n");

    return targetChannel.send(entries || "You are not monitoring any accounts.");
  }

  if (command === "!stats") {
    return targetChannel.send({ embeds: [buildStatsEmbed(message)] });
  }

  if (command === "!health") {
    return targetChannel.send({ embeds: [buildHealthEmbed(message.guild)] });
  }

  if (command === "!close") {
    const active = getUserMonitorEntries(guildId, userId).length;
    if (active > 0) {
      return targetChannel.send("You still have monitored accounts. Use `!clearall` before closing this room.");
    }

    const delay = parseDurationMs(args[0] || "");
    if (delay === null) return targetChannel.send("Use: `!close` or `!close 10m`.");

    if (delay > 0) {
      config.roomCloseAt[userId] = Date.now() + delay;
      config.updatedAt = Date.now();
      saveGuildConfigs();
      await sendGuildLog(guildId, "Private room close scheduled", { userId, delay: args[0] });
      return targetChannel.send(`This room will close in ${args[0]}.`);
    }

    await targetChannel.send("Closing this room...");
    setTimeout(() => closeUserRoom(message.guild, userId, "User requested close"), 1500);
    return;
  }

  if (command === "!sesun") {
    const hours = Math.max(1, Math.min(168, Number(args[0] || 24)));
    return targetChannel.send({ embeds: [buildRecentUnbansEmbed(message, hours)] });
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.guild || !interaction.member || interaction.user.bot) return;

    const guildId = interaction.guild.id;
    const userId = interaction.user.id;
    const config = getGuildConfig(guildId);
    const context = { guildId, userId, channel: interaction.channel };

    if (!interaction.isButton() && !interaction.isModalSubmit()) return;

    if (!isUserRoom(config, userId, interaction.channelId)) {
      return interaction.reply({ content: "Use these controls inside your private room.", ephemeral: true });
    }

    touchUserRoom(guildId, userId);

    if (!canUseBot(interaction.member)) {
      return interaction.reply({ content: "You do not have permission to use this bot.", ephemeral: true });
    }

    if (!getLicenseStatus(guildId).active) {
      return interaction.reply({ content: "This server license has expired. Contact support.", ephemeral: true });
    }

    if (interaction.isButton()) {
      if (interaction.customId === "bot:start") {
        if (config.paused) return interaction.reply({ content: "Bot is paused for new monitoring sessions.", ephemeral: true });

        const modal = new ModalBuilder()
          .setCustomId("bot:start:modal")
          .setTitle("Start Monitoring");
        const input = new TextInputBuilder()
          .setCustomId("usernames")
          .setLabel("Instagram usernames")
          .setPlaceholder("username1 username2")
          .setRequired(true)
          .setStyle(TextInputStyle.Paragraph);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "bot:stop") {
        const modal = new ModalBuilder()
          .setCustomId("bot:stop:modal")
          .setTitle("Stop Monitoring");
        const input = new TextInputBuilder()
          .setCustomId("username")
          .setLabel("Instagram username")
          .setRequired(true)
          .setStyle(TextInputStyle.Short);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
      }

      await interaction.deferReply({ ephemeral: true });

      if (interaction.customId === "bot:list") {
        await sendUserMonitorList(context);
        return interaction.editReply("List sent.");
      }

      if (interaction.customId === "bot:stats") {
        await interaction.channel.send({ embeds: [buildStatsEmbed({ guild: interaction.guild, author: interaction.user, member: interaction.member })] });
        return interaction.editReply("Stats sent.");
      }

      if (interaction.customId === "bot:clear") {
        await clearUserMonitoring(context);
        return interaction.editReply("List cleared.");
      }

      if (interaction.customId === "bot:close") {
        const active = getUserMonitorEntries(guildId, userId).length;
        if (active > 0) return interaction.editReply("Clear your monitored accounts before closing this room.");

        await interaction.channel.send("Closing this room...");
        setTimeout(() => closeUserRoom(interaction.guild, userId, "User clicked close"), 1500);
        return interaction.editReply("Closing.");
      }

      return interaction.editReply("Unknown button.");
    }

    if (interaction.isModalSubmit()) {
      await interaction.deferReply({ ephemeral: true });

      if (interaction.customId === "bot:start:modal") {
        if (config.paused) return interaction.editReply("Bot is paused for new monitoring sessions.");

        const usernames = parseUsernames(interaction.fields.getTextInputValue("usernames"));
        await startMonitoringUsernames(context, usernames);
        return interaction.editReply("Monitoring request sent.");
      }

      if (interaction.customId === "bot:stop:modal") {
        const username = getUsername(interaction.fields.getTextInputValue("username"));
        if (!username) return interaction.editReply("Invalid username.");

        await stopMonitoringUsername(context, username);
        return interaction.editReply("Stop request sent.");
      }
    }
  } catch (error) {
    console.log("Interaction error:", error.message);
    if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    }
  }
});

function startMonitorLoop() {
  setInterval(async () => {
    const entries = Object.entries(monitors);

    for (const [key, item] of entries) {
      enqueueCheck(item.username)
        .then(async (result) => {
          if (result.status === "error") {
            console.log("MONITOR CHECK ERROR:", item.username, result.error);
            return;
          }

          if (
            (item.lastStatus === "banned" ||
              item.lastStatus === "login" ||
              item.lastStatus === "unknown") &&
            result.status === "active"
          ) {
            item.activeHits = (item.activeHits || 0) + 1;
            saveMonitors();

            console.log(
              `ACTIVE CONFIRMATION ${item.username}: ${item.activeHits}/${ACTIVE_CONFIRMATIONS}`
            );

            if (item.activeHits < ACTIVE_CONFIRMATIONS) {
              saveMonitors();
              safeDelete(result.screenshot);
              return;
            }

            const duration = item.bannedStartedAt
              ? formatDuration(Date.now() - item.bannedStartedAt)
              : "Unknown";

            const channel = await client.channels.fetch(item.channelId);

            await sendRecovered(channel, item.username, result, duration, {
              guildId: item.guildId,
              userId: item.userId,
            });

            item.lastStatus = "active";
            item.activeHits = 0;
            item.bannedStartedAt = null;
            saveMonitors();

            return;
          }

          if (result.status !== "active") {
            item.activeHits = 0;
          }

          if (item.lastStatus === "active" && result.status === "banned") {
            item.bannedStartedAt = Date.now();
          }

          item.lastStatus = result.status;
          saveMonitors();

          safeDelete(result.screenshot);
        })
        .catch((error) => {
          console.log("Monitor error:", error.message);
        });
    }
  }, CHECK_EVERY_SECONDS * 1000);
}

client.login(process.env.DISCORD_BOT_TOKEN);
