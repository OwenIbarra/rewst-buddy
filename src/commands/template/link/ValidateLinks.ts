import { LinkManager } from '@models';
import { log, uriExists } from '@utils';
import vscode from 'vscode';
import GenericCommand from '../../GenericCommand';

export class ValidateLinks extends GenericCommand {
	commandName = 'ValidateLinks';

	async execute(): Promise<void> {
		const allLinks = LinkManager.getAllTemplateLinks();

		if (allLinks.length === 0) {
			log.notifyInfo('No template links to validate.');
			return;
		}

		// Phase 1: Purge duplicates
		const duplicatesRemoved = await LinkManager.purgeDuplicates();

		// Phase 2: Remove links where the file no longer exists on disk
		const refreshedLinks = LinkManager.getAllTemplateLinks();
		let staleRemoved = 0;
		for (const link of refreshedLinks) {
			if (!(await uriExists(vscode.Uri.parse(link.uriString)))) {
				LinkManager.removeLink(link.uriString);
				staleRemoved++;
			}
		}

		const total = duplicatesRemoved + staleRemoved;
		if (total === 0) {
			log.notifyInfo(`All ${allLinks.length} template links are valid.`);
		} else {
			const parts: string[] = [];
			if (duplicatesRemoved > 0) parts.push(`${duplicatesRemoved} duplicates`);
			if (staleRemoved > 0) parts.push(`${staleRemoved} missing files`);
			log.notifyInfo(
				`Cleaned up ${total} invalid links (${parts.join(', ')}). ${LinkManager.getAllTemplateLinks().length} links remain.`,
			);
		}
	}
}
