import { Resource, type Context } from "alchemy";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Props for the PGLite resource.
 */
export interface PGLiteProps {
  /**
   * Directory to store PGLite data files.
   * @default ".acp/pglite"
   */
  dataDir?: string;

  /**
   * Whether to delete the data directory when the resource is destroyed.
   * @default false
   */
  delete?: boolean;
}

/**
 * Output of the PGLite resource.
 */
export type PGLite = Omit<PGLiteProps, "delete"> & {
  /**
   * Resolved absolute path to the data directory.
   */
  dataDir: string;

  /**
   * Connection string for use with Drizzle or other PG clients.
   * Format: `pglite://<dataDir>`
   */
  connectionString: string;
};

/**
 * Creates an embedded PGLite database on disk.
 *
 * @example
 * const db = await PGLite("my-db");
 * // db.dataDir = "/abs/path/.acp/pglite"
 * // db.connectionString = "pglite:///abs/path/.acp/pglite"
 *
 * @example
 * const db = await PGLite("my-db", { dataDir: "./data/pg" });
 */
// eslint-disable-next-line no-redeclare
export const PGLite = Resource(
  "flamecast::PGLite",
  async function (this: Context<PGLite>, id: string, props: PGLiteProps = {}): Promise<PGLite> {
    if (this.phase === "delete") {
      if (props.delete && this.output?.dataDir) {
        const { rm } = await import("node:fs/promises");
        await rm(this.output.dataDir, { recursive: true, force: true });
      }
      return this.destroy();
    }

    const dataDir = resolve(props.dataDir ?? this.output?.dataDir ?? ".acp/pglite");
    await mkdir(dataDir, { recursive: true });

    return {
      dataDir,
      connectionString: `pglite://${dataDir}`,
    };
  },
);
