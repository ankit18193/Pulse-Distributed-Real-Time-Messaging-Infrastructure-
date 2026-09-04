import type { Redis } from 'ioredis';

/**
 * Key Prefixes and Channel Constants for Distributed Presence (Phase 4)
 */
export const PRESENCE_USER_KEY_PREFIX = 'pulse:presence:user:';
export const PRESENCE_ROOM_MEMBERS_PREFIX = 'pulse:room:';
export const CHANNEL_PRESENCE_EVENTS = 'pulse:presence:events';
export const DEFAULT_KEY_SAFEGUARD_TTL_SEC = 120;

export function getPresenceUserKey(userId: string): string {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new Error('Invalid userId provided for presence key');
  }
  return `${PRESENCE_USER_KEY_PREFIX}${userId.trim()}`;
}

export function getRoomMembersKey(roomId: string): string {
  if (!roomId || typeof roomId !== 'string' || roomId.trim() === '') {
    throw new Error('Invalid roomId provided for room members key');
  }
  return `${PRESENCE_ROOM_MEMBERS_PREFIX}${roomId.trim()}:members`;
}

export function formatPresenceMember(instanceId: string, connectionId: string): string {
  if (!instanceId || !connectionId) {
    throw new Error('instanceId and connectionId are required to format presence member');
  }
  return `${instanceId}:${connectionId}`;
}

export function parsePresenceMember(
  member: string
): { instanceId: string; connectionId: string } | null {
  if (!member || typeof member !== 'string') return null;
  const separatorIndex = member.indexOf(':');
  if (separatorIndex === -1) return null;
  const instanceId = member.slice(0, separatorIndex);
  const connectionId = member.slice(separatorIndex + 1);
  if (!instanceId || !connectionId) return null;
  return { instanceId, connectionId };
}

/**
 * 1. REGISTER_PRESENCE_LUA
 *
 * KEYS[1]: pulse:presence:user:{userId} (ZSET)
 * ARGV[1]: {instanceId}:{connectionId} (member)
 * ARGV[2]: expireAtTimestampMs (score)
 * ARGV[3]: nowTimestampMs (prune timestamp)
 * ARGV[4]: keyTtlSeconds (safeguard TTL)
 *
 * Returns:
 * 1 = User transitioned from 0 -> 1 connections (ONLINE transition)
 * 0 = User was already online on other connections
 */
export const REGISTER_PRESENCE_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local expireAt = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local keyTtl = tonumber(ARGV[4])

-- 1. Prune expired leases
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

-- 2. Check active connection count before adding
local countBefore = redis.call('ZCARD', key)

-- 3. Add or refresh the connection lease
redis.call('ZADD', key, expireAt, member)

-- 4. Extend key-level TTL safeguard
redis.call('EXPIRE', key, keyTtl)

-- 5. Return whether this caused a 0 -> 1 transition
if countBefore == 0 then
  return 1
else
  return 0
end
`;

/**
 * 2. REMOVE_PRESENCE_LUA
 *
 * KEYS[1]: pulse:presence:user:{userId} (ZSET)
 * ARGV[1]: {instanceId}:{connectionId} (member)
 * ARGV[2]: nowTimestampMs (prune timestamp)
 * ARGV[3]: keyTtlSeconds (safeguard TTL)
 *
 * Returns:
 * 1 = User transitioned from 1 -> 0 connections (OFFLINE transition)
 * 0 = User still has active connections online
 */
export const REMOVE_PRESENCE_LUA = `
local key = KEYS[1]
local member = ARGV[1]
local now = tonumber(ARGV[2])
local keyTtl = tonumber(ARGV[3])

-- 1. Remove this specific connection lease
redis.call('ZREM', key, member)

-- 2. Prune any other expired leases
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)

-- 3. Check remaining active connection count
local countAfter = redis.call('ZCARD', key)

-- 4. If members remain, update TTL; if empty, delete key immediately
if countAfter > 0 then
  redis.call('EXPIRE', key, keyTtl)
  return 0
else
  redis.call('DEL', key)
  return 1
end
`;

/**
 * 3. GET_ROOM_PRESENCE_ROSTER_LUA
 *
 * KEYS[1]: pulse:room:{roomId}:members (SET of userIds)
 * ARGV[1]: nowTimestampMs (prune timestamp)
 *
 * Returns:
 * Array of userIds who currently have at least one active, unexpired connection lease.
 * Automatically prunes users from the room set who have zero active leases anywhere.
 */
export const GET_ROOM_PRESENCE_ROSTER_LUA = `
local roomKey = KEYS[1]
local now = tonumber(ARGV[1])

local members = redis.call('SMEMBERS', roomKey)
local onlineMembers = {}

for i = 1, #members do
  local userId = members[i]
  local userKey = 'pulse:presence:user:' .. userId

  -- Prune expired leases for this user
  redis.call('ZREMRANGEBYSCORE', userKey, '-inf', now)
  local count = redis.call('ZCARD', userKey)

  if count > 0 then
    table.insert(onlineMembers, userId)
  else
    -- Clean up room membership if user has zero active connections cluster-wide
    redis.call('SREM', roomKey, userId)
  end
end

return onlineMembers
`;

/**
 * Lua Script Invocation Wrappers
 */
export async function executeRegisterPresence(
  redis: Redis,
  userId: string,
  instanceId: string,
  connectionId: string,
  expireAtMs: number,
  nowMs: number = Date.now(),
  keyTtlSeconds: number = DEFAULT_KEY_SAFEGUARD_TTL_SEC
): Promise<number> {
  const userKey = getPresenceUserKey(userId);
  const member = formatPresenceMember(instanceId, connectionId);
  const result = await redis.eval(
    REGISTER_PRESENCE_LUA,
    1,
    userKey,
    member,
    expireAtMs.toString(),
    nowMs.toString(),
    keyTtlSeconds.toString()
  );
  return Number(result);
}

export async function executeRemovePresence(
  redis: Redis,
  userId: string,
  instanceId: string,
  connectionId: string,
  nowMs: number = Date.now(),
  keyTtlSeconds: number = DEFAULT_KEY_SAFEGUARD_TTL_SEC
): Promise<number> {
  const userKey = getPresenceUserKey(userId);
  const member = formatPresenceMember(instanceId, connectionId);
  const result = await redis.eval(
    REMOVE_PRESENCE_LUA,
    1,
    userKey,
    member,
    nowMs.toString(),
    keyTtlSeconds.toString()
  );
  return Number(result);
}

export async function executeGetRoomPresenceRoster(
  redis: Redis,
  roomId: string,
  nowMs: number = Date.now()
): Promise<string[]> {
  const roomKey = getRoomMembersKey(roomId);
  const result = await redis.eval(
    GET_ROOM_PRESENCE_ROSTER_LUA,
    1,
    roomKey,
    nowMs.toString()
  );
  return (result as string[]) || [];
}
