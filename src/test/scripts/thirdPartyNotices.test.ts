/*---------------------------------------------------------------------------------------------
 *  Copyright (c) jhare96. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NullTelemetry } from '../../common/telemetry';

const notices: {
	packageRoot(resource: string): string | undefined;
	packageNotice(directory: string): string;
} = require(path.resolve(__dirname, '../../../../build/thirdPartyNotices'));

describe('Fork licensing and telemetry', () => {
	let directory: string;

	beforeEach(() => {
		directory = fs.mkdtempSync(path.join(os.tmpdir(), 'azdo-licence-'));
		fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', license: 'MIT' }));
	});

	afterEach(() => {
		fs.rmSync(directory, { recursive: true });
	});

	it('locates scoped and nested packages without attributing application files to dependencies', () => {
		assert.strictEqual(notices.packageRoot('/repo/node_modules/@scope/package/lib/index.js'), '/repo/node_modules/@scope/package');
		assert.strictEqual(notices.packageRoot('/repo/node_modules/outer/node_modules/inner/index.js'), '/repo/node_modules/outer/node_modules/inner');
		assert.strictEqual(notices.packageRoot('/repo/src/extension.ts'), undefined);
	});

	it('preserves licence and notice text verbatim in generated output', () => {
		const licence = fs.readFileSync(path.resolve(__dirname, '../../../../LICENSE'), 'utf8').trim();
		fs.writeFileSync(path.join(directory, 'LICENSE'), licence);
		fs.writeFileSync(path.join(directory, 'NOTICE.txt'), 'Original dependency attribution.');
		const result = notices.packageNotice(directory);
		assert.ok(result.startsWith('fixture@1.0.0\n\nLicence: MIT'));
		assert.ok(result.includes(licence));
		assert.ok(result.includes('Original dependency attribution.'));
	});

	it('includes licences embedded in a README when the archive has no licence file', () => {
		const licence = fs.readFileSync(path.resolve(__dirname, '../../../../LICENSE'), 'utf8');
		fs.writeFileSync(path.join(directory, 'README.md'), `# Package\n\n${licence}`);
		assert.ok(notices.packageNotice(directory).includes(licence.trim()));
	});

	it('fails explicitly instead of distributing a package with only a licence identifier', () => {
		fs.writeFileSync(path.join(directory, 'README.md'), 'Licence: MIT');
		assert.throws(() => notices.packageNotice(directory), /Missing full licence text.*fixture/);
	});

	it('uses version-specific supplements for archives missing their licence files', () => {
		fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'tr46', version: '0.0.3', license: 'MIT' }));
		assert.ok(notices.packageNotice(directory).includes('Copyright (c) Sebastian Mayr'));
		fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'tr46', version: '0.0.4', license: 'MIT' }));
		assert.throws(() => notices.packageNotice(directory), /Missing full licence text/);
	});

	it('handles shared workflow telemetry calls without creating a reporter', async () => {
		const telemetry = new NullTelemetry();
		telemetry.sendTelemetryEvent('startup', { source: 'test' }, { count: 1 });
		telemetry.sendTelemetryErrorEvent('error', { source: 'test' }, { count: 1 });
		await telemetry.dispose();
	});
});
