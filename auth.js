import crypto from "crypto";
import jwt from "jsonwebtoken";

export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken) throw new Error("Telegram authentication data is missing");

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  const authDate = Number(params.get("auth_date"));

  if (!hash || !authDate) throw new Error("Invalid Telegram initData");
  if (Math.floor(Date.now() / 1000) - authDate > maxAgeSeconds) {
    throw new Error("Telegram session expired");
  }

  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calculated = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  const a = Buffer.from(calculated, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error("Telegram authentication failed");
  }

  const user = JSON.parse(params.get("user") || "{}");
  if (!user.id) throw new Error("Telegram user missing");
  return user;
}

export function signUser(user, secret) {
  return jwt.sign(
    { telegramId: String(user.id), username: user.username || "", firstName: user.first_name || "" },
    secret,
    { expiresIn: "7d" }
  );
}

export function verifyToken(token, secret) {
  return jwt.verify(token, secret);
}
