import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

const buildRedisUrl = () => {
  // Prefer full URL if provided (supports TLS, username, etc.)
  if (process.env.REDIS_URL) return process.env.REDIS_URL;

  const host = process.env.REDIS_HOST || "127.0.0.1";
  const port = process.env.REDIS_PORT || "6379";

  return `redis://${host}:${port}`;
};

export const createSocketRedisAdapter = async () => {
  const url = buildRedisUrl();

  const pubClient = createClient({
    url,
    password: process.env.REDIS_PASSWORD || undefined,
  });

  const subClient = pubClient.duplicate();

  pubClient.on("error", (err) => {
    console.error("[socket.io][redis] pubClient error:", err?.message || err);
  });
  subClient.on("error", (err) => {
    console.error("[socket.io][redis] subClient error:", err?.message || err);
  });

  await pubClient.connect();
  await subClient.connect();

  return {
    adapter: createAdapter(pubClient, subClient),
    pubClient,
    subClient,
  };
};

