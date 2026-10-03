
import "dotenv/config";
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import { connectDB, getDB } from "./db.js";
import { validateTelegramInitData, signUser, verifyToken } from "./auth.js";
import { createInvoice, getPayment, createPayout } from "./oxapay.js";

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cookieParser());

/* OxaPay webhooks must receive the raw request body for HMAC verification. */
app.post("/api/webhooks/oxapay", express.raw({ type: "*/*", limit: "256kb" }), async (req, res) => {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    const data = JSON.parse(raw.toString("utf8") || "{}");
    const type = data.type;
    const key = type === "payout"
      ? ((await getSecretSetting("oxapay_payout_key")) || process.env.OXAPAY_PAYOUT_KEY)
      : ((await getSecretSetting("oxapay_merchant_key")) || process.env.OXAPAY_MERCHANT_KEY);
    const hmac = req.get("HMAC") || req.get("hmac") || "";
    const expected = crypto.createHmac("sha512", key || "").update(raw).digest("hex");

    if (!hmac || !key || Buffer.byteLength(expected) !== Buffer.byteLength(hmac) || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmac))) {
      return res.status(401).send("invalid signature");
    }

    if (type === "invoice") await handleInvoiceWebhook(data);
    if (type === "payout") await handlePayoutWebhook(data);

    return res.json({ ok: true });
  } catch (e) {
    console.error("OxaPay webhook:", e);
    return res.status(400).json({ ok: false });
  }
});

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/api", limiter);

let db;
await connectDB(process.env.MONGODB_URI);
db = getDB();
await bootstrap();

function now() { return new Date(); }
function round(n, p=8) {
  const x = Number(n);
  return Number.isFinite(x) ? Number(x.toFixed(p)) : 0;
}
function clampInt(n, min, max) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(min, Math.min(max, Math.floor(x))) : min;
}

async function bootstrap() {
  if (process.env.APP_ENCRYPTION_KEY) {
    if (process.env.OXAPAY_MERCHANT_KEY && !(await getSetting("oxapay_merchant_key", ""))) await setSecretSetting("oxapay_merchant_key", process.env.OXAPAY_MERCHANT_KEY);
    if (process.env.OXAPAY_PAYOUT_KEY && !(await getSetting("oxapay_payout_key", ""))) await setSecretSetting("oxapay_payout_key", process.env.OXAPAY_PAYOUT_KEY);
  }
  const defaults = {
    channelUsername: process.env.CHANNEL_USERNAME || "@your_channel",
    channelJoinUrl: process.env.CHANNEL_JOIN_URL || "https://t.me/your_channel",
    adminEntryUserId: String(process.env.ADMIN_ENTRY_USER_ID || "8994226373"),
    referralCoins: 10,
    referralDepositPercent: 5,
    dailyCheckinCoins: 10,
    giftBoxesPerReferral: 2,
    giftMin: 1,
    giftMax: 10,
    giftDefaultBoxes: 1,
    minWithdrawal: 0.10,
    coinUsdRate: 0.0001,
    coinDailyPercent: 0.02,
    appName: "Goex AI",
    onlineBase: 28
  };
  for (const [key, value] of Object.entries(defaults)) {
    await db.collection("settings").updateOne({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }

  if (process.env.ADMIN_PASSWORD) {
    const exists = await db.collection("admins").findOne({ username: "admin" });
    if (!exists) {
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
      await db.collection("admins").insertOne({ username: "admin", passwordHash, createdAt: now() });
    }
  }

  const taskCount = await db.collection("tasks").countDocuments();
  if (!taskCount) {
    await db.collection("tasks").insertMany([
      { title: "Join our Telegram channel", reward: 20, type: "channel", url: defaults.channelJoinUrl, active: true, createdAt: now() },
      { title: "Open the app daily", reward: 5, type: "daily", url: "", active: true, createdAt: now() }
    ]);
  }
}

async function getSetting(key, fallback=null) {
  const x = await db.collection("settings").findOne({ key });
  return x ? x.value : fallback;
}
async function setSetting(key, value) {
  await db.collection("settings").updateOne({ key }, { $set: { key, value, updatedAt: now() } }, { upsert: true });
}
async function getSecretSetting(key) {
  const enc = await getSetting(key, "");
  if (!enc || !process.env.APP_ENCRYPTION_KEY) return "";
  try {
    const raw = Buffer.from(process.env.APP_ENCRYPTION_KEY, "hex");
    const iv = Buffer.from(enc.iv, "hex");
    const tag = Buffer.from(enc.tag, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", raw, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(enc.data, "hex")), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}
async function setSecretSetting(key, value) {
  const raw = Buffer.from(process.env.APP_ENCRYPTION_KEY || "", "hex");
  if (raw.length !== 32) throw new Error("APP_ENCRYPTION_KEY must be 64 hex characters");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", raw, iv);
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  await setSetting(key, { iv: iv.toString("hex"), tag: tag.toString("hex"), data: data.toString("hex") });
}

async function requireUser(req, res, next) {
  try {
    const token = req.cookies.session || req.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "Not authenticated" });
    req.auth = verifyToken(token, process.env.JWT_SECRET);
    req.user = await db.collection("users").findOne({ telegramId: String(req.auth.telegramId) });
    if (!req.user) return res.status(401).json({ error: "User not found" });
    next();
  } catch {
    return res.status(401).json({ error: "Session expired" });
  }
}

async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies.admin_session;
    if (!token) return res.status(401).json({ error: "Admin login required" });
    const payload = verifyToken(token, process.env.JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "Forbidden" });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Admin login required" });
  }
}

