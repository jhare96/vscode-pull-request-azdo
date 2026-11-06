/*---------------------------------------------------------------------------------------------
 *  Copyright (c) jhare96. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EXTENSION_ID } from '../../constants';
import { Schemes } from '../../common/uri';
import { PullRequestCommentController } from '../../view/pullRequestCommentController';
import { ReviewCommentController } from '../../view/reviewCommentController';

const extension = vscode.extensions.getExtension(EXTENSION_ID);
if (!extension) {
	throw new Error('Run contribution tests in the extension development host.');
}
const root = extension.extensionPath;
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('Standalone fork contributions', () => {
	it('keeps a stable standalone extension identity', () => {
		assert.strictEqual(`${manifest.publisher}.${manifest.name}`, EXTENSION_ID);
		assert.strictEqual(EXTENSION_ID, 'jhare96.vscode-pull-request-azdo');
	});

	it('makes independent branding and support explicit without replacing upstream copyright', () => {
		const localization = JSON.parse(readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
		assert.strictEqual(localization.displayName, 'Azure DevOps Pull Requests (Unofficial)');
		assert.ok(localization.description.includes('Not affiliated with, endorsed by, or supported by Microsoft or GitHub'));
		assert.strictEqual(manifest.icon, 'resources/icons/azdo-pr.png');
		assert.ok(existsSync(path.join(root, manifest.icon)));
		assert.strictEqual(manifest.bugs.url, 'https://github.com/jhare96/vscode-pull-request-azdo/issues');
		assert.ok(readFileSync(path.join(root, 'LICENSE'), 'utf8').includes('Copyright (c) Microsoft Corporation.'));
	});

	it('does not initialize upstream telemetry or experimentation in activation', () => {
		const activation = readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
		assert.ok(activation.includes('telemetry = new NullTelemetry()'));
		assert.ok(!activation.includes('TelemetryReporter'));
		assert.ok(!activation.includes('ingestionKey'));
		assert.ok(!activation.includes('createExperimentationService'));
	});

	it('retains the original view surfaces under independent identifiers', () => {
		const views: { id: string }[] = Object.values(manifest.contributes.views).flat() as { id: string }[];
		assert.ok(views.some(view => view.id === 'pr:azureDevOps'));
		assert.ok(views.some(view => view.id === 'azureDevOps:createPullRequestWebview'));
		assert.ok(views.some(view => view.id === 'azureDevOps:activePullRequest'));
		assert.ok(views.every(view => !view.id.includes('github')));
		const commands: { command: string }[] = manifest.contributes.commands;
		assert.ok(commands.length > 150, 'Keep the original workflow actions, not an Azure replacement command set.');
		assert.ok(commands.every(command => command.command.startsWith('azdo.')));
	});

	it('namespaces configuration, chat tools, contexts and custom document providers', () => {
		assert.ok(Object.keys(manifest.contributes.configuration.properties).every(key => key.startsWith('azureDevOps')));
		const tools: { name: string; toolReferenceName: string }[] = manifest.contributes.languageModelTools;
		assert.ok(tools.every(tool => tool.name.startsWith('azure-devops-') && tool.toolReferenceName.startsWith('azdo_')));
		const contexts: { id: string }[] = manifest.contributes.chatContext;
		assert.ok(contexts.every(context => context.id.startsWith('azdo')));
		assert.strictEqual(Schemes.Pr, 'azdo-pr');
		assert.strictEqual(Schemes.Review, 'azdo-review');
		assert.strictEqual(Schemes.CheckRunLog, 'azdocheckrunlog');
		assert.ok(manifest.activationEvents.includes(`onFileSystem:${Schemes.NewIssue}`));
	});

	it('uses the Azure controller prefixes and draft context for comment commands', () => {
		assert.strictEqual(PullRequestCommentController.PREFIX, 'azdo-browse');
		assert.strictEqual(ReviewCommentController.PREFIX, 'azdo-review');
		const menus = manifest.contributes.menus as Record<string, { command: string; when?: string }[]>;
		const commentActions = Object.entries(menus)
			.filter(([menu]) => menu.startsWith('comments/'))
			.flatMap(([, actions]) => actions);
		assert.ok(commentActions.every(action => !action.when?.includes('github-')));
		assert.ok(commentActions.every(action => !/(^|[^:\w])reviewInDraftMode\b/.test(action.when ?? '')));
		const draftActions = [
			...menus['comments/commentThread/context'],
			...menus['comments/commentThread/additionalActions'].filter(action => action.command === 'azdo.pr.openReview'),
		];
		assert.strictEqual(draftActions.length, 6);
		for (const action of draftActions) {
			assert.ok(action.when?.includes(`commentController =~ /^${PullRequestCommentController.PREFIX}/ && `), action.command);
			assert.ok(action.when?.includes(`commentController =~ /^${ReviewCommentController.PREFIX}/ && `), action.command);
			assert.ok(action.when?.includes('azureDevOps:prInDraft'), action.command);
			assert.ok(action.when?.includes('azureDevOps:reviewInDraftMode'), action.command);
		}
	});

	it('matches Azure tree views for command menus and the reveal shortcut', () => {
		const menus = manifest.contributes.menus as Record<string, { command: string; when?: string }[]>;
		const keybindings = manifest.contributes.keybindings as { command: string; when: string }[];
		const actions = [
			...menus['view/item/context'].filter(action => action.when?.includes('view =~')),
			...keybindings.filter(action => action.command === 'azdo.pr.revealFileInOS'),
		];
		assert.strictEqual(actions.length, 10);
		const views = Object.values(manifest.contributes.views).flat() as { id: string }[];
		for (const action of actions) {
			const match = /(?:view|focusedView) =~ \/(?<pattern>[^/]+)\//.exec(action.when ?? '');
			assert.ok(match?.groups?.pattern, action.command);
			const pattern = new RegExp(match.groups.pattern);
			for (const view of ['pr:azureDevOps', 'prStatus:azureDevOps']) {
				assert.ok(views.some(entry => entry.id === view), view);
				assert.ok(pattern.test(view), `${action.command}: ${view}`);
			}
			assert.ok(!pattern.test('pr:github'), action.command);
			assert.ok(!pattern.test('prStatus:github'), action.command);
			assert.ok(!pattern.test('issues:azureDevOps'), action.command);
		}
	});

	it('uses the document provider schemes in editor command conditions', () => {
		const menus = manifest.contributes.menus as Record<string, { command: string; when?: string }[]>;
		const exclusions = `resourceScheme != ${Schemes.Pr} && resourceScheme != ${Schemes.Review} && resourceScheme != ${Schemes.FileChange}`;
		const expected = [
			['azdo.review.openFile', `(resourceScheme =~ /^${Schemes.Review}$/ && isInDiffEditor) && !isSessionsWindow`],
			['azdo.review.openLocalFile', `(resourceScheme =~ /^${Schemes.Review}$/ && !isInDiffEditor) && !isSessionsWindow`],
			['azdo.pr.markFileAsViewed', `(${exclusions} && resourcePath in azureDevOps:unviewedFiles) && !isSessionsWindow`],
			['azdo.pr.unmarkFileAsViewed', `(${exclusions} && resourcePath in azureDevOps:viewedFiles) && !isSessionsWindow`],
			['azdo.pr.openDiffViewFromEditor', `(!isInDiffEditor && ${exclusions} && resourcePath in azureDevOps:unviewedFiles) && !isSessionsWindow`],
			['azdo.pr.openDiffViewFromEditor', `(!isInDiffEditor && ${exclusions} && resourcePath in azureDevOps:viewedFiles) && !isSessionsWindow`],
			['azdo.pr.addFileComment', `(resourceScheme == ${Schemes.Pr}) || (resourcePath in azureDevOps:viewedFiles) || (resourcePath in azureDevOps:unviewedFiles)`],
			['azdo.pr.closeRelatedEditors', `(resourceScheme == '${Schemes.Pr}' || resourceScheme == '${Schemes.Review}' || resourcePath in azureDevOps:unviewedFiles || resourcePath in azureDevOps:viewedFiles) && !isSessionsWindow`],
		];
		const actions = [...menus['editor/title'], ...menus['editor/title/context']]
			.filter(action => action.when?.includes('resourceScheme'));
		assert.strictEqual(actions.length, expected.length);
		for (const [command, when] of expected) {
			assert.ok(actions.some(action => action.command === command && action.when === when), `${command}: ${when}`);
		}
	});

	it('matches both merge editor providers without accepting legacy schemes', () => {
		const menus = manifest.contributes.menus as Record<string, { command: string; when?: string }[]>;
		const actions = Object.values(menus).flat().filter(action => action.command === 'azdo.pr.acceptMerge');
		assert.strictEqual(actions.length, 2);
		for (const action of actions) {
			const match = /mergeEditorBaseUri =~ \/(?<pattern>[^/]+)\//.exec(action.when ?? '');
			assert.ok(match?.groups?.pattern);
			const pattern = new RegExp(match.groups.pattern);
			for (const scheme of [Schemes.GithubPr, Schemes.GitPr]) {
				assert.ok(pattern.test(`${scheme}:/file.ts`), scheme);
			}
			for (const scheme of ['githubpr', 'gitpr', 'file']) {
				assert.ok(!pattern.test(`${scheme}:/file.ts`), scheme);
			}
			assert.ok(action.when?.includes('isMergeResultEditor'));
			assert.ok(action.when?.includes('!isSessionsWindow'));
		}
	});

	it('uses independent repository, draft and issue creation context keys', () => {
		const contributions = JSON.stringify(manifest.contributes);
		assert.ok(!contributions.includes('gitHubOpenRepositoryCount'));
		assert.ok(!/(^|[^:\w])prInDraft\b/.test(contributions));
		assert.ok(!contributions.includes('issues.creatingFromFile'));
		const menus = manifest.contributes.menus as Record<string, { when?: string }[]>;
		const repositoryActions = Object.values(menus).flat()
			.filter(action => action.when?.includes('azureDevOps:openRepositoryCount'));
		assert.strictEqual(repositoryActions.length, 18);
		const commands = manifest.contributes.commands as { command: string; enablement?: string }[];
		assert.strictEqual(commands.find(command => command.command === 'azdo.issue.createIssueFromFile')?.enablement,
			'!azureDevOps:creatingIssueFromFile');
	});

	it('uses independent repository state for sign-in views and welcome messages', () => {
		const views = Object.values(manifest.contributes.views).flat() as { id: string; when?: string }[];
		const login = views.find(view => view.id === 'azureDevOps:login');
		const pulls = views.find(view => view.id === 'pr:azureDevOps');
		assert.ok(login?.when?.includes('azureDevOps:reposManagerState == NeedsAuthentication'));
		assert.ok(pulls?.when?.includes('azureDevOps:reposManagerState != NeedsAuthentication'));
		const welcome = manifest.contributes.viewsWelcome as { view: string; when: string }[];
		assert.ok(welcome.filter(entry => entry.view === 'azureDevOps:login')
			.every(entry => entry.when.includes('azureDevOps:reposManagerState == NeedsAuthentication')));
		assert.ok(!JSON.stringify(manifest.contributes).includes('ReposManagerStateContext'));
	});

	it('builds and hosts the original overview and creation forms, not separate Azure pages', () => {
		const webpack = readFileSync(path.join(root, 'webpack.config.js'), 'utf8');
		assert.ok(webpack.includes('webviews/editorWebview/index.ts'));
		assert.ok(webpack.includes('webviews/createPullRequestViewNew/index.ts'));
		assert.ok(!webpack.includes('azureOverview'));
		assert.strictEqual(existsSync(path.join(root, 'src/azure/extension.ts')), false);
		assert.strictEqual(existsSync(path.join(root, 'webviews/azureOverview')), false);
		const activation = readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
		assert.ok(activation.includes('registerCommands('));
		assert.ok(!activation.includes('activateAzure'));
	});
});
