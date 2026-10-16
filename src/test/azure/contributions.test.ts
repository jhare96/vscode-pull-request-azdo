/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import manifest from '../../../package.json';
import localized from '../../../package.nls.json';
import { azureToolNames } from '../../azure/tools';

describe('Azure DevOps extension contributions', () => {
	it('defaults to Azure DevOps and Microsoft authentication', () => {
		assert.strictEqual(manifest.contributes.configuration.properties['azureDevOps.provider'].default, 'azureDevOps');
		assert.ok(manifest.extensionDependencies.includes('vscode.microsoft-authentication'));
		assert.ok(!manifest.extensionDependencies.includes('vscode.github-authentication'));
	});

	it('restricts trusted Server collections to machine configuration', () => {
		const setting = manifest.contributes.configuration.properties['azureDevOps.serverCollections'];
		assert.strictEqual(setting.scope, 'machine');
		assert.strictEqual(setting.items.pattern, '^https://');
	});

	it('declares structured Azure query categories', () => {
		const setting = manifest.contributes.configuration.properties['azureDevOps.queries'];
		assert.deepStrictEqual(setting.default, []);
		assert.deepStrictEqual(setting.items.required, ['label']);
		assert.deepStrictEqual(setting.items.properties.status.enum, ['active', 'completed', 'abandoned', 'all']);
		assert.ok(localized['azureDevOps.queries']);
	});

	it('matches every Azure language-model contribution to a registered tool and gates legacy tools', () => {
		const tools = manifest.contributes.languageModelTools;
		assert.deepStrictEqual(tools.filter(tool => tool.name.startsWith('azure-devops_')).map(tool => tool.name).sort(),
			azureToolNames.map(name => `azure-devops_${name}`).sort());
		for (const tool of tools) {
			assert.ok(tool.when.includes(`config.azureDevOps.provider == ${tool.name.startsWith('azure-devops_') ? 'azureDevOps' : 'github'}`), tool.name);
		}
	});

	it('registers and localizes all Azure commands', () => {
		const expected = [
			'signIn', 'signOut', 'refresh', 'createPullRequest', 'createWorkItem', 'pullRequestActions',
			'workItemActions', 'reply', 'openDiff', 'resolveThread', 'reopenThread', 'editComment', 'deleteComment',
			'startReview', 'submitReview', 'openNotification', 'markNotificationsRead',
			'toggleFileViewed', 'applySuggestion',
			'openPullRequest',
		].map(name => `azureDevOps.${name}`);
		const commands = manifest.contributes.commands.filter(command => command.command.startsWith('azureDevOps.'));
		assert.deepStrictEqual(commands.map(command => command.command).sort(), expected.sort());
		for (const command of commands) {
			const key = command.title.replace(/^%|%$/g, '');
			assert.ok(localized[key], `Missing localization for ${command.title}`);
			assert.strictEqual(command.enablement, 'config.azureDevOps.provider == azureDevOps');
		}
	});

	it('keeps argument-only comment and diff commands out of the command palette', () => {
		for (const name of ['reply', 'openDiff', 'resolveThread', 'reopenThread', 'editComment', 'deleteComment', 'startReview', 'openNotification', 'toggleFileViewed', 'applySuggestion']) {
			assert.ok(manifest.contributes.menus.commandPalette.some(entry => entry.command === `azureDevOps.${name}` && entry.when === 'false'));
		}
	});

	it('does not offer unregistered GitHub commands in Azure mode', () => {
		const legacy = manifest.contributes.commands.filter(command => !command.command.startsWith('azureDevOps.'));
		for (const command of legacy) {
			assert.ok(command.enablement.includes('config.azureDevOps.provider == github'), command.command);
			assert.ok(manifest.contributes.menus.commandPalette.some(entry => entry.command === command.command && entry.when.includes('config.azureDevOps.provider == github')), command.command);
		}
		for (const entries of Object.values(manifest.contributes.menus)) {
			for (const entry of entries) {
				if ('command' in entry && legacy.some(command => command.command === entry.command)) {
					assert.ok(entry.when.includes('config.azureDevOps.provider == github'), entry.command);
				}
			}
		}
	});
});
