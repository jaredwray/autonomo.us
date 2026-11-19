import { DatabaseSync } from "node:sqlite";
import type { DecisionOutcome } from "@autonomo.us/common";
import { continuityRequest } from "./rustboy.js";

/** The external editor owns its shots. SQLite persists duplicate checks and outcomes across restarts. */
export class ShotConsumer {
	private db: DatabaseSync;
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS shots (work TEXT, revision TEXT, state TEXT, resumes INTEGER DEFAULT 0, PRIMARY KEY (work, revision));
			CREATE TABLE IF NOT EXISTS failures (work TEXT, revision TEXT, check_id TEXT, PRIMARY KEY (work, revision, check_id));
			CREATE TABLE IF NOT EXISTS outcomes (id TEXT PRIMARY KEY);
			INSERT OR IGNORE INTO shots (work, revision, state) VALUES ('rustboy/shot-014','cut-3','running'), ('rustboy/shot-015','cut-3','running');`);
	}
	/** A repeated check can retry opening a blocked case after a dropped response. */
	check(checkId: string) {
		const args = [
			continuityRequest.sourceWorkId,
			continuityRequest.sourceRevision,
		];
		this.db
			.prepare("INSERT OR IGNORE INTO failures VALUES (?,?,?)")
			.run(...args, checkId);
		this.db
			.prepare(
				"UPDATE shots SET state='blocked' WHERE work=? AND revision=? AND state='running' AND resumes=0 AND (SELECT count(*) FROM failures WHERE work=? AND revision=?)>=2",
			)
			.run(...args, ...args);
		return this.shot()?.state === "blocked";
	}
	shot(work = continuityRequest.sourceWorkId) {
		return this.db
			.prepare("SELECT state, resumes FROM shots WHERE work=? AND revision=?")
			.get(work, continuityRequest.sourceRevision);
	}
	apply(outcome: DecisionOutcome) {
		if (
			outcome.decisionKey !== continuityRequest.decisionKey ||
			outcome.sourceWorkId !== continuityRequest.sourceWorkId ||
			outcome.sourceRevision !== continuityRequest.sourceRevision
		)
			return false;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const recorded = this.db
				.prepare("INSERT OR IGNORE INTO outcomes VALUES (?)")
				.run(outcome.id);
			const result = recorded.changes
				? this.db
						.prepare(
							"UPDATE shots SET state=?,resumes=resumes+? WHERE work=? AND revision=? AND state='blocked'",
						)
						.run(
							outcome.status === "approved" ? "running" : "changes_requested",
							outcome.status === "approved" ? 1 : 0,
							outcome.sourceWorkId,
							outcome.sourceRevision,
						)
				: null;
			this.db.exec("COMMIT");
			return Boolean(result?.changes);
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	close() {
		this.db.close();
	}
}
