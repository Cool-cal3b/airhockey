import { createServer } from 'http';
import { handler } from './build/handler.js';
import { setupSocketIO } from './build/socket-server.js';

const server = createServer(handler);

setupSocketIO(server);

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => {
	console.log(`Listening on port ${port}`);
});
