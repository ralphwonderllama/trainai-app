import { createClient } from 'redis';

let _client = null;

export async function getRedis() {
  if (_client?.isReady) return _client;
  _client = createClient({ url: process.env.REDIS_URL });
  _client.on('error', () => { _client = null; });
  await _client.connect();
  return _client;
}
