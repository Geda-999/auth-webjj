const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { chromium } = require('playwright');

// ========================= 配置区 =========================
const CONFIG = {
  telegram: {
    token: process.env.BOT_TOKEN,
    chatId: process.env.CHAT_ID,
  },
  accounts: process.env.ACCOUNTS,
  urls: process.env.URLS,
  // 支持通过环境变量覆盖，默认保持原值
  codeURL: process.env.CODE_URL,
  loginURL: process.env.LOGIN_URL,
  screenshotDir: process.env.SCREENSHOT_DIR || '/tmp/netlib-screenshots',
  pageTimeoutMs: 30000,
  stepDelayMs: 1500,
  retryPerAccount: 2, // 每个账号最多尝试次数（含首次）
  delayBetweenAccountsMs: 3000,
  selectors: {
    email: 'input[id="email"], input[type="email"]',
    password: 'input[id="password"], input[type="password"]',
    submit: 'button:has-text("登录"), input[type="submit"]',
    personalCenter: 'a:has-text("个人中心")',
    navLinksFallback: '.min-h-screen header nav a',
    redeemEntry: 'button:has-text("兑换")',
    redeemEntryFallback: 'main .rounded-lg button',
    giftCodeInput: '#gift_card_code',
    redeemConfirmGroup: 'div.space-y-4 button.inline-flex',
    finalConfirmGroup: 'div.flex.flex-col-reverse button.inline-flex',
  },
};

// ========================= 工具函数 =========================


async function getAccounts() {
  const accounts = CONFIG.accounts;
  const urls = CONFIG.urls;
  if (accounts) {
    // 尝试解析本地 ACCOUNTS 环境变量或常量，优先使用逗号分隔，回退为原始字符串
    try {
      let local = accounts.trim();
      return parseAccounts(local)
    } catch (e) {
      console.error('本地 ACCOUNTS 解析失败:', e);
      return null;
    }
  }
  if (!urls) return null;
  let text;
  try {
    const resp = await fetch(urls);
    text = await resp.text();
    // console.log('list>>>', text);
  } catch (e) {
    console.error('拉取账号列表失败:', e);
    return null;
  }

  // 尝试 JSON.parse，回退为逗号分隔字符串
  try {
    return parseAccounts(text);
  } catch (e) {
    console.error('JSON 解析失败:', e);
    return null;
  }
}


/** 解析 "user1:pass1,user2:pass2"（支持逗号/分号分隔）格式的账号字符串 */
function parseAccounts(raw) {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((entry) => {
      const [user, pass] = entry.split(':').map((s) => s.trim());
      return { user, pass };
    })
    .filter((acc) => acc.user && acc.pass);
}

/** 等待指定毫秒，语义化封装，方便统一调整 */
function wait(page, ms = CONFIG.stepDelayMs) {
  return page.waitForTimeout(ms);
}

// ========================= 兑换码获取 =========================

class GiftCodeFetcher {
  // 精确正则优先尝试，命中即返回，避免误判
  static PATTERNS = [
    /礼品卡\*\*[:：]\s*([A-Z0-9]{10,20})/,
    /礼品卡[：:]\s*([A-Z0-9]{10,20})/,
  ];
  // 宽松兜底正则：只有上面两个都没命中时才用，且只取第一个候选并打印告警，
  // 避免把页面里其它无关的 14~16 位大写字母数字串误判成兑换码
  static FALLBACK_PATTERN = /\b[A-Z0-9]{14,16}\b/g;

  static async fetch(url) {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`获取兑换码源失败，HTTP ${res.status}`);
    }
    const text = await res.text();

    for (const pattern of this.PATTERNS) {
      const match = text.match(pattern);
      if (match && match[1]) return match[1];
    }

    const fallbackMatches = text.match(this.FALLBACK_PATTERN);
    if (fallbackMatches && fallbackMatches.length > 0) {
      console.warn(`⚠️ 未匹配到明确标注的兑换码，使用宽松正则抓到候选: ${fallbackMatches[0]}`);
      return fallbackMatches[0];
    }

    return null;
  }
}

// ========================= Telegram 通知 =========================

class TelegramNotifier {
  constructor({ token, chatId }) {
    this.token = token;
    this.chatId = chatId;
  }

