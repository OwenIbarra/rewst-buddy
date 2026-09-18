import { randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, stat, unlink, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { getRuntimeHost } from '../host';

export interface SaveExportRequest {
	outputPath: string;
	recommendedFilename: string;
	contents: string;
	overwrite: boolean;
	signal?: AbortSignal;
}

export interface SavedExport {
	outputPath: string;
	bytes: number;
}

/** Destination boundary for future GitHub, GitLab, or object-storage adapters. */
export interface ExportStorage {
	save(request: SaveExportRequest): Promise<SavedExport>;
}

async function pathKind(path: string): Promise<'directory' | 'file' | 'missing'> {
	try {
		return (await stat(path)).isDirectory() ? 'directory' : 'file';
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
		throw error;
	}
}

function configuredRoots(): string[] {
	const configured = getRuntimeHost().getSetting<unknown>('mcp.exportRoots', []);
	return Array.isArray(configured)
		? configured.filter((value): value is string => typeof value === 'string' && isAbsolute(value))
		: [];
}

async function gitCheckoutRoot(start: string): Promise<string | undefined> {
	let candidate = start;
	for (;;) {
		if ((await pathKind(join(candidate, '.git'))) !== 'missing') return candidate;
		const parent = dirname(candidate);
		if (parent === candidate) return undefined;
		candidate = parent;
	}
}

async function approvedExportRoots(): Promise<string[]> {
	const host = getRuntimeHost();
	const candidates = [
		join(homedir(), 'Downloads'),
		resolveDefaultExportDir(),
		...(host.workspaceRoots?.() ?? []),
		...configuredRoots(),
	];
	const checkout = await gitCheckoutRoot(process.cwd());
	if (checkout) candidates.push(checkout);

	const approved = new Set<string>();
	for (const candidate of candidates) {
		if (!isAbsolute(candidate)) continue;
		try {
			const canonical = await realpath(candidate);
			if ((await stat(canonical)).isDirectory()) approved.add(canonical);
		} catch {
			// Unreadable, missing, or unresolvable candidates are skipped so
			// one bad root cannot block the remaining candidates.
			continue;
		}
	}
	return [...approved];
}

function isWithinRoot(candidate: string, root: string): boolean {
	const remainder = relative(root, candidate);
	return remainder === '' || (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
}

interface ApprovedTarget {
	target: string;
	approvedRoots: string[];
}

async function approvedCanonicalTarget(target: string): Promise<ApprovedTarget> {
	const canonicalParent = await realpath(dirname(target)).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error(`Export output directory does not exist: ${dirname(target)}`);
		}
		throw error;
	});
	const approved = await approvedExportRoots();
	if (!approved.some(root => isWithinRoot(canonicalParent, root))) {
		throw new Error(
			'Export outputPath is outside the approved local roots. Use Downloads, an active workspace, the current Git checkout, or configure rewst-buddy.mcp.exportRoots.',
		);
	}
	return { target: join(canonicalParent, basename(target)), approvedRoots: approved };
}

/** Converts a server-suggested filename into one safe path segment. */
export function sanitizeExportFilename(value: string): string {
	const unsafeCharacters = new Set('<>:"/\\|?*');
	let safe = [...value.normalize('NFC')]
		.map(character => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 31 || codePoint === 127 || unsafeCharacters.has(character) ? '_' : character;
		})
		.join('')
		.replace(/[. ]+$/g, '')
		.replace(/^\.+$/g, '')
		.trim();
	if (!safe) safe = 'rewst-workflows-export';
	// Windows treats device names as reserved even when followed by an extension.
	if (/^(?:CON|NUL|PRN|AUX|COM[1-9]|LPT[1-9])(?:[. ]|$)/i.test(safe)) safe = `_${safe}`;
	if (!safe.toLowerCase().endsWith('.json')) safe += '.json';
	return safe.length <= 240 ? safe : `${safe.slice(0, 235)}.json`;
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('Workflow export was cancelled.');
}

