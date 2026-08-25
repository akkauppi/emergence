import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeParcelActivityConfig,
  ParcelActivityDemand,
} from "../src/simulation/parcel-activity.js";

function grid(columns = 3, rows = 1, cellSize = 20) {
  const cells = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const id = `land-${row}-${column}`;
      const neighborIds = [];
      if (column + 1 < columns) neighborIds.push(`land-${row}-${column + 1}`);
      if (row + 1 < rows) neighborIds.push(`land-${row + 1}-${column}`);
      if (column > 0) neighborIds.push(`land-${row}-${column - 1}`);
      if (row > 0) neighborIds.push(`land-${row - 1}-${column}`);
      cells.push(Object.freeze({
        id,
        index: row * columns + column,
        row,
        column,
        x: column * cellSize,
        y: row * cellSize,
        width: cellSize,
        height: cellSize,
        center: Object.freeze({
          x: column * cellSize + cellSize / 2,
          y: row * cellSize + cellSize / 2,
        }),
        neighborIds: Object.freeze(neighborIds),
      }));
    }
  }
  return cells;
}

function stores({ cells = grid(), parcels = [], publicIds = [], usage = {} } = {}) {
  const state = { parcels: [...parcels], publicIds: new Set(publicIds), usage: { ...usage } };
  return {
    state,
    land: {
      config: {
        cells,
        geometry: {
          worldWidth: Math.max(...cells.map((cell) => cell.x + cell.width)),
          worldHeight: Math.max(...cells.map((cell) => cell.y + cell.height)),
        },
      },
      frame: () => ({ parcels: state.parcels }),
    },
    circulation: {
      isPublic: (landId) => state.publicIds.has(landId),
      usage: (landId) => state.usage[landId] ?? 0,
    },
  };
}

const onlyMarket = [{
  id: "market",
  label: "Market",
  frequency: 1,
  weight: 2,
  minimumCells: 1,
}];

test("parcel activity policy normalizes into bounded immutable values", () => {
  const normalized = normalizeParcelActivityConfig({
    startTick: -4,
    maturationTicks: 0,
    frontageLossTicks: 0,
    minimumParcelCells: 0,
    maximumActivities: 999,
    radius: 0,
    accessOffset: -2,
    types: [
      { id: "workshop", frequency: 0, weight: -4, minimumCells: 0 },
      { id: "home", label: "Dwelling", share: 3, weight: 0.2, minimumCells: 2 },
      { id: "home", label: "duplicate" },
    ],
  });

  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.types));
  assert.ok(Object.isFrozen(normalized.types[0]));
  assert.deepEqual(
    {
      startTick: normalized.startTick,
      maturationTicks: normalized.maturationTicks,
      frontageLossTicks: normalized.frontageLossTicks,
      minimumParcelCells: normalized.minimumParcelCells,
      maximumActivities: normalized.maximumActivities,
      radius: normalized.radius,
      accessOffset: normalized.accessOffset,
    },
    {
      startTick: 0,
      maturationTicks: 1,
      frontageLossTicks: 1,
      minimumParcelCells: 1,
      maximumActivities: 256,
      radius: 1,
      accessOffset: 0,
    },
  );
  assert.deepEqual(normalized.types.map(({ id }) => id), ["home", "workshop"]);
  assert.equal(normalized.types[0].label, "Dwelling");
  assert.equal(normalized.types[1].frequency, 0.001);
  assert.equal(normalized.types[1].weight, 0);
  assert.equal(normalized.types[1].minimumCells, 1);
  assert.equal(normalizeParcelActivityConfig({ enabled: false }), null);
});

