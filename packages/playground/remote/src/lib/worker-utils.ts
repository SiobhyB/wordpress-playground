import { WebPHP } from '@php-wasm/web';
import {
	LatestSupportedWordPressVersion,
	SupportedWordPressVersionsList,
} from '@wp-playground/wordpress-builds';
import {
	PHPResponse,
	PHPProcessManager,
	SupportedPHPVersion,
	SupportedPHPVersionsList,
	rotatePHPRuntime,
	PHPRequestHandler,
	proxyFileSystem,
	writeFiles,
} from '@php-wasm/universal';
import { EmscriptenDownloadMonitor } from '@php-wasm/progress';
import { createSpawnHandler, joinPaths, phpVar } from '@php-wasm/util';
import { createMemoizedFetch } from './create-memoized-fetch';
import { logger } from '@php-wasm/logger';
/** @ts-ignore */
import transportFetch from './playground-mu-plugin/playground-includes/wp_http_fetch.php?raw';
/** @ts-ignore */
import transportDummy from './playground-mu-plugin/playground-includes/wp_http_dummy.php?raw';
/** @ts-ignore */
import playgroundWebMuPlugin from './playground-mu-plugin/0-playground.php?raw';
import {
	enablePlatformMuPlugins,
	preloadPhpInfoRoute,
	preloadRequiredMuPlugin,
} from '@wp-playground/wordpress';

export type ReceivedStartupOptions = {
	wpVersion?: string;
	phpVersion?: string;
	sapiName?: string;
	storage?: string;
	phpExtensions?: string[];
};

export type ParsedStartupOptions = {
	wpVersion: string;
	phpVersion: SupportedPHPVersion;
	sapiName: string;
	storage: string;
	phpExtensions: string[];
};

export const receivedParams: ReceivedStartupOptions = {};
const url = self?.location?.href;
if (typeof url !== 'undefined') {
	const params = new URL(self.location.href).searchParams;
	receivedParams.wpVersion = params.get('wpVersion') || undefined;
	receivedParams.phpVersion = params.get('phpVersion') || undefined;
	receivedParams.storage = params.get('storage') || undefined;
	// Default to CLI to support the WP-CLI Blueprint step
	receivedParams.sapiName = params.get('sapiName') || 'cli';
	receivedParams.phpExtensions = params.getAll('php-extension');
}

export const requestedWPVersion = receivedParams.wpVersion || '';
export const startupOptions = {
	wpVersion: SupportedWordPressVersionsList.includes(requestedWPVersion)
		? requestedWPVersion
		: LatestSupportedWordPressVersion,
	phpVersion: SupportedPHPVersionsList.includes(
		receivedParams.phpVersion || ''
	)
		? (receivedParams.phpVersion as SupportedPHPVersion)
		: '8.0',
	sapiName: receivedParams.sapiName || 'cli',
	storage: receivedParams.storage || 'local',
	phpExtensions: receivedParams.phpExtensions || [],
} as ParsedStartupOptions;

export async function createPhp(
	requestHandler: PHPRequestHandler<WebPHP>,
	siteUrl: string,
	isPrimary: boolean
) {
	const php = new WebPHP();
	php.requestHandler = requestHandler as any;

	php.initializeRuntime(await createPhpRuntime());
	if (startupOptions.sapiName) {
		await php.setSapiName(startupOptions.sapiName);
	}
	php.setPhpIniEntry('memory_limit', '256M');
	php.setSpawnHandler(spawnHandlerFactory(requestHandler.processManager));

	if (isPrimary) {
		const scopedSitePath = new URL(siteUrl).pathname;
		await preloadPhpInfoRoute(
			php,
			joinPaths(scopedSitePath, 'phpinfo.php')
		);
		await enablePlatformMuPlugins(php);
		await preloadRequiredMuPlugin(php);
		await writeFiles(php, joinPaths('/internal/shared/mu-plugins'), {
			'1-playground-web.php': playgroundWebMuPlugin,
			'playground-includes/wp_http_dummy.php': transportDummy,
			'playground-includes/wp_http_fetch.php': transportFetch,
		});
	} else {
		proxyFileSystem(await requestHandler.getPrimaryPhp(), php, [
			'/tmp',
			requestHandler.documentRoot,
			'/internal/shared',
		]);
	}

	// Rotate the PHP runtime periodically to avoid memory leak-related crashes.
	// @see https://github.com/WordPress/wordpress-playground/pull/990 for more context
	rotatePHPRuntime({
		php,
		cwd: requestHandler.documentRoot,
		recreateRuntime: createPhpRuntime,
		maxRequests: 400,
	});
	return php;
}

export const downloadMonitor = new EmscriptenDownloadMonitor();

