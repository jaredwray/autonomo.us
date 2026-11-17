import { createServer, type Server, type Socket } from "node:net";
import { BSON } from "mongodb";

const OP_REPLY = 1;
const OP_QUERY = 2004;
const OP_MSG = 2013;

/**
 * A standalone MongoDB stand-in that speaks just enough of the wire protocol
 * for the driver to connect, ping, create indexes and read an empty
 * collection. While `reachable` is false it drops every connection, as an
 * unreachable database does, so tests can fail a client's first connection and
 * then let the next one through without a real server.
 */
export class FakeMongo {
	reachable = false;
	private readonly sockets = new Set<Socket>();
	private constructor(
		private readonly server: Server,
		readonly url: string,
	) {}

	static async listen(): Promise<FakeMongo> {
		const server = createServer();
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as { port: number };
		const fake = new FakeMongo(server, `mongodb://127.0.0.1:${port}/fake`);
		server.on("connection", (socket) => fake.accept(socket));
		return fake;
	}

	private accept(socket: Socket) {
		socket.on("error", () => {});
		if (!this.reachable) {
			socket.destroy();
			return;
		}
		this.sockets.add(socket);
		socket.on("close", () => this.sockets.delete(socket));
		let pending = Buffer.alloc(0);
		socket.on("data", (chunk) => {
			pending = Buffer.concat([pending, chunk]);
			while (pending.length >= 4 && pending.length >= pending.readInt32LE(0)) {
				const message = pending.subarray(0, pending.readInt32LE(0));
				pending = pending.subarray(message.length);
				socket.write(this.reply(message));
			}
		});
	}

	private reply(message: Buffer): Buffer {
		const requestId = message.readInt32LE(4);
		if (message.readInt32LE(12) === OP_QUERY) {
			// The legacy handshake: flags, cursor id, starting from, one document.
			const body = BSON.serialize(HELLO);
			const reply = Buffer.alloc(36 + body.length);
			reply.writeInt32LE(reply.length, 0);
			reply.writeInt32LE(requestId, 8);
			reply.writeInt32LE(OP_REPLY, 12);
			reply.writeInt32LE(8, 16);
			reply.writeInt32LE(1, 32);
			body.copy(reply, 36);
			return reply;
		}
		// OP_MSG: flag bits, then a kind-0 section holding the command document.
		const command = BSON.deserialize(message.subarray(21));
		const name = Object.keys(command)[0];
		const body = BSON.serialize(
			name === "find"
				? {
						cursor: {
							id: BSON.Long.ZERO,
							ns: `${command.$db}.${command.find}`,
							firstBatch: [],
						},
						ok: 1,
					}
				: name === "hello" || name === "ismaster" || name === "isMaster"
					? HELLO
					: { ok: 1 },
		);
		const reply = Buffer.alloc(21 + body.length);
		reply.writeInt32LE(reply.length, 0);
		reply.writeInt32LE(requestId, 8);
		reply.writeInt32LE(OP_MSG, 12);
		body.copy(reply, 21);
		return reply;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.destroy();
		await new Promise((resolve) => this.server.close(resolve));
	}
}

const HELLO = {
	ok: 1,
	isWritablePrimary: true,
	ismaster: true,
	helloOk: true,
	maxBsonObjectSize: 16_777_216,
	maxMessageSizeBytes: 48_000_000,
	maxWriteBatchSize: 100_000,
	minWireVersion: 0,
	maxWireVersion: 25,
};
