import {
	BasePHP,
	PHPRequestHandler,
	SpawnHandler,
	proxyFileSystem,
	rotatePHPRuntime,
	writeFiles,
} from '@php-wasm/universal';
import {
	enablePlatformMuPlugins,
	preloadPhpInfoRoute,
	preloadRequiredMuPlugin,
} from '.';

export type PhpIniOptions = Record<string, string>;
export type Hook = () => void | Promise<void>;
export interface Hooks {
	beforeWordPress?: Hook;
	beforeDatabase?: Hook;
	beforeBlueprint?: Hook;
}

export type DatabaseType = 'sqlite' | 'mysql' | 'custom';

export interface BootOptions<PHP extends BasePHP> {
	createPhpRuntime: () => Promise<number>;
	createPhpInstance: () => PHP;
	/** Default: 'sqlite' */
	databaseType?: DatabaseType;
	/**
	 * Mounting and Copying is handled via hooks for starters.
	 *
	 * In the future we could standardize the
	 * browser-specific and node-specific mounts
	 * in the future.
	 */
	hooks?: Hooks;
	siteUrl: string;
	/** SQL file to load instead of installing WordPress. */
	dataSqlPath?: string;
	/** Zip with the WordPress installation to extract in /wordpress. */
	baseSnapshot?: File | Promise<File>;
	/** Preloaded SQLite integration plugin. */
	sqliteIntegrationPlugin?: File | Promise<File>;
	spawnHandler?: SpawnHandler;
	phpIniPath?: string;
	phpIniOverrides?: PhpIniOptions;
	phpIniRoute?: string;
	muPlugins?: Record<string, string>;
	sharedFiles?: Record<string, string>;
}

export async function bootPlayground<PHP extends BasePHP>(
	options: BootOptions<PHP>
) {
	async function createPhp(
		requestHandler: PHPRequestHandler<BasePHP>,
		isPrimary: boolean
	) {
		const php = options.createPhpInstance();
		php.initializeRuntime(await options.createPhpRuntime());
		if (requestHandler) {
			php.requestHandler = requestHandler;
		}
		if (options.phpIniPath) {
			php.setPhpIniPath(options.phpIniPath);
		}
		for (const [key, value] of Object.entries(
			options.phpIniOverrides || {}
		)) {
			php.setPhpIniEntry(key, value);
		}
		if (isPrimary) {
			await enablePlatformMuPlugins(php);
			await preloadRequiredMuPlugin(php);
			await writeFiles(
				php,
				'/internal/shared',
				options.sharedFiles || {}
			);
			await writeFiles(
				php,
				'/internal/shared/mu-plugins',
				options.muPlugins || {}
			);
			if (options.phpIniRoute) {
				await preloadPhpInfoRoute(php, options.phpIniRoute);
			}
		} else {
			proxyFileSystem(await requestHandler.getPrimaryPhp(), php, [
				'/tmp',
				requestHandler.documentRoot,
				'/internal/shared',
			]);
		}

		if (options.spawnHandler) {
			await php.setSpawnHandler(options.spawnHandler);
		}

		// php.setSpawnHandler(spawnHandlerFactory(processManager));
		// Rotate the PHP runtime periodically to avoid memory leak-related crashes.
		// @see https://github.com/WordPress/wordpress-playground/pull/990 for more context
		rotatePHPRuntime({
			php,
			cwd: requestHandler.documentRoot,
			recreateRuntime: options.createPhpRuntime,
			maxRequests: 400,
		});

		return php;
	}

	const requestHandler: PHPRequestHandler<PHP> = new PHPRequestHandler<PHP>({
		phpFactory: async ({ isPrimary }) =>
			createPhp(requestHandler, isPrimary),
		documentRoot: '/wordpress',
		absoluteUrl: options.siteUrl,
	});

	const php = await requestHandler.getPrimaryPhp();

	// Run "before install" hooks to mount/copy more files in

	// Unzip WordPress snapshot to /wordpress
	//    * Use a PHP function that can detect a subdirectory called /wordpress and
	//      directly extract files from there.
	//    * Also, thinking about wordpress-develop builds, let's accept a path inside
	//      a zip file to extract from.
	//    * Should we have an "optional top-level path" and "subdirectory" options, then?
	// Assert WordPress core is set up

	// Run "before database" hooks to mount/copy more files in

	// Setup SQLite if needed
	// Import data.sql if needed
	// Stream-rewrite data.sql URLs if needed
	// Assert is_blog_installed()

	return requestHandler;
}