test("a mature parcel opens a stable public-frontage destination and records demand", () => {
  const parcel = {
    id: "parcel-7",
    ownerId: 7,
    cellIds: ["land-0-1"],
    area: 400,
  };
  const { land, circulation, state } = stores({
    parcels: [parcel],
    publicIds: ["land-0-0", "land-0-2"],
    usage: { "land-0-0": 3, "land-0-2": 10 },
  });
  const activity = new ParcelActivityDemand({
    enabled: true,
    startTick: 0,
    maturationTicks: 2,
    frontageLossTicks: 2,
    minimumParcelCells: 1,
    maximumActivities: 3,
    radius: 6,
    accessOffset: 4,
    types: onlyMarket,
  }, { land, circulation, seed: 19, worldWidth: 60, worldHeight: 20 });

  activity.advance(0);
  assert.deepEqual(activity.destinations, []);
  activity.advance(1);
  assert.equal(activity.destinations.length, 1);
  assert.deepEqual(activity.destinations[0], {
    id: "activity:parcel-7",
    label: "Market · person 7",
    kind: "parcel-activity",
    activityType: "market",
    parcelId: "parcel-7",
    ownerId: 7,
    landId: "land-0-1",
    roadLandId: "land-0-2",
    side: "east",
    x: 44,
    y: 10,
    radius: 6,
    weight: 2,
    visits: 0,
  });
  assert.ok(Object.isFrozen(activity.destinations));
  assert.ok(Object.isFrozen(activity.destinations[0]));
  assert.equal(activity.metrics().activityOpenings, 1);

  state.usage["land-0-0"] = 100;
  activity.advance(2);
  assert.equal(activity.destinations[0].roadLandId, "land-0-2", "a surviving entrance must not jitter");
  assert.equal(activity.recordArrival("activity:parcel-7"), true);
  assert.equal(activity.recordArrival("authored-gate"), false);
  assert.equal(activity.destinations[0].visits, 1);
  assert.equal(activity.metrics().activityTrips, 1);
  assert.deepEqual(activity.frame().byType, [{ id: "market", label: "Market", count: 1, trips: 1 }]);

  state.publicIds.clear();
  activity.advance(3);
  assert.equal(activity.destinations.length, 1, "brief frontage loss receives a grace period");
  activity.advance(4);
  assert.deepEqual(activity.destinations, []);
  assert.equal(activity.metrics().activityClosures, 1);
  assert.equal(activity.frame().events[0].reason, "frontage-lost");
});

test("activity activation and checksums ignore parcel declaration order", () => {
  const cells = grid(4, 2);
  const parcels = [
    { id: "parcel-2", ownerId: 2, cellIds: ["land-0-1"], area: 400 },
    { id: "parcel-8", ownerId: 8, cellIds: ["land-1-1"], area: 400 },
  ];
  const firstStores = stores({
    cells,
    parcels,
    publicIds: ["land-0-0", "land-1-0"],
  });
  const secondStores = stores({
    cells,
    parcels: [...parcels].reverse(),
    publicIds: ["land-1-0", "land-0-0"],
  });
  const config = {
    enabled: true,
    startTick: 0,
    maturationTicks: 1,
    minimumParcelCells: 1,
    maximumActivities: 1,
    types: onlyMarket,
  };
  const first = new ParcelActivityDemand(config, {
    land: firstStores.land,
    circulation: firstStores.circulation,
    seed: 91,
    worldWidth: 80,
    worldHeight: 40,
  });
  const second = new ParcelActivityDemand(config, {
    land: secondStores.land,
    circulation: secondStores.circulation,
    seed: 91,
    worldWidth: 80,
    worldHeight: 40,
  });

  first.advance(1);
  second.advance(1);
  assert.deepEqual(second.frame(), first.frame());
  assert.deepEqual(second.checksumState(), first.checksumState());

  const activeParcelId = first.destinations[0].parcelId;
  firstStores.state.parcels = parcels.filter((parcel) => parcel.id !== activeParcelId);
  first.advance(2);
  assert.equal(first.metrics().activityClosures, 1);
  assert.equal(first.frame().events[0].reason, "tenure-ended");
});

test("the first activity cohort balances available purposes before repeating one", () => {
  const cells = grid(10, 1);
  const parcels = [1, 3, 5, 7, 9].map((column, ownerId) => ({
    id: `parcel-${ownerId}`,
    ownerId,
    cellIds: [`land-0-${column}`],
    area: 400,
  }));
  const { land, circulation } = stores({
    cells,
    parcels,
    publicIds: ["land-0-0", "land-0-2", "land-0-4", "land-0-6", "land-0-8"],
  });
  const types = ["green", "home", "market", "well", "workshop"].map((id, index) => ({
    id,
    label: id,
    frequency: index === 1 ? 6 : 1,
    weight: 1,
    minimumCells: 1,
  }));
  const activity = new ParcelActivityDemand({
    enabled: true,
    startTick: 0,
    maturationTicks: 1,
    minimumParcelCells: 1,
    maximumActivities: 5,
    types,
  }, { land, circulation, seed: 414, worldWidth: 200, worldHeight: 20 });

  activity.advance(1);
  assert.deepEqual(
    [...new Set(activity.destinations.map((destination) => destination.activityType))].sort(),
    ["green", "home", "market", "well", "workshop"],
  );
});