async function ensureUser(tgUser, refParam) {
  const telegramId = String(tgUser.id);
  let user = await db.collection("users").findOne({ telegramId });

  if (!user) {
    const referralCode = crypto.randomBytes(5).toString("hex");
    let referredBy = null;
    if (refParam && String(refParam) !== telegramId) {
      const ref = await db.collection("users").findOne({
        $or: [{ referralCode: String(refParam) }, { telegramId: String(refParam) }]
      });
      if (ref && ref.telegramId !== telegramId) referredBy = ref.telegramId;
    }
    user = {
      telegramId,
      username: tgUser.username || "",
      firstName: tgUser.first_name || "Telegram user",
      lastName: tgUser.last_name || "",
      photoUrl: tgUser.photo_url || "",
      referralCode,
      referredBy,
      balance: 0,
      coins: 100,
      referralCoins: 0,
      referralIncome: 0,
      withdrawn: 0,
      invitedCount: 0,
      giftBoxes: Number(await getSetting("giftDefaultBoxes", 1)),
      giftOpened: 0,
      lastCheckin: null,
      lastCoinAccrual: now(),
      createdAt: now(),
      updatedAt: now()
    };
    await db.collection("users").insertOne(user);

    await addTransaction(telegramId, "Welcome bonus", "in", 100, "coins");
    if (referredBy) {
      await db.collection("users").updateOne(
        { telegramId: referredBy },
        { $inc: { invitedCount: 1, coins: Number(await getSetting("referralCoins", 10)), giftBoxes: Number(await getSetting("giftBoxesPerReferral", 2)) } }
      );
      await addTransaction(referredBy, "Referral reward", "in", Number(await getSetting("referralCoins", 10)), "coins");
    }
  } else {
    await db.collection("users").updateOne({ telegramId }, {
      $set: {
        username: tgUser.username || "",
        firstName: tgUser.first_name || user.firstName,
        lastName: tgUser.last_name || user.lastName,
        photoUrl: tgUser.photo_url || user.photoUrl,
        updatedAt: now()
      }
    });
    user = await db.collection("users").findOne({ telegramId });
  }
  return user;
}

async function addTransaction(telegramId, title, direction, amount, unit="USDT", meta={}) {
  await db.collection("transactions").insertOne({
    telegramId: String(telegramId),
    title,
    direction,
    amount: round(amount, unit === "coins" ? 0 : 8),
    unit,
    meta,
    createdAt: now()
  });
}

async function accrueCoins(user) {
  const daily = Number(await getSetting("coinDailyPercent", 0.02)) / 100;
  const last = new Date(user.lastCoinAccrual || user.createdAt || now());
  const elapsed = Date.now() - last.getTime();
  const days = elapsed / 86400000;
  if (days < 1/24) return user;
  const coins = Number(user.coins || 0);
  const earned = round(coins * daily * days, 4);
  if (earned <= 0) {
    await db.collection("users").updateOne({ telegramId: user.telegramId }, { $set: { lastCoinAccrual: now() } });
    return user;
  }
  await db.collection("users").updateOne(
    { telegramId: user.telegramId },
    { $inc: { coins: earned }, $set: { lastCoinAccrual: now() } }
  );
  await addTransaction(user.telegramId, "Coin earnings", "in", earned, "coins");
  return await db.collection("users").findOne({ telegramId: user.telegramId });
}

