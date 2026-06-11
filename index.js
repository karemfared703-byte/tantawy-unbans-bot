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
const TRIAL_DAYS = Math.max(1, Math.min(30, Number(process.env.TRIAL_DAYS || 7)));
const BACKUP_EVERY_HOURS = Math.max(1, Math.min(168, Number(process.env.BACKUP_EVERY_HOURS || 6)));
const OWNER_IDS = new Set(
  String(process.env.OWNER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const OWNER_LOG_CHANNEL_ID = String(process.env.OWNER_LOG_CHANNEL_ID || "").trim();
const SUPPORT_CHANNEL_ID = String(process.env.SUPPORT_CHANNEL_ID || OWNER_LOG_CHANNEL_ID || "").trim();
const COMMAND_DELETE_SECONDS = Math.max(0, Math.min(300, Number(process.env.COMMAND_DELETE_SECONDS || 10)));
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
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(DATA_DIR, "backups");

const PLAN_DEFINITIONS = {
  trial: {
    name: "Trial",
    price: "Trial",
    maxUsers: 2,
    maxRooms: 3,
    dailySessions: 10,
    maxSessionHours: 6,
    lockedFeatures: ["webhook"],
  },
  free: {
    name: "Free",
    price: "Free",
    maxUsers: 1,
    maxRooms: 2,
    dailySessions: 5,
    maxSessionHours: 2,
    lockedFeatures: ["webhook", "daily_report", "white_label"],
  },
  basic: {
    name: "Basic",
    price: "300 EGP/month",
    maxUsers: 5,
    maxRooms: 8,
    dailySessions: 50,
    maxSessionHours: 24,
    lockedFeatures: ["webhook"],
  },
  pro: {
    name: "Pro",
    price: "600 EGP/month",
    maxUsers: 20,
    maxRooms: 30,
    dailySessions: 200,
    maxSessionHours: 72,
    lockedFeatures: [],
  },
  vip: {
    name: "VIP",
    price: "1000+ EGP/month",
    maxUsers: 999,
    maxRooms: 999,
    dailySessions: 9999,
    maxSessionHours: 720,
    lockedFeatures: [],
  },
};

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
    sessionExpiresAt: item.sessionExpiresAt ? Number(item.sessionExpiresAt) : null,
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

function todayKey(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 10);
}

function addDays(timestamp, days) {
  return timestamp + days * 24 * 60 * 60 * 1000;
}

function defaultGuildConfig(guildId, now = Date.now()) {
  return {
    guildId,
    botName: "",
    embedColor: "#5865F2",
    logoUrl: "",
    welcomeMessage: "",
    guideMessage: "",
    footerText: "",
    errorMessage: "",
    roomPrefix: "unban",
    commandChannelId: null,
    privateCategoryId: null,
    logsChannelId: null,
    guideChannelId: null,
    supportChannelId: null,
    allowedRoleId: null,
    adminRoleId: null,
    licenseExpiresAt: null,
    plan: "trial",
    planExpiresAt: addDays(now, TRIAL_DAYS),
    trialStartedAt: now,
    trialEndsAt: addDays(now, TRIAL_DAYS),
    disabledByOwner: false,
    cleanupHours: 24,
    cooldownSeconds: 0,
    commandDeleteSeconds: COMMAND_DELETE_SECONDS,
    dailyReportEnabled: false,
    lastDailyReportDate: "",
    lang: "en",
    webhookUrl: "",
    paused: false,
    rooms: {},
    roomActivity: {},
    roomCloseAt: {},
    userCooldowns: {},
    activity: {
      date: todayKey(),
      roomsOpened: 0,
      sessionsStarted: 0,
      stopped: 0,
      cleared: 0,
      errors: 0,
      activeUsers: {},
    },
    feedback: {
      count: 0,
      total: 0,
      last: [],
    },
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeGuildConfig(guildId, config = {}, isLoaded = false) {
  const now = Date.now();
  const defaults = defaultGuildConfig(guildId, now);
  const migratedPlan = config.plan || (isLoaded ? (config.licenseExpiresAt ? "basic" : "vip") : defaults.plan);
  const plan = PLAN_DEFINITIONS[migratedPlan] ? migratedPlan : defaults.plan;
  const trialStartedAt = Number(config.trialStartedAt || config.createdAt || now);
  const trialEndsAt = Number(config.trialEndsAt || (plan === "trial" ? addDays(trialStartedAt, TRIAL_DAYS) : 0)) || null;

  return {
    ...defaults,
    ...config,
    guildId,
    botName: String(config.botName || defaults.botName),
    embedColor: String(config.embedColor || defaults.embedColor),
    logoUrl: String(config.logoUrl || defaults.logoUrl),
    welcomeMessage: String(config.welcomeMessage || defaults.welcomeMessage),
    guideMessage: String(config.guideMessage || defaults.guideMessage),
    footerText: String(config.footerText || defaults.footerText),
    errorMessage: String(config.errorMessage || defaults.errorMessage),
    roomPrefix: String(config.roomPrefix || defaults.roomPrefix),
    commandChannelId: config.commandChannelId || null,
    privateCategoryId: config.privateCategoryId || null,
    logsChannelId: config.logsChannelId || null,
    guideChannelId: config.guideChannelId || null,
    supportChannelId: config.supportChannelId || null,
    allowedRoleId: config.allowedRoleId || null,
    adminRoleId: config.adminRoleId || null,
    licenseExpiresAt: config.licenseExpiresAt ? Number(config.licenseExpiresAt) : null,
    plan,
    planExpiresAt: config.planExpiresAt ? Number(config.planExpiresAt) : (plan === "trial" ? trialEndsAt : (config.licenseExpiresAt ? Number(config.licenseExpiresAt) : null)),
    trialStartedAt,
    trialEndsAt,
    disabledByOwner: Boolean(config.disabledByOwner),
    cleanupHours: Number(config.cleanupHours ?? defaults.cleanupHours),
    cooldownSeconds: Math.max(0, Math.min(3600, Number(config.cooldownSeconds || 0))),
    commandDeleteSeconds: Math.max(0, Math.min(300, Number(config.commandDeleteSeconds ?? defaults.commandDeleteSeconds))),
    dailyReportEnabled: Boolean(config.dailyReportEnabled),
    lastDailyReportDate: String(config.lastDailyReportDate || ""),
    lang: ["ar", "en"].includes(String(config.lang || "").toLowerCase()) ? String(config.lang).toLowerCase() : defaults.lang,
    webhookUrl: String(config.webhookUrl || ""),
    paused: Boolean(config.paused),
    rooms: config.rooms && typeof config.rooms === "object" ? config.rooms : {},
    roomActivity: config.roomActivity && typeof config.roomActivity === "object" ? config.roomActivity : {},
    roomCloseAt: config.roomCloseAt && typeof config.roomCloseAt === "object" ? config.roomCloseAt : {},
    userCooldowns: config.userCooldowns && typeof config.userCooldowns === "object" ? config.userCooldowns : {},
    activity: config.activity && typeof config.activity === "object" ? { ...defaults.activity, ...config.activity } : defaults.activity,
    feedback: config.feedback && typeof config.feedback === "object" ? {
      count: Number(config.feedback.count || 0),
      total: Number(config.feedback.total || 0),
      last: Array.isArray(config.feedback.last) ? config.feedback.last.slice(-10) : [],
    } : defaults.feedback,
    createdAt: Number(config.createdAt || now),
    updatedAt: Number(config.updatedAt || now),
  };
}

function getGuildConfig(guildId) {
  if (!guildConfigs[guildId]) {
    guildConfigs[guildId] = defaultGuildConfig(guildId);
  }

  guildConfigs[guildId] = normalizeGuildConfig(guildId, guildConfigs[guildId]);
  if (!guildConfigs[guildId].rooms) guildConfigs[guildId].rooms = {};
  if (!guildConfigs[guildId].roomActivity) guildConfigs[guildId].roomActivity = {};
  if (!guildConfigs[guildId].roomCloseAt) guildConfigs[guildId].roomCloseAt = {};
  if (!guildConfigs[guildId].userCooldowns) guildConfigs[guildId].userCooldowns = {};
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
      guildConfigs[guildId] = normalizeGuildConfig(guildId, config, true);
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

function getPlanDefinition(plan) {
  return PLAN_DEFINITIONS[String(plan || "").toLowerCase()] || PLAN_DEFINITIONS.trial;
}

function formatLimit(value) {
  return value >= 999 ? "Unlimited" : String(value);
}

function getPlanStatus(guildId) {
  const config = getGuildConfig(guildId);
  const plan = getPlanDefinition(config.plan);
  const expiresAt = config.planExpiresAt || config.licenseExpiresAt || null;

  if (config.disabledByOwner) {
    return {
      active: false,
      plan,
      planKey: config.plan,
      label: `${plan.name} - disabled by owner`,
      reason: "This server has been disabled. Contact support.",
      daysLeft: null,
      expiresAt,
    };
  }

  if (!expiresAt) {
    return {
      active: true,
      plan,
      planKey: config.plan,
      label: `${plan.name} - Lifetime`,
      reason: "",
      daysLeft: null,
      expiresAt: null,
    };
  }

  const msLeft = expiresAt - Date.now();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  return {
    active: msLeft > 0,
    plan,
    planKey: config.plan,
    label: msLeft > 0
      ? `${plan.name} - ${daysLeft} day(s) left`
      : `${plan.name} - expired ${Math.abs(daysLeft)} day(s) ago`,
    reason: msLeft > 0
      ? ""
      : (config.plan === "trial"
        ? "Your trial has expired. Contact support to renew."
        : "This server license has expired. Contact support."),
    daysLeft,
    expiresAt,
  };
}

function getLicenseStatus(guildId) {
  const status = getPlanStatus(guildId);
  return {
    active: status.active,
    label: status.label,
    daysLeft: status.daysLeft,
  };
}

function getPlanLimitsText(guildId) {
  const status = getPlanStatus(guildId);
  const plan = status.plan;
  const locked = plan.lockedFeatures.length ? plan.lockedFeatures.join(", ") : "None";
  return [
    `Plan: ${plan.name}`,
    `Price: ${plan.price}`,
    `Users: ${formatLimit(plan.maxUsers)}`,
    `Private rooms: ${formatLimit(plan.maxRooms)}`,
    `Daily sessions: ${formatLimit(plan.dailySessions)}`,
    `Session duration: ${formatLimit(plan.maxSessionHours)} hour(s)`,
    `Locked features: ${locked}`,
  ].join("\n");
}

function getGuildActiveUserIds(guildId) {
  const config = getGuildConfig(guildId);
  const ids = new Set(Object.keys(config.rooms || {}));
  for (const item of Object.values(monitors)) {
    if (item.guildId === guildId && item.userId) ids.add(item.userId);
  }
  return ids;
}

function getDailyActivity(guildId) {
  const config = getGuildConfig(guildId);
  const key = todayKey();
  if (!config.activity || config.activity.date !== key) {
    config.activity = {
      date: key,
      roomsOpened: 0,
      sessionsStarted: 0,
      stopped: 0,
      cleared: 0,
      errors: 0,
      activeUsers: {},
    };
    config.updatedAt = Date.now();
    saveGuildConfigs();
  }
  if (!config.activity.activeUsers || typeof config.activity.activeUsers !== "object") {
    config.activity.activeUsers = {};
  }
  return config.activity;
}

function incrementActivity(guildId, field, userId = null, amount = 1) {
  const activity = getDailyActivity(guildId);
  activity[field] = Number(activity[field] || 0) + amount;
  if (userId) {
    activity.activeUsers[userId] = Number(activity.activeUsers[userId] || 0) + amount;
  }
  const config = getGuildConfig(guildId);
  config.updatedAt = Date.now();
  saveGuildConfigs();
}

function getTopActivityUser(guildId) {
  const activity = getDailyActivity(guildId);
  const entries = Object.entries(activity.activeUsers || {}).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return "None";
  return `<@${entries[0][0]}> (${entries[0][1]})`;
}

function getFeatureBlockReason(guildId, feature) {
  const status = getPlanStatus(guildId);
  if (!status.active) return status.reason;
  if (feature && status.plan.lockedFeatures.includes(feature)) {
    return `${feature.replace(/_/g, " ")} is locked on the ${status.plan.name} plan. Upgrade this server plan to use it.`;
  }
  return "";
}

function getRoomCreationBlockReason(guildId, userId) {
  const status = getPlanStatus(guildId);
  if (!status.active) return status.reason;

  const config = getGuildConfig(guildId);
  const plan = status.plan;
  const existingRoom = Boolean(config.rooms?.[userId]);
  const roomCount = Object.keys(config.rooms || {}).length;
  const activeUsers = getGuildActiveUserIds(guildId);

  if (!existingRoom && roomCount >= plan.maxRooms) {
    return `This plan allows ${formatLimit(plan.maxRooms)} private room(s). Upgrade the server plan or close old rooms.`;
  }

  if (!activeUsers.has(userId) && activeUsers.size >= plan.maxUsers) {
    return `This plan allows ${formatLimit(plan.maxUsers)} user(s). Upgrade the server plan.`;
  }

  return "";
}

function checkCooldown(guildId, userId, action) {
  const config = getGuildConfig(guildId);
  const seconds = Number(config.cooldownSeconds || 0);
  if (!seconds) return { allowed: true, remaining: 0 };

  const key = `${userId}:${action}`;
  const last = Number(config.userCooldowns?.[key] || 0);
  const remaining = seconds * 1000 - (Date.now() - last);
  return {
    allowed: remaining <= 0,
    remaining: Math.ceil(Math.max(0, remaining) / 1000),
  };
}

function markCooldown(guildId, userId, action) {
  const config = getGuildConfig(guildId);
  if (!config.cooldownSeconds) return;
  config.userCooldowns[`${userId}:${action}`] = Date.now();
  config.updatedAt = Date.now();
  saveGuildConfigs();
}

function consumeDailySession(guildId, userId) {
  const status = getPlanStatus(guildId);
  if (!status.active) return status.reason;

  const activity = getDailyActivity(guildId);
  if (Number(activity.sessionsStarted || 0) >= status.plan.dailySessions) {
    return `This plan allows ${formatLimit(status.plan.dailySessions)} session(s) per day. Upgrade this server plan.`;
  }

  incrementActivity(guildId, "sessionsStarted", userId);
  return "";
}

function getSessionExpiresAt(guildId) {
  const status = getPlanStatus(guildId);
  const hours = Number(status.plan.maxSessionHours || 0);
  if (!hours || hours >= 999) return null;
  return Date.now() + hours * 60 * 60 * 1000;
}

function getFeedbackSummary(guildId) {
  const feedback = getGuildConfig(guildId).feedback || { count: 0, total: 0 };
  const count = Number(feedback.count || 0);
  const total = Number(feedback.total || 0);
  return {
    count,
    average: count ? (total / count).toFixed(1) : "N/A",
  };
}

function recordRating(guildId, userId, score) {
  const config = getGuildConfig(guildId);
  const value = Math.max(1, Math.min(5, Number(score || 0)));
  if (!config.feedback) config.feedback = { count: 0, total: 0, last: [] };
  config.feedback.count = Number(config.feedback.count || 0) + 1;
  config.feedback.total = Number(config.feedback.total || 0) + value;
  config.feedback.last = Array.isArray(config.feedback.last) ? config.feedback.last : [];
  config.feedback.last.push({ userId, score: value, at: Date.now() });
  config.feedback.last = config.feedback.last.slice(-10);
  config.updatedAt = Date.now();
  saveGuildConfigs();
}

function isOwner(userId) {
  return OWNER_IDS.has(String(userId || ""));
}

function shortValue(value, max = 900) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

async function sendOwnerReport(title, fields = {}, files = []) {
  const description = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `**${key}:** ${shortValue(value, 900)}`)
    .join("\n") || "No details.";

  const embed = new EmbedBuilder()
    .setColor(0xff3366)
    .setTitle(shortValue(title, 250))
    .setDescription(description)
    .setTimestamp(new Date());

  const payload = { embeds: [embed] };
  if (files.length) payload.files = files;

  try {
    const channelId = SUPPORT_CHANNEL_ID || OWNER_LOG_CHANNEL_ID;
    if (channelId) {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (channel?.isTextBased?.()) {
        await channel.send(payload);
        return true;
      }
    }

    for (const ownerId of OWNER_IDS) {
      const user = await client.users.fetch(ownerId).catch(() => null);
      if (!user) continue;
      await user.send(payload).catch(() => {});
    }
    return OWNER_IDS.size > 0;
  } catch (error) {
    console.log("Owner report error:", error.message);
    return false;
  }
}

async function sendBroadcastToGuild(guildId, text) {
  const config = getGuildConfig(guildId);
  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return false;

  const channelId = config.logsChannelId || config.commandChannelId || guild.systemChannelId;
  const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
  if (!channel?.isTextBased?.()) return false;

  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(guildId))
    .setTitle("Bot Announcement")
    .setDescription(shortValue(text, 3500))
    .setFooter({ text: getConfiguredBotName(guild) })
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] });
  return true;
}

