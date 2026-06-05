const { chromium } = require("playwright");

async function saveSession() {
  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext({
    viewport: { width: 430, height: 932 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    colorScheme: "dark",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });

  const page = await context.newPage();

  await page.goto("https://www.instagram.com/accounts/login/", {
    waitUntil: "domcontentloaded",
  });

  console.log("سجل دخول Instagram من النافذة اللي فتحت.");
  console.log("بعد ما تدخل، افتح بروفايل زي: https://www.instagram.com/2asssm/");
  console.log("لما البروفايل يفتح عادي، ارجع هنا واضغط Enter.");

  process.stdin.resume();

  process.stdin.on("data", async () => {
    await context.storageState({
      path: "ig-session.json",
    });

    console.log("✅ Saved ig-session.json");
    await browser.close();
    process.exit();
  });
}

saveSession();