async function channelStatus(telegramId) {
  const channel = await getSetting("channelUsername", process.env.CHANNEL_USERNAME || "");
  if (!channel) return { joined: true, channel: "" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=${encodeURIComponent(channel)}&user_id=${encodeURIComponent(telegramId)}`);
    const j = await r.json();
    const status = j?.result?.status;
    return { joined: Boolean(j.ok && ["creator","administrator","member"].includes(status)), channel };
  } catch {
    return { joined: false, channel };
  }
}

app.post("/api/auth/telegram", async (req, res) => {
  try {
    const { initData, startParam } = req.body || {};
    const tgUser = validateTelegramInitData(initData, process.env.BOT_TOKEN);
    const user = await ensureUser(tgUser, startParam);
    const session = signUser(tgUser, process.env.JWT_SECRET);
    res.cookie("session", session, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 7*86400000 });
    const membership = await channelStatus(user.telegramId);
    res.json({
      ok: true,
      user: publicUser(user),
      membership,
      adminEntry: String(user.telegramId) === String(await getSetting("adminEntryUserId", process.env.ADMIN_ENTRY_USER_ID))
    });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: e.message || "Telegram authentication failed" });
  }
});

app.get("/api/me", requireUser, async (req, res) => {
  const user = await accrueCoins(req.user);
  const membership = await channelStatus(user.telegramId);
  const tasks = await db.collection("tasks").find({ active: true }).sort({ createdAt: -1 }).toArray();
  const claimed = await db.collection("transactions").find({
    telegramId: user.telegramId,
    title: { $regex: /^Task:/ }
  }).project({ title:1 }).toArray();
  const claimedSet = new Set(claimed.map(x => x.title));
  res.json({
    user: publicUser(user),
    membership,
    tasks: tasks.map(t => ({...t, _id: String(t._id), claimed: claimedSet.has(`Task: ${t.title}`)})),
    settings: {
      appName: await getSetting("appName", "Goex AI"),
      referralCoins: Number(await getSetting("referralCoins", 10)),
      referralDepositPercent: Number(await getSetting("referralDepositPercent", 5)),
      dailyCheckinCoins: Number(await getSetting("dailyCheckinCoins", 10)),
      minWithdrawal: Number(await getSetting("minWithdrawal", 0.1)),
      coinUsdRate: Number(await getSetting("coinUsdRate", 0.0001)),
      coinDailyPercent: Number(await getSetting("coinDailyPercent", 0.02)),
      channelJoinUrl: await getSetting("channelJoinUrl", "")
    }
  });
});

function publicUser(u) {
  const coinRate = Number(u.coins || 0) * Number(process.env.COIN_USD_RATE || 0.0001);
  return {
    telegramId: u.telegramId,
    username: u.username,
    firstName: u.firstName,
    lastName: u.lastName,
    photoUrl: u.photoUrl,
    balance: round(u.balance),
    coins: round(u.coins, 2),
    referralCoins: round(u.referralCoins, 2),
    referralIncome: round(u.referralIncome),
    withdrawn: round(u.withdrawn),
    invitedCount: Number(u.invitedCount || 0),
    giftBoxes: Number(u.giftBoxes || 0),
    giftOpened: Number(u.giftOpened || 0),
    referralCode: u.referralCode,
    referralLink: `https://t.me/${process.env.BOT_USERNAME || "YOUR_BOT"}/app?startapp=${u.referralCode}`,
    coinEstimatedUsd: round(coinRate)
  };
}

app.post("/api/channel/check", requireUser, async (req, res) => {
  const membership = await channelStatus(req.user.telegramId);
  res.json(membership);
});