async function broadcastToGuilds(text) {
  let sent = 0;
  let failed = 0;

  for (const guild of client.guilds.cache.values()) {
    const ok = await sendBroadcastToGuild(guild.id, text).catch(() => false);
    if (ok) sent++;
    else failed++;
  }

  return { sent, failed };
}

async function emitWebhookEvent(guildId, type, payload = {}) {
  const config = getGuildConfig(guildId);
  const url = String(config.webhookUrl || "").trim();
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        guildId,
        at: new Date().toISOString(),
        payload,
      }),
    });
  } catch (error) {
    console.log("Webhook event error:", error.message);
  }
}

async function reportError(error, context = {}) {
  const message = error?.message || String(error || "Unknown error");
  const guildId = context.guildId || context.guild?.id || context.message?.guild?.id || null;

  if (guildId) {
    incrementActivity(guildId, "errors", context.userId || context.message?.author?.id || null);
    addOperationLog(guildId, "Error reported", {
      command: context.command || "",
      error: message,
    });
    await emitWebhookEvent(guildId, "error", {
      command: context.command || "",
      userId: context.userId || context.message?.author?.id || "",
      error: message,
    });
  }

  await sendOwnerReport("Bot error", {
    server: context.guild?.name || context.message?.guild?.name || guildId || "unknown",
    command: context.command || "unknown",
    user: context.userTag || context.message?.author?.tag || context.userId || "unknown",
    error: message,
  });
}