/** Default folder for saves that point at the Downloads folder itself. */
export const DOWNLOADS_EXPORT_FOLDER = 'Rewst Exports';

/** Runtime-host setting key for the configurable default export directory. */
export const DEFAULT_EXPORT_DIR_SETTING = 'mcp.exportDefaultDir';

function configuredDefaultDir(): string | undefined {
	const configured = getRuntimeHost().getSetting<unknown>(DEFAULT_EXPORT_DIR_SETTING, '');
	if (typeof configured !== 'string') return undefined;
	const trimmed = configured.trim();
	if (!trimmed) return undefined;
	if (!isAbsolute(trimmed)) {
		throw new Error('"mcp.exportDefaultDir" must be an absolute directory path.');
	}
	return trimmed;
}

/**
 * Resolves the default export directory without touching the filesystem:
 * the configured absolute path when set, otherwise the cross-OS
 * `<home>/Downloads/Rewst Exports` folder.
 */
export function resolveDefaultExportDir(): string {
	return configuredDefaultDir() ?? join(homedir(), 'Downloads', DOWNLOADS_EXPORT_FOLDER);
}

/**
 * Resolves the default export directory and creates it when missing, so an
 * omitted outputPath always has somewhere to land on any OS.
 */
export async function ensureDefaultExportDir(): Promise<string> {
	const directory = resolveDefaultExportDir();
	await mkdir(directory, { recursive: true });
	return directory;
}

async function redirectDownloadsRoot(target: string): Promise<string> {
	let downloads: string;
	try {
		downloads = await realpath(join(homedir(), 'Downloads'));
	} catch {
		return target;
	}
	if (dirname(target) !== downloads) return target;
	const directory = join(downloads, DOWNLOADS_EXPORT_FOLDER);
	await mkdir(directory, { recursive: true });
	return join(directory, basename(target));
}

async function resolveTarget(outputPath: string, recommendedFilename: string): Promise<string> {
	if (!isAbsolute(outputPath)) throw new Error('"outputPath" must be an absolute file or directory path.');
	const kind = await pathKind(outputPath);
	if (kind === 'directory') return join(outputPath, sanitizeExportFilename(recommendedFilename));
	return outputPath;
}

function sameFile(left: Pick<Stats, 'dev' | 'ino'>, right: Pick<Stats, 'dev' | 'ino'>): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function openParentDirectory(parent: string): Promise<FileHandle | undefined> {
	const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
	try {
		return await open(parent, flags);
	} catch (error) {
		// Windows does not consistently permit opening a directory as a file
		// handle. Other platforms are expected to support this guard and fail
		// closed if it cannot be established.
		if (process.platform === 'win32') return undefined;
		throw error;
	}
}

async function validateParent(parent: string, approvedRoots: readonly string[], handle?: FileHandle): Promise<string> {
	const canonical = await realpath(parent);
	if (canonical !== parent || !approvedRoots.some(root => isWithinRoot(canonical, root))) {
		throw new Error('Export output directory changed or escaped the approved local roots.');
	}

	if (handle) {
		const [opened, current] = await Promise.all([handle.stat(), stat(canonical)]);
		if (!opened.isDirectory() || !current.isDirectory() || !sameFile(opened, current)) {
			throw new Error('Export output directory changed while the file was being written.');
		}

		// Linux exposes an open directory descriptor as a stable path. Child
		// operations through it cannot be redirected by replacing any parent
		// component after this point.
		if (process.platform === 'linux') {
			const descriptorPath = `/proc/self/fd/${handle.fd}`;
			const openedCanonical = await realpath(descriptorPath);
			if (openedCanonical !== parent || !approvedRoots.some(root => isWithinRoot(openedCanonical, root))) {
				throw new Error('Export output directory changed or escaped the approved local roots.');
			}
			return descriptorPath;
		}
	}

	return canonical;
}