app.post("/api/checkin", requireUser, async (req, res) => {
  const user = await db.collection("users").findOne({ telegramId: req.user.telegramId });
  const today = new Date().toISOString().slice(0,10);
  const last = user.lastCheckin ? new Date(user.lastCheckin).toISOString().slice(0,10) : "";
  if (last === today) return res.json({ ok: false, message: "Already checked in today" });
  const reward = Number(await getSetting("dailyCheckinCoins", 10));
  await db.collection("users").updateOne({ telegramId: user.telegramId }, { $inc: { coins: reward }, $set: { lastCheckin: now() } });
  await addTransaction(user.telegramId, "Daily check-in", "in", reward, "coins");
  res.json({ ok: true, reward });
});

app.post("/api/gifts/open", requireUser, async (req, res) => {
  const user = await db.collection("users").findOne({ telegramId: req.user.telegramId });
  if (Number(user.giftBoxes || 0) < 1) return res.status(400).json({ error: "No gift boxes left" });
  const min = clampInt(await getSetting("giftMin", 1), 1, 100);
  const max = clampInt(await getSetting("giftMax", 10), min, 100);
  const reward = Math.floor(Math.random() * (max - min + 1)) + min;
  const updated = await db.collection("users").findOneAndUpdate(
    { telegramId: user.telegramId, giftBoxes: { $gte: 1 } },
    { $inc: { giftBoxes: -1, coins: reward, giftOpened: 1 } },
    { returnDocument: "after" }
  );
  if (!updated) return res.status(409).json({ error: "Gift already opened" });
  await addTransaction(user.telegramId, "Gift", "in", reward, "coins");
  res.json({ ok: true, reward, boxesLeft: updated.giftBoxes });
});

app.post("/api/tasks/:id/claim", requireUser, async (req, res) => {
  const task = await db.collection("tasks").findOne({ _id: new (await import("mongodb")).ObjectId(req.params.id), active: true });
  if (!task) return res.status(404).json({ error: "Task not found" });
  const existing = await db.collection("transactions").findOne({ telegramId: req.user.telegramId, title: `Task: ${task.title}` });
  if (existing) return res.status(400).json({ error: "Task already claimed" });

  if (task.type === "channel") {
    const m = await channelStatus(req.user.telegramId);
    if (!m.joined) return res.status(403).json({ error: "Join the channel first" });
  }
  await db.collection("users").updateOne({ telegramId: req.user.telegramId }, { $inc: { coins: Number(task.reward) } });
  await addTransaction(req.user.telegramId, `Task: ${task.title}`, "in", Number(task.reward), "coins");
  res.json({ ok: true, reward: Number(task.reward) });
});

app.get("/api/history", requireUser, async (req, res) => {
  const items = await db.collection("transactions").find({ telegramId: req.user.telegramId }).sort({ createdAt: -1 }).limit(50).toArray();
  const withdrawals = await db.collection("withdrawals").find({ telegramId: req.user.telegramId }).sort({ createdAt: -1 }).limit(50).toArray();
  res.json({
    history: items.map(x => ({ ...x, _id: String(x._id) })),
    withdrawals: withdrawals.map(x => ({ ...x, _id: String(x._id) }))
  });
});

app.get("/api/friends", requireUser, async (req, res) => {
  const friends = await db.collection("users").find({ referredBy: req.user.telegramId })
    .project({ firstName:1, username:1, createdAt:1 }).sort({ createdAt:-1 }).limit(100).toArray();
  res.json({ friends });
});

app.post("/api/deposit", requireUser, async (req, res) => {
  try {
    const amount = round(req.body.amount);
    const min = Number(await getSetting("minDeposit", 0.10));
    if (!Number.isFinite(amount) || amount < min || amount > 100000) return res.status(400).json({ error: `Deposit must be between ${min} and 100000 USDT` });
    const key = (await getSecretSetting("oxapay_merchant_key")) || process.env.OXAPAY_MERCHANT_KEY;
    if (!key) return res.status(500).json({ error: "OxaPay Merchant API key is not configured" });
    const orderId = `dep_${req.user.telegramId}_${uuid()}`;
    const result = await createInvoice({
      merchantKey: key,
      amount,
      currency: "USDT",
      callbackUrl: `${process.env.APP_URL}/api/webhooks/oxapay`,
      orderId,
      description: `USDT deposit for Telegram user ${req.user.telegramId}`
    });
    const trackId = result.track_id || result.trackId;
    const payLink = result.payment_url || result.pay_link || result.payLink;
    if (!trackId || !payLink) throw new Error("OxaPay did not return a payment link");
    await db.collection("deposits").insertOne({
      trackId: String(trackId), telegramId: req.user.telegramId, amount, currency: "USDT",
      status: "Waiting", orderId, createdAt: now()
    });
    res.json({ ok: true, trackId, payLink, amount });
  } catch (e) {
    console.error("deposit", e?.response?.data || e);
    res.status(400).json({ error: e?.response?.data?.message || e.message || "Deposit creation failed" });
  }
});

