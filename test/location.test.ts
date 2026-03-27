import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// Isolated state DB for location tests
const TEST_STATE_DIR = mkdtempSync(join(tmpdir(), "claude-assist-location-"));
process.env.CONDUIT_STATE_DIR = TEST_STATE_DIR;

const {
  createLocation,
  listLocations,
  getLocation,
  deleteLocation,
  storeLocationUpdate,
  getLatestLocation,
  checkGeofences,
  distanceToLocation,
  closeDb,
} = await import("../src/conduit/state");

afterAll(() => {
  closeDb();
  rmSync(TEST_STATE_DIR, { recursive: true, force: true });
});

// =============================================================================
// Location CRUD
//
// Named locations with lat/lon/radius used for geofencing.
// =============================================================================

describe("createLocation", () => {
  test("creates a location with slug ID from name", () => {
    const loc = createLocation("Home", -37.7, 176.2, 50);
    expect(loc.id).toBe("home");
    expect(loc.name).toBe("Home");
    expect(loc.lat).toBe(-37.7);
    expect(loc.lon).toBe(176.2);
    expect(loc.radiusM).toBe(50);
  });

  test("slug normalises special characters", () => {
    const loc = createLocation("Dave's Office (CBD)", -37.8, 176.3);
    expect(loc.id).toBe("dave-s-office-cbd");
  });

  test("slug truncates at 40 characters", () => {
    const longName = "A".repeat(60);
    const loc = createLocation(longName, 0, 0);
    expect(loc.id.length).toBeLessThanOrEqual(40);
  });

  test("defaults radius to 100m", () => {
    const loc = createLocation("Default Radius", -37.7, 176.2);
    expect(loc.radiusM).toBe(100);
  });

  test("upserts on same slug ID (OR REPLACE)", () => {
    createLocation("Upsert Test", -37.0, 176.0, 50);
    const updated = createLocation("Upsert Test", -38.0, 177.0, 200);
    expect(updated.lat).toBe(-38.0);
    expect(updated.lon).toBe(177.0);
    expect(updated.radiusM).toBe(200);

    const fetched = getLocation("upsert-test");
    expect(fetched!.lat).toBe(-38.0);
  });
});

describe("listLocations", () => {
  test("returns all created locations sorted by name", () => {
    createLocation("Zulu Office", -37.0, 176.0);
    createLocation("Alpha Cafe", -37.1, 176.1);
    const locs = listLocations();
    const names = locs.map(l => l.name);
    // Alpha should come before Zulu
    const alphaIdx = names.indexOf("Alpha Cafe");
    const zuluIdx = names.indexOf("Zulu Office");
    expect(alphaIdx).toBeLessThan(zuluIdx);
  });

  test("returns empty array when no locations exist after deleting all", () => {
    // Get current locations and delete them all
    const before = listLocations();
    for (const loc of before) {
      deleteLocation(loc.id);
    }
    expect(listLocations()).toEqual([]);
  });
});

describe("getLocation", () => {
  test("returns null for non-existent ID", () => {
    expect(getLocation("nonexistent-location")).toBeNull();
  });

  test("returns location by ID", () => {
    createLocation("Get Test", -37.5, 176.5, 75);
    const loc = getLocation("get-test");
    expect(loc).not.toBeNull();
    expect(loc!.name).toBe("Get Test");
    expect(loc!.radiusM).toBe(75);
  });
});

describe("deleteLocation", () => {
  test("returns true when location deleted", () => {
    createLocation("Delete Me", -37.0, 176.0);
    expect(deleteLocation("delete-me")).toBe(true);
    expect(getLocation("delete-me")).toBeNull();
  });

  test("returns false for non-existent location", () => {
    expect(deleteLocation("never-existed")).toBe(false);
  });
});

// =============================================================================
// Location History
//
// Stores GPS updates from OwnTracks. Retains last 1000 entries.
// =============================================================================

describe("storeLocationUpdate", () => {
  test("stores and retrieves latest location", () => {
    storeLocationUpdate({
      lat: -37.7,
      lon: 176.2,
      accuracy: 10,
      velocity: 0,
      battery: 85,
      timestamp: 1711500000,
    });

    const latest = getLatestLocation();
    expect(latest).not.toBeNull();
    expect(latest!.lat).toBe(-37.7);
    expect(latest!.lon).toBe(176.2);
    expect(latest!.accuracy).toBe(10);
    expect(latest!.velocity).toBe(0);
    expect(latest!.battery).toBe(85);
    expect(latest!.timestamp).toBe(1711500000);
  });

  test("latest returns most recent update", () => {
    storeLocationUpdate({ lat: -37.0, lon: 176.0, timestamp: 1000 });
    storeLocationUpdate({ lat: -38.0, lon: 177.0, timestamp: 2000 });

    const latest = getLatestLocation();
    expect(latest!.lat).toBe(-38.0);
    expect(latest!.lon).toBe(177.0);
  });

  test("handles optional fields as null", () => {
    storeLocationUpdate({ lat: -37.5, lon: 176.5, timestamp: 3000 });
    const latest = getLatestLocation();
    expect(latest!.accuracy).toBeNull();
    expect(latest!.velocity).toBeNull();
    expect(latest!.battery).toBeNull();
  });
});

