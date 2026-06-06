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