app.get("/api/deposit/:trackId", requireUser, async (req, res) => {
  const dep = await db.collection("deposits").findOne({ trackId: String(req.params.trackId), telegramId: req.user.telegramId });
  if (!dep) return res.status(404).json({ error: "Deposit not found" });
  try {
    const key = (await getSecretSetting("oxapay_merchant_key")) || process.env.OXAPAY_MERCHANT_KEY;
    const p = await getPayment(req.params.trackId, key);
    const status = p.status || p.payment_status;
    res.json({ ok: true, status, payment: p });
  } catch (e) {
    res.status(400).json({ error: e?.response?.data?.message || e.message });
  }
});

app.post("/api/withdraw", requireUser, async (req, res) => {
  try {
    const amount = round(req.body.amount);
    const address = String(req.body.address || "").trim();
    const currency = String(req.body.currency || "USDT").toUpperCase();
    const network = String(req.body.network || "").trim();

    const min = Number(await getSetting("minWithdrawal", 0.10));
    if (!address || !Number.isFinite(amount) || amount < min) return res.status(400).json({ error: `Minimum withdrawal is ${min} USDT` });
    if (!["USDT","TRX","GRAM"].includes(currency)) return res.status(400).json({ error: "Unsupported currency" });

    const user = await db.collection("users").findOne({ telegramId: req.user.telegramId });
    if (Number(user.balance) < amount) return res.status(400).json({ error: "Insufficient balance" });

    const payoutKey = (await getSecretSetting("oxapay_payout_key")) || process.env.OXAPAY_PAYOUT_KEY;
    if (!payoutKey) return res.status(500).json({ error: "OxaPay Payout API key is not configured" });

    const hold = await db.collection("users").findOneAndUpdate(
      { telegramId: req.user.telegramId, balance: { $gte: amount } },
      { $inc: { balance: -amount } },
      { returnDocument: "after" }
    );
    if (!hold) return res.status(409).json({ error: "Balance changed; please retry" });

    const w = {
      telegramId: req.user.telegramId, amount, currency, network, address,
      status: "Processing", createdAt: now(), updatedAt: now()
    };
    const inserted = await db.collection("withdrawals").insertOne(w);

    try {
      const result = await createPayout({
        payoutKey, address, currency, amount, network: network || undefined,
        callbackUrl: `${process.env.APP_URL}/api/webhooks/oxapay`,
        description: `Withdrawal ${inserted.insertedId}`
      });
      const trackId = result.track_id || result.trackId || result.id;
      await db.collection("withdrawals").updateOne({ _id: inserted.insertedId }, {
        $set: { trackId: trackId ? String(trackId) : null, provider: result, updatedAt: now() }
      });
      res.json({ ok: true, status: result.status || "Processing", trackId });
    } catch (e) {
      await db.collection("users").updateOne({ telegramId: req.user.telegramId }, { $inc: { balance: amount } });
      await db.collection("withdrawals").updateOne({ _id: inserted.insertedId }, { $set: { status: "Failed", error: e?.response?.data || e.message, updatedAt: now() } });
      throw e;
    }
  } catch (e) {
    console.error("withdraw", e?.response?.data || e);
    res.status(400).json({ error: e?.response?.data?.message || e.message || "Withdrawal failed" });
  }
});

