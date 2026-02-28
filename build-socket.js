import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

await build({
	entryPoints: ['src/lib/server/socket-handler.ts'],
	bundle: true,
	platform: 'node',
	format: 'esm',
	outfile: 'build/socket-server.js',
	external: ['socket.io', 'crypto'],
	plugins: [
		{
			name: 'sveltekit-aliases',
			setup(build) {
				build.onResolve({ filter: /^\$lib\// }, (args) => ({
					path: resolve(__dirname, 'src/lib', args.path.slice('$lib/'.length).replace(/\.js$/, '.ts'))
				}));
			}
		}
	]
});

console.log('Socket server bundle written to build/socket-server.js');
