require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  AttachmentBuilder,
} = require("discord.js");

const { chromium } = require("playwright");
const sharp = require("sharp");
const fs = require("fs");
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

const monitors = {};
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

async function removePopups(page) {
  try {
    await page.evaluate(() => {
      document
        .querySelectorAll('div[role="dialog"]')
        .forEach((el) => el.remove());

      document.querySelectorAll("*").forEach((el) => {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor || "";

        if (
          (style.position === "fixed" || style.position === "sticky") &&
          (bg.includes("rgba") || bg.includes("rgb(0"))
        ) {
          el.remove();
        }
      });

      document.body.style.filter = "none";
      document.documentElement.style.filter = "none";
      document.body.style.background = "#000";
      document.documentElement.style.background = "#000";
    });
  } catch {}
}

async function roundImage(inputPath, outputPath) {
  const image = sharp(inputPath);
  const meta = await image.metadata();

  const roundedCorners = Buffer.from(`
    <svg width="${meta.width}" height="${meta.height}">
      <rect x="0" y="0" width="${meta.width}" height="${meta.height}" rx="38" ry="38" fill="white"/>
    </svg>
  `);

  await image
    .composite([{ input: roundedCorners, blend: "dest-in" }])
    .png()
    .toFile(outputPath);
}

async function checkInstagram(username) {
  let context = null;
  let page = null;

  const url = toInstagramUrl(username);

  try {
    const browser = await getBrowser();
    const created = await createPage(browser);

    context = created.context;
    page = created.page;

    await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 30000,
    });

    await page.waitForTimeout(4000);
    await removePopups(page);
    await page.waitForTimeout(1500);

    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.body.style.zoom = "1.15";
      document.body.style.background = "#000";
      document.documentElement.style.background = "#000";
    });

    await page.waitForTimeout(1500);

    const bodyText = (await page.locator("body").innerText()).toLowerCase();
    const pageUrl = page.url().toLowerCase();

    console.log("DEBUG USER:", username);
    console.log("DEBUG URL:", page.url());
    console.log("DEBUG TEXT:", bodyText.slice(0, 500));

    const rawScreenshot = `screenshots/raw-${Date.now()}-${username}.png`;
    const finalScreenshot = `screenshots/${Date.now()}-${username}.png`;

    await page.screenshot({
      path: rawScreenshot,
      clip: {
        x: 0,
        y: 60,
        width: 430,
        height: 185,
      },
    });

    await roundImage(rawScreenshot, finalScreenshot);
    safeDelete(rawScreenshot);

    const stats = extractStats(bodyText);

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

    if (isBanned) return { status: "banned", screenshot: finalScreenshot, stats };
    if (isLoginOnly) return { status: "login", screenshot: finalScreenshot, stats };
    if (isActive) return { status: "active", screenshot: finalScreenshot, stats };

    return { status: "unknown", screenshot: finalScreenshot, stats };
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

function recoveredEmbed(username, result, duration) {
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

  return {
    embeds: [embed],
    files: [attachment],
  };
}

function unavailableEmbed(username, result) {
  const embed = new EmbedBuilder()
    .setColor(0xff3333)
    .setTitle(`Account Unavailable | @${username} 🚫`)
    .setDescription(
      "This account appears to be banned, unavailable, or not accessible."
    )
    .setFooter({
      text: `Monitoring started at ${getTime()}`,
    });

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

async function sendRecovered(channel, username, result, duration) {
  const payload = recoveredEmbed(username, result, duration);
  await channel.send(payload);
  safeDelete(result.screenshot);
}

async function sendUnavailable(channel, username, result) {
  const payload = unavailableEmbed(username, result);
  await channel.send(payload);
  safeDelete(result.screenshot);
}

client.once("ready", async () => {
  console.log(`Discord bot online: ${client.user.tag}`);

  sharedBrowser = await launchBrowser();

  console.log(`Shared browser started. Concurrency: ${CONCURRENT_CHECKS}`);

  setInterval(restartBrowser, 1000 * 60 * BROWSER_RESTART_MINUTES);
  setInterval(cleanupOldScreenshots, 1000 * 60 * 5);

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

      return message.reply("🛑 Cancelled all your monitors.");
    }

    const username = getUsername(arg);

    if (!username) return message.reply("❌ اكتب يوزر صحيح.");

    const key = `${message.author.id}:${username}`;

    if (monitors[key]) {
      delete monitors[key];
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

  return sendUnavailable(dmChannel, username, result);
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

            console.log(
              `ACTIVE CONFIRMATION ${item.username}: ${item.activeHits}/${ACTIVE_CONFIRMATIONS}`
            );

            if (item.activeHits < ACTIVE_CONFIRMATIONS) {
              safeDelete(result.screenshot);
              return;
            }

            const duration = item.bannedStartedAt
              ? formatDuration(Date.now() - item.bannedStartedAt)
              : "Unknown";

            const channel = await client.channels.fetch(item.channelId);

            await sendRecovered(channel, item.username, result, duration);

            item.lastStatus = "active";
            item.activeHits = 0;
            item.bannedStartedAt = null;

            return;
          }

          if (result.status !== "active") {
            item.activeHits = 0;
          }

          if (item.lastStatus === "active" && result.status === "banned") {
            item.bannedStartedAt = Date.now();
          }

          item.lastStatus = result.status;

          safeDelete(result.screenshot);
        })
        .catch((error) => {
          console.log("Monitor error:", error.message);
        });
    }
  }, CHECK_EVERY_SECONDS * 1000);
}

client.login(process.env.DISCORD_BOT_TOKEN);