async function handleInvoiceWebhook(data) {
  const trackId = String(data.track_id || data.trackId || "");
  if (!trackId) return;
  const status = String(data.status || "").toLowerCase();
  const dep = await db.collection("deposits").findOne({ trackId });
  if (!dep) return;
  if (status !== "paid" && status !== "complete") return;

  const lock = await db.collection("deposits").updateOne(
    { _id: dep._id, status: { $ne: "Paid" } },
    { $set: { status: "Paid", paidAt: now(), provider: data } }
  );
  if (!lock.modifiedCount) return;

  const paid = Number(data.amount ?? data.value ?? dep.amount);
  const refPercent = Number(await getSetting("referralDepositPercent", 5));
  await db.collection("users").updateOne({ telegramId: dep.telegramId }, { $inc: { balance: paid } });
  await addTransaction(dep.telegramId, "Deposit", "in", paid, "USDT", { trackId });

  const user = await db.collection("users").findOne({ telegramId: dep.telegramId });
  if (user?.referredBy && refPercent > 0) {
    const bonus = round(paid * refPercent / 100);
    if (bonus > 0) {
      await db.collection("users").updateOne({ telegramId: user.referredBy }, { $inc: { balance: bonus, referralIncome: bonus } });
      await addTransaction(user.referredBy, "Referral deposit bonus", "in", bonus, "USDT", { from: dep.telegramId, percent: refPercent });
    }
  }
}

async function handlePayoutWebhook(data) {
  const trackId = String(data.track_id || data.trackId || "");
  if (!trackId) return;
  const status = String(data.status || "").toLowerCase();
  const w = await db.collection("withdrawals").findOne({ trackId });
  if (!w) return;

  if (["complete","completed","paid","success"].includes(status)) {
    await db.collection("withdrawals").updateOne({ _id: w._id }, { $set: { status: "Completed", txHash: data.tx_hash || data.txID || "", updatedAt: now(), provider: data } });
    await db.collection("users").updateOne({ telegramId: w.telegramId }, { $inc: { withdrawn: w.amount } });
    await addTransaction(w.telegramId, "Withdrawal completed", "out", w.amount, "USDT", { trackId });
  } else if (["failed","rejected","cancelled","canceled"].includes(status)) {
    const lock = await db.collection("withdrawals").updateOne(
      { _id: w._id, status: { $nin: ["Failed","Rejected"] } },
      { $set: { status: "Failed", updatedAt: now(), provider: data } }
    );
    if (lock.modifiedCount) {
      await db.collection("users").updateOne({ telegramId: w.telegramId }, { $inc: { balance: w.amount } });
      await addTransaction(w.telegramId, "Withdrawal refunded", "in", w.amount, "USDT", { trackId });
    }
  }
}

/* Admin authentication */
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await db.collection("admins").findOne({ username: String(username || "admin") });
  if (!admin || !(await bcrypt.compare(String(password || ""), admin.passwordHash))) {
    return res.status(401).json({ error: "Invalid credentials" });
  }
  const token = signAdmin(admin.username);
  res.cookie("admin_session", token, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 8*3600000 });
  res.json({ ok: true });
});
app.post("/api/admin/logout", requireAdmin, (req,res)=> {
  res.clearCookie("admin_session", { httpOnly:true, secure:true, sameSite:"lax" });
  res.json({ ok:true });
});
function signAdmin(username) {
  return jwt.sign({ role:"admin", username }, process.env.JWT_SECRET, { expiresIn:"8h" });
}