function createBackup() {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filePath = path.join(BACKUPS_DIR, `backup-${timestamp}.json`);
  writeJsonAtomic(filePath, {
    createdAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    monitors,
    guildConfigs,
    recentUnbans,
  });

  try {
    const files = fs.readdirSync(BACKUPS_DIR)
      .filter((file) => file.startsWith("backup-") && file.endsWith(".json"))
      .sort();
    for (const old of files.slice(0, Math.max(0, files.length - 30))) {
      fs.unlinkSync(path.join(BACKUPS_DIR, old));
    }
  } catch (error) {
    console.log("Backup prune error:", error.message);
  }

  return filePath;
}

function startBackupLoop() {
  try {
    const filePath = createBackup();
    console.log(`Backup created: ${filePath}`);
  } catch (error) {
    console.log("Backup error:", error.message);
  }

  setInterval(() => {
    try {
      const filePath = createBackup();
      console.log(`Backup created: ${filePath}`);
    } catch (error) {
      console.log("Backup error:", error.message);
      reportError(error, { command: "auto-backup" }).catch(() => {});
    }
  }, BACKUP_EVERY_HOURS * 60 * 60 * 1000);
}

async function sendDailyActivityReport(guildId, force = false) {
  const config = getGuildConfig(guildId);
  if (!force && !config.dailyReportEnabled) return false;
  if (!config.logsChannelId) return false;

  const key = todayKey();
  if (!force && config.lastDailyReportDate === key) return false;
  if (!force && new Date().getUTCHours() < 20) return false;

  const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
  const channel = await client.channels.fetch(config.logsChannelId).catch(() => null);
  if (!guild || !channel?.isTextBased?.()) return false;

  const activity = getDailyActivity(guildId);
  const feedback = getFeedbackSummary(guildId);
  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(guildId))
    .setTitle("Daily Activity Report")
    .setDescription(
      `**Server:** ${guild.name}\n` +
      `**Private rooms opened:** ${activity.roomsOpened || 0}\n` +
      `**Sessions started:** ${activity.sessionsStarted || 0}\n` +
      `**Stopped:** ${activity.stopped || 0}\n` +
      `**Cleared:** ${activity.cleared || 0}\n` +
      `**Errors:** ${activity.errors || 0}\n` +
      `**Most active user:** ${getTopActivityUser(guildId)}\n` +
      `**Average rating:** ${feedback.average} (${feedback.count})`
    )
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] });
  config.lastDailyReportDate = key;
  config.updatedAt = Date.now();
  saveGuildConfigs();
  return true;
}

function startDailyReportLoop() {
  setInterval(() => {
    for (const guildId of Object.keys(guildConfigs)) {
      sendDailyActivityReport(guildId).catch((error) => {
        console.log("Daily report error:", error.message);
      });
    }
  }, 60 * 60 * 1000);
}

function hasRole(member, roleId) {
  return Boolean(roleId && member?.roles?.cache?.has(roleId));
}

function canUseBot(member) {
  if (!member?.guild) return false;
  const config = getGuildConfig(member.guild.id);
  if (isOwner(member.user?.id)) return true;
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

function deleteMessageLater(message, seconds = COMMAND_DELETE_SECONDS) {
  const wait = Math.max(0, Number(seconds || 0));
  if (!message?.delete || !wait) return;
  setTimeout(() => message.delete().catch(() => {}), wait * 1000);
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

function getRatingButtons() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("bot:rate:1").setLabel("1").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot:rate:2").setLabel("2").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot:rate:3").setLabel("3").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("bot:rate:4").setLabel("4").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("bot:rate:5").setLabel("5").setStyle(ButtonStyle.Success)
    ),
  ];
}

function buildWelcomeEmbed(member) {
  const config = getGuildConfig(member.guild.id);
  const name = config.botName || getConfiguredBotName(member.guild);
  const isArabic = config.lang === "ar";
  const description = config.welcomeMessage || (
    isArabic
      ? "الروم الخاص جاهز. استخدم الازرار تحت او اكتب الامر اللي محتاجه."
      : "Your private room is ready. Use the buttons below or type a command."
  );
  const commandsText = isArabic
    ? "**Available Commands:**\n" +
      "`!t username` - Start monitoring\n" +
      "`!stop username` - Stop monitoring\n" +
      "`!list` - Show your list\n" +
      "`!stats` - Show stats\n" +
      "`!sesun 24` - Recent unbans\n" +
      "`!support` - Contact support\n" +
      "`!close` - Close this room"
    : "**Available Commands:**\n" +
      "`!t username` - Start monitoring\n" +
      "`!stop username` - Stop monitoring\n" +
      "`!list` - Show your list\n" +
      "`!stats` - Show stats\n" +
      "`!sesun 24` - Recent unbans\n" +
      "`!support` - Contact support\n" +
      "`!close` - Close this room";

  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(member.guild.id))
    .setTitle(`Welcome ${member.displayName || member.user.username}`)
    .setDescription(`${description}\n\n${commandsText}`)
    .setFooter({ text: config.footerText || name });

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

async function requestRoomRatingAndClose(guild, userId, channel, reason = "User requested close") {
  const config = getGuildConfig(guild.id);
  config.roomCloseAt[userId] = Date.now() + 60 * 1000;
  config.updatedAt = Date.now();
  saveGuildConfigs();

  await channel.send({
    content: "Rate your experience from 1 to 5. This room will close in 60 seconds.",
    components: getRatingButtons(),
  }).catch(() => {});

  await sendGuildLog(guild.id, "Private room close scheduled", { userId, reason });
  setTimeout(() => closeUserRoom(guild, userId, reason).catch(() => {}), 60 * 1000);
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
  const planBlock = getRoomCreationBlockReason(guild.id, message.author.id);
  if (planBlock) {
    const error = new Error(planBlock);
    error.code = "PLAN_LIMIT";
    throw error;
  }

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
  incrementActivity(guild.id, "roomsOpened", message.author.id);
  await sendGuildLog(guild.id, "Private room opened", {
    user: message.author.tag,
    channel: `#${channel.name}`,
  });
  await emitWebhookEvent(guild.id, "room_created", {
    userId: message.author.id,
    userTag: message.author.tag,
    channelId: channel.id,
    channelName: channel.name,
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
  await emitWebhookEvent(guild.id, "room_closed", { userId, reason });
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
      .then((msg) => deleteMessageLater(msg, config.commandDeleteSeconds || COMMAND_DELETE_SECONDS))
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
      { name: "!support", value: "Send a support request to the bot owner. (`!support`)" },
      { name: "!plan", value: "Show plan info and limits. (`!plan info`, `!plan limits`)" },
      { name: "!health", value: "Show bot health and storage status. (`!health`)" },
      { name: "Admin setup", value: "`!quicksetup <name>`\n`!setup`\n`!setupname <name>`\n`!setupchannel [#channel]`\n`!setupcategory <category>`\n`!setuplogs #bot-logs`\n`!setuprole @Role`\n`!setupadminrole @Role`\n`!setupcleanup 24`\n`!setupcooldown 60`\n`!setupbrand color #ff0055`\n`!setwebhook https://...`\n`!setupdailyreport on`\n`!exportconfig`" }
    )
    .setFooter({ text: botName });
}

function buildStatsEmbed(message) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const userEntries = getUserMonitorEntries(guildId, userId).map(([, item]) => item);
  const guildEntries = Object.values(monitors).filter((item) => item.guildId === guildId);
  const counts = {};
  const activity = getDailyActivity(guildId);
  const feedback = getFeedbackSummary(guildId);

  for (const item of guildEntries) {
    counts[item.lastStatus || "unknown"] = (counts[item.lastStatus || "unknown"] || 0) + 1;
  }
  const plan = getPlanStatus(guildId);

  return new EmbedBuilder()
    .setColor(getEmbedColor(guildId))
    .setTitle("📊 Bot Stats")
    .setDescription(
      `**Your monitored accounts:** ${userEntries.length}\n` +
      `**Server monitored accounts:** ${guildEntries.length}\n` +
      `**Active:** ${counts.active || 0}\n` +
      `**Banned/Login/Unknown:** ${(counts.banned || 0) + (counts.login || 0) + (counts.unknown || 0)}\n` +
      `**Plan:** ${plan.label}\n` +
      `**Today sessions:** ${activity.sessionsStarted || 0}/${formatLimit(plan.plan.dailySessions)}\n` +
      `**Today rooms opened:** ${activity.roomsOpened || 0}\n` +
      `**Average rating:** ${feedback.average} (${feedback.count})`
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
      `**Backups directory:** ${BACKUPS_DIR}\n` +
      `**Storage:** ${storageOk ? "OK" : "ERROR"}\n` +
      `**Uptime:** ${uptime}\n` +
      `**Servers:** ${client.guilds.cache.size}\n` +
      `**Private rooms:** ${privateRooms}\n` +
      `**Owner IDs configured:** ${OWNER_IDS.size}\n` +
      `**Queue:** ${queue.length}\n` +
      `**Active jobs:** ${activeJobs}`
    );

  if (guild) embed.setFooter({ text: getConfiguredBotName(guild) });
  return embed;
}

