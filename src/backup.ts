import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type Database from "better-sqlite3";

const s3 = new S3Client({ region: process.env.AWS_REGION ?? "us-east-1" });

export async function createBackup(db: Database.Database): Promise<{ key: string }> {
  const bucket = process.env.S3_BACKUP_BUCKET;
  if (!bucket) throw new Error("S3_BACKUP_BUCKET is not configured");
  const file = join(tmpdir(), `diet-backup-${randomUUID()}.db`);
  try {
    db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
    const now = new Date();
    const key = `backups/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${String(now.getUTCDate()).padStart(2, "0")}.db`;
    const { createReadStream } = await import("node:fs");
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: createReadStream(file),
      ContentType: "application/x-sqlite3",
      ServerSideEncryption: "AES256"
    }));
    return { key };
  } finally {
    if (existsSync(file)) unlinkSync(file);
  }
}

export async function restoreBackup(key: string, destination: string, bucket = process.env.S3_BACKUP_BUCKET): Promise<void> {
  if (!bucket || !/^backups\/\d{4}\/\d{2}\/\d{2}\.db$/.test(key)) throw new Error("Invalid backup configuration or key");
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!response.Body) throw new Error("Backup object was empty");
  await pipeline(response.Body as NodeJS.ReadableStream, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
}
