import type { Connection } from "mongoose";

// Retire only the IDs created by the old seed. Keep a recoverable archive;
// UUID records entered by people are never deleted or reset.
export async function archiveLegacyDemo(connection: Connection) {
  const db = connection.db!;
  await db.createCollection("_legacy_demo_archive").catch((e: { code?: number }) => { if (e.code !== 48) throw e; });
  await connection.transaction(async (session) => {
    const meta = db.collection("_crm_meta");
    await meta.updateOne({ _id: "write-lock" as never }, { $inc: { revision: 1 } }, { session });
    if (await meta.findOne({ _id: "retire-demo-v1" as never }, { session })) return;
    const groups = [
      ["clients", Array.from({ length: 15 }, (_, i) => `c-${i + 1}`)],
      ["deals", Array.from({ length: 12 }, (_, i) => `d-${i + 1}`)],
      ["tasks", Array.from({ length: 10 }, (_, i) => `t-${i + 1}`)],
      ["users", ["u-admin", "u-rop", "u-manager"]],
    ] as const;
    for (const [name, ids] of groups.slice(1, 3)) {
      if (await db.collection(name).findOne({ _id: { $nin: ids as never }, clientId: { $in: groups[0][1] } }, { session })) {
        throw new Error("Legacy migration: real records reference demo clients; review required");
      }
    }
    for (const [name, ids] of groups) {
      const collection = db.collection(name);
      const records = await collection.find({ _id: { $in: ids as never } }, { session }).toArray();
      for (const record of records) {
        await db.collection("_legacy_demo_archive").updateOne(
          { _id: `${name}:${record._id}` as never },
          { $setOnInsert: { collection: name, record, archivedAt: new Date() } }, { upsert: true, session },
        );
      }
      await collection.deleteMany({ _id: { $in: ids as never } }, { session });
    }
    await meta.insertOne({ _id: "retire-demo-v1" as never, completedAt: new Date().toISOString() }, { session });
  });
}
