import type { ViteDevServer, Plugin } from 'vite';

export function socketIOPlugin(): Plugin {
	return {
		name: 'socket-io',
		configureServer(server: ViteDevServer) {
			if (!server.httpServer) return;

			server.httpServer.once('listening', async () => {
				const mod = await server.ssrLoadModule('$lib/server/socket-handler.js');
				(mod.setupSocketIO as Function)(server.httpServer!);
				console.log('[socket.io] attached to Vite dev server');
			});
		}
	};
}