  get enabled() {
    return Boolean(this.token && this.chatId);
  }

  async send(message) {
    if (!this.enabled) {
      console.log('ℹ️ 未配置 BOT_TOKEN / CHAT_ID，跳过 Telegram 通知');
      return;
    }

    const hkTime = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const timeStr = hkTime.toISOString().replace('T', ' ').substr(0, 19) + ' HKT';
    const fullMessage = `🎉 Netlib 登录通知\n\n登录时间：${timeStr}\n\n${message}`;

    try {
      await axios.post(
        `https://api.telegram.org/bot${this.token}/sendMessage`,
        { chat_id: this.chatId, text: fullMessage },
        { timeout: 10000 }
      );
      console.log('✅ Telegram 通知发送成功');
    } catch (e) {
      console.log(`⚠️ Telegram 发送失败: ${e.message}`);
    }
  }
}

// ========================= 单账号自动化（核心点击逻辑与原版保持一致） =========================

class NetlibAccountBot {
  constructor(page, { user, pass, code }) {
    this.page = page;
    this.user = user;
    this.pass = pass;
    this.code = code;
  }

  async login() {
    const { page, user, pass } = this;
    console.log(`📱 ${user} - 正在访问网站...`);
    await page.goto(CONFIG.loginURL, { waitUntil: 'networkidle' });
    await wait(page, 3000);

    console.log(`📝 ${user} - 填写用户名...`);
    await page.fill(CONFIG.selectors.email, user);
    await wait(page, 1000);

    console.log(`🔒 ${user} - 填写密码...`);
    await page.fill(CONFIG.selectors.password, pass);
    await wait(page, 1000);

    console.log(`📤 ${user} - 提交登录...`);
    await page.click(CONFIG.selectors.submit);
    await page.waitForLoadState('networkidle');
    await wait(page, 5000);

    const content = await page.content();
    const success = content.includes('exclusive owner') || content.includes(user);
    if (!success) {
      throw new Error('登录后页面未检测到成功标识，可能账号密码错误或页面结构变化');
    }
    console.log(`✅ ${user} - 登录成功`);
  }

  /** 通用的「文本优先 + 索引兜底」点击逻辑，替代原来重复的 if/else 代码块 */
  async clickByTextOrFallback({ textSelector, fallbackSelector, fallbackIndex, label }) {
    const { page } = this;
    let target = await page.$(textSelector);

    if (!target) {
      const candidates = await page.$$(fallbackSelector);
      if (candidates.length > fallbackIndex) {
        target = candidates[fallbackIndex];
      } else if (candidates.length > 0) {
        target = candidates[candidates.length - 1];
        console.warn(`⚠️ [${label}] 候选元素数量异常，自动选最后一个 (${fallbackSelector})`);
      }
    }

    if (!target) {
      throw new Error(`未找到预期的「${label}」按钮，请检查页面结构`);
    }
    await target.click();
    console.log(`✅ 成功点击「${label}」`);
  }

  async goToPersonalCenter() {
    await this.clickByTextOrFallback({
      textSelector: CONFIG.selectors.personalCenter,
      fallbackSelector: CONFIG.selectors.navLinksFallback,
      fallbackIndex: 5,
      label: '个人中心',
    });
    await wait(this.page, 2000);
  }

  async openRedeemDialog() {
    await this.clickByTextOrFallback({
      textSelector: CONFIG.selectors.redeemEntry,
      fallbackSelector: CONFIG.selectors.redeemEntryFallback,
      fallbackIndex: 3,
      label: '兑换',
    });
    await wait(this.page, 2000);
  }

  async fillCode() {
    console.log(`✅ ${this.user} - 填写兑换码`);
    await this.page.locator(CONFIG.selectors.giftCodeInput).fill(this.code);
    await wait(this.page, 2000);
  }

  async confirmRedeem() {
    const { page } = this;

    const redeemButtons = await page.$$(CONFIG.selectors.redeemConfirmGroup);
    if (redeemButtons.length <= 1) throw new Error('未找到预期的兑换确认按钮');
    await redeemButtons[1].click();
    console.log('✅ 已点击兑换确认按钮，等待5秒');
    await wait(page, 5000);

    const finalButtons = await page.$$(CONFIG.selectors.finalConfirmGroup);
    if (finalButtons.length <= 2) throw new Error('未找到预期的最终确认按钮');
    await finalButtons[2].click();
    console.log('✅ 已点击最终确认按钮，等待5秒');
    await wait(page, 5000);
  }

