import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, sites } from "../src/db/schema.js";

const email = `test-dashboards-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  cookie = loginRes.headers["set-cookie"]![0];

  const [site] = await db.insert(sites).values({ name: `test-dashboards-site-${crypto.randomUUID()}` }).returning();
  siteId = site.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(eq(sites.id, siteId));
});

describe("dashboards", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/dashboards");
    expect(res.status).toBe(401);
  });

  it("creates a dashboard, adds a widget, repositions it, then deletes both", async () => {
    const createRes = await request(app).post("/api/dashboards").set("Cookie", cookie).send({ name: "Test dashboard" });
    expect(createRes.status).toBe(201);
    const dashboardId = createRes.body.id;

    const widgetRes = await request(app)
      .post(`/api/dashboards/${dashboardId}/widgets`)
      .set("Cookie", cookie)
      .send({ type: "group_summary", config: { siteId }, x: 0, y: 0, w: 4, h: 3 });
    expect(widgetRes.status).toBe(201);
    const widgetId = widgetRes.body.id;

    const listRes = await request(app).get(`/api/dashboards/${dashboardId}/widgets`).set("Cookie", cookie);
    expect(listRes.body).toHaveLength(1);

    const moveRes = await request(app)
      .patch(`/api/dashboards/widgets/${widgetId}`)
      .set("Cookie", cookie)
      .send({ x: 4, y: 2 });
    expect(moveRes.status).toBe(200);
    expect(moveRes.body.x).toBe(4);
    expect(moveRes.body.y).toBe(2);

    // Deleting the dashboard should cascade-delete its widgets (schema's
    // onDelete: "cascade") — verify the widget is actually gone, not just
    // the dashboard row.
    const deleteRes = await request(app).delete(`/api/dashboards/${dashboardId}`).set("Cookie", cookie);
    expect(deleteRes.status).toBe(204);

    const widgetsAfterDelete = await request(app).get(`/api/dashboards/${dashboardId}/widgets`).set("Cookie", cookie);
    expect(widgetsAfterDelete.body).toHaveLength(0);
  });

  it("rejects an invalid widget type", async () => {
    const createRes = await request(app).post("/api/dashboards").set("Cookie", cookie).send({ name: "Another dashboard" });
    const res = await request(app)
      .post(`/api/dashboards/${createRes.body.id}/widgets`)
      .set("Cookie", cookie)
      .send({ type: "not_a_real_type", config: {} });
    expect(res.status).toBe(400);
    await request(app).delete(`/api/dashboards/${createRes.body.id}`).set("Cookie", cookie);
  });
});
