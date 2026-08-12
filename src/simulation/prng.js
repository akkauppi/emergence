const UINT32_RANGE = 0x1_0000_0000;

function avalanche(value) {
  let hash = value >>> 0;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function hashPart(value) {
  if (typeof value === "number") {
    if (Number.isInteger(value)) return avalanche(value);
    value = String(value);
  }

  const text = String(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return avalanche(hash);
}

/**
 * Return a reproducible random value without advancing shared state.
 * Adding a new random call under a different key will not alter existing calls.
 */
export function keyedRandom(seed, ...parts) {
  let hash = avalanche(Number(seed) || 0);
  for (const part of parts) {
    hash = avalanche(hash ^ hashPart(part));
  }
  return hash / UINT32_RANGE;
}

export function randomInteger(seed, minimum, maximumExclusive, ...parts) {
  const span = Math.max(0, maximumExclusive - minimum);
  return minimum + Math.floor(keyedRandom(seed, ...parts) * span);
}

export function stateChecksum(agents, tick = 0) {
  let checksum = avalanche(tick);
  const quantize = (value) => Math.round(value * 1_000);

  for (const agent of agents) {
    checksum = avalanche(checksum ^ hashPart(agent.id));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.x)));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.y)));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.vx)));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.vy)));
    checksum = avalanche(checksum ^ hashPart(agent.chosen[0]));
    checksum = avalanche(checksum ^ hashPart(agent.chosen[1]));
  }

  return checksum.toString(16).padStart(8, "0");
}
