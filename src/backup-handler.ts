import { createBackup } from "./backup.js";
import { createDatabase } from "./db.js";

export async function handler(): Promise<{ key: string }> {
  const db = createDatabase(process.env.DB_PATH ?? "/mnt/data/diet.db");
  try {
    return await createBackup(db);
  } finally {
    db.close();
  }
}