function buildGuideEmbed(guild) {
  const config = getGuildConfig(guild.id);
  const botName = getConfiguredBotName(guild);
  const description = config.guideMessage || [
    `Welcome to ${botName}.`,
    "",
    "Start by typing `!chat` in the command channel. The bot will create a private room that only you and the bot can see.",
    "",
    "Inside your private room you can use buttons or commands.",
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor(getEmbedColor(guild.id))
    .setTitle(`${botName} Guide`)
    .setDescription(description)
    .addFields(
      { name: "User commands", value: "`!chat`\n`!t username`\n`!stop username`\n`!list`\n`!stats`\n`!sesun 24`\n`!support`\n`!close`" },
      { name: "Admin commands", value: "`!quicksetup <name>`\n`!setupinfo`\n`!setupbrand ...`\n`!setupcooldown 60`\n`!setupdailyreport on`\n`!setwebhook https://...`" }
    )
    .setFooter({ text: config.footerText || botName });

  if (config.logoUrl) embed.setThumbnail(config.logoUrl);
  return embed;
}

async function publishGuide(guild, channel = null) {
  const config = getGuildConfig(guild.id);
  const target = channel ||
    (config.guideChannelId ? await client.channels.fetch(config.guideChannelId).catch(() => null) : null) ||
    (config.commandChannelId ? await client.channels.fetch(config.commandChannelId).catch(() => null) : null);

  if (!target?.isTextBased?.()) return null;
  return target.send({ embeds: [buildGuideEmbed(guild)] });
}

function resolveTextChannelByInput(guild, input, fallback = null) {
  const raw = String(input || "").trim().replace(/[<#>]/g, "");
  if (!raw || raw.toLowerCase() === "skip") return fallback;
  const byId = guild.channels.cache.get(raw);
  if (byId?.type === ChannelType.GuildText) return byId;
  return guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === raw.toLowerCase()
  ) || fallback;
}

function resolveCategoryByInput(guild, input, fallback = null) {
  const raw = String(input || "").trim().replace(/[<#>]/g, "");
  if (!raw || raw.toLowerCase() === "skip") return fallback;
  const byId = guild.channels.cache.get(raw);
  if (byId?.type === ChannelType.GuildCategory) return byId;
  return guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === raw.toLowerCase()
  ) || fallback;
}

async function findOrCreateCategory(guild, name, permissionOverwrites = []) {
  const channelName = String(name || "Unban Rooms").trim().slice(0, 90) || "Unban Rooms";
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === channelName.toLowerCase()
  );
  if (existing) return existing;
  return guild.channels.create({
    name: channelName,
    type: ChannelType.GuildCategory,
    permissionOverwrites,
  });
}

async function findOrCreateTextChannel(guild, name, options = {}) {
  const channelName = sanitizeChannelName(name);
  const existing = guild.channels.cache.find(
    (channel) => channel.type === ChannelType.GuildText && channel.name.toLowerCase() === channelName
  );
  if (existing) return existing;
  return guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: options.parent || undefined,
    topic: options.topic || undefined,
    permissionOverwrites: options.permissionOverwrites || undefined,
  });
}

async function runSetupWizard(message) {
  const config = getGuildConfig(message.guild.id);
  const filter = (reply) => reply.author.id === message.author.id && reply.channel.id === message.channel.id;
  const ask = async (prompt) => {
    await message.channel.send(prompt);
    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 120000, errors: ["time"] });
    return collected.first().content.trim();
  };

  try {
    const botName = await ask("Setup 1/4: send the bot nickname, or `skip`.");
    if (botName.toLowerCase() !== "skip") {
      if (botName.length < 2 || botName.length > 32) return message.reply("Nickname must be 2-32 characters.");
      await applyServerBotName(message, botName);
    }

    const commandAnswer = await ask("Setup 2/4: mention the command channel, send its ID/name, or `skip`.");
    const commandChannel = resolveTextChannelByInput(message.guild, commandAnswer, null);
    if (commandChannel) config.commandChannelId = commandChannel.id;

    const categoryAnswer = await ask("Setup 3/4: send the private category name/ID, or `skip`.");
    const category = resolveCategoryByInput(message.guild, categoryAnswer, null);
    if (category) config.privateCategoryId = category.id;

    const logsAnswer = await ask("Setup 4/4: mention the logs channel, send its ID/name, or `skip`.");
    const logsChannel = resolveTextChannelByInput(message.guild, logsAnswer, null);
    if (logsChannel) config.logsChannelId = logsChannel.id;

    config.updatedAt = Date.now();
    saveGuildConfigs();
    await sendGuildLog(message.guild.id, "Setup wizard completed", { by: message.author.tag });
    return message.reply("Setup wizard completed. Run `!setupinfo` to review settings.");
  } catch {
    return message.reply("Setup wizard timed out. Run `!setup` again when you are ready.");
  }
}

async function runQuickSetup(message, rawName) {
  const guild = message.guild;
  const config = getGuildConfig(guild.id);
  const botName = rawName.trim().slice(0, 32) || config.botName || "Unbans Bot";

  const privateCategory = await findOrCreateCategory(guild, "Unban Rooms", [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
  ]);
  const commandChannel = await findOrCreateTextChannel(guild, "unban-bot", {
    topic: "Use !chat to open your private bot room.",
  });
  const guideChannel = await findOrCreateTextChannel(guild, "how-to-use", {
    topic: "How to use the unbans bot.",
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
        deny: [PermissionFlagsBits.SendMessages],
      },
      {
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
      },
    ],
  });
  const logsChannel = await findOrCreateTextChannel(guild, "bot-logs", {
    topic: "Private bot logs.",
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks],
      },
    ],
  });

  config.botName = botName;
  config.commandChannelId = commandChannel.id;
  config.privateCategoryId = privateCategory.id;
  config.logsChannelId = logsChannel.id;
  config.guideChannelId = guideChannel.id;
  config.roomPrefix = sanitizeChannelName(botName).slice(0, 24) || "unban";
  config.updatedAt = Date.now();
  saveGuildConfigs();

  await applyServerBotName(message, botName);
  await publishGuide(guild, guideChannel);
  await sendGuildLog(guild.id, "Quick setup completed", { by: message.author.tag });

  return message.reply(
    `Quick setup completed.\n` +
    `Command channel: ${commandChannel}\n` +
    `Guide channel: ${guideChannel}\n` +
    `Logs channel: ${logsChannel}\n` +
    `Private category: **${privateCategory.name}**`
  );
}

function parseDaysInput(value, fallback = 30) {
  const text = String(value || "").trim().toLowerCase();
  const match = text.match(/^(\d+)(d|day|days)?$/);
  if (!match) return fallback;
  return Math.max(1, Math.min(3650, Number(match[1])));
}