export const monitoredFetch = (input: RequestInfo | URL, init?: RequestInit) =>
	downloadMonitor.monitorFetch(fetch(input, init));
const memoizedFetch = createMemoizedFetch(monitoredFetch);

const createPhpRuntime = async () => {
	let wasmUrl = '';
	return await WebPHP.loadRuntime(startupOptions.phpVersion, {
		onPhpLoaderModuleLoaded: (phpLoaderModule) => {
			wasmUrl = phpLoaderModule.dependencyFilename;
			downloadMonitor.expectAssets({
				[wasmUrl]: phpLoaderModule.dependenciesTotalSize,
			});
		},
		// We don't yet support loading specific PHP extensions one-by-one.
		// Let's just indicate whether we want to load all of them.
		loadAllExtensions: startupOptions.phpExtensions?.length > 0,
		emscriptenOptions: {
			instantiateWasm(imports, receiveInstance) {
				// Using .then because Emscripten typically returns an empty
				// object here and not a promise.
				memoizedFetch(wasmUrl, {
					credentials: 'same-origin',
				})
					.then((response) =>
						WebAssembly.instantiateStreaming(response, imports)
					)
					.then((wasm) => {
						receiveInstance(wasm.instance, wasm.module);
					});
				return {};
			},
		},
	});
};

export function spawnHandlerFactory(processManager: PHPProcessManager<WebPHP>) {
	return createSpawnHandler(async function (args, processApi, options) {
		if (args[0] === 'exec') {
			args.shift();
		}

		// Mock programs required by wp-cli:
		if (
			args[0] === '/usr/bin/env' &&
			args[1] === 'stty' &&
			args[2] === 'size'
		) {
			// These numbers are hardcoded because this
			// spawnHandler is transmitted as a string to
			// the PHP backend and has no access to local
			// scope. It would be nice to find a way to
			// transfer / proxy a live object instead.
			// @TODO: Do not hardcode this
			processApi.stdout(`18 140`);
			processApi.exit(0);
		} else if (args[0] === 'less') {
			processApi.on('stdin', (data: Uint8Array) => {
				processApi.stdout(data);
			});
			processApi.flushStdin();
			processApi.exit(0);
		} else if (args[0] === 'fetch') {
			processApi.flushStdin();
			fetch(args[1]).then(async (res) => {
				const reader = res.body?.getReader();
				if (!reader) {
					processApi.exit(1);
					return;
				}
				while (true) {
					const { done, value } = await reader.read();
					if (done) {
						processApi.exit(0);
						break;
					}
					processApi.stdout(value);
				}
			});
			return;
		} else if (args[0] === 'php') {
			const { php, reap } = await processManager.acquirePHPInstance();

			let result: PHPResponse | undefined = undefined;
			try {
				// @TODO: Run the actual PHP CLI SAPI instead of
				//        interpreting the arguments and emulating
				//        the CLI constants and globals.
				const cliBootstrapScript = `<?php
                // Set the argv global.
                $GLOBALS['argv'] = array_merge([
                    "/wordpress/wp-cli.phar",
                    "--path=/wordpress"
                ], ${phpVar(args.slice(2))});

                // Provide stdin, stdout, stderr streams outside of
                // the CLI SAPI.
                define('STDIN', fopen('php://stdin', 'rb'));
                define('STDOUT', fopen('php://stdout', 'wb'));
                define('STDERR', fopen('/tmp/stderr', 'wb'));

                ${options.cwd ? 'chdir(getenv("DOCROOT")); ' : ''}
                `;

				if (args.includes('-r')) {
					result = await php.run({
						code: `${cliBootstrapScript} ${
							args[args.indexOf('-r') + 1]
						}`,
						env: options.env,
					});
				} else if (args[1] === 'wp-cli.phar') {
					result = await php.run({
						code: `${cliBootstrapScript} require( "/wordpress/wp-cli.phar" );`,
						env: {
							...options.env,
							// Set SHELL_PIPE to 0 to ensure WP-CLI formats
							// the output as ASCII tables.
							// @see https://github.com/wp-cli/wp-cli/issues/1102
							SHELL_PIPE: '0',
						},
					});
				} else {
					result = await php.run({
						scriptPath: args[1],
						env: options.env,
					});
				}
				processApi.stdout(result.bytes);
				processApi.stderr(result.errors);
				processApi.exit(result.exitCode);
			} catch (e) {
				logger.error('Error in childPHP:', e);
				if (e instanceof Error) {
					processApi.stderr(e.message);
				}
				processApi.exit(1);
			} finally {
				reap();
			}
		} else {
			processApi.exit(1);
		}
	});
}