describe("getLatestLocation", () => {
  // Note: already tested above, but test the empty case separately
  // by using a fresh conceptual check — previous tests already populated data
  test("returns a location (history is populated from prior tests)", () => {
    const latest = getLatestLocation();
    expect(latest).not.toBeNull();
    expect(typeof latest!.lat).toBe("number");
    expect(typeof latest!.lon).toBe("number");
  });
});

// =============================================================================
// Geofencing
//
// Haversine distance calculation and geofence matching.
// =============================================================================

describe("checkGeofences", () => {
  test("matches location inside geofence radius", () => {
    // Create a location and check a point very close to it
    createLocation("Geofence Test", -37.7, 176.2, 500); // 500m radius
    const matched = checkGeofences(-37.7, 176.2); // exact same point
    const names = matched.map(l => l.name);
    expect(names).toContain("Geofence Test");
  });

  test("does not match location outside geofence radius", () => {
    createLocation("Far Away Fence", 40.0, -74.0, 100); // NYC area, 100m radius
    const matched = checkGeofences(-37.7, 176.2); // NZ — thousands of km away
    const names = matched.map(l => l.name);
    expect(names).not.toContain("Far Away Fence");
  });

  test("matches multiple overlapping geofences", () => {
    createLocation("Overlap A", -37.7, 176.2, 1000);
    createLocation("Overlap B", -37.7, 176.2, 2000);
    const matched = checkGeofences(-37.7, 176.2);
    const names = matched.map(l => l.name);
    expect(names).toContain("Overlap A");
    expect(names).toContain("Overlap B");
  });

  test("returns empty array when no geofences match", () => {
    // Point in the middle of the ocean, far from any defined location
    const matched = checkGeofences(0, 0);
    // Filter to only locations near 0,0 (there shouldn't be any)
    const nearOrigin = matched.filter(l => Math.abs(l.lat) < 1 && Math.abs(l.lon) < 1);
    expect(nearOrigin).toEqual([]);
  });

  test("boundary: point just inside radius", () => {
    // Haversine: ~111.32m per 0.001 degrees latitude at equator
    createLocation("Boundary Test", 0, 0, 120); // 120m radius, covers 0.001 deg
    const matched = checkGeofences(0.001, 0);
    const names = matched.map(l => l.name);
    expect(names).toContain("Boundary Test");
  });

  test("boundary: point just outside radius", () => {
    createLocation("Tight Fence", 0, 0, 50); // 50m radius
    // 0.001 degrees = ~111m, well outside 50m
    const matched = checkGeofences(0.001, 0);
    const names = matched.map(l => l.name);
    expect(names).not.toContain("Tight Fence");
  });
});

describe("distanceToLocation", () => {
  test("returns 0 for same point", () => {
    createLocation("Distance Zero", -37.7, 176.2);
    const d = distanceToLocation(-37.7, 176.2, "distance-zero");
    expect(d).toBe(0);
  });

  test("returns correct approximate distance", () => {
    // Auckland to Wellington is roughly 500km
    createLocation("Auckland", -36.85, 174.76);
    const d = distanceToLocation(-41.29, 174.78, "auckland");
    expect(d).not.toBeNull();
    // Should be between 450km and 550km
    expect(d!).toBeGreaterThan(450000);
    expect(d!).toBeLessThan(550000);
  });

  test("returns null for non-existent location", () => {
    expect(distanceToLocation(0, 0, "nonexistent")).toBeNull();
  });

  test("haversine is symmetric", () => {
    createLocation("Sym A", -37.0, 176.0);
    createLocation("Sym B", -38.0, 177.0);
    const d1 = distanceToLocation(-38.0, 177.0, "sym-a");
    const d2 = distanceToLocation(-37.0, 176.0, "sym-b");
    expect(d1).not.toBeNull();
    expect(d2).not.toBeNull();
    // Should be equal (or very close due to floating point)
    expect(Math.abs(d1! - d2!)).toBeLessThan(1); // within 1 meter
  });
});