async function assertPathMatchesHandle(path: string, handle: FileHandle): Promise<Stats> {
	const [opened, current] = await Promise.all([handle.stat(), lstat(path)]);
	if (!opened.isFile() || !current.isFile() || current.isSymbolicLink() || !sameFile(opened, current)) {
		throw new Error('Export temporary file changed while it was being written.');
	}
	return opened;
}

async function unlinkIfSameFile(path: string, identity: Pick<Stats, 'dev' | 'ino'> | undefined): Promise<void> {
	if (!identity) return;
	try {
		const current = await lstat(path);
		if (current.isFile() && !current.isSymbolicLink() && sameFile(current, identity)) await unlink(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}

/** Local filesystem storage with same-directory temporary files and rename. */
export class LocalExportStorage implements ExportStorage {
	async save(request: SaveExportRequest): Promise<SavedExport> {
		throwIfCancelled(request.signal);
		if (request.overwrite) {
			throw new Error('overwrite=true is not authorized for the read-only workflow export capability.');
		}
		const requestedTarget = await resolveTarget(request.outputPath, request.recommendedFilename);
		// Pointing at the Downloads folder itself saves into a Rewst Exports
		// subfolder (created when missing) instead of scattering bundles at the
		// top level. Every other directory keeps its existing behavior.
		const approvedTarget = await approvedCanonicalTarget(await redirectDownloadsRoot(requestedTarget));
		const target = approvedTarget.target;
		const parent = dirname(target);
		throwIfCancelled(request.signal);

		const parentHandle = await openParentDirectory(parent);
		let accessParent = await validateParent(parent, approvedTarget.approvedRoots, parentHandle);
		const targetAccessPath = join(accessParent, basename(target));
		try {
			await lstat(targetAccessPath);
			throw new Error(`Export output file already exists: ${target}. Choose a new outputPath.`);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
				await parentHandle?.close();
				throw error;
			}
		}

		const temporaryName = `.${basename(target)}.${randomBytes(12).toString('hex')}.tmp`;
		const temporaryAccessPath = join(accessParent, temporaryName);
		let temporaryHandle: FileHandle | undefined;
		let temporaryIdentity: Stats | undefined;
		let published = false;
		let complete = false;
		try {
			throwIfCancelled(request.signal);
			temporaryHandle = await open(
				temporaryAccessPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			temporaryIdentity = await assertPathMatchesHandle(temporaryAccessPath, temporaryHandle);
			throwIfCancelled(request.signal);
			await temporaryHandle.writeFile(request.contents, { encoding: 'utf8', signal: request.signal });
			throwIfCancelled(request.signal);
			await temporaryHandle.sync();
			throwIfCancelled(request.signal);
			accessParent = await validateParent(parent, approvedTarget.approvedRoots, parentHandle);
			await assertPathMatchesHandle(join(accessParent, temporaryName), temporaryHandle);
			// A same-directory hard link publishes the complete 0600 temporary file
			// atomically and fails with EEXIST instead of replacing a racing writer.
			try {
				throwIfCancelled(request.signal);
				await link(join(accessParent, temporaryName), join(accessParent, basename(target)));
				published = true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
					throw new Error(`Export output file already exists: ${target}. Choose a new outputPath.`);
				}
				throw error;
			}
			await validateParent(parent, approvedTarget.approvedRoots, parentHandle);
			const publishedStats = await lstat(join(accessParent, basename(target)));
			if (!temporaryIdentity || !publishedStats.isFile() || !sameFile(publishedStats, temporaryIdentity)) {
				throw new Error('Export output file changed during atomic publication.');
			}
			throwIfCancelled(request.signal);
			complete = true;
		} finally {
			await temporaryHandle?.close();
			if (!complete && published) {
				await unlinkIfSameFile(join(accessParent, basename(target)), temporaryIdentity);
			}
			await unlinkIfSameFile(join(accessParent, temporaryName), temporaryIdentity);
			await parentHandle?.close();
		}

		return { outputPath: target, bytes: Buffer.byteLength(request.contents, 'utf8') };
	}
}
