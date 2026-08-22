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

function hashAgents(checksum, agents) {
  const quantize = (value) => Math.round(value * 1_000);

  for (const agent of [...agents].sort((a, b) => a.id - b.id)) {
    checksum = avalanche(checksum ^ hashPart(agent.id));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.x ?? agent.position?.x)));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.y ?? agent.position?.y)));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.vx ?? agent.velocity?.x ?? 0)));
    checksum = avalanche(checksum ^ hashPart(quantize(agent.vy ?? agent.velocity?.y ?? 0)));
    const chosen = agent.chosen || [];
    checksum = avalanche(checksum ^ hashPart(chosen[0] ?? -1));
    checksum = avalanche(checksum ^ hashPart(chosen[1] ?? -1));
    checksum = avalanche(checksum ^ hashPart(agent.destinationId ?? ""));
    checksum = avalanche(checksum ^ hashPart(agent.arrivalCount ?? 0));
  }
  return checksum;
}

function hashCanonicalValue(checksum, value) {
  if (value === null) return avalanche(checksum ^ hashPart("null"));

  if (ArrayBuffer.isView(value)) {
    checksum = avalanche(checksum ^ hashPart(`typed:${value.constructor.name}:${value.length}`));
    const bytes = new DataView(value.buffer, value.byteOffset, value.byteLength);
    let offset = 0;
    for (; offset + 4 <= value.byteLength; offset += 4) {
      checksum = avalanche(checksum ^ bytes.getUint32(offset, true));
    }
    // Uint8/Uint16 state arrays are not necessarily word-aligned in length.
    // Hash the tail explicitly so a changed final road/tenure cell cannot be
    // invisible to replay checksums.
    for (; offset < value.byteLength; offset += 1) {
      checksum = avalanche(checksum ^ bytes.getUint8(offset));
    }
    return checksum;
  }

  if (Array.isArray(value)) {
    checksum = avalanche(checksum ^ hashPart(`array:${value.length}`));
    for (const item of value) checksum = hashCanonicalValue(checksum, item);
    return checksum;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    checksum = avalanche(checksum ^ hashPart(`object:${keys.length}`));
    for (const key of keys) {
      checksum = avalanche(checksum ^ hashPart(`key:${key}`));
      checksum = hashCanonicalValue(checksum, value[key]);
    }
    return checksum;
  }

  return avalanche(checksum ^ hashPart(`${typeof value}:${String(value)}`));
}

export function stateChecksum(agents, tick = 0, hiddenState = {}) {
  let checksum = avalanche(tick);
  checksum = hashAgents(checksum, agents);
  checksum = avalanche(checksum ^ hashPart(hiddenState.eventCursor ?? 0));
  checksum = avalanche(checksum ^ hashPart(hiddenState.delayTicks ?? 0));

  for (const snapshot of hiddenState.history || []) {
    checksum = avalanche(checksum ^ hashPart(snapshot.tick));
    checksum = snapshot.fingerprint === undefined
      ? hashAgents(checksum, snapshot.views)
      : avalanche(checksum ^ hashPart(snapshot.fingerprint));
  }

  if (hiddenState.configuration !== undefined) {
    checksum = hashCanonicalValue(checksum, hiddenState.configuration);
  }

  if (hiddenState.journey !== undefined) {
    checksum = hashCanonicalValue(checksum, hiddenState.journey);
  }

  if (hiddenState.field !== undefined) {
    checksum = hashCanonicalValue(checksum, hiddenState.field);
  }

  if (hiddenState.land !== undefined) {
    checksum = hashCanonicalValue(checksum, hiddenState.land);
  }

  if (hiddenState.circulation !== undefined) {
    checksum = hashCanonicalValue(checksum, hiddenState.circulation);
  }

  return checksum.toString(16).padStart(8, "0");
}
