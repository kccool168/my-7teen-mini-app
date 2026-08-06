// Shared Redis client for Vercel serverless functions.
// Reuses one connection across warm invocations of the same function instance.
import { createClient } from 'redis';

let client;

export default async function getClient() {
  if (!process.env.REDIS_URL) {
    throw new Error('Missing REDIS_URL environment variable');
  }
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on('error', (err) => console.error('Redis Client Error', err));
  }
  if (!client.isOpen) {
    await client.connect();
  }
  return client;
}
