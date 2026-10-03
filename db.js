import { MongoClient } from "mongodb";

let client;
let db;

export async function connectDB(uri) {
  if (!uri) throw new Error("MONGODB_URI is missing");
  client = new MongoClient(uri);
  await client.connect();
  db = client.db();
  await ensureIndexes();
  return db;
}

export function getDB() {
  if (!db) throw new Error("Database is not connected");
  return db;
}

async function ensureIndexes() {
  await db.collection("users").createIndex({ telegramId: 1 }, { unique: true });
  await db.collection("deposits").createIndex({ trackId: 1 }, { unique: true });
  await db.collection("withdrawals").createIndex({ trackId: 1 }, { unique: true, sparse: true });
  await db.collection("transactions").createIndex({ telegramId: 1, createdAt: -1 });
  await db.collection("tasks").createIndex({ active: 1 });
}

export async function closeDB() {
  if (client) await client.close();
}