  async run() {
    await this.login();
    await this.goToPersonalCenter();
    await this.openRedeemDialog();
    await this.fillCode();
    await this.confirmRedeem();
  }
}

// ========================= 账号处理 + 重试 + 失败截图 =========================

async function takeFailureScreenshot(page, user, attempt) {
  try {
    if (!fs.existsSync(CONFIG.screenshotDir)) {
      fs.mkdirSync(CONFIG.screenshotDir, { recursive: true });
    }
    const filePath = path.join(CONFIG.screenshotDir, `${user}-attempt${attempt}-${Date.now()}.png`);
    await page.screenshot({ path: filePath, fullPage: true });
    console.log(`🖼️ 已保存失败截图: ${filePath}`);
  } catch (e) {
    console.warn(`⚠️ 截图保存失败: ${e.message}`);
  }
}

async function processAccount({ user, pass }, code) {
  let lastError = null;

  for (let attempt = 1; attempt <= CONFIG.retryPerAccount; attempt++) {
    console.log(`\n🚀 [${user}] 第 ${attempt}/${CONFIG.retryPerAccount} 次尝试`);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    let page;
    try {
      page = await browser.newPage();
      page.setDefaultTimeout(CONFIG.pageTimeoutMs);

      const bot = new NetlibAccountBot(page, { user, pass, code });
      await bot.run();

      return { user, success: true, message: `✅ ${user} 登录并兑换成功` };
    } catch (e) {
      lastError = e;
      console.log(`❌ [${user}] 第 ${attempt} 次尝试失败: ${e.message}`);
      if (page) await takeFailureScreenshot(page, user, attempt);
    } finally {
      if (page) await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  return {
    user,
    success: false,
    message: `❌ ${user} 登录异常（已重试${CONFIG.retryPerAccount}次）: ${lastError?.message || '未知错误'}`,
  };
}

// ========================= 主流程 =========================

async function main() {
  // const accounts = parseAccounts(process.env.ACCOUNTS);
  const accounts = await getAccounts();
  if (accounts.length === 0) {
    console.log('❌ 账号格式错误或未配置，应为 username1:password1,username2:password2');
    process.exit(1);
  }
  // console.log(`🚀 开始处理 ${accounts.length} 个账号`);
  // console.log('ACCOUNTS:', accounts);
  // return

  const notifier = new TelegramNotifier(CONFIG.telegram);

  let code;
  try {
    code = await GiftCodeFetcher.fetch(CONFIG.codeURL);
  } catch (e) {
    console.log(`❌ 获取兑换码失败: ${e.message}`);
    await notifier.send(`❌ 获取兑换码失败，本次任务终止：${e.message}`);
    process.exit(1);
  }

  if (!code) {
    console.log('❌ 未能从来源中提取到兑换码，终止本次任务');
    await notifier.send('❌ 未能提取到兑换码，本次任务终止，请检查兑换码来源页面');
    process.exit(1);
  }

  console.log('🎁 兑换码:', code);
  console.log(`🔍 发现 ${accounts.length} 个账号需要登录`);

  const results = [];
  for (let i = 0; i < accounts.length; i++) {
    console.log(`\n📋 处理第 ${i + 1}/${accounts.length} 个账号: ${accounts[i].user}`);
    results.push(await processAccount(accounts[i], code));

    if (i < accounts.length - 1) {
      console.log(`⏳ 等待${CONFIG.delayBetweenAccountsMs / 1000}秒后处理下一个账号...`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.delayBetweenAccountsMs));
    }
  }

  const successCount = results.filter((r) => r.success).length;
  let summary = `📊 登录汇总: ${successCount}/${results.length} 个账号成功\n\n`;
  summary += results.map((r) => r.message).join('\n');

  await notifier.send(summary);
  console.log('\n📊 最终结果:\n', summary);

  if (successCount < results.length) {
    process.exitCode = 1; // 有账号失败时返回非 0 退出码，方便 CI 识别
  }
}

main().catch((e) => {
  console.error('💥 主流程出现未捕获异常:', e);
  process.exit(1);
});