app.get("/api/admin/me", requireAdmin, async (req,res)=>res.json({ok:true,username:req.admin.username}));
app.get("/api/admin/settings", requireAdmin, async (req,res)=>{
  const keys = ["channelUsername","channelJoinUrl","adminEntryUserId","referralCoins","referralDepositPercent","dailyCheckinCoins","giftBoxesPerReferral","giftMin","giftMax","giftDefaultBoxes","minWithdrawal","minDeposit","coinUsdRate","coinDailyPercent","appName","onlineBase"];
  const out={};
  for (const k of keys) out[k]=await getSetting(k,null);
  out.hasMerchantKey=Boolean(process.env.OXAPAY_MERCHANT_KEY || await getSecretSetting("oxapay_merchant_key"));
  out.hasPayoutKey=Boolean(process.env.OXAPAY_PAYOUT_KEY || await getSecretSetting("oxapay_payout_key"));
  res.json(out);
});
app.put("/api/admin/settings", requireAdmin, async (req,res)=>{
  const allowed = ["channelUsername","channelJoinUrl","adminEntryUserId","referralCoins","referralDepositPercent","dailyCheckinCoins","giftBoxesPerReferral","giftMin","giftMax","giftDefaultBoxes","minWithdrawal","minDeposit","coinUsdRate","coinDailyPercent","appName","onlineBase"];
  for (const k of allowed) if (req.body[k] !== undefined) await setSetting(k, req.body[k]);
  if (req.body.oxapayMerchantKey) await setSecretSetting("oxapay_merchant_key", req.body.oxapayMerchantKey);
  if (req.body.oxapayPayoutKey) await setSecretSetting("oxapay_payout_key", req.body.oxapayPayoutKey);
  if (req.body.newAdminPassword) {
    const passwordHash = await bcrypt.hash(String(req.body.newAdminPassword),12);
    await db.collection("admins").updateOne({ username:"admin" }, { $set:{passwordHash,updatedAt:now()} });
  }
  res.json({ok:true});
});
app.get("/api/admin/stats", requireAdmin, async (req,res)=>{
  const [users,deposits,withdrawals] = await Promise.all([
    db.collection("users").countDocuments(),
    db.collection("deposits").countDocuments({status:"Paid"}),
    db.collection("withdrawals").countDocuments({status:"Completed"})
  ]);
  const sums = await db.collection("users").aggregate([
    {$group:{_id:null,totalBalance:{$sum:"$balance"},totalWithdrawn:{$sum:"$withdrawn"},totalCoins:{$sum:"$coins"}}}
  ]).toArray();
  res.json({users,deposits,withdrawals,...(sums[0]||{})});
});
app.get("/api/admin/users", requireAdmin, async (req,res)=>{
  const q=String(req.query.q||"").trim();
  const filter=q?{$or:[{telegramId:q},{username:{$regex:q.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\\\$&"),$options:"i"}}]}:{};
  const users=await db.collection("users").find(filter).sort({createdAt:-1}).limit(100).toArray();
  res.json({users:users.map(u=>({...publicUser(u),createdAt:u.createdAt}))});
});
app.patch("/api/admin/users/:telegramId", requireAdmin, async (req,res)=>{
  const id=String(req.params.telegramId);
  const inc={};
  if (req.body.addBalance!==undefined) inc.balance=Number(req.body.addBalance)||0;
  if (req.body.addCoins!==undefined) inc.coins=Number(req.body.addCoins)||0;
  if (req.body.addGiftBoxes!==undefined) inc.giftBoxes=Number(req.body.addGiftBoxes)||0;
  await db.collection("users").updateOne({telegramId:id},{$inc:inc,$set:{updatedAt:now()}});
  res.json({ok:true});
});
app.get("/api/admin/tasks", requireAdmin, async (req,res)=>{
  const tasks=await db.collection("tasks").find({}).sort({createdAt:-1}).toArray();
  res.json(tasks.map(t=>({...t,_id:String(t._id)})));
});
app.post("/api/admin/tasks", requireAdmin, async (req,res)=>{
  const task={title:String(req.body.title||"Task"),reward:Number(req.body.reward)||0,type:String(req.body.type||"custom"),url:String(req.body.url||""),active:req.body.active!==false,createdAt:now()};
  const r=await db.collection("tasks").insertOne(task); res.json({...task,_id:String(r.insertedId)});
});
app.patch("/api/admin/tasks/:id", requireAdmin, async (req,res)=>{
  const {ObjectId}=await import("mongodb");
  const update={};
  for(const k of ["title","reward","type","url","active"]) if(req.body[k]!==undefined) update[k]=req.body[k];
  await db.collection("tasks").updateOne({_id:new ObjectId(req.params.id)},{$set:update});
  res.json({ok:true});
});
app.delete("/api/admin/tasks/:id", requireAdmin, async (req,res)=>{
  const {ObjectId}=await import("mongodb");
  await db.collection("tasks").deleteOne({_id:new ObjectId(req.params.id)});
  res.json({ok:true});
});

app.get("/health", (req,res)=>res.json({ok:true,service:"goex-miniapp"}));
app.use(express.static(".", { extensions:["html"] }));
app.get("/admin", (req,res)=>res.sendFile(process.cwd()+"/admin.html"));
app.get(/.*/, (req,res)=>res.sendFile(process.cwd()+"/index.html"));

app.listen(PORT, ()=>console.log(`Goex Mini App running on :${PORT}`));