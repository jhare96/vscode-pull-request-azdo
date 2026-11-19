/*---------------------------------------------------------------------------------------------
 *  Copyright (c) jhare96. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { readFileSync } from 'fs';
import * as path from 'path';
import React from 'react';
import { cleanup, render } from 'react-testing-library';
import { renderAzureMarkdown } from '../../../src/azure/markdown';
import { CommentBody } from '../../components/comment';

describe('Azure overview Markdown lists', () => {
	let styles: HTMLStyleElement;

	beforeEach(() => {
		styles = document.createElement('style');
		styles.textContent = [
			'node_modules/azure-devops-ui/Core/override.css',
			'webviews/editorWebview/index.css',
			'webviews/azdoOverview/index.css',
		].map(file => readFileSync(path.resolve(file), 'utf8')).join('\n');
		document.head.appendChild(styles);
	});

	afterEach(() => {
		cleanup();
		styles.remove();
	});

	for (const marker of ['-', '*', '+']) {
		it(`restores ${marker} bullet lists in comments and descriptions`, () => {
			const body = `${marker} First item\n${marker} Second item\n  ${marker} Nested item`;
			const bodyHTML = renderAzureMarkdown(body);
			const out = render(<>
				<CommentBody body={body} bodyHTML={bodyHTML} canApplyPatch={false} allowEmpty={false} />
				<div className="azdo-markdown" dangerouslySetInnerHTML={{ __html: bodyHTML }} />
				<ul className="menu"><li>Menu item</li></ul>
			</>);
			for (const selector of ['.comment-body', '.azdo-markdown']) {
				const content = out.container.querySelector(selector)!;
				assert.deepStrictEqual([...content.querySelectorAll('li')].map(item => item.firstChild!.textContent!.trim()),
					['First item', 'Second item', 'Nested item']);
				for (const list of content.querySelectorAll('ul')) {
					assert.strictEqual(window.getComputedStyle(list).paddingLeft, '2em');
				}
				for (const item of content.querySelectorAll('li')) {
					// JSDOM does not resolve inherited list styles; Chromium inherits the list's native marker.
					assert.strictEqual(window.getComputedStyle(item).listStyle, 'inherit');
				}
			}
			assert.strictEqual(window.getComputedStyle(out.container.querySelector('.menu li')!).listStyle, 'none');
		});
	}

	it('preserves ordered lists and keeps task checkboxes free of bullet markers', () => {
		const bodyHTML = renderAzureMarkdown('1. Ordered item\n\n- [x] Done\n- [ ] Todo\n\n---\n\n- [x] Loose task\n\n  Paragraph');
		const out = render(<CommentBody bodyHTML={bodyHTML} canApplyPatch={false} allowEmpty={false} />);
		const ordered = out.container.querySelector('ol > li')!;
		assert.strictEqual(ordered.textContent, 'Ordered item');
		assert.strictEqual(window.getComputedStyle(ordered).listStyle, 'inherit');
		const checkboxes = out.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
		assert.strictEqual(checkboxes.length, 3);
		assert.strictEqual(checkboxes[0].checked, true);
		assert.strictEqual(checkboxes[1].checked, false);
		for (const checkbox of checkboxes) {
			assert.strictEqual(window.getComputedStyle(checkbox.closest('li')!).listStyle, 'none', checkbox.closest('li')!.outerHTML);
		}
	});
});
