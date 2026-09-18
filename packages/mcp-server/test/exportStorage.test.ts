import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	buildTemporaryExportName,
	LocalExportStorage,
	ensureDefaultExportDir,
	resolveDefaultExportDir,
	sanitizeExportFilename,
} from '../src/export/exportStorage';

const state = vi.hoisted(() => ({
	root: '',
	homedir: '',
	settings: {} as Record<string, unknown>,
	beforeLink: undefined as ((source: string, destination: string) => Promise<void>) | undefined,
}));
vi.mock('../src/host', () => ({
	getRuntimeHost: () => ({
		getSetting: (key: string, fallback: unknown) => (key in state.settings ? state.settings[key] : fallback),
		workspaceRoots: () => [state.root],
	}),
}));
vi.mock('node:os', async importOriginal => {
	const actual = await importOriginal<typeof import('node:os')>();
	return { ...actual, homedir: () => state.homedir };
});
// Only publication is intercepted. All file identities, canonical paths, and
// exclusive creates exercise the real filesystem inside this test's temp root.
vi.mock('node:fs/promises', async importOriginal => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();
	return {
		...actual,
		link: vi.fn(async (source: string, destination: string) => {
			await state.beforeLink?.(source, destination);
			return actual.link(source, destination);
		}),
	};
});

let sandbox: string;
const storage = new LocalExportStorage();
const contents = JSON.stringify({ version: 2, signing: { signature: 'fixture' }, objects: ['é'] });
function save(outputPath: string) {
	return storage.save({ outputPath, contents, recommendedFilename: 'workflow.bundle.json', overwrite: false });
}

beforeEach(async () => {
	sandbox = await realpath(await mkdtemp(join(tmpdir(), 'rewst-export-test-')));
	state.root = join(sandbox, 'approved');
	state.homedir = sandbox;
	state.settings = {};
	await mkdir(state.root);
	state.beforeLink = undefined;
	vi.mocked(link).mockClear();
});
afterEach(async () => {
	state.beforeLink = undefined;
	await rm(sandbox, { recursive: true, force: true });
});

