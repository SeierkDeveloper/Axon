import { createHash } from "crypto";
import { getDb } from "./db";
import { syncToTurso } from "./db-turso";
import { postMemoTransaction } from "./evm";
import { EXPLORER } from "./chain";
import { logger } from "./logger";
import { filesHash, receiptFiles } from "./agentFiles";

// Memo format: axon:commitment:v1:{taskId}:{sha256hex}
// This is posted on-chain so anyone can independently verify the task output
// by hashing the result and checking it matches the on-chain record.
//
// A job that handed back files commits to them too:
//   axon:commitment:v2:{taskId}:{sha256 of the output}:{hash of the files}
// where the hash of the files is SHA-256 over each file's own SHA-256, sorted, one a line. A job with no files posts
// the first form exactly as before.
const MEMO_PREFIX = "axon:commitment:v1";
const MEMO_PREFIX_FILES = "axon:commitment:v2";

export interface OutputCommitment {
  hash: string;
  signature: string;
  explorerUrl: string;
  /** the hash over the files the job handed back, when it handed any back */
  filesHash?: string;
}

/** The hash over a job's returned files, or null when it returned none. Never throws. */
export function outputFilesHash(taskId: string): string | null {
  try {
    return filesHash(receiptFiles(taskId, "out").map((f) => f.sha256));
  } catch {
    return null;
  }
}

/** The memo a job's commitment is posted under. */
export function commitmentMemo(taskId: string, outputHash: string, files: string | null): string {
  return files ? `${MEMO_PREFIX_FILES}:${taskId}:${outputHash}:${files}` : `${MEMO_PREFIX}:${taskId}:${outputHash}`;
}

export function hashOutput(output: string): string {
  return createHash("sha256").update(output, "utf8").digest("hex");
}

// Writes the SHA-256 hash of a completed task's output on-chain.
// Fire-and-forget safe — never throws. Always stores the hash; stores the
// signature only when the on-chain post succeeds.
export async function commitOutput(taskId: string, output: string): Promise<string | null> {
  const hash = hashOutput(output);
  // the files were written while the agent worked, before the job completed, so they are all here by now
  const files = outputFilesHash(taskId);
  const memo = commitmentMemo(taskId, hash, files);

  let signature: string | null = null;
  try {
    signature = await postMemoTransaction(memo);
    getDb()
      .prepare("UPDATE tasks SET output_hash = ?, output_files_hash = ?, output_commitment = ? WHERE task_id = ?")
      .run(hash, files, signature, taskId);
    void syncToTurso();
    logger.info("output.committed", "Output commitment written on-chain", {
      taskId,
      hash,
      signature,
    });
  } catch (err) {
    // Store the hash even if the on-chain post failed — it's still locally verifiable
    getDb()
      .prepare("UPDATE tasks SET output_hash = ?, output_files_hash = ? WHERE task_id = ?")
      .run(hash, files, taskId);
    void syncToTurso();
    logger.warn("output.commitment_skipped", "Output hash stored locally; the on-chain write failed", {
      taskId,
      hash,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  return signature;
}

export function getOutputCommitment(taskId: string): OutputCommitment | null {
  const row = getDb()
    .prepare("SELECT output_hash, output_files_hash, output_commitment FROM tasks WHERE task_id = ?")
    .get(taskId) as { output_hash: string | null; output_files_hash: string | null; output_commitment: string | null } | undefined;

  if (!row?.output_hash || !row?.output_commitment) return null;

  return {
    hash: row.output_hash,
    signature: row.output_commitment,
    explorerUrl: `${EXPLORER}/tx/${row.output_commitment}`,
    ...(row.output_files_hash ? { filesHash: row.output_files_hash } : {}),
  };
}
