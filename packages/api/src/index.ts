import { createServer } from "./server.js";

const server = createServer();

const start = async () => {
	const port = Number(process.env.PORT) || 3000;
	const host = process.env.HOST || "0.0.0.0";

	await server.listen({ port, host });
};

start();

export { createServer };