function sanitizeWebhookUrl(value) {
  const text = String(value || "").trim();
  if (!text || text.toLowerCase() === "clear" || text.toLowerCase() === "none") return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function exportableGuildConfig(config) {
  return {
    botName: config.botName || "",
    embedColor: config.embedColor || "#5865F2",
    logoUrl: config.logoUrl || "",
    welcomeMessage: config.welcomeMessage || "",
    guideMessage: config.guideMessage || "",
    footerText: config.footerText || "",
    errorMessage: config.errorMessage || "",
    roomPrefix: config.roomPrefix || "unban",
    commandChannelId: config.commandChannelId || null,
    privateCategoryId: config.privateCategoryId || null,
    logsChannelId: config.logsChannelId || null,
    guideChannelId: config.guideChannelId || null,
    allowedRoleId: config.allowedRoleId || null,
    adminRoleId: config.adminRoleId || null,
    cleanupHours: Number(config.cleanupHours || 24),
    cooldownSeconds: Number(config.cooldownSeconds || 0),
    commandDeleteSeconds: Number(config.commandDeleteSeconds || COMMAND_DELETE_SECONDS),
    dailyReportEnabled: Boolean(config.dailyReportEnabled),
    lang: config.lang || "en",
    webhookUrl: config.webhookUrl || "",
  };
}

function applyImportedGuildConfig(guildId, imported) {
  const config = getGuildConfig(guildId);
  const source = imported.config && typeof imported.config === "object" ? imported.config : imported;
  const allowed = exportableGuildConfig(source);

  config.botName = String(allowed.botName || "").slice(0, 32);
  config.logoUrl = String(allowed.logoUrl || "");
  config.welcomeMessage = String(allowed.welcomeMessage || "").slice(0, 500);
  config.guideMessage = String(allowed.guideMessage || "").slice(0, 1500);
  config.footerText = String(allowed.footerText || "").slice(0, 100);
  config.errorMessage = String(allowed.errorMessage || "").slice(0, 250);
  config.roomPrefix = sanitizeChannelName(allowed.roomPrefix || "unban");
  config.commandChannelId = allowed.commandChannelId || null;
  config.privateCategoryId = allowed.privateCategoryId || null;
  config.logsChannelId = allowed.logsChannelId || null;
  config.guideChannelId = allowed.guideChannelId || null;
  config.allowedRoleId = allowed.allowedRoleId || null;
  config.adminRoleId = allowed.adminRoleId || null;
  config.cleanupHours = Math.max(0, Math.min(720, Number(allowed.cleanupHours || 24)));
  config.cooldownSeconds = Math.max(0, Math.min(3600, Number(allowed.cooldownSeconds || 0)));
  config.commandDeleteSeconds = Math.max(0, Math.min(300, Number(allowed.commandDeleteSeconds || COMMAND_DELETE_SECONDS)));
  config.dailyReportEnabled = Boolean(allowed.dailyReportEnabled);
  config.lang = ["ar", "en"].includes(String(allowed.lang || "").toLowerCase()) ? String(allowed.lang).toLowerCase() : "en";
  config.webhookUrl = sanitizeWebhookUrl(allowed.webhookUrl) || "";
  const color = normalizeHexColor(allowed.embedColor || "");
  if (color) config.embedColor = color;
  config.updatedAt = Date.now();
  saveGuildConfigs();
  return config;
}

async function readImportPayload(message, args) {
  if (message.attachments.size) {
    const attachment = message.attachments.first();
    if (attachment.size > 200000) throw new Error("Config file is too large.");
    const response = await fetch(attachment.url);
    return response.text();
  }

  const raw = args.join(" ").trim();
  if (!raw) throw new Error("Attach a JSON file or paste JSON after `!importconfig`.");
  if (raw.length > 200000) throw new Error("Config JSON is too large.");
  return raw;
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
    const status = getPlanStatus(guildId);
    const activity = getDailyActivity(guildId);
    const feedback = getFeedbackSummary(guildId);
    const planOptions = Object.entries(PLAN_DEFINITIONS)
      .map(([key, plan]) => `<option value="${key}"${config.plan === key ? " selected" : ""}>${escapeHtml(plan.name)}</option>`)
      .join("");
    const recentOps = operationLogs
      .filter((item) => item.guildId === guildId)
      .slice(-6)
      .reverse()
      .map((item) => `<li><span>${escapeHtml(new Date(item.at).toLocaleString())}</span>${escapeHtml(item.message)}</li>`)
      .join("");
    const monitorChips = guildMonitors.slice(0, 20)
      .map((item) => `<span class="chip">@${escapeHtml(item.username)} <small>${escapeHtml(item.lastStatus)}</small></span>`)
      .join("");

    return `
      <section class="card">
        <div class="card-head">
          <div>
            <p class="eyebrow">${escapeHtml(guildId)}</p>
            <h2>${escapeHtml(guild?.name || guildId)}</h2>
            <p class="muted">${escapeHtml(status.label)}${config.paused ? " | Paused" : ""}</p>
          </div>
          <form method="post" action="/dashboard/guild/${encodeURIComponent(guildId)}/pause${tokenSuffix}">
            <input type="hidden" name="paused" value="${config.paused ? "false" : "true"}">
            <button class="${config.paused ? "success" : "ghost"}">${config.paused ? "Resume" : "Pause"}</button>
          </form>
        </div>

        <div class="mini-stats">
          <span><b>${guildMonitors.length}</b> sessions</span>
          <span><b>${Object.keys(config.rooms || {}).length}</b> rooms</span>
          <span><b>${activity.sessionsStarted || 0}</b> today sessions</span>
          <span><b>${feedback.average}</b> rating</span>
        </div>

        <form method="post" action="/dashboard/guild/${encodeURIComponent(guildId)}/config${tokenSuffix}" class="config-grid">
          <label>Bot name <input name="botName" value="${escapeHtml(config.botName)}"></label>
          <label>Embed color <input name="embedColor" value="${escapeHtml(config.embedColor)}"></label>
          <label>Logo URL <input name="logoUrl" value="${escapeHtml(config.logoUrl)}"></label>
          <label>Footer <input name="footerText" value="${escapeHtml(config.footerText || "")}"></label>
          <label>Room prefix <input name="roomPrefix" value="${escapeHtml(config.roomPrefix)}"></label>
          <label>Language
            <select name="lang">
              <option value="en"${config.lang !== "ar" ? " selected" : ""}>English</option>
              <option value="ar"${config.lang === "ar" ? " selected" : ""}>Arabic</option>
            </select>
          </label>
          <label>Command channel ID <input name="commandChannelId" value="${escapeHtml(config.commandChannelId || "")}"></label>
          <label>Private category ID <input name="privateCategoryId" value="${escapeHtml(config.privateCategoryId || "")}"></label>
          <label>Logs channel ID <input name="logsChannelId" value="${escapeHtml(config.logsChannelId || "")}"></label>
          <label>Guide channel ID <input name="guideChannelId" value="${escapeHtml(config.guideChannelId || "")}"></label>
          <label>Allowed role ID <input name="allowedRoleId" value="${escapeHtml(config.allowedRoleId || "")}"></label>
          <label>Admin role ID <input name="adminRoleId" value="${escapeHtml(config.adminRoleId || "")}"></label>
          <label>Cleanup hours <input name="cleanupHours" type="number" min="0" max="720" value="${escapeHtml(config.cleanupHours || 24)}"></label>
          <label>Cooldown seconds <input name="cooldownSeconds" type="number" min="0" max="3600" value="${escapeHtml(config.cooldownSeconds || 0)}"></label>
          <label>Command delete seconds <input name="commandDeleteSeconds" type="number" min="0" max="300" value="${escapeHtml(config.commandDeleteSeconds || COMMAND_DELETE_SECONDS)}"></label>
          <label>Daily report
            <select name="dailyReportEnabled">
              <option value="true"${config.dailyReportEnabled ? " selected" : ""}>On</option>
              <option value="false"${!config.dailyReportEnabled ? " selected" : ""}>Off</option>
            </select>
          </label>
          <label class="wide">Webhook URL <input name="webhookUrl" value="${escapeHtml(config.webhookUrl || "")}"></label>
          <label class="wide">Welcome message <textarea name="welcomeMessage">${escapeHtml(config.welcomeMessage)}</textarea></label>
          <label class="wide">Guide message <textarea name="guideMessage">${escapeHtml(config.guideMessage || "")}</textarea></label>
          <label class="wide">Custom error message <input name="errorMessage" value="${escapeHtml(config.errorMessage || "")}"></label>
          <button class="wide">Save config</button>
        </form>

        <form method="post" action="/dashboard/guild/${encodeURIComponent(guildId)}/license${tokenSuffix}" class="plan-row">
          <select name="plan">${planOptions}</select>
          <input name="days" type="number" min="1" max="3650" placeholder="30">
          <button name="action" value="set">Set plan</button>
          <button name="action" value="extend">Extend</button>
          <button name="action" value="clear">Lifetime</button>
          <button name="action" value="${config.disabledByOwner ? "enable" : "disable"}">${config.disabledByOwner ? "Enable" : "Disable"}</button>
        </form>

        <div class="split">
          <div>
            <h3>Monitored accounts</h3>
            <div class="chips">${monitorChips || "<span class=\"muted\">None</span>"}</div>
          </div>
          <div>
            <h3>Last operations</h3>
            <ul class="ops">${recentOps || "<li><span>Now</span>No operations yet.</li>"}</ul>
          </div>
        </div>
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
      :root{color-scheme:dark;--bg:#0b0f14;--panel:#121821;--panel2:#17202b;--line:#243142;--text:#edf3fb;--muted:#91a0b3;--accent:#22c55e;--accent2:#38bdf8;--danger:#fb7185}
      *{box-sizing:border-box}body{font-family:Inter,Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text);margin:0;padding:24px;letter-spacing:0}
      main{max-width:1280px;margin:0 auto}h1,h2,h3,p{margin-top:0}h1{font-size:28px;margin-bottom:6px}h2{font-size:20px;margin-bottom:4px}h3{font-size:14px;margin:18px 0 10px;color:#cbd5e1}
      .topbar{display:flex;justify-content:space-between;gap:16px;align-items:flex-end;margin-bottom:18px}.muted,.eyebrow{color:var(--muted)}.eyebrow{font-size:12px;margin:0 0 4px}
      .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:18px 0}
      .stat,.card{background:linear-gradient(180deg,var(--panel),#0f151d);border:1px solid var(--line);border-radius:8px;padding:16px}
      .stat span{display:block;color:var(--muted);font-size:13px}.stat b{display:block;font-size:28px;margin-top:8px}
      .card{margin:16px 0}.card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:14px}
      .mini-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:10px 0 16px}.mini-stats span{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px;color:var(--muted)}.mini-stats b{color:var(--text)}
      .config-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}.wide{grid-column:1/-1}
      label{color:#cbd5e1;font-size:13px}input,textarea,select{width:100%;margin-top:6px;background:#0b1118;color:var(--text);border:1px solid #2a394b;border-radius:6px;padding:9px;font:inherit}textarea{min-height:72px;resize:vertical}
      button{background:#2563eb;color:white;border:0;border-radius:6px;padding:9px 12px;cursor:pointer;font-weight:700}.ghost{background:#243142}.success{background:var(--accent);color:#04130a}
      .plan-row{display:flex;gap:8px;flex-wrap:wrap;margin:14px 0}.plan-row input{width:110px}.plan-row select{width:150px}
      .split{display:grid;grid-template-columns:minmax(0,1fr) minmax(260px,.8fr);gap:16px}.chips{display:flex;gap:8px;flex-wrap:wrap}.chip{background:#0b1118;border:1px solid #2a394b;border-radius:999px;padding:6px 10px}.chip small{color:var(--muted);margin-left:6px}
      .ops{padding:0;margin:0;list-style:none}.ops li{border-bottom:1px solid var(--line);padding:8px 0}.ops span{display:block;color:var(--muted);font-size:12px;margin-bottom:2px}
      table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:9px;text-align:left}
      @media(max-width:720px){body{padding:14px}.topbar,.card-head,.split{display:block}.plan-row select,.plan-row input{width:100%}}
    </style>
  </head>
  <body>
    <main>
      <div class="topbar">
        <div>
          <h1>Unbans Bot Dashboard</h1>
          <p class="muted">Status: ${stats.online ? "Online" : "Offline"} | Uptime: ${escapeHtml(stats.uptime)} | Data: ${escapeHtml(DATA_DIR)}</p>
        </div>
        <p class="muted">Backups: ${escapeHtml(BACKUPS_DIR)}</p>
      </div>
      <div class="stats">
        <div class="stat"><span>Servers</span><b>${stats.servers}</b></div>
        <div class="stat"><span>Sessions</span><b>${stats.sessions}</b></div>
        <div class="stat"><span>Private rooms</span><b>${stats.rooms}</b></div>
        <div class="stat"><span>Today unbans</span><b>${stats.todayUnbans}</b></div>
        <div class="stat"><span>Storage</span><b>${stats.storageOk ? "OK" : "ERR"}</b></div>
      </div>
      ${guildCards || "<p>No server configs yet. Run setup commands in Discord first.</p>"}
      <section class="card"><h2>Recent Unbans</h2><table><tr><th>Username</th><th>Followers</th><th>When</th></tr>${recentRows}</table></section>
    </main>
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
    config.guideMessage = (body.get("guideMessage") || "").slice(0, 1500);
    config.footerText = (body.get("footerText") || "").slice(0, 100);
    config.errorMessage = (body.get("errorMessage") || "").slice(0, 250);
    config.roomPrefix = sanitizeChannelName(body.get("roomPrefix") || "unban");
    config.commandChannelId = body.get("commandChannelId") || null;
    config.privateCategoryId = body.get("privateCategoryId") || null;
    config.logsChannelId = body.get("logsChannelId") || null;
    config.guideChannelId = body.get("guideChannelId") || null;
    config.allowedRoleId = body.get("allowedRoleId") || null;
    config.adminRoleId = body.get("adminRoleId") || null;
    config.cleanupHours = Math.max(0, Math.min(720, Number(body.get("cleanupHours") || 24)));
    config.cooldownSeconds = Math.max(0, Math.min(3600, Number(body.get("cooldownSeconds") || 0)));
    config.commandDeleteSeconds = Math.max(0, Math.min(300, Number(body.get("commandDeleteSeconds") || COMMAND_DELETE_SECONDS)));
    config.dailyReportEnabled = body.get("dailyReportEnabled") === "true";
    config.lang = ["ar", "en"].includes(String(body.get("lang") || "").toLowerCase())
      ? String(body.get("lang")).toLowerCase()
      : "en";
    const webhook = sanitizeWebhookUrl(body.get("webhookUrl") || "");
    if (webhook !== null) config.webhookUrl = webhook;
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
    const planKey = String(body.get("plan") || config.plan || "trial").toLowerCase();
    const days = Math.max(1, Math.min(3650, Number(body.get("days") || 30)));
    if (PLAN_DEFINITIONS[planKey]) config.plan = planKey;

    if (licenseAction === "clear") {
      config.licenseExpiresAt = null;
      config.planExpiresAt = null;
      config.plan = "vip";
    }
    if (licenseAction === "set") {
      config.planExpiresAt = Date.now() + days * 24 * 60 * 60 * 1000;
      config.licenseExpiresAt = config.planExpiresAt;
      config.disabledByOwner = false;
    }
    if (licenseAction === "extend") {
      const base = config.planExpiresAt && config.planExpiresAt > Date.now() ? config.planExpiresAt : Date.now();
      config.planExpiresAt = base + days * 24 * 60 * 60 * 1000;
      config.licenseExpiresAt = config.planExpiresAt;
    }
    if (licenseAction === "disable") config.disabledByOwner = true;
    if (licenseAction === "enable") config.disabledByOwner = false;

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
  if (meta?.guildId) {
    await emitWebhookEvent(meta.guildId, "account_recovered", {
      userId: meta.userId || "",
      username,
      followers: result.stats?.followers || "0",
      following: result.stats?.following || "0",
      duration,
    });
  }
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

  const cooldown = checkCooldown(guildId, userId, "start");
  if (!cooldown.allowed) {
    await channel.send(`Please wait ${cooldown.remaining}s before starting another session.`);
    return;
  }

  const dailyBlock = consumeDailySession(guildId, userId);
  if (dailyBlock) {
    await channel.send(dailyBlock);
    return;
  }

  markCooldown(guildId, userId, "start");

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
      await reportError(new Error(result.error), { guildId, userId, command: "!t" });
      continue;
    }

    const monitorRecord = {
      username,
      guildId,
      userId,
      channelId: channel.id,
      lastStatus: result.status === "active" ? "active" : result.status,
      startedAt,
      sessionExpiresAt: getSessionExpiresAt(guildId),
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
    await emitWebhookEvent(guildId, "session_started", {
      userId,
      username,
      status: result.status,
      channelId: channel.id,
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
  incrementActivity(guildId, "stopped", userId);
  await channel.send(`Stopped monitoring @${username}.`);
  await sendGuildLog(guildId, "Monitoring stopped", { userId, username });
  await emitWebhookEvent(guildId, "session_stopped", { userId, username });
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
  incrementActivity(guildId, "cleared", userId);
  await channel.send(`Cleared ${removed} monitored account(s).`);
  await sendGuildLog(guildId, "Monitoring list cleared", { userId, removed });
  await emitWebhookEvent(guildId, "sessions_cleared", { userId, removed });
}

async function sendUserMonitorList(context) {
  const { guildId, userId, channel } = context;
  const entries = getUserMonitorEntries(guildId, userId)
    .map(([, item]) => `â€¢ @${item.username} â€” ${item.lastStatus}`)
    .join("\n");

  await channel.send(entries || "You are not monitoring any accounts.");
}

function formatMonitorEntries(guildId, userId) {
  return getUserMonitorEntries(guildId, userId)
    .map(([, item]) => `- @${item.username} - ${item.lastStatus}`)
    .join("\n");
}

async function sendUserMonitorList(context) {
  const { guildId, userId, channel } = context;
  await channel.send(formatMonitorEntries(guildId, userId) || "You are not monitoring any accounts.");
}

client.once("ready", async () => {
  console.log(`Discord bot online: ${client.user.tag}`);
  console.log(`Persistent data directory: ${DATA_DIR}`);

  loadMonitors();
  loadGuildConfigs();
  loadRecentUnbans();
  for (const guild of client.guilds.cache.values()) {
    getGuildConfig(guild.id);
  }
  saveGuildConfigs();
  startDashboard();
  startBackupLoop();
  startDailyReportLoop();

  sharedBrowser = await launchBrowser();

  console.log(`Shared browser started. Concurrency: ${CONCURRENT_CHECKS}`);

  setInterval(restartBrowser, 1000 * 60 * BROWSER_RESTART_MINUTES);
  setInterval(cleanupOldScreenshots, 1000 * 60 * 5);
  setInterval(() => cleanupInactiveRooms().catch((error) => {
    console.log("Room cleanup error:", error.message);
  }), 1000 * 60 * 15);

  startMonitorLoop();
});

client.on("guildCreate", async (guild) => {
  const config = getGuildConfig(guild.id);
  config.plan = "trial";
  config.planExpiresAt = addDays(Date.now(), TRIAL_DAYS);
  config.trialStartedAt = Date.now();
  config.trialEndsAt = config.planExpiresAt;
  config.updatedAt = Date.now();
  saveGuildConfigs();
  await sendOwnerReport("Bot added to server", {
    server: guild.name,
    serverId: guild.id,
    trialDays: TRIAL_DAYS,
  });
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

  if (command === "!owner") {
    if (!isOwner(userId)) return message.reply("Owner only.");

    const action = (args.shift() || "help").toLowerCase();
    if (action === "guilds") {
      const lines = client.guilds.cache.map((guild) => {
        const status = getPlanStatus(guild.id);
        return `${guild.name} - ${guild.id} - ${status.label}`;
      });
      return message.reply(lines.join("\n").slice(0, 1900) || "No guilds.");
    }

    if (action === "stats") {
      const stats = dashboardStats();
      const planCounts = {};
      for (const id of Object.keys(guildConfigs)) {
        const plan = getGuildConfig(id).plan || "trial";
        planCounts[plan] = (planCounts[plan] || 0) + 1;
      }
      return message.reply(
        `Servers: ${stats.servers}\n` +
        `Sessions: ${stats.sessions}\n` +
        `Rooms: ${stats.rooms}\n` +
        `Storage: ${stats.storageOk ? "OK" : "ERR"}\n` +
        `Plans: ${Object.entries(planCounts).map(([plan, count]) => `${plan}=${count}`).join(", ") || "none"}`
      );
    }

    if (action === "disable" || action === "enable") {
      const targetGuildId = args[0];
      if (!targetGuildId) return message.reply("Use: `!owner disable <serverId>` or `!owner enable <serverId>`.");
      const targetConfig = getGuildConfig(targetGuildId);
      targetConfig.disabledByOwner = action === "disable";
      targetConfig.updatedAt = Date.now();
      saveGuildConfigs();
      return message.reply(`Server ${targetGuildId} ${action === "disable" ? "disabled" : "enabled"}.`);
    }

    if (action === "extend") {
      const targetGuildId = args[0];
      const days = parseDaysInput(args[1], 30);
      if (!targetGuildId) return message.reply("Use: `!owner extend <serverId> 30`.");
      const targetConfig = getGuildConfig(targetGuildId);
      const base = targetConfig.planExpiresAt && targetConfig.planExpiresAt > Date.now() ? targetConfig.planExpiresAt : Date.now();
      targetConfig.planExpiresAt = addDays(base, days);
      targetConfig.licenseExpiresAt = targetConfig.planExpiresAt;
      targetConfig.updatedAt = Date.now();
      saveGuildConfigs();
      return message.reply(`Extended ${targetGuildId} for ${days} day(s).`);
    }

    if (action === "broadcast") {
      const text = args.join(" ").trim();
      if (!text) return message.reply("Use: `!owner broadcast <message>`.");
      const result = await broadcastToGuilds(text);
      return message.reply(`Broadcast sent to ${result.sent} server(s), failed ${result.failed}.`);
    }

    if (action === "backup") {
      const filePath = createBackup();
      const file = new AttachmentBuilder(filePath);
      await sendOwnerReport("Manual backup created", { file: filePath }, [file]);
      return message.reply(`Backup created: ${filePath}`);
    }

    return message.reply("Owner commands: `guilds`, `stats`, `disable`, `enable`, `extend`, `broadcast`, `backup`.");
  }

  if (command === "!broadcast") {
    if (!isOwner(userId)) return message.reply("Owner only.");
    const text = args.join(" ").trim();
    if (!text) return message.reply("Use: `!broadcast <message>`.");
    const result = await broadcastToGuilds(text);
    return message.reply(`Broadcast sent to ${result.sent} server(s), failed ${result.failed}.`);
  }

  if (command === "!plan") {
    const action = (args.shift() || "info").toLowerCase();

    if (action === "info") {
      const status = getPlanStatus(guildId);
      return message.reply(`Plan: **${status.label}**\n${getPlanLimitsText(guildId)}`);
    }

    if (action === "limits") {
      return message.reply(`\`\`\`\n${getPlanLimitsText(guildId)}\n\`\`\``);
    }

    if (action === "set") {
      if (!isOwner(userId)) return message.reply("Only the bot owner can change paid plans.");
      const planKey = (args.shift() || "").toLowerCase();
      if (!PLAN_DEFINITIONS[planKey]) return message.reply("Use: `!plan set trial|free|basic|pro|vip 30d`.");
      const days = parseDaysInput(args[0], planKey === "trial" ? TRIAL_DAYS : 30);
      config.plan = planKey;
      config.planExpiresAt = addDays(Date.now(), days);
      config.licenseExpiresAt = config.planExpiresAt;
      if (planKey === "trial") {
        config.trialStartedAt = Date.now();
        config.trialEndsAt = config.planExpiresAt;
      }
      config.disabledByOwner = false;
      config.updatedAt = Date.now();
      saveGuildConfigs();
      await sendGuildLog(guildId, "Plan updated", { plan: planKey, days, by: message.author.tag });
      return message.reply(`Plan set to **${PLAN_DEFINITIONS[planKey].name}** for ${days} day(s).`);
    }

    return message.reply("Use: `!plan info`, `!plan limits`, `!plan set pro 30d`.");
  }

  if (command === "!support") {
    const room = config.rooms?.[userId] ? `<#${config.rooms[userId]}>` : `#${message.channel.name}`;
    const invite = await message.channel.createInvite({
      maxAge: 24 * 60 * 60,
      maxUses: 1,
      unique: true,
      reason: "Support request",
    }).then((created) => created.url).catch(() => "");
    await sendOwnerReport("Support request", {
      server: message.guild.name,
      serverId: guildId,
      user: message.author.tag,
      userId,
      room,
      invite,
      message: args.join(" ").trim() || "Client needs help.",
    });
    await sendGuildLog(guildId, "Support request sent", { user: message.author.tag });
    return message.reply("Support request sent. The owner will contact you.");
  }

  if (command === "!quicksetup") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    return runQuickSetup(message, args.join(" "));
  }

  if (command === "!setup") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    return runSetupWizard(message);
  }

  if (command === "!setupguide") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const channel = resolveTextChannel(message, args);
    config.guideChannelId = channel.id;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    await publishGuide(message.guild, channel);
    return message.reply(`Guide published in ${channel}.`);
  }

  if (command === "!setguide") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    config.guideMessage = args.join(" ").trim().slice(0, 1500);
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply("Guide message updated. Run `!setupguide` to publish it.");
  }

  if (command === "!setwelcome") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    config.welcomeMessage = args.join(" ").trim().slice(0, 500);
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply("Welcome message updated.");
  }

  if (command === "!setlang") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const lang = (args[0] || "").toLowerCase();
    if (!["ar", "en"].includes(lang)) return message.reply("Use: `!setlang ar` or `!setlang en`.");
    config.lang = lang;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(`Language set to ${lang}.`);
  }

  if (command === "!setcolor") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const block = getFeatureBlockReason(guildId, "white_label");
    if (block) return message.reply(block);
    const color = normalizeHexColor(args[0] || "");
    if (!color) return message.reply("Use a hex color like `#ff0055`.");
    config.embedColor = color;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(`Embed color set to ${color}.`);
  }

  if (command === "!setlogo") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const block = getFeatureBlockReason(guildId, "white_label");
    if (block) return message.reply(block);
    const url = args.join(" ").trim();
    if (url && !/^https?:\/\//i.test(url)) return message.reply("Logo must be a URL or empty.");
    config.logoUrl = url;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(url ? "Logo updated." : "Logo cleared.");
  }

  if (command === "!setfooter") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const block = getFeatureBlockReason(guildId, "white_label");
    if (block) return message.reply(block);
    config.footerText = args.join(" ").trim().slice(0, 100);
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply("Footer updated.");
  }

  if (command === "!setwebhook") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const block = getFeatureBlockReason(guildId, "webhook");
    if (block) return message.reply(block);
    const webhook = sanitizeWebhookUrl(args.join(" "));
    if (webhook === null) return message.reply("Use a valid HTTPS webhook URL, or `!setwebhook clear`.");
    config.webhookUrl = webhook;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(webhook ? "Webhook updated." : "Webhook cleared.");
  }

  if (command === "!setupcooldown") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const seconds = Math.max(0, Math.min(3600, Number(args[0] || 0)));
    config.cooldownSeconds = seconds;
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(seconds ? `Cooldown set to ${seconds}s.` : "Cooldown disabled.");
  }

  if (command === "!setupdailyreport") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const block = getFeatureBlockReason(guildId, "daily_report");
    if (block) return message.reply(block);
    const value = (args[0] || "on").toLowerCase();
    if (value === "test") {
      const sent = await sendDailyActivityReport(guildId, true);
      return message.reply(sent ? "Daily report sent." : "Set logs channel first with `!setuplogs #bot-logs`.");
    }
    config.dailyReportEnabled = value !== "off";
    config.updatedAt = Date.now();
    saveGuildConfigs();
    return message.reply(config.dailyReportEnabled ? "Daily report enabled." : "Daily report disabled.");
  }

  if (command === "!exportconfig") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const payload = {
      version: 1,
      exportedAt: new Date().toISOString(),
      guildId,
      config: exportableGuildConfig(config),
    };
    const file = new AttachmentBuilder(Buffer.from(JSON.stringify(payload, null, 2)), {
      name: `unbans-config-${guildId}.json`,
    });
    return message.reply({ content: "Server config export ready.", files: [file] });
  }

  if (command === "!importconfig") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    try {
      const raw = await readImportPayload(message, args);
      const imported = JSON.parse(raw);
      applyImportedGuildConfig(guildId, imported);
      if (config.botName) await applyServerBotName(message, config.botName);
      return message.reply("Config imported. Run `!setupinfo` to review it.");
    } catch (error) {
      return message.reply(`Import failed: ${error.message}`);
    }
  }

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
      if (!isOwner(userId)) return message.reply("Only the bot owner can update licenses.");
      const days = Math.max(1, Math.min(3650, Number(args[0] || 30)));
      const base = action === "extend" && config.licenseExpiresAt && config.licenseExpiresAt > Date.now()
        ? config.licenseExpiresAt
        : Date.now();
      config.licenseExpiresAt = base + days * 24 * 60 * 60 * 1000;
      config.planExpiresAt = config.licenseExpiresAt;
      if (!config.plan || config.plan === "trial") config.plan = "basic";
      config.updatedAt = Date.now();
      saveGuildConfigs();
      await sendGuildLog(guildId, "License updated", { action, days, expiresAt: new Date(config.licenseExpiresAt).toISOString() });
      return message.reply(`License ${action === "extend" ? "extended" : "set"} for ${days} day(s).`);
    }

    if (action === "clear" || action === "lifetime") {
      if (!isOwner(userId)) return message.reply("Only the bot owner can update licenses.");
      config.licenseExpiresAt = null;
      config.planExpiresAt = null;
      config.plan = "vip";
      config.updatedAt = Date.now();
      saveGuildConfigs();
      return message.reply("License set to Lifetime.");
    }

    return message.reply("Use: `!license info`, `!license set 30`, `!license extend 15`, `!license clear`.");
  }

  if (command === "!setupbrand") {
    if (!isAdmin(message.member)) return message.reply("You need Manage Server permission to use setup commands.");
    const block = getFeatureBlockReason(guildId, "white_label");
    if (block) return message.reply(block);

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
    } else if (field === "guide") {
      config.guideMessage = value.slice(0, 1500);
    } else if (field === "footer") {
      config.footerText = value.slice(0, 100);
    } else if (field === "error") {
      config.errorMessage = value.slice(0, 250);
    } else {
      return message.reply("Use: `!setupbrand name|color|logo|roomprefix|welcome|guide|footer|error <value>`.");
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
        `**Plan:** ${getPlanStatus(guildId).label}\n` +
        `**Paused:** ${config.paused ? "Yes" : "No"}\n` +
        `**Auto cleanup:** ${config.cleanupHours || 0}h\n` +
        `**Cooldown:** ${config.cooldownSeconds || 0}s\n` +
        `**Language:** ${config.lang || "en"}\n` +
        `**Daily report:** ${config.dailyReportEnabled ? "On" : "Off"}\n` +
        `**Guide channel:** ${config.guideChannelId ? `<#${config.guideChannelId}>` : "Not set"}\n` +
        `**Webhook:** ${config.webhookUrl ? "Set" : "Not set"}\n` +
        `**Private rooms:** ${Object.keys(config.rooms || {}).length}`
      );

    return message.channel.send({ embeds: [embed] });
  }

  if (command === "!chat") {
    if (!canUseBot(message.member)) return message.reply("You do not have permission to use this bot.");
    const planStatus = getPlanStatus(guildId);
    if (!planStatus.active) return message.reply(planStatus.reason);

    const cooldown = checkCooldown(guildId, userId, "chat");
    if (!cooldown.allowed) return message.reply(`Please wait ${cooldown.remaining}s before opening another room.`);

    try {
      const room = await ensureUserRoom(message);
      touchUserRoom(guildId, userId);
      markCooldown(guildId, userId, "chat");
      const reply = await message.reply(`Your private bot room is ${room}.`);
      deleteMessageLater(message, config.commandDeleteSeconds || COMMAND_DELETE_SECONDS);
      deleteMessageLater(reply, config.commandDeleteSeconds || COMMAND_DELETE_SECONDS);
      return;
    } catch (error) {
      console.log("Create private room error:", error.message);
      if (error.code === "PLAN_LIMIT") return message.reply(error.message);
      const text = config.errorMessage || "I could not create your private room. Give me Manage Channels permission.";
      await reportError(error, { guildId, userId, command: "!chat", message });
      return message.reply(text);
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

  const planStatus = getPlanStatus(guildId);
  if (!planStatus.active && command !== "!health") {
    return message.reply(planStatus.reason);
  }

  if (config.paused && monitorCommands.has(command)) {
    return message.reply("Bot is paused for new monitoring sessions.");
  }

  if (command === "!health") {
    return message.channel.send({ embeds: [buildHealthEmbed(message.guild)] });
  }

  let targetChannel;
  try {
    targetChannel = await getUserCommandChannel(message);
  } catch (error) {
    console.log("Private command channel error:", error.message);
    if (error.code === "PLAN_LIMIT") return message.reply(error.message);
    await reportError(error, { guildId, userId, command, message });
    return message.reply(config.errorMessage || "I could not open your private bot room. Give me Manage Channels permission.");
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
    const entries = formatMonitorEntries(guildId, userId);
    return targetChannel.send(entries || "You are not monitoring any accounts.");
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

    return requestRoomRatingAndClose(message.guild, userId, targetChannel, "User requested close");
  }

  if (command === "!sesun") {
    const requested = Math.max(1, Math.min(168, Number(args[0] || 24)));
    const maxHours = getPlanStatus(guildId).plan.maxSessionHours;
    if (requested > maxHours) {
      return targetChannel.send(`Your plan allows up to ${maxHours} hour(s) for session history.`);
    }
    const hours = requested;
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

    if (interaction.isButton() && interaction.customId.startsWith("bot:rate:")) {
      const score = Number(interaction.customId.split(":").pop());
      recordRating(guildId, userId, score);
      await sendGuildLog(guildId, "User rating received", { userId, score });
      await emitWebhookEvent(guildId, "rating_received", { userId, score });
      await interaction.reply({ content: `Thanks. Rating saved: ${score}/5.`, ephemeral: true });
      setTimeout(() => closeUserRoom(interaction.guild, userId, "Rated and closed").catch(() => {}), 2000);
      return;
    }

    if (!canUseBot(interaction.member)) {
      return interaction.reply({ content: "You do not have permission to use this bot.", ephemeral: true });
    }

    const planStatus = getPlanStatus(guildId);
    if (!planStatus.active) {
      return interaction.reply({ content: planStatus.reason, ephemeral: true });
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

        await requestRoomRatingAndClose(interaction.guild, userId, interaction.channel, "User clicked close");
        return interaction.editReply("Rating requested. Room will close soon.");
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
    await reportError(error, {
      guildId: interaction.guild?.id,
      userId: interaction.user?.id,
      userTag: interaction.user?.tag,
      command: interaction.customId || "interaction",
    }).catch(() => {});
    if (interaction.isRepliable?.() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong.", ephemeral: true }).catch(() => {});
    }
  }
});

function startMonitorLoop() {
  setInterval(async () => {
    const entries = Object.entries(monitors);

    for (const [key, item] of entries) {
      if (item.sessionExpiresAt && item.sessionExpiresAt <= Date.now()) {
        delete monitors[key];
        saveMonitors();
        client.channels.fetch(item.channelId)
          .then((channel) => channel?.send?.(`Session expired for @${item.username}.`).catch(() => {}))
          .catch(() => {});
        sendGuildLog(item.guildId, "Monitoring session expired", {
          userId: item.userId,
          username: item.username,
        }).catch(() => {});
        emitWebhookEvent(item.guildId, "session_expired", {
          userId: item.userId,
          username: item.username,
        }).catch(() => {});
        continue;
      }

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
          reportError(error, {
            guildId: item.guildId,
            userId: item.userId,
            command: "monitor-loop",
          }).catch(() => {});
        });
    }
  }, CHECK_EVERY_SECONDS * 1000);
}

process.on("unhandledRejection", (error) => {
  const err = error instanceof Error ? error : new Error(String(error));
  console.log("Unhandled rejection:", err.message);
  reportError(err, { command: "unhandledRejection" }).catch(() => {});
});

process.on("uncaughtException", (error) => {
  console.log("Uncaught exception:", error.message);
  reportError(error, { command: "uncaughtException" }).catch(() => {});
});

client.login(process.env.DISCORD_BOT_TOKEN);