describe('local signed-bundle storage', () => {
	it('publishes complete contents atomically, preserves bytes, and removes the temporary file', async () => {
		const target = join(state.root, 'export.bundle.json');
		state.beforeLink = async (temporary, destination) => {
			expect(await readFile(temporary, 'utf8')).toBe(contents);
			await expect(lstat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
			if (process.platform !== 'win32') expect((await lstat(temporary)).mode & 0o777).toBe(0o600);
		};
		expect(await save(target)).toEqual({ outputPath: target, bytes: Buffer.byteLength(contents, 'utf8') });
		expect(await readFile(target, 'utf8')).toBe(contents);
		expect(await readdir(state.root)).toEqual(['export.bundle.json']);
		expect(link).toHaveBeenCalledTimes(1);
	});

	it('ignores unresolvable configured roots and still approves the remaining candidates', async () => {
		const notADirectory = join(sandbox, 'not-a-directory');
		await writeFile(notADirectory, 'fixture');
		state.settings['mcp.exportRoots'] = [join(notADirectory, 'child'), join(sandbox, 'missing-root')];
		const target = join(state.root, 'export.json');
		expect((await save(target)).outputPath).toBe(target);
		expect(await readFile(target, 'utf8')).toBe(contents);
	});

	it('rejects destinations outside approved roots and traversal through a sibling directory', async () => {
		const sibling = join(sandbox, 'approved-sibling');
		await mkdir(sibling);
		await expect(save(join(sibling, 'export.json'))).rejects.toThrow('outside the approved local roots');
		await expect(save(join(state.root, '..', 'export.json'))).rejects.toThrow('outside the approved local roots');
		expect(link).not.toHaveBeenCalled();
	});

	it('rejects a symlinked parent escaping the approved root', async () => {
		const outside = join(sandbox, 'outside');
		await mkdir(outside);
		await symlink(outside, join(state.root, 'escape'), 'junction');
		await expect(save(join(state.root, 'escape', 'export.json'))).rejects.toThrow(
			'outside the approved local roots',
		);
		expect(await readdir(outside)).toEqual([]);
	});

	it.skipIf(process.platform === 'win32')('does not follow a final-component symlink', async () => {
		const victim = join(sandbox, 'victim.json');
		await writeFile(victim, 'original');
		const target = join(state.root, 'export.json');
		await symlink(victim, target);
		await expect(save(target)).rejects.toThrow('already exists');
		expect(await readFile(victim, 'utf8')).toBe('original');
	});

	it('rejects a pre-existing target file without publishing or replacing it', async () => {
		const target = join(state.root, 'export.json');
		await writeFile(target, 'existing');
		await expect(save(target)).rejects.toThrow('already exists');
		expect(await readFile(target, 'utf8')).toBe('existing');
		expect(link).not.toHaveBeenCalled();
		expect(await readdir(state.root)).toEqual(['export.json']);
	});

	it('preserves a competing writer and cleans up after an atomic publication collision', async () => {
		const target = join(state.root, 'export.json');
		state.beforeLink = async (_temporary, destination) => {
			await writeFile(destination, 'competing writer', {
				flag: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			});
		};
		await expect(save(target)).rejects.toThrow('already exists');
		expect(await readFile(target, 'utf8')).toBe('competing writer');
		expect(await readdir(state.root)).toEqual(['export.json']);
	});

	it('cleans up a temporary file when publication fails', async () => {
		state.beforeLink = async () => {
			throw new Error('fixture publication failure');
		};
		await expect(save(join(state.root, 'export.json'))).rejects.toThrow('fixture publication failure');
		expect(await readdir(state.root)).toEqual([]);
	});

	it('rejects overwrite and relative paths before writing', async () => {
		await expect(
			storage.save({
				outputPath: join(state.root, 'export.json'),
				contents,
				recommendedFilename: 'fixture.json',
				overwrite: true,
			}),
		).rejects.toThrow('overwrite=true');
		await expect(save('relative.json')).rejects.toThrow('absolute');
		expect(await readdir(state.root)).toEqual([]);
	});

	it('sanitizes suggested filenames but retains an explicit file path', async () => {
		expect(sanitizeExportFilename('../../CON:bad')).not.toMatch(/[\\/:]/);
		expect(sanitizeExportFilename('CON')).toBe('_CON.json');
		const explicit = join(state.root, 'exact.bundle');
		expect((await save(explicit)).outputPath).toBe(explicit);
		expect((await save(state.root)).outputPath).toBe(join(state.root, 'workflow.bundle.json'));
	});

	it('redirects the Downloads folder itself into a Rewst Exports subfolder', async () => {
		const downloads = join(state.homedir, 'Downloads');
		await mkdir(downloads);
		const saved = await save(downloads);
		expect(saved.outputPath).toBe(join(downloads, 'Rewst Exports', 'workflow.bundle.json'));
		expect(await readFile(saved.outputPath, 'utf8')).toBe(contents);
		expect(await readdir(downloads)).toEqual(['Rewst Exports']);
		await expect(save(downloads)).rejects.toThrow('already exists');
	});

	it('defaults to <home>/Downloads/Rewst Exports and creates it on demand', async () => {
		expect(resolveDefaultExportDir()).toBe(join(state.homedir, 'Downloads', 'Rewst Exports'));
		const directory = await ensureDefaultExportDir();
		expect(directory).toBe(join(state.homedir, 'Downloads', 'Rewst Exports'));
		const saved = await save(directory);
		expect(saved.outputPath).toBe(join(directory, 'workflow.bundle.json'));
		expect(await readFile(saved.outputPath, 'utf8')).toBe(contents);
	});

	it('honors a configured absolute default directory outside the other roots', async () => {
		const custom = join(sandbox, 'custom-exports');
		state.settings['mcp.exportDefaultDir'] = custom;
		expect(resolveDefaultExportDir()).toBe(custom);
		const directory = await ensureDefaultExportDir();
		expect(directory).toBe(custom);
		const saved = await save(directory);
		expect(saved.outputPath).toBe(join(custom, 'workflow.bundle.json'));
		expect(await readFile(saved.outputPath, 'utf8')).toBe(contents);
	});

	it('rejects a configured default directory that is not absolute', async () => {
		state.settings['mcp.exportDefaultDir'] = 'relative/exports';
		expect(() => resolveDefaultExportDir()).toThrow('absolute directory path');
		await expect(ensureDefaultExportDir()).rejects.toThrow('absolute directory path');
	});

	it('bounds the temporary filename within 255 bytes for a long basename', async () => {
		const longBase = `${'a'.repeat(230)}.json`;
		const target = join(state.root, longBase);
		expect(Buffer.byteLength(longBase, 'utf8')).toBeLessThanOrEqual(255);
		const saved = await save(target);
		expect(saved.outputPath).toBe(target);
		expect(await readFile(target, 'utf8')).toBe(contents);
		expect(await readdir(state.root)).toEqual([longBase]);
	});

	it('truncates temporary names by whole Unicode code points', () => {
		const suffix = 'a'.repeat(24);
		const temporary = buildTemporaryExportName('é'.repeat(200), suffix);
		expect(Buffer.byteLength(temporary, 'utf8')).toBeLessThanOrEqual(255);
		expect(temporary.endsWith(`.${suffix}.tmp`)).toBe(true);
		expect(temporary.startsWith('.')).toBe(true);
		// No partial multi-byte character: re-encoding round-trips cleanly.
		expect(Buffer.byteLength(temporary, 'utf8')).toBe(Buffer.from(temporary, 'utf8').length);
		expect(temporary).toContain('é');
	});